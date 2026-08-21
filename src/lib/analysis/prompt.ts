/**
 * 研判 prompt 构造。
 *
 * 设计原则：模型只做"解读"，不做"计算"。
 * 所有数字（指标值、涨跌幅、资金费率）都由确定性代码算好后填进来，
 * 模型的任务是把这些事实串成有逻辑的判断，并明确说出证据冲突和不确定性。
 * 这样既省 token，也避免模型算错数还说得头头是道。
 */

import type { TechnicalSnapshot } from '../indicators/summary';
import { computeResonance } from '../indicators/resonance';
import type { OnchainSnapshot } from '../datasources/onchain';
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
  /** 链上：稳定币供应（场内流动性）与 BTC 网络状态 */
  onchain: OnchainSnapshot | null;
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
   去解释一根 15 分钟 K 线。真正值得提高其权重的情形有三类：
   议息在即（此时波动率通常被压制、决议后放大）、政策口径刚发生变化、
   或临近 CPI / 非农这类会引发跨资产重定价的数据发布。
9. 鹰鸽分附有逐条依据（命中哪句话、加减多少分）。你可以不同意它，
   但要针对**具体某一条依据**说明分歧，不要凭印象重新感受一遍——
   那等于用一个不可复核的判断替换掉一个可复核的判断。
10. 净流动性反映市场上实际可用的钱，它与价格的关系是中长期的。
   用它解释日内波动几乎总是错的。

