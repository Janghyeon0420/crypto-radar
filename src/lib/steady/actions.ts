/**
 * 「今日行动」：把用户自己写下的计划，翻译成今天需要做（或不需要做）的事。
 *
 * 设计上的三条约束：
 *   1. **每条提示都来自用户自己设定的规则**，而不是模型的判断。引擎里没有任何
 *      「看涨/看跌」——项目自己的回测已经说明那类信号没有稳定的预测力。
 *   2. **每条都带 why**：说清楚是哪条规则、用了哪个数字触发的，用户可以质疑它。
 *   3. **默认动作是什么都不做**。没有规则被触发时明确说「今天没有需要做的事」。
 *      研究（Morningstar《Mind the Gap》）显示散户的买卖时机平均在拖累收益，
 *      所以「没事发生」本身就是一条有价值的信息，不该用无关紧要的提示去填满屏幕。
 */

import {
  daysUntil,
  describeDca,
  isDcaDay,
  nextDcaDate,
  splitContribution,
  type AllocationRow,
  type DriftRow,
} from './plan';
import type { Plan } from './schema';

export type ActionLevel = 'alert' | 'warn' | 'info' | 'ok';

export interface Action {
  id: string;
  level: ActionLevel;
  title: string;
  detail: string;
  /** 为什么会出现这条——哪条规则、哪个数字 */
  why: string;
}

export interface ActionContext {
  now: Date;
  plan: Plan | null;
  hasHoldings: boolean;
  total: number;
  alloc: AllocationRow[];
  drift: DriftRow[];
  /** 熊市基准情景下的损失（正数 = 亏损 %）。无法计算时为 null */
  tail: { lossPct: number; lossValue: number; shockPct: number } | null;
  budget: { maxCryptoSharePct: number; currentCryptoSharePct: number } | null;
  /** 组合历史回放的「当前回撤」（≤ 0，%）。无法计算时为 null */
  currentDrawdownPct: number | null;
  btc24hChangePct: number | null;
  btcDailySigmaPct: number | null;
}

const ORDER: Record<ActionLevel, number> = { alert: 0, warn: 1, info: 2, ok: 3 };
const usd = (n: number) => Math.round(n).toLocaleString('en-US');
const pct = (n: number, d = 0) => n.toFixed(d);

