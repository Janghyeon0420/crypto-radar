/**
 * 驾驶舱接口返回的结构。单独成文件而不放在 summary.ts：
 * 客户端组件要引用这些类型，而 summary.ts 依赖服务端的数据源模块，不该被拉进浏览器包。
 */

import type { Action } from './actions';
import type { DriftRow, PricedHolding } from './plan';
import type { Environment } from './risk';
import type { Holding, Plan } from './schema';

/** 历史回放：按**当前比例**在已有历史上重放得到的风险指标（事实，但样本有限） */
export interface RiskReplay {
  /** 回放覆盖的天数。币安日线最多约 1000 天，OKX 币种只有 300 天 */
  windowDays: number;
  /** 哪个资产的历史最短、限制了窗口。没有限制时为 null */
  limitedBy: string | null;
  /** 以下三个「Pct」均为正数，表示跌幅（35.2 = 跌了 35.2%） */
  maxDrawdownPct: number;
  maxDrawdownFrom: string;
  maxDrawdownTo: string;
  currentDrawdownPct: number;
  worst30dPct: number | null;
  annualVolPct: number | null;
}

/** 情景压力：假设 BTC 跌 shockPct，各资产按 beta 联动后，整个组合的损失 */
export interface StressRow {
  /** 例如 -75 */
  shockPct: number;
  /** 正数，组合损失 % */
  lossPct: number;
  lossValue: number;
  /** 是否为用来对照底线的「熊市基准」情景 */
  isBear: boolean;
}

export interface BetaInfo {
  asset: string;
  beta: number;
  /** true = 历史不足，用的是默认估计值而不是实测 */
  estimated: boolean;
}

export interface RiskBudget {
  /** 按底线与熊市基准反推：加密资产最多占组合的 %。当前持仓没有加密资产时为 null */
  maxCryptoSharePct: number | null;
  currentCryptoSharePct: number;
  /** 你的**目标配置**里加密资产占的 % */
  planCryptoSharePct: number;
  /** 你的目标配置在熊市基准下的损失 %（正数）。用来检查「计划本身是否自洽」 */
  planTailLossPct: number;
}

export interface EnvironmentView extends Environment {
  fearGreed: number | null;
  fearGreedLabel: string | null;
  btc24hChangePct: number | null;
}

export interface SteadySummary {
  generatedAt: number;
  updatedAt: number;
  plan: Plan | null;
  holdings: Holding[];
  portfolio: {
    total: number;
    rows: PricedHolding[];
    cryptoPct: number;
    stablePct: number;
    unpriced: string[];
  } | null;
  drift: DriftRow[];
  replay: RiskReplay | null;
  stress: StressRow[];
  betas: BetaInfo[];
  budget: RiskBudget | null;
  environment: EnvironmentView | null;
  actions: Action[];
  /** 没取到或不可靠的数据。让用户知道哪些数字不能全信 */
  dataGaps: string[];
}
