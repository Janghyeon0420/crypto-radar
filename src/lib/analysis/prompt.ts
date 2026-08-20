/**
 * 研判 prompt 构造。
 *
 * 设计原则：模型只做"解读"，不做"计算"。
 * 所有数字（指标值、涨跌幅、资金费率）都由确定性代码算好后填进来，
 * 模型的任务是把这些事实串成有逻辑的判断，并明确说出证据冲突和不确定性。
 * 这样既省 token，也避免模型算错数还说得头头是道。
 */

import type { TechnicalSnapshot } from '../indicators/summary';
import type {
  DerivativesSnapshot,
  MacroSnapshot,
  NewsItem,
  SentimentSnapshot,
  Ticker,
} from '../datasources/types';

export interface AnalysisInput {
  symbol: string;
  baseAsset: string;
  ticker: Ticker;
  /** 多周期技术面。多周期共振是判断趋势强度的关键，单周期容易被噪音骗 */
  technicals: TechnicalSnapshot[];
  derivatives: DerivativesSnapshot | null;
  sentiment: SentimentSnapshot | null;
  news: NewsItem[];
  /**
   * 美联储政策环境。它解释的是"整个风险资产市场处在什么水温"，
   * 单币种的技术面解释不了这个。
   */
  macro: MacroSnapshot | null;
}

export const SYSTEM_PROMPT = `你是一位加密货币市场分析师，服务于一个个人使用的行情看板。

你的职责是把给定的**已经计算好的**市场数据，整合成结构化的走势研判。

必须遵守：
1. 只使用输入中给出的数据。不要编造价格、指标值或新闻。
2. 不要重新计算任何指标——数字已经算好了，直接引用。
3. 当不同维度的信号互相冲突时，明确指出冲突，并降低 confidence，不要强行给出方向。
4. 数据缺失时（比如没有衍生品数据或资讯），在 dataGaps 中如实列出，不要假装看到了。
5. confidence 要诚实。加密市场本质上难以预测，大部分时候 40-65 是合理区间；
   只有多周期、多维度高度共振时才给 75 以上；证据冲突时低于 40。
6. scenarios 的概率必须反映真实的不确定性，不要给出 90% 这种过度自信的数字。
7. factors 中的 note 必须引用具体数值（如"RSI 72.3 已入超买区"），不要只说"技术面偏强"。
8. 宏观（美联储）数据是**背景**，不是择时信号。除非临近议息或刚出决议/讲话，
   否则它对日内、数日尺度的权重应该很低。不要用"美联储维持利率不变"
   去解释一根 15 分钟 K 线。真正值得提高其权重的情形只有两类：
   议息在即（此时波动率通常被压制、决议后放大），或政策口径刚发生变化。

你的输出是分析，不是投资建议。不要写"建议买入/卖出"这类操作指令，
而是描述市场状态、可能的演化路径和各自的触发条件。`;