export function buildActions(ctx: ActionContext): Action[] {
  const { plan, now } = ctx;

  if (!plan) {
    return [
      {
        id: 'no-plan',
        level: 'info',
        title: '先写下你的底线',
        detail: '还没有投资计划。先回答一个问题：这笔钱最多能亏多少？系统会据此反推最多该持有多少加密资产。',
        why: '稳健投资的第一步不是选币，而是在行情冲昏头脑之前，先把规则定好。',
      },
    ];
  }

  if (!ctx.hasHoldings) {
    return [
      {
        id: 'no-holdings',
        level: 'info',
        title: '录入你现在的持仓',
        detail: '计划已经有了。把你现在持有的币和数量填进来（只存在本机），就能做风险体检。',
        why: '没有持仓就没有可检查的东西。持仓只在本机手动录入，不需要任何交易所 API Key。',
      },
    ];
  }

  const out: Action[] = [];

  // ── 1. 极端情景下的亏损 vs 底线 ──
  if (ctx.tail) {
    const { lossPct, lossValue, shockPct } = ctx.tail;
    const budgetLine = ctx.budget
      ? `按你的底线（并留 20% 安全垫），加密资产最多占约 ${pct(ctx.budget.maxCryptoSharePct)}%，现在是 ${pct(ctx.budget.currentCryptoSharePct)}%。`
      : '';
    if (lossPct > plan.maxLossPct) {
      out.push({
        id: 'tail-over',
        level: 'alert',
        title: `熊市情景下可能亏 ${pct(lossPct)}%，超过你的底线 ${pct(plan.maxLossPct)}%`,
        detail:
          `如果 BTC 像历轮熊市一样跌 ${pct(Math.abs(shockPct))}%，你的组合约亏 ${pct(lossPct)}%（约 ${usd(lossValue)} USDT）。` +
          budgetLine,
        why:
          `这是情景压力，不是预测：BTC 历轮熊市的回撤量级约 -75%~-85%，其他币按各自的 beta 联动。` +
          `你把底线定在 ${pct(plan.maxLossPct)}%，而这个组合在该情景下会超过它。` +
          `提示的意义不是让你现在就卖，而是让你清楚：到那一天，你会不会按计划拿得住。`,
      });
    } else if (lossPct > plan.maxLossPct * 0.8) {
      out.push({
        id: 'tail-near',
        level: 'warn',
        title: `熊市情景下可能亏 ${pct(lossPct)}%，已接近你的底线 ${pct(plan.maxLossPct)}%`,
        detail: `约 ${usd(lossValue)} USDT。${budgetLine}`,
        why: `熊市情景下的亏损已超过你底线的 80%（${pct(plan.maxLossPct * 0.8, 1)}%），余量不多。`,
      });
    }
  }

  // ── 2. 回撤是否已触及底线 ──
  if (ctx.currentDrawdownPct != null) {
    const dd = ctx.currentDrawdownPct; // ≤ 0
    if (dd <= -plan.maxLossPct) {
      out.push({
        id: 'drawdown-limit',
        level: 'alert',
        title: `组合已从高点回撤 ${pct(Math.abs(dd), 1)}%，触及你设定的底线`,
        detail: plan.ifLimitHit.trim()
          ? `你当初在冷静时写下的预案：「${plan.ifLimitHit.trim()}」。先照它来，不要现场重新决定。`
          : '你还没有写下「触及底线时我怎么做」。趁现在冷静，把答案写进计划里——不要等恐慌时再想。',
        why:
          `你把底线设为 ${pct(plan.maxLossPct)}%，当前回放回撤 ${pct(Math.abs(dd), 1)}%。` +
          `人在亏损的当下最容易做出后悔的决定，所以决定要在亏损之前写好（事前承诺）。`,
      });
    } else if (dd <= -plan.maxLossPct * 0.8) {
      out.push({
        id: 'drawdown-near',
        level: 'warn',
        title: `组合已从高点回撤 ${pct(Math.abs(dd), 1)}%，接近你的底线 ${pct(plan.maxLossPct)}%`,
        detail: '提前看一眼你写下的预案，确认到那一步你真的会照做。',
        why: `回撤已达到底线的 80%（${pct(plan.maxLossPct * 0.8, 1)}%）。`,
      });
    }
  }

  // ── 3. 配置偏离 ──
  const off = ctx.drift.filter((d) => d.status !== 'ok');
  if (off.length > 0) {
    const lines = off
      .slice(0, 4)
      .map((d) =>
        d.status === 'untargeted'
          ? `${d.asset} 占 ${pct(d.actualPct)}%，不在你的目标配置里`
          : `${d.asset} 占 ${pct(d.actualPct)}%，目标 ${pct(d.targetPct)}%（${d.driftPp > 0 ? '高' : '低'} ${pct(Math.abs(d.driftPp), 1)} 个百分点）`,
      )
      .join('；');
    out.push({
      id: 'rebalance',
      level: 'warn',
      title: `配置偏离了目标：${off.map((d) => d.asset).slice(0, 4).join('、')}`,
      detail: `${lines}。优先用下次定投的新资金补低配，不用卖出；补不过来再考虑卖出超配部分（卖出可能产生税费）。`,
      why:
        `你把再平衡容忍带设为 ±${pct(plan.rebalanceBandPct)} 个百分点，有资产偏离超过它就提醒。` +
        `在容忍带内不动，是因为为了小偏离去买卖，手续费和税往往比偏离本身更伤。`,
    });
  }

  // ── 4. 今天是定投日 ──
  if (isDcaDay(now, plan.dca)) {
    const split = splitContribution(plan.dca.amount, ctx.alloc, plan.targets)
      .map((s) => `${s.asset} ${usd(s.amount)}`)
      .join('、');
    out.push({
      id: 'dca-due',
      level: 'info',
      title: `今天是定投日：计划投入 ${usd(plan.dca.amount)} USDT`,
      detail: split
        ? `按你的目标配置，用这笔新资金优先补低配：${split}（USDT 部分留在稳定币里即可）。`
        : '各资产都已在目标附近，按目标比例分配即可。',
      why:
        `你设定了${describeDca(plan.dca)}。定投的意义是让「买入」变成与行情无关的习惯，` +
        `而不是每次都去判断今天该不该买——那正是最容易追涨杀跌的地方。`,
    });
  }

  // ── 5. 异常大波动日：冷静 24 小时 ──
  if (
    ctx.btc24hChangePct != null &&
    ctx.btcDailySigmaPct != null &&
    ctx.btcDailySigmaPct > 0 &&
    Math.abs(ctx.btc24hChangePct) >= 3 * ctx.btcDailySigmaPct
  ) {
    const k = Math.abs(ctx.btc24hChangePct) / ctx.btcDailySigmaPct;
    out.push({
      id: 'wild-day',
      level: 'info',
      title: `今天 BTC 的波动是平时的 ${k.toFixed(1)} 倍`,
      detail: '大波动日最容易做出后悔的决定。计划之外的买卖，先等 24 小时再说。',
      why:
        `近 30 天 BTC 日涨跌的标准差约 ${pct(ctx.btcDailySigmaPct, 2)}%，` +
        `最近 24 小时涨跌 ${ctx.btc24hChangePct >= 0 ? '+' : ''}${pct(ctx.btc24hChangePct, 2)}%，超过 3 倍标准差，属于少见的大波动。`,
    });
  }

  if (out.length === 0) {
    const next = nextDcaDate(now, plan.dca);
    const nextLine = next
      ? `下一次定投：${next.getMonth() + 1} 月 ${next.getDate()} 日（${daysUntil(next, now)} 天后）。`
      : '';
    out.push({
      id: 'all-clear',
      level: 'ok',
      title: '今天没有需要做的事',
      detail: `一切都在你的计划之内。${nextLine}`,
      why:
        '没有任何一条你设定的规则被触发。研究显示散户的买卖时机平均在拖累收益，' +
        '所以没有触发规则时，最好的动作通常就是不动。',
    });
  }

  return out.sort((a, b) => ORDER[a.level] - ORDER[b.level]);
}
