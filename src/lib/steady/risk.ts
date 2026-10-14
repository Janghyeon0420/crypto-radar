/**
 * 组合风险计算。全部是纯函数：不取数、不读文件，客户端与服务端共用。
 *
 * 这里刻意**不预测任何价格**。回测已经说明方向预测在这个项目里没有稳定优势
 * （docs/ROADMAP.md 第 6、7、11 项），而风险——能亏多少、会跌多深——
 * 是可以从历史与算术里诚实地算出来的，且正是「稳健」这个目标真正需要的东西。
 *
 * 两类数字要分清，界面上也分开标注：
 *   - **历史回放**：按当前比例在已有历史上重放，是事实（但样本只有这一段历史）；
 *   - **情景压力**：假设 BTC 跌 X%，各资产按 beta 联动，是假设（不是预测）。
 * 币安日线只能回溯约 2.7 年，覆盖不到真正的熊市（BTC 历轮熊市约 -75%~-85%），
 * 所以必须有「历史样本之外」的压力情景，只看回放会系统性低估风险。
 */

import type { Target } from './schema';
import { isStable } from './schema';

// ───────────── 基础统计 ─────────────

export function simpleReturns(values: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    out.push(prev > 0 ? values[i] / prev - 1 : 0);
  }
  return out;
}

export interface Drawdown {
  /** 峰谷跌幅，≤ 0 的小数（-0.5 = 从最高点跌了一半） */
  depth: number;
  peakIndex: number;
  troughIndex: number;
}

/** 区间内最大回撤：任意「先到过的高点」到其后「最低点」的最大跌幅 */
export function maxDrawdown(values: number[]): Drawdown {
  let peak = values[0] ?? 0;
  let peakIdx = 0;
  let best: Drawdown = { depth: 0, peakIndex: 0, troughIndex: 0 };
  for (let i = 0; i < values.length; i++) {
    if (values[i] > peak) {
      peak = values[i];
      peakIdx = i;
    }
    const dd = peak > 0 ? values[i] / peak - 1 : 0;
    if (dd < best.depth) best = { depth: dd, peakIndex: peakIdx, troughIndex: i };
  }
  return best;
}

/** 当前距「最近 lookback 个点内最高点」的回撤（≤ 0）。不传 lookback 则用全部 */
export function currentDrawdown(values: number[], lookback?: number): number {
  if (values.length === 0) return 0;
  const win = lookback ? values.slice(-lookback) : values;
  const peak = Math.max(...win);
  const last = values[values.length - 1];
  return peak > 0 ? last / peak - 1 : 0;
}

/** 年化波动率（小数）。加密货币全年无休，按 365 个周期折算 */
export function annualizedVolatility(returns: number[], periodsPerYear = 365): number | null {
  if (returns.length < 2) return null;
  const mean = returns.reduce((s, x) => s + x, 0) / returns.length;
  const variance = returns.reduce((s, x) => s + (x - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(periodsPerYear);
}

/** 日收益标准差（小数）。用来衡量「今天这个波动算不算异常」 */
export function dailySigma(returns: number[]): number | null {
  const v = annualizedVolatility(returns, 1);
  return v;
}

/** 资产相对市场（BTC）的 beta = cov(资产, 市场) / var(市场)。样本不足 30 个点不给数 */
export function beta(asset: number[], market: number[]): number | null {
  const n = Math.min(asset.length, market.length);
  if (n < 30) return null;
  const a = asset.slice(-n);
  const m = market.slice(-n);
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mm = m.reduce((s, x) => s + x, 0) / n;
  let cov = 0;
  let varM = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i] - ma) * (m[i] - mm);
    varM += (m[i] - mm) ** 2;
  }
  return varM > 0 ? cov / varM : null;
}

/** 任意 window 个周期内「最差的那一段」的涨跌幅。样本不足返回 null */
export function worstWindowReturn(values: number[], window: number): number | null {
  if (window < 1 || values.length <= window) return null;
  let worst = Infinity;
  for (let i = 0; i + window < values.length; i++) {
    if (values[i] > 0) worst = Math.min(worst, values[i + window] / values[i] - 1);
  }
  return Number.isFinite(worst) ? worst : null;
}

