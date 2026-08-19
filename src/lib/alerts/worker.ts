/**
 * 告警轮询进程。
 *
 * 这是「服务端告警」的核心：只要服务在跑，无论浏览器是否打开，
 * 规则都会被持续求值并推送通知。
 *
 * 求值逻辑完全复用 engine.ts 的纯函数——它当初就是为此设计的，
 * 这里只负责调度、取数、持久化与通知。
 */

import { fetchCandles, fetchTickers } from '../datasources/binance-vision';
import { buildTechnicalSnapshot, type TechnicalSnapshot } from '../indicators/summary';
import { evaluateRules } from './engine';
import { appendEvents, readRules, updateRules } from './store';
import { formatEvents, sendTelegram, telegramConfigFromEnv } from './notify/telegram';
import type { AlertEvent, AlertRule } from './types';
import { INTERVALS, type Interval } from '../datasources/types';

export interface WorkerStatus {
  running: boolean;
  /** 关闭原因，running 为 false 时有值 */
  reason: string | null;
  pollSeconds: number;
  lastRunAt: number | null;
  lastError: string | null;
  /** 上一轮求值的规则数与触发数 */
  lastRuleCount: number;
  lastEventCount: number;
  totalRuns: number;
  notifier: 'telegram' | null;
}

/**
 * 状态挂在 globalThis 上，而不是模块级变量。
 *
 * 原因是 Next.js 把 instrumentation 与 API 路由编译进不同的模块图，
 * 模块级变量在两边是各自独立的副本——worker 在 instrumentation 侧真的跑起来了，
 * 而 /api/alerts/status 读到的却永远是另一份初始值，界面会误报「未运行」。
 * 这类不一致比功能不可用更糟：用户以为没在监控，实际在监控（或反之）。
 */
const GLOBAL_KEY = Symbol.for('crypto-radar.alerts.worker');

interface WorkerGlobal {
  state: WorkerStatus;
  timer: NodeJS.Timeout | null;
  previousSnapshots: Map<string, TechnicalSnapshot>;
}

const g = globalThis as unknown as Record<symbol, WorkerGlobal | undefined>;

if (!g[GLOBAL_KEY]) {
  g[GLOBAL_KEY] = {
    state: {
      running: false,
      reason: null,
      pollSeconds: 60,
      lastRunAt: null,
      lastError: null,
      lastRuleCount: 0,
      lastEventCount: 0,
      totalRuns: 0,
      notifier: null,
    },
    timer: null,
    previousSnapshots: new Map(),
  };
}

const shared = g[GLOBAL_KEY]!;
const state = shared.state;

/**
 * 上一轮的技术面快照，键为 `${symbol}:${interval}`。
 * bb_squeeze_release 这类规则关心的是「状态发生变化」而非「当前状态」，
 * 必须有上一轮的快照才能判断。放内存即可：
 * 重启后丢失只意味着第一轮不触发这类规则，不影响正确性。
 */
const previousSnapshots = shared.previousSnapshots;

export function getWorkerStatus(): WorkerStatus {
  return { ...state };
}

export function startWorker(): void {
  if (shared.timer) return;

  if (process.env.ALERTS_ENABLED === 'false') {
    state.running = false;
    state.reason = '已由 ALERTS_ENABLED=false 显式关闭';
    return;
  }

  const seconds = Number(process.env.ALERTS_POLL_SECONDS);
  // 太频繁除了浪费配额没有意义——技术指标基于 K 线，1 分钟内不会有实质变化
  state.pollSeconds = Number.isFinite(seconds) && seconds >= 20 ? seconds : 60;

  state.notifier = telegramConfigFromEnv() ? 'telegram' : null;
  state.running = true;
  state.reason = null;

  console.log(
    `[alerts] 告警轮询已启动，每 ${state.pollSeconds} 秒一轮` +
      `，通知出口：${state.notifier ?? '仅记录（未配置 Telegram）'}`,
  );

  // 立即跑一轮，不必等第一个周期
  void tick();
  shared.timer = setInterval(() => void tick(), state.pollSeconds * 1000);
  // 不要因为这个定时器而阻止进程退出
  shared.timer.unref?.();
}

