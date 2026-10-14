/**
 * 把「状态 + 行情」算成驾驶舱要展示的一切。服务端使用（取数）。
 *
 * 取数策略：行情与日线都是**可部分失败**的——币安镜像偶尔抖动（走代理时尤其），
 * 但风险体检不该因为一个币没取到就整体报错。取不到的部分记进 dataGaps，
 * 其余照算，让用户看到「哪些数字不能全信」，而不是一个空白页。
 */

import { withRetry } from '@/lib/analysis/errors';
import { fetchCandles, fetchTickers } from '@/lib/datasources/market';
import { fetchFearGreed } from '@/lib/datasources/sentiment';
import type { Candle } from '@/lib/datasources/types';
import { buildActions } from './actions';
import {
  allocationOf,
  driftTable,
  valueHoldings,
  type Allocation,
} from './plan';
import {
  BEAR_SHOCK,
  BUDGET_FRACTION,
  STRESS_SHOCKS,
  annualizedVolatility,
  beta as calcBeta,
  currentDrawdown,
  defaultBeta,
  describeEnvironment,
  maxCryptoShare,
  maxDrawdown,
  replayPortfolio,
  simpleReturns,
  sleeveLoss,
  stressLoss,
  worstWindowReturn,
  type StressAsset,
} from './risk';
import { isStable, type SteadyState } from './schema';
import type { BetaInfo, EnvironmentView, RiskReplay, SteadySummary } from './types';

const DAY = 86_400_000;
const dayKey = (t: number) => Math.floor(t / DAY);
const dayIso = (k: number) => new Date(k * DAY).toISOString().slice(0, 10);

/** 回放窗口短于这个天数，数字参考价值很低，要明说 */
const MIN_RELIABLE_DAYS = 90;
const BETA_WINDOW = 365;

type CloseMap = Map<number, number>;
const toCloseMap = (c: Candle[]): CloseMap => new Map(c.map((k) => [dayKey(k.time), k.close]));

/** 多条序列的共同日期（升序）。日期对齐是回放正确的前提——错位一天，相关性与回撤都会失真 */
function commonDays(maps: CloseMap[]): number[] {
  if (maps.length === 0) return [];
  return [...maps[0].keys()].filter((k) => maps.every((m) => m.has(k))).sort((a, b) => a - b);
}

const pickCloses = (m: CloseMap, days: number[]) => days.map((d) => m.get(d) as number);