/** 分位数（线性插值），p ∈ [0,1] */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((x, y) => x - y);
  const idx = Math.min(Math.max(p, 0), 1) * (s.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

/** x 在 values 里处于什么位置（0-100）：有多大比例的历史值不高于它 */
export function percentRank(values: number[], x: number): number | null {
  if (values.length === 0) return null;
  return (values.filter((v) => v <= x).length / values.length) * 100;
}

/**
 * 按固定权重回放组合净值（起点 1）。**每日再平衡**回到目标权重，
 * 忽略手续费与滑点——这是风险分析里的标准简化，不是真实收益。
 * returns[i] 是第 i 个资产的逐日收益，各资产长度必须一致、日期已对齐。
 */
export function replayPortfolio(weights: number[], returns: number[][]): number[] {
  const n = returns[0]?.length ?? 0;
  const out = [1];
  for (let t = 0; t < n; t++) {
    let r = 0;
    for (let i = 0; i < weights.length; i++) r += weights[i] * (returns[i]?.[t] ?? 0);
    out.push(out[out.length - 1] * (1 + r));
  }
  return out;
}

// ───────────── 情景压力 ─────────────

export interface StressAsset {
  asset: string;
  /** 占整个组合的权重（0-1），含稳定币 */
  weight: number;
  /** 相对 BTC 的 beta。稳定币为 0 */
  beta: number;
}

/**
 * 压力情景：BTC 下跌幅度。
 * 回调 -30% 在每年都会发生；深度回调 -50% 几乎每轮周期都有；
 * 熊市基准 -75% 对应 BTC 历轮熊市的量级（约 -75%~-85%，iShares 等机构资料称
 * 其三次最大回撤平均约 -80%）。**这是历史量级的参考，不是对未来的预测。**
 */
export const STRESS_SHOCKS = [-0.3, -0.5, -0.75] as const;
export const BEAR_SHOCK = -0.75;

/** 默认 beta：只用于还没有真实历史可算时的预览（建计划阶段），界面会标注「估计」 */
export function defaultBeta(asset: string): number {
  if (isStable(asset)) return 0;
  if (asset === 'BTC') return 1;
  if (asset === 'ETH') return 1.2;
  return 1.5;
}

/** 单个资产在 BTC 下跌 shock 时的跌幅。-95% 封底：币价不会为负，且「归零」是另一类风险 */
export function assetShockReturn(assetBeta: number, shock: number): number {
  return Math.max(-0.95, assetBeta * shock);
}

/** 整个组合在 BTC 下跌 shock 时的损失（≤ 0，占组合总值的小数） */
export function stressLoss(items: StressAsset[], shock: number): number {
  return items.reduce((s, it) => s + it.weight * assetShockReturn(it.beta, shock), 0);
}

/**
 * 只看加密部分（把稳定币剔掉、权重重新归一到 100%）的损失。
 * 用来回答：「每 1 块钱放进这批币里，在熊市基准下会亏多少？」
 */
export function sleeveLoss(items: StressAsset[], shock: number): number | null {
  const crypto = items.filter((i) => !isStable(i.asset));
  const total = crypto.reduce((s, i) => s + i.weight, 0);
  if (total <= 0) return null;
  return crypto.reduce((s, i) => s + (i.weight / total) * assetShockReturn(i.beta, shock), 0);
}

/**
 * 在「熊市基准下最大亏损不超过 maxLoss」的前提下，加密资产最多能占组合的多少。
 * 返回 0-1。这是用户自己设定的底线的**算术推论**，不是推荐。
 * 调用方应传入「底线 × BUDGET_FRACTION」，把安全垫算进去。
 */
export function maxCryptoShare(maxLossFraction: number, sleeveLossFraction: number): number {
  const l = Math.abs(sleeveLossFraction);
  if (l <= 0) return 1;
  return Math.min(1, maxLossFraction / l);
}

// ───────────── 由底线反推配置 ─────────────

/**
 * 安全垫：反推配置时，把熊市基准下的亏损控制在底线的 80% 以内，而不是正好踩线。
 * 原因是「熊市基准」本身只是个假设——下一次可能比 -75% 更深，ETH 等币的 beta 也可能比估计更高。
 * 正好踩线的配置，一旦现实略差于假设就破线；留 20% 余量，才叫「底线」而不是「目标」。
 * 它也与「接近底线」的提醒阈值（80%）一致：按反推配置持有，不会一上来就被提醒。
 */
export const BUDGET_FRACTION = 0.8;

/** 三个预设档位只是「底线」的三个常见取值，配置由底线反推，不是拍脑袋给的 */
export const PROFILE_PRESETS = {
  conservative: { label: '保守', maxLossPct: 15, hint: '亏超过一成半就会睡不着' },
  balanced: { label: '稳健', maxLossPct: 25, hint: '能承受四分之一的暂时亏损' },
  growth: { label: '积极', maxLossPct: 40, hint: '愿意为长期增长承受较深的回撤' },
} as const;

/** 加密部分内部的 BTC:ETH 默认比例。新手只配两个大盘币，山寨币要用户自己加 */
const BTC_SHARE_OF_CRYPTO = 0.8;

/**
 * 由底线反推目标配置：先算「熊市基准下每 1 块加密资产亏多少」，
 * 再用「底线 × 安全垫」得出加密部分最多占多少，向下取整到 5% 的档位
 * （宁可少配，不超预算），其余放稳定币。
 */
export function deriveTargets(maxLossPct: number): Target[] {
  const mix: StressAsset[] = [
    { asset: 'BTC', weight: BTC_SHARE_OF_CRYPTO, beta: defaultBeta('BTC') },
    { asset: 'ETH', weight: 1 - BTC_SHARE_OF_CRYPTO, beta: defaultBeta('ETH') },
  ];
  const l = sleeveLoss(mix, BEAR_SHOCK) ?? 1;
  const share = maxCryptoShare((maxLossPct / 100) * BUDGET_FRACTION, l);
  const crypto = Math.floor((share * 100) / 5 + 1e-9) * 5;
  const btc = Math.round(crypto * BTC_SHARE_OF_CRYPTO);
  const eth = crypto - btc;
  return [
    { asset: 'BTC', weightPct: btc },
    { asset: 'ETH', weightPct: eth },
    { asset: 'USDT', weightPct: 100 - crypto },
  ].filter((t) => t.weightPct > 0);
}

// ───────────── 市场环境（只描述，不预测） ─────────────

export interface Environment {
  last: number;
  /** 距最近一年最高收盘的回撤（≤ 0，%） */
  drawdownFromHighPct: number;
  /** 收盘价高于 200 日均线多少 %（负数 = 在均线下方）。不足 200 根时为 null */
  distFromSma200Pct: number | null;
  /** 近 30 日年化波动率（%） */
  vol30Pct: number | null;
  /** 当前波动率在自身历史里处于什么位置（0-100）。越高越「躁动」 */
  volPercentile: number | null;
  /** 日收益标准差（%），用来衡量某一天的波动算不算异常 */
  dailySigmaPct: number | null;
}

export function describeEnvironment(closes: number[]): Environment | null {
  if (closes.length < 40) return null;
  const last = closes[closes.length - 1];
  const rets = simpleReturns(closes);

  const dd = currentDrawdown(closes, 365);
  const sma200 =
    closes.length >= 200 ? closes.slice(-200).reduce((s, x) => s + x, 0) / 200 : null;

  const vol30 = annualizedVolatility(rets.slice(-30));
  // 滚动 30 日波动率序列，看「现在」在自身历史里处于什么位置
  const rolling: number[] = [];
  for (let i = 30; i <= rets.length; i++) {
    const v = annualizedVolatility(rets.slice(i - 30, i));
    if (v != null) rolling.push(v);
  }
  const sigma = dailySigma(rets.slice(-30));

  return {
    last,
    drawdownFromHighPct: dd * 100,
    distFromSma200Pct: sma200 ? (last / sma200 - 1) * 100 : null,
    vol30Pct: vol30 != null ? vol30 * 100 : null,
    volPercentile: vol30 != null ? percentRank(rolling, vol30) : null,
    dailySigmaPct: sigma != null ? sigma * 100 : null,
  };
}