export function stopWorker(): void {
  if (shared.timer) clearInterval(shared.timer);
  shared.timer = null;
  state.running = false;
  state.reason = '已手动停止';
}

/** 单轮求值。任何异常都不允许中断循环。 */
async function tick(): Promise<void> {
  try {
    const rules = (await readRules()).filter((r) => r.enabled);
    state.lastRuleCount = rules.length;
    state.lastRunAt = Date.now();
    state.totalRuns++;

    // 没有启用中的规则时直接返回，一次网络请求都不发
    if (rules.length === 0) {
      state.lastEventCount = 0;
      state.lastError = null;
      return;
    }

    const events = await evaluateAll(rules);
    state.lastEventCount = events.length;
    state.lastError = null;

    if (events.length > 0) await handleEvents(events);
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    console.warn('[alerts] 本轮求值失败：', state.lastError);
  }
}

async function evaluateAll(rules: AlertRule[]): Promise<AlertEvent[]> {
  // 一次拉齐所有涉及的币种行情，而不是每条规则各拉一次
  const symbols = [...new Set(rules.map((r) => r.symbol))];
  const tickers = await fetchTickers(symbols);
  const priceOf = new Map(tickers.map((t) => [t.symbol, t.last]));

  // 按 币种+周期 分组，同组共用一次 K 线请求
  const groups = new Map<string, AlertRule[]>();
  for (const r of rules) {
    const key = `${r.symbol}:${r.interval}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  const events: AlertEvent[] = [];

  for (const [key, groupRules] of groups) {
    const [symbol, interval] = key.split(':');
    const price = priceOf.get(symbol);
    if (price == null) {
      console.warn(`[alerts] ${symbol} 行情不可用，跳过本轮`);
      continue;
    }

    let technical: TechnicalSnapshot | null = null;
    // 规则来自 JSON 文件，interval 未必是合法值——强转会把脏数据带进取数层
    if (!isInterval(interval)) {
      console.warn(`[alerts] 规则周期 "${interval}" 非法，跳过技术面求值`);
    } else {
      try {
        const candles = await fetchCandles(symbol, interval, 200);
        technical = buildTechnicalSnapshot(candles, interval);
      } catch (err) {
        // 取不到 K 线时仍然求值：价格类规则不依赖技术面，不该被一并拖垮
        console.warn(`[alerts] ${key} K线获取失败，仅求值价格类规则：`, err);
      }
    }

    events.push(
      ...evaluateRules(groupRules, {
        symbol,
        price,
        technical,
        previousTechnical: previousSnapshots.get(key) ?? null,
      }),
    );

    if (technical) previousSnapshots.set(key, technical);
  }

  return events;
}

async function handleEvents(events: AlertEvent[]): Promise<void> {
  await appendEvents(events);

  // 记录触发时间用于冷却；once 规则触发后自动停用
  await updateRules((rules) =>
    rules.map((r) => {
      const hit = events.find((e) => e.ruleId === r.id);
      if (!hit) return r;
      return { ...r, lastTriggeredAt: hit.triggeredAt, enabled: r.once ? false : r.enabled };
    }),
  );

  console.log(`[alerts] 触发 ${events.length} 条：${events.map((e) => e.message).join(' | ')}`);

  const cfg = telegramConfigFromEnv();
  if (!cfg) return;

  const result = await sendTelegram(cfg, formatEvents(events));
  if (!result.ok) {
    // 通知失败不该让事件丢失——事件已先落盘，界面上仍然看得到
    console.warn('[alerts] Telegram 推送失败：', result.detail);
    state.lastError = `通知发送失败：${result.detail}`;
  }
}

function isInterval(v: string): v is Interval {
  return (INTERVALS as string[]).includes(v);
}
