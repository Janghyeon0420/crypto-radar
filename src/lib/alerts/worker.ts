/**
 * 告警轮询进程。
 *
 * 这是「服务端告警」的核心：只要服务在跑，无论浏览器是否打开，
 * 规则都会被持续求值并推送通知。
 *
 * 求值逻辑完全复用 engine.ts 的纯函数——它当初就是为此设计的，
 * 这里只负责调度、取数、持久化与通知。
 */

import { fetchCandles, fetchTickers } from '../datasources/market';
import { buildTechnicalSnapshot, type TechnicalSnapshot } from '../indicators/summary';
import { evaluateRules } from './engine';
import { appendEvents, readRules, updateRules } from './store';
import { dispatchEvents, dispatchText, resolveNotifiers } from './notify';
import { evaluateDueRecords } from '../history/evaluate';
import { backupDataFiles } from '../history/backup';
import { acquireLock, refreshLock, releaseLock } from './lock';
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
  /** 已配置的通知通道名，空数组表示只记录不推送 */
  notifiers: string[];
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
  /** 上次跑到期评估 / 上次备份的时间，用于把低频任务错开在高频轮询里 */
  lastEvalAt: number;
  lastBackupAt: number;
  /** 连续失败轮数，用于自监控告警 */
  consecutiveFailures: number;
  /** 是否已就本次故障发过通知，避免每轮都发 */
  outageNotified: boolean;
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
      notifiers: [],
    },
    timer: null,
    previousSnapshots: new Map(),
    lastEvalAt: 0,
    lastBackupAt: 0,
    consecutiveFailures: 0,
    outageNotified: false,
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

  state.notifiers = resolveNotifiers().map((n) => n.label);

  // 取锁失败说明同一份 data/ 已有另一个进程在轮询——最常见的情形是
  // 常驻服务在跑着，又手动敲了一次 npm run dev（Next 会自动换到 3001）。
  // 此时必须让出：两个进程同时求值会重复通知、交替覆盖事件文件。
  void acquireLock(state.pollSeconds).then((lock) => {
    if (!lock.acquired) {
      state.running = false;
      state.reason =
        `另一个进程（pid ${lock.heldBy?.pid}）正在轮询同一份 data/，本进程不重复求值。` +
        `若那个进程已经不在了，删掉 data/alerts.lock 即可`;
      console.warn(`[alerts] ${state.reason}`);
      return;
    }

    state.running = true;
    state.reason = null;

    console.log(
      `[alerts] 告警轮询已启动，每 ${state.pollSeconds} 秒一轮` +
        `，通知出口：${state.notifiers.join('、') || '仅记录（未配置通知通道）'}`,
    );

    // 启动通知有两个作用：确认通道确实通（配错了当场就知道，
    // 而不是等到第一次真实触发时才发现），以及常驻服务意外重启时留下痕迹
    if (state.notifiers.length > 0) {
      void dispatchText(
        `🟢 Crypto Radar 告警监控已启动，每 ${state.pollSeconds} 秒一轮`,
      ).catch(() => {});
    }

    // 立即跑一轮，不必等第一个周期
    void tick();
    shared.timer = setInterval(() => void tick(), state.pollSeconds * 1000);
    // 不要因为这个定时器而阻止进程退出
    shared.timer.unref?.();
  });
}

export function stopWorker(): void {
  if (shared.timer) clearInterval(shared.timer);
  shared.timer = null;
  state.running = false;
  state.reason = '已手动停止';
  void releaseLock();
}

/** 单轮求值。任何异常都不允许中断循环。 */
async function tick(): Promise<void> {
  try {
    const rules = (await readRules()).filter((r) => r.enabled);
    state.lastRuleCount = rules.length;
    state.lastRunAt = Date.now();
    state.totalRuns++;

    // 没有启用中的规则时不做行情请求。但低频维护任务照做——
    // 「没建告警规则」和「不需要评估研判、不需要备份」是两回事
    if (rules.length === 0) {
      state.lastEventCount = 0;
      state.lastError = null;
      await runMaintenance();
      return;
    }

    const events = await evaluateAll(rules);
    state.lastEventCount = events.length;
    state.lastError = null;
    await noteSuccess();

    if (events.length > 0) await handleEvents(events);
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    console.warn('[alerts] 本轮求值失败：', state.lastError);
    await noteFailure(state.lastError);
  } finally {
    // 续期放在 finally：求值失败（比如网络断了）不代表进程死了，
    // 不续期会让锁过期、被另一个进程接管，反而造成两边都在跑
    await refreshLock();
    await runMaintenance();
  }
}

