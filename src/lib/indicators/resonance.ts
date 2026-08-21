/**
 * 多周期共振评分。
 *
 * 在此之前，多周期数据是直接丢给 LLM 让它自己判断是否共振的。
 * 用规则先算一个确定性的分数有两个好处：不花钱、不延迟就能看到；
 * 以及当模型说「多周期共振」而规则说「明显背离」时，
 * **分歧本身就是值得注意的信号**——至少说明这个判断不稳固。
 *
 * 定位说明（这一点是被规则引擎的回测教训出来的）：
 * 这里算的是「各周期的技术面状态有多一致」，**不是**「一致就会涨」。
 * 一致性高只意味着当前证据不矛盾，不意味着预测力更强。
 * 见 summary.ts 中 SIGNAL_WEIGHTS 的实测记录。
 */

import type { Interval } from '../datasources/types';
import type { TechnicalSnapshot } from './summary';

/**
 * 各周期的权重。
 *
 * 按周期长度递增：日线的状态比 1 分钟线更能代表「当前处于什么趋势里」，
 * 短周期的噪音比例高得多。用 2 的幂而不是实际分钟数——
 * 实际分钟数（1 分钟 vs 1 周 = 1:10080）会让短周期彻底失声，
 * 那还不如不看它们。
 */
const INTERVAL_WEIGHT: Record<Interval, number> = {
  '1m': 1,
  '5m': 1.5,
  '15m': 2,
  '1h': 3,
  '4h': 4,
  '1d': 6,
  '1w': 8,
};

export interface Resonance {
  /**
   * 共振分，-100（各周期一致看空）到 +100（一致看多）。
   * 0 附近意味着各周期互相抵消，而不是「中性」。
   */
  score: number;
  /** 一致性 0-100：不看方向，只看各周期是否指向同一边 */
  agreement: number;
  /** 综合方向。仅在一致性足够时才给方向，否则为 conflicted */
  verdict: 'bullish' | 'bearish' | 'mixed' | 'conflicted';
  /** 一句话描述，直接可显示 */
  summary: string;
  /** 长短周期背离的具体描述，没有则为空 */
  divergence: string | null;
  perInterval: { interval: Interval; bias: string; weight: number }[];
}

const dirValue = (bias: string) => (bias === 'bullish' ? 1 : bias === 'bearish' ? -1 : 0);

/** 周期从短到长排序，用于识别长短背离 */
const ORDER: Interval[] = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'];

export function computeResonance(snapshots: TechnicalSnapshot[]): Resonance | null {
  if (snapshots.length === 0) return null;

  const sorted = [...snapshots].sort(
    (a, b) => ORDER.indexOf(a.interval) - ORDER.indexOf(b.interval),
  );

  const totalWeight = sorted.reduce((sum, s) => sum + INTERVAL_WEIGHT[s.interval], 0);
  const weighted = sorted.reduce(
    (sum, s) => sum + dirValue(s.bias) * INTERVAL_WEIGHT[s.interval],
    0,
  );
  const score = Math.round((weighted / totalWeight) * 100);

  // 一致性只看「有表态的周期里有多少指向同一边」。
  // 把 neutral 计入分母会让「全部周期都中性」显示成低一致性，
  // 但那其实是一种高度一致的状态——只是一致地没方向
  const directional = sorted.filter((s) => s.bias !== 'neutral');
  const bullish = directional.filter((s) => s.bias === 'bullish').length;
  const bearish = directional.length - bullish;
  const agreement = directional.length
    ? Math.round((Math.max(bullish, bearish) / directional.length) * 100)
    : 100;

  const divergence = findDivergence(sorted);

  let verdict: Resonance['verdict'];
  if (directional.length === 0) {
    verdict = 'mixed';
  } else if (divergence) {
    verdict = 'conflicted';
  } else if (agreement >= 67 && Math.abs(score) >= 30) {
    verdict = score > 0 ? 'bullish' : 'bearish';
  } else {
    verdict = 'mixed';
  }

  return {
    score,
    agreement,
    verdict,
    summary: describe(verdict, score, agreement, directional.length, sorted.length, divergence),
    divergence,
    perInterval: sorted.map((s) => ({
      interval: s.interval,
      bias: s.bias,
      weight: INTERVAL_WEIGHT[s.interval],
    })),
  };
}

/**
 * 长短周期背离。
 *
 * 只认「最长周期与最短周期方向相反」这一种，不做更复杂的模式匹配——
 * 中间周期的来回摇摆在真实行情里很常见，把它们都算成背离
 * 会让这个提示天天出现，然后就没人看了。
 */
function findDivergence(sorted: TechnicalSnapshot[]): string | null {
  if (sorted.length < 2) return null;
  const shortest = sorted[0];
  const longest = sorted[sorted.length - 1];
  if (shortest.bias === 'neutral' || longest.bias === 'neutral') return null;
  if (shortest.bias === longest.bias) return null;

  const zh = (b: string) => (b === 'bullish' ? '偏多' : '偏空');
  return `${shortest.interval} ${zh(shortest.bias)} 而 ${longest.interval} ${zh(longest.bias)}，短期与主趋势相反`;
}

/**
 * @param directional 有明确方向的周期数
 * @param total 参与计算的周期总数
 *
 * 两个数都要出现在文案里。只说「3 个周期偏多」而其中一个其实是中性，
 * 是在陈述一件不成立的事——用户看到的每个数字都该经得起对照。
 */
function describe(
  verdict: Resonance['verdict'],
  score: number,
  agreement: number,
  directional: number,
  total: number,
  divergence: string | null,
): string {
  const rest = total - directional > 0 ? `，另 ${total - directional} 个中性` : '';
  switch (verdict) {
    case 'bullish':
      return `${directional}/${total} 个周期偏多${rest}，方向无冲突（一致性 ${agreement}%）`;
    case 'bearish':
      return `${directional}/${total} 个周期偏空${rest}，方向无冲突（一致性 ${agreement}%）`;
    case 'conflicted':
      return divergence ?? '各周期方向冲突';
    default:
      return Math.abs(score) < 15
        ? '各周期方向互相抵消，没有形成合力'
        : `方向偏${score > 0 ? '多' : '空'}但共振不足（一致性 ${agreement}%）`;
  }
}