export function buildUserPrompt(input: AnalysisInput): string {
  const { symbol, baseAsset, ticker, technicals, derivatives, sentiment, news, macro } = input;
  const parts: string[] = [];

  parts.push(`# 分析标的：${symbol}（${baseAsset}）`);
  parts.push(`分析时间：${new Date().toISOString()}`);

  parts.push(`\n## 当前行情
现价：${fmt(ticker.last)} USDT
24h 涨跌：${ticker.changePercent.toFixed(2)}%
24h 高/低：${fmt(ticker.high24h)} / ${fmt(ticker.low24h)}
24h 成交额：${fmtCompact(ticker.quoteVolume24h)} USDT`);

  parts.push('\n## 多周期技术面');
  for (const t of technicals) {
    parts.push(`
### ${t.interval} 周期
- 均线：MA20 ${fmt(t.ma.ma20)} / MA50 ${fmt(t.ma.ma50)} / MA200 ${fmt(t.ma.ma200)}，排列=${zh(t.ma.alignment)}
- RSI(14)：${t.rsi14.toFixed(1)}（${t.rsiState}）
- MACD：柱=${t.macd.histogram.toFixed(4)}，交叉=${t.macd.cross}
- 布林带：上轨 ${fmt(t.bollinger.upper)} / 中轨 ${fmt(t.bollinger.middle)} / 下轨 ${fmt(t.bollinger.lower)}，%B=${t.bollinger.percentB.toFixed(2)}${t.bollinger.squeeze ? '，处于挤压状态' : ''}
- KDJ：K=${t.kdj.k.toFixed(1)} D=${t.kdj.d.toFixed(1)} J=${t.kdj.j.toFixed(1)}
- 波动率：ATR14=${fmt(t.volatility.atr14)}（占价格 ${t.volatility.atrPercent.toFixed(2)}%）
- 成交量：为 20 周期均量的 ${t.volume.ratio20.toFixed(2)} 倍
- 支撑：${t.levels.supports.map(fmt).join(' / ') || '未识别'}
- 阻力：${t.levels.resistances.map(fmt).join(' / ') || '未识别'}
- 规则引擎倾向：${zh(t.bias)}
- 依据：${t.reasons.join('；')}`);
  }

  if (derivatives) {
    const annualized = derivatives.fundingRate * 3 * 365 * 100;
    parts.push(`\n## 衍生品（${derivatives.source} 永续合约）
资金费率：${(derivatives.fundingRate * 100).toFixed(4)}%（年化约 ${annualized.toFixed(1)}%）
  —— 正值表示多头向空头付费，市场杠杆偏多；负值反之
未平仓量：${fmtCompact(derivatives.openInterest)} ${baseAsset}`);
  } else {
    parts.push('\n## 衍生品\n无数据（该标的无对应永续合约，或数据源不可用）');
  }

  if (sentiment) {
    parts.push(`\n## 市场情绪
恐惧贪婪指数：${sentiment.fearGreed} / 100（${sentiment.classification}）
  —— 该指数反映全市场情绪，非单一币种`);
  } else {
    parts.push('\n## 市场情绪\n无数据');
  }

  parts.push(renderMacro(macro));

  if (news.length) {
    parts.push('\n## 相关资讯（近期，按时间倒序）');
    // 只给标题和时间，正文摘要太占 token 且 RSS 摘要质量参差
    news.slice(0, 12).forEach((n) => {
      parts.push(`- [${new Date(n.publishedAt).toISOString().slice(0, 16)}] (${n.source}) ${n.title}`);
    });
  } else {
    parts.push('\n## 相关资讯\n未匹配到该币种的近期资讯');
  }

  parts.push(`\n---
请基于以上数据，输出对 ${symbol} 后续走势的结构化研判。
注意多周期之间是否共振或背离，这是判断趋势可靠性的关键。`);

  return parts.join('\n');
}

/**
 * 宏观段落。
 *
 * 刻意把"距下次议息还有几天"算好再喂进去，而不是给个日期让模型自己减——
 * 模型对"今天是哪天"没有可靠概念，让它算天数几乎必错，
 * 而这个天数恰恰是宏观维度里最影响判断的一个数字。
 */
function renderMacro(macro: AnalysisInput['macro']): string {
  if (!macro || (!macro.policyRate && !macro.nextMeeting && macro.news.length === 0)) {
    return '\n## 宏观政策（美联储）\n无数据';
  }

  const lines = ['\n## 宏观政策（美联储）'];

  if (macro.policyRate) {
    lines.push(
      `联邦基金目标区间：${macro.policyRate.targetLow.toFixed(2)}%-${macro.policyRate.targetHigh.toFixed(2)}%` +
        `（实际成交 EFFR ${macro.policyRate.effectiveRate.toFixed(2)}%，截至 ${macro.policyRate.effectiveDate}）`,
    );
  }

  if (macro.nextMeeting) {
    const days = (macro.nextMeeting.decisionAt - Date.now()) / 86400_000;
    lines.push(
      `下次 FOMC 决议：${macro.nextMeeting.label}，距今 ${days.toFixed(1)} 天` +
        (macro.nextMeeting.hasProjections ? '（同场发布经济预测与点阵图）' : ''),
    );
  }

  if (macro.news.length) {
    lines.push('美联储近期发布：');
    macro.news.slice(0, 6).forEach((n) => {
      lines.push(`- [${new Date(n.publishedAt).toISOString().slice(0, 10)}] (${n.source}) ${n.title}`);
    });
  }

  return lines.join('\n');
}

const zh = (b: string) => ({ bullish: '多头', bearish: '空头', neutral: '中性' })[b] ?? b;

function fmt(n: number): string {
  if (!Number.isFinite(n)) return 'N/A';
  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  return n.toPrecision(6);
}

function fmtCompact(n: number): string {
  if (!Number.isFinite(n)) return 'N/A';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(2);
}