/** 到期评估的间隔。研判的检验周期以天计，比这更频繁没有意义 */
const EVAL_INTERVAL_MS = 15 * 60_000;
const BACKUP_INTERVAL_MS = 24 * 3600_000;

/**
 * 低频维护任务：研判到期评估 + data/ 每日快照。
 *
 * 挂在告警轮询里，是因为常驻进程已经在跑了，再起一套调度纯属多余。
 * 每项任务自己记上次执行时间，与轮询间隔解耦——
 * 用户把 ALERTS_POLL_SECONDS 调成 20 秒，也不会因此每 20 秒评估一次。
 *
 * 任何一项失败都只记日志：维护任务不该拖垮告警这个主职能。
 */
async function runMaintenance(): Promise<void> {
  const now = Date.now();

  // ── 研判到期评估 ──
  // 这件事此前只在有人打开准确率面板时才发生，也就是说
  // 不打开看板研判就永远不会被检验，而置信度校准要攒够样本才出数。
  // 常驻进程本来就在跑，这是它天然该做的事
  if (now - shared.lastEvalAt >= EVAL_INTERVAL_MS) {
    shared.lastEvalAt = now;
    try {
      const n = await evaluateDueRecords();
      if (n > 0) console.log(`[history] 自动评估了 ${n} 条到期研判`);
    } catch (err) {
      console.warn('[history] 自动评估失败：', err);
    }
  }

  // ── data/ 每日快照 ──
  if (now - shared.lastBackupAt >= BACKUP_INTERVAL_MS) {
    shared.lastBackupAt = now;
    try {
      const r = await backupDataFiles();
      if (r) console.log(`[backup] 已快照 ${r.files.length} 个文件到 ${r.dir}`);
    } catch (err) {
      console.warn('[backup] 快照失败：', err);
    }
  }
}

/**
 * 自监控：连续失败到一定轮数就主动发通知。
 *
 * 告警的全部意义是「你不用盯着」。那么当告警本身停摆时，
 * 更不该指望用户主动打开页面去发现——必须让它自己喊一声。
 *
 * 只在跨过阈值的那一轮发一次，恢复时再发一次。
 * 每轮都发会在网络断开的整个期间刷屏，那和不发一样糟。
 */
const FAILURE_THRESHOLD = 3;

async function noteFailure(detail: string): Promise<void> {
  shared.consecutiveFailures++;
  if (shared.consecutiveFailures < FAILURE_THRESHOLD || shared.outageNotified) return;

  shared.outageNotified = true;
  await dispatchText(
    `⚠️ 告警轮询连续 ${shared.consecutiveFailures} 轮失败，监控可能已中断。
` +
      `最近一次错误：${detail}`,
  ).catch(() => {
    // 通知本身也发不出去时无处可诉，日志已经记过了
  });
}

async function noteSuccess(): Promise<void> {
  const failed = shared.consecutiveFailures;
  shared.consecutiveFailures = 0;
  if (!shared.outageNotified) return;

  shared.outageNotified = false;
  await dispatchText(`✅ 告警轮询已恢复（此前连续失败 ${failed} 轮）`).catch(() => {});
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

  const results = await dispatchEvents(events);
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    // 通知失败不该让事件丢失——事件已先落盘，界面上仍然看得到
    const detail = failed.map((f) => `${f.channel}：${f.detail}`).join('；');
    console.warn('[alerts] 推送失败：', detail);
    state.lastError = `通知发送失败 — ${detail}`;
  }
}

function isInterval(v: string): v is Interval {
  return (INTERVALS as string[]).includes(v);
}