export async function buildSummary(state: SteadyState, now = new Date()): Promise<SteadySummary> {
  const { plan, holdings } = state;
  const dataGaps: string[] = [];
  const base = {
    generatedAt: now.getTime(),
    updatedAt: state.updatedAt,
    plan,
    holdings,
  };

  const cryptoAssets = holdings.filter((h) => !isStable(h.asset)).map((h) => h.asset);
  const symbolOf = (a: string) => `${a}USDT`;
  // BTC 总要取：beta 的基准、市场环境、「今天是不是大波动日」都靠它
  const wanted = [...new Set(['BTC', ...cryptoAssets])];

  // ── 行情与日线（可部分失败）──
  const [tickersRes, ...candleRes] = await Promise.allSettled([
    withRetry(() => fetchTickers(wanted.map(symbolOf))),
    ...wanted.map((a) => withRetry(() => fetchCandles(symbolOf(a), '1d', 1000))),
  ]);

  const tickers = tickersRes.status === 'fulfilled' ? tickersRes.value : [];
  if (tickersRes.status === 'rejected') dataGaps.push('行情价格没取到，持仓市值可能不完整');
  const prices: Record<string, number> = {};
  for (const t of tickers) prices[t.symbol.replace(/USDT$/, '')] = t.last;
  const btcTicker = tickers.find((t) => t.symbol === 'BTCUSDT');

  const closeMaps = new Map<string, CloseMap>();
  wanted.forEach((asset, i) => {
    const r = candleRes[i];
    if (r.status === 'fulfilled' && r.value.length >= 30) closeMaps.set(asset, toCloseMap(r.value));
    else dataGaps.push(`${asset} 的日线历史没取到，相关风险指标按默认估计值计算`);
  });

  // ── 估值与配置 ──
  const priced = valueHoldings(holdings, prices);
  const alloc: Allocation = allocationOf(priced);
  if (alloc.unpriced.length) {
    dataGaps.push(`查不到 ${alloc.unpriced.join('、')} 的行情，未计入总值与占比`);
  }
  const hasValue = alloc.total > 0;

  const portfolio = holdings.length
    ? {
        total: alloc.total,
        rows: priced,
        cryptoPct: alloc.cryptoPct,
        stablePct: alloc.stablePct,
        unpriced: alloc.unpriced,
      }
    : null;

  const drift = plan && hasValue ? driftTable(alloc.rows, plan.targets, plan.rebalanceBandPct) : [];

  // ── beta：每个币相对 BTC，用最近一年的共同日期实测；历史不足则退回默认值并标注 ──
  const btcMap = closeMaps.get('BTC');
  const betaOf = (asset: string): BetaInfo => {
    if (isStable(asset)) return { asset, beta: 0, estimated: false };
    if (asset === 'BTC') return { asset, beta: 1, estimated: !btcMap };
    const m = closeMaps.get(asset);
    if (m && btcMap) {
      const days = commonDays([m, btcMap]).slice(-BETA_WINDOW - 1);
      const b = calcBeta(
        simpleReturns(pickCloses(m, days)),
        simpleReturns(pickCloses(btcMap, days)),
      );
      // 夹在 [0.3, 2.5]：极端值多半来自样本太短，而不是资产真的那样
      if (b != null) return { asset, beta: Math.min(2.5, Math.max(0.3, b)), estimated: false };
    }
    return { asset, beta: defaultBeta(asset), estimated: true };
  };

  const involved = new Set([...alloc.rows.map((r) => r.asset), ...(plan?.targets.map((t) => t.asset) ?? [])]);
  const betas = [...involved].filter((a) => !isStable(a)).map(betaOf);
  const betaMap = new Map(betas.map((b) => [b.asset, b.beta]));
  const stressItems: StressAsset[] = alloc.rows.map((r) => ({
    asset: r.asset,
    weight: r.weightPct / 100,
    beta: betaMap.get(r.asset) ?? 0,
  }));

  // ── 情景压力 ──
  const stress = hasValue
    ? STRESS_SHOCKS.map((shock) => {
        const loss = -stressLoss(stressItems, shock);
        return {
          shockPct: shock * 100,
          lossPct: loss * 100,
          lossValue: loss * alloc.total,
          isBear: shock === BEAR_SHOCK,
        };
      })
    : [];
  const bear = stress.find((s) => s.isBear) ?? null;

  // ── 风险预算：按用户自己的底线，反推加密资产最多占多少 ──
  let budget: SteadySummary['budget'] = null;
  if (plan && hasValue) {
    const sleeve = sleeveLoss(stressItems, BEAR_SHOCK);
    const planItems: StressAsset[] = plan.targets.map((t) => ({
      asset: t.asset,
      weight: t.weightPct / 100,
      beta: betaMap.get(t.asset) ?? defaultBeta(t.asset),
    }));
    budget = {
      maxCryptoSharePct:
        sleeve != null ? maxCryptoShare((plan.maxLossPct / 100) * BUDGET_FRACTION, sleeve) * 100 : null,
      currentCryptoSharePct: alloc.cryptoPct,
      planCryptoSharePct: plan.targets.filter((t) => !isStable(t.asset)).reduce((s, t) => s + t.weightPct, 0),
      planTailLossPct: -stressLoss(planItems, BEAR_SHOCK) * 100,
    };
  }

  // ── 历史回放：按当前比例，在持仓里各币的共同历史上重放 ──
  let replay: RiskReplay | null = null;
  const replayAssets = alloc.rows.filter((r) => !isStable(r.asset) && closeMaps.has(r.asset));
  if (hasValue && replayAssets.length > 0) {
    const maps = replayAssets.map((r) => closeMaps.get(r.asset) as CloseMap);
    const days = commonDays(maps);
    if (days.length >= 31) {
      const retsByAsset = new Map(
        replayAssets.map((r, i) => [r.asset, simpleReturns(pickCloses(maps[i], days))]),
      );
      const n = days.length - 1;
      const weights = alloc.rows.map((r) => r.weightPct / 100);
      const returns = alloc.rows.map((r) => retsByAsset.get(r.asset) ?? new Array(n).fill(0));
      const series = replayPortfolio(weights, returns);
      const dd = maxDrawdown(series);
      const vol = annualizedVolatility(simpleReturns(series));
      const worst30 = worstWindowReturn(series, 30);

      // 窗口被谁限制：找出各币自己历史长度里最短的那个（与全体最长的相比明显更短时才报告）
      const lens = replayAssets.map((r) => ({ asset: r.asset, len: (closeMaps.get(r.asset) as CloseMap).size }));
      const shortest = lens.reduce((a, b) => (b.len < a.len ? b : a));
      const longest = lens.reduce((a, b) => (b.len > a.len ? b : a));

      replay = {
        windowDays: n,
        limitedBy: shortest.len < longest.len ? shortest.asset : null,
        maxDrawdownPct: -dd.depth * 100,
        maxDrawdownFrom: dayIso(days[dd.peakIndex]),
        maxDrawdownTo: dayIso(days[Math.min(dd.troughIndex, days.length - 1)]),
        currentDrawdownPct: -currentDrawdown(series) * 100,
        worst30dPct: worst30 != null ? -worst30 * 100 : null,
        annualVolPct: vol != null ? vol * 100 : null,
      };
      if (n < MIN_RELIABLE_DAYS) {
        dataGaps.push(`历史回放只有 ${n} 天，样本太短，回撤与波动的参考价值很低`);
      }
    } else {
      dataGaps.push('持仓各币的共同历史不足 30 天，无法做历史回放');
    }
  }

  // ── 市场环境（只描述）──
  let environment: EnvironmentView | null = null;
  if (btcMap) {
    const closes = [...btcMap.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
    const env = describeEnvironment(closes);
    if (env) {
      const fg = await withRetry(() => fetchFearGreed(), { attempts: 1 }).catch(() => null);
      environment = {
        ...env,
        fearGreed: fg?.fearGreed ?? null,
        fearGreedLabel: fg?.classification ?? null,
        btc24hChangePct: btcTicker?.changePercent ?? null,
      };
    }
  }

  // ── 今日行动 ──
  const actions = buildActions({
    now,
    plan,
    hasHoldings: holdings.length > 0,
    total: alloc.total,
    alloc: alloc.rows,
    drift,
    tail: bear ? { lossPct: bear.lossPct, lossValue: bear.lossValue, shockPct: bear.shockPct } : null,
    budget:
      budget && budget.maxCryptoSharePct != null
        ? {
            maxCryptoSharePct: budget.maxCryptoSharePct,
            currentCryptoSharePct: budget.currentCryptoSharePct,
          }
        : null,
    currentDrawdownPct: replay ? -replay.currentDrawdownPct : null,
    btc24hChangePct: environment?.btc24hChangePct ?? null,
    btcDailySigmaPct: environment?.dailySigmaPct ?? null,
  });

  return {
    ...base,
    portfolio,
    drift,
    replay,
    stress,
    betas,
    budget,
    environment,
    actions,
    dataGaps,
  };
}
