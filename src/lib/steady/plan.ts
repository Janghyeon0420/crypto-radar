/**
 * 计划相关的纯逻辑：估值、配置偏离、用新资金补低配、定投日程。
 *
 * 全部不取数：价格由调用方传进来。这样既能单测，也保证「界面上的数字」
 * 和「提示依据的数字」永远是同一份计算结果。
 */

import { isStable, type Dca, type Holding, type Target } from './schema';

export interface PricedHolding {
  asset: string;
  quantity: number;
  stable: boolean;
  /** 单价（USDT）。稳定币按 1 计；查不到行情的币为 null */
  price: number | null;
  value: number | null;
  avgCost?: number;
  /** 相对平均成本的盈亏 %。无成本或无行情时为 null；稳定币无意义，也为 null */
  pnlPct: number | null;
}

export function valueHoldings(
  holdings: Holding[],
  prices: Record<string, number | undefined>,
): PricedHolding[] {
  return holdings.map((h) => {
    const stable = isStable(h.asset);
    // 稳定币按 1 计是**假设**（脱锚时不成立），界面上会单独提示这一点
    const price = stable ? 1 : (prices[h.asset] ?? null);
    const value = price != null ? price * h.quantity : null;
    const pnlPct =
      !stable && price != null && h.avgCost && h.avgCost > 0 ? (price / h.avgCost - 1) * 100 : null;
    return { asset: h.asset, quantity: h.quantity, stable, price, value, avgCost: h.avgCost, pnlPct };
  });
}

export interface AllocationRow {
  asset: string;
  value: number;
  weightPct: number;
}

export interface Allocation {
  total: number;
  rows: AllocationRow[];
  /** 加密资产（非稳定币）占比 % */
  cryptoPct: number;
  stablePct: number;
  /** 查不到行情、没能计入总值的币——必须让用户看到，否则占比会悄悄失真 */
  unpriced: string[];
}

export function allocationOf(priced: PricedHolding[]): Allocation {
  const valued = priced.filter((p) => p.value != null && p.value > 0);
  const total = valued.reduce((s, p) => s + (p.value as number), 0);
  const rows = valued
    .map((p) => ({
      asset: p.asset,
      value: p.value as number,
      weightPct: total > 0 ? ((p.value as number) / total) * 100 : 0,
    }))
    .sort((a, b) => b.value - a.value);
  const stablePct = rows.filter((r) => isStable(r.asset)).reduce((s, r) => s + r.weightPct, 0);
  return {
    total,
    rows,
    cryptoPct: total > 0 ? 100 - stablePct : 0,
    stablePct,
    unpriced: priced.filter((p) => p.value == null).map((p) => p.asset),
  };
}

export type DriftStatus = 'ok' | 'over' | 'under' | 'untargeted';

export interface DriftRow {
  asset: string;
  actualPct: number;
  targetPct: number;
  /** 实际 - 目标，单位是百分点 */
  driftPp: number;
  status: DriftStatus;
}

/**
 * 配置偏离表。超出容忍带才算偏离——为了 0.5 个百分点去买卖，手续费和税比偏离本身更伤。
 * 持仓里有、目标里没有的币标为 untargeted：它不在你的计划里，但占着仓位。
 */
export function driftTable(rows: AllocationRow[], targets: Target[], bandPct: number): DriftRow[] {
  const actual = new Map(rows.map((r) => [r.asset, r.weightPct]));
  const want = new Map(targets.map((t) => [t.asset, t.weightPct]));
  const assets = [...new Set([...want.keys(), ...actual.keys()])];

  return assets
    .map((asset): DriftRow => {
      const a = actual.get(asset) ?? 0;
      const t = want.get(asset) ?? 0;
      const d = a - t;
      let status: DriftStatus = 'ok';
      if (!want.has(asset)) status = a > bandPct ? 'untargeted' : 'ok';
      else if (d > bandPct) status = 'over';
      else if (d < -bandPct) status = 'under';
      return { asset, actualPct: a, targetPct: t, driftPp: d, status };
    })
    .sort((x, y) => Math.abs(y.driftPp) - Math.abs(x.driftPp));
}

/**
 * 用新资金补低配，而不是卖出超配。
 *
 * 做法：先算「加上这笔钱之后，每个资产应有多少」，再把差额优先补给低配者。
 * 好处：不产生卖出的手续费与税，也不需要判断「该不该卖」。
 * 若所有资产都已达标（不需要补），按目标比例平均分配。
 */
export function splitContribution(
  amount: number,
  rows: AllocationRow[],
  targets: Target[],
): { asset: string; amount: number }[] {
  if (amount <= 0 || targets.length === 0) return [];
  const total = rows.reduce((s, r) => s + r.value, 0);
  const current = new Map(rows.map((r) => [r.asset, r.value]));
  const after = total + amount;

  const need = targets.map((t) => ({
    asset: t.asset,
    weight: t.weightPct / 100,
    gap: Math.max(0, (t.weightPct / 100) * after - (current.get(t.asset) ?? 0)),
  }));
  const gapSum = need.reduce((s, n) => s + n.gap, 0);

  const out = need.map((n) => {
    // 缺口总和超过这笔钱：按缺口比例缩放；缺口不足：补完缺口后，余额按目标比例分
    const share =
      gapSum >= amount
        ? gapSum > 0
          ? (n.gap / gapSum) * amount
          : 0
        : n.gap + (amount - gapSum) * n.weight;
    return { asset: n.asset, amount: share };
  });
  return out.filter((o) => o.amount > 0.005).sort((a, b) => b.amount - a.amount);
}

// ───────────── 定投日程 ─────────────

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/**
 * 下一个定投日（含今天）。amount 为 0 视为未启用，返回 null。
 * 使用本机时区的日期：提醒是给「这台电脑前的人」看的，按他的「今天」算才对。
 */
export function nextDcaDate(now: Date, dca: Dca): Date | null {
  if (dca.amount <= 0) return null;
  const today = startOfDay(now);

  if (dca.frequency === 'weekly') {
    const jsDay = dca.day % 7; // 我们的 7=周日，JS 的周日是 0
    const ahead = (jsDay - today.getDay() + 7) % 7;
    return new Date(today.getFullYear(), today.getMonth(), today.getDate() + ahead);
  }
  // monthly：本月的日子还没过（含今天）就是本月，否则下月
  const thisMonth = new Date(today.getFullYear(), today.getMonth(), dca.day);
  return thisMonth >= today ? thisMonth : new Date(today.getFullYear(), today.getMonth() + 1, dca.day);
}

export function isDcaDay(now: Date, dca: Dca): boolean {
  const next = nextDcaDate(now, dca);
  return next != null && next.getTime() === startOfDay(now).getTime();
}

export function daysUntil(date: Date, now: Date): number {
  return Math.round((startOfDay(date).getTime() - startOfDay(now).getTime()) / 86_400_000);
}

export const WEEKDAY_LABEL = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'] as const;

export function describeDca(dca: Dca): string {
  if (dca.amount <= 0) return '未启用';
  const when = dca.frequency === 'weekly' ? `每${WEEKDAY_LABEL[dca.day]}` : `每月 ${dca.day} 日`;
  return `${when}投入 ${dca.amount.toLocaleString('en-US')} USDT`;
}