你的输出是分析，不是投资建议。不要写"建议买入/卖出"这类操作指令，
而是描述市场状态、可能的演化路径和各自的触发条件。`;

export function buildUserPrompt(input: AnalysisInput): string {
  const { symbol, baseAsset, ticker, technicals, derivatives, sentiment, news, macro, onchain } =
    input;
  const parts: string[] = [];

  parts.push(`# 分析标的：${symbol}（${baseAsset}）`);
  parts.push(`分析时间：${new Date().toISOString()}`);

  parts.push(`\n## 当前行情
现价：${fmt(ticker.last)} USDT
24h 涨跌：${ticker.changePercent.toFixed(2)}%
24h 高/低：${fmt(ticker.high24h)} / ${fmt(ticker.low24h)}
24h 成交额：${fmtCompact(ticker.quoteVolume24h)} USDT`);

  parts.push(`\n## 多周期技术面
说明：下面每个周期末尾的「规则引擎倾向」是各项指标的加权汇总，
**它的方向预测力经回测未跑赢「全猜震荡」基线**（2026-08 实测，22216 个观测）。
把它当作「当前技术面处于什么状态」的摘要来读，不要因为它指向某个方向就提高置信度。`);
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

  // 共振分由确定性代码算好再喂进来，而不是让模型自己去比对三个周期。
  // 模型可以照样给出自己的判断——两者分歧时，那个分歧本身就值得写进结论
  const resonance = computeResonance(technicals);
  if (resonance) {
    parts.push(`\n## 多周期共振（规则计算）
共振分：${resonance.score}（-100 全周期看空 ~ +100 全周期看多）
一致性：${resonance.agreement}%
判定：${resonance.summary}${resonance.divergence ? `\n背离：${resonance.divergence}` : ''}
  —— 这是各周期状态一致性的度量，**不是**预测。实测中只有「背离时更易走震荡」
     这一条有较弱的支持，方向类结论受行情区间影响很大。
     若你的判断与它相反，请在结论中明确指出分歧所在。`);
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
  parts.push(renderOnchain(onchain));

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
 * 三件事刻意由代码算好再喂进去，而不是让模型自己推：
 *
 *   1. **距下次议息几天**——模型对「今天是哪天」没有可靠概念，让它减日期几乎必错，
 *      而这个天数恰恰是宏观维度里最影响判断的数字。
 *   2. **净流动性**——需要三个不同频率、不同单位的序列相减，算错不会报错。
 *   3. **鹰鸽分及其证据**——基于官方原文的确定性打分。给模型的是「哪句话、加减多少分」，
 *      它可以不同意，但必须针对具体证据说，而不是凭印象重新感受一遍。
 */
function renderMacro(macro: AnalysisInput['macro']): string {
  if (!macro) return '\n## 宏观政策（美联储）\n无数据';

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

  if (macro.statement) {
    const a = macro.statement.analysis;
    lines.push(`\n### 最近一次 FOMC 声明的措辞分析（基于官方原文）
倾向：${zhStance(a.stance)}（${a.score > 0 ? '+' : ''}${a.score}，+100 极鹰 / -100 极鸽）
本次动作：${a.action === 'raise' ? '加息' : a.action === 'lower' ? '降息' : a.action === 'maintain' ? '维持不变' : '未识别'}${
      a.dissent
        ? `　投票分歧：${a.dissent.against} 票反对，主张${a.dissent.direction === 'hawkish' ? '更紧' : '更松'}`
        : '　无异议票'
    }
逐条依据：
${a.evidence
  .slice(0, 8)
  .map((e) => `  ${e.weight > 0 ? '+' : ''}${e.weight}　${e.phrase}${e.note ? `（${e.note}）` : ''}`)
  .join('\n')}
  —— 这是**词典打分**，不是对政策的预测。回测显示鹰派声明之后从未降息、
     鸽派之后从未加息（41 次会议），但样本稀少且政策周期高度自相关。
     若你对措辞的解读与它不同，请针对上面某一条具体依据说明。`);
  }

  if (macro.netLiquidity) {
    const n = macro.netLiquidity;
    lines.push(`\n### 流动性
净流动性：${n.value.toFixed(0)} 十亿美元${
      n.changePercent !== null
        ? `，近一月${n.changePercent >= 0 ? '增加' : '减少'} ${Math.abs(n.changePercent).toFixed(2)}%`
        : ''
    }
  = 美联储总资产 ${n.components.walcl.toFixed(0)} − 逆回购 ${n.components.reverseRepo.toFixed(0)} − 财政部账户 ${n.components.tga.toFixed(0)}
  —— 这度量的是市场上实际可用的钱，对加密比利率水平本身更直接。
     三项频率不同（周/日/周），观测日期未必对齐。`);
  }

  if (macro.series.length) {
    lines.push(
      '\n### 关键宏观数值\n' +
        macro.series
          .map((x) => {
            const delta = x.previous ? `（上期 ${x.previous.value.toFixed(2)}）` : '';
            return `- ${x.label}：${x.latest.value.toFixed(2)}${unitOf(x.unit)} ${delta} @${x.latest.date}`;
          })
          .join('\n'),
    );
  }

  if (macro.releases.length) {
    lines.push(
      '\n### 未来数据发布（这些时点前后行情性质与平时不同）\n' +
        macro.releases
          .slice(0, 5)
          .map((r) => `- ${r.date}（${r.daysAway} 天后）${r.name}`)
          .join('\n'),
    );
  }

  if (macro.news.length) {
    lines.push(
      '\n### 宏观资讯\n' +
        macro.news
          .slice(0, 8)
          .map((n) => `- [${new Date(n.publishedAt).toISOString().slice(0, 10)}] (${n.source}) ${n.title}`)
          .join('\n'),
    );
  }

  return lines.join('\n');
}

/**
 * 链上段落。
 *
 * 稳定币供应与美联储净流动性是一对：宏观水位与场内水位。
 * 两者背离时值得注意——比如宏观在收紧而稳定币仍在增发，
 * 说明有资金在逆着大环境进场。
 *
 * 明确标注「已回测、无预测力」：不这么说的话，模型很容易
 * 把「稳定币增发」当成看涨依据写进结论——那个说法流传很广但没通过检验。
 */
function renderOnchain(onchain: AnalysisInput['onchain']): string {
  if (!onchain || (!onchain.stablecoins && !onchain.btcNetwork)) {
    return '\n## 链上\n无数据';
  }

  const lines = ['\n## 链上'];
  const sc = onchain.stablecoins;
  if (sc) {
    lines.push(
      `稳定币总供应：${sc.totalBillions.toFixed(0)} 十亿美元（截至 ${sc.date}）` +
        (sc.change7d !== null ? `，近 7 天 ${sc.change7d >= 0 ? '+' : ''}${sc.change7d.toFixed(2)}%` : '') +
        (sc.change30d !== null ? `，近 30 天 ${sc.change30d >= 0 ? '+' : ''}${sc.change30d.toFixed(2)}%` : '') +
        `\n  —— 链上可随时买币的钱，与上面的美联储净流动性构成「场内 / 宏观」一对。` +
        `\n     **已回测：供应变化与后续 7/14/30 天涨跌没有可用关系**（6 种组合，` +
        `分组差异均小于 3pt）。可以用它描述水位，不要用它推方向。`,
    );
  }

  const n = onchain.btcNetwork;
  if (n) {
    lines.push(
      `BTC 网络：算力 ${n.hashrate.toFixed(0)} EH/s，待确认 ${n.mempoolTransactions} 笔，` +
        `建议费率 ${n.suggestedFeeSatPerByte} sat/vB，BTC 市占 ${n.dominance.toFixed(1)}%` +
        `\n  —— 拥堵与安全边际的描述，不构成方向依据。`,
    );
  }

  return lines.join('\n');
}

const zhStance = (s: string) => ({ hawkish: '偏鹰', dovish: '偏鸽', neutral: '中性' })[s] ?? s;
const unitOf = (u: string) => (u === 'percent' ? '%' : u === 'billionsUSD' ? ' 十亿美元' : '');

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
