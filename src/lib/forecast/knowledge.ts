import type { Interval } from '../datasources/types';

/** Reviewed source snapshot. Update this version when rules or source summaries change. */
export const knowledgeVersion = 'technical-knowledge-2026-10-12-v1';

export interface KnowledgeSource {
  title: string;
  publisher: string;
  url: string;
  retrievedAt: string;
  kind: 'official-documentation' | 'original-author' | 'original-research';
}

export interface TechnicalKnowledgeEntry {
  id: string;
  title: string;
  category: 'trend' | 'momentum' | 'volatility' | 'volume' | 'pattern' | 'timeframe' | 'evaluation';
  summary: string;
  signals: string[];
  timeframes: Interval[];
  timeframeNotes: string;
  limitations: string[];
  /** Product interpretations, not claims made or validated by the cited source. */
  implementationNotes: string[];
  sources: KnowledgeSource[];
}

const allTimeframes: Interval[] = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'];
const retrievedAt = '2026-10-12';
const source = (title: string, publisher: string, url: string, kind: KnowledgeSource['kind'] = 'official-documentation'): KnowledgeSource =>
  ({ title, publisher, url, kind, retrievedAt });

/** Curated, attributable rules. This is a source snapshot, not a live web/news feed. */
export const knowledgeEntries: TechnicalKnowledgeEntry[] = [
  {
    id: 'trend-moving-averages', title: 'SMA / EMA 趋势与滞后', category: 'trend',
    summary: '均线平滑历史价格；EMA 更重视近期变化。均线是趋势描述和确认工具，不能单独证明未来方向。',
    signals: ['比较快慢均线位置与斜率。', '交叉需结合行情是否处于趋势或震荡状态。'],
    timeframes: [...allTimeframes], timeframeNotes: '周期数指当前图表的 K 线根数；日线参数不能被理解为分钟图上的同等时间跨度。',
    limitations: ['均线具有滞后性，震荡中的交叉可能反复失效。', 'EMA 与 MACD 来源相关，不应当作独立证据累加置信度。'],
    implementationNotes: ['按 interval 选择快慢周期；用当前周期 ATR 归一化均线差。', '当前周期参数为产品假设，尚未证明优于其他参数。'],
    sources: [source('Moving Averages', 'TradingView', 'https://www.tradingview.com/support/solutions/43000502589-moving-averages/')],
  },
  {
    id: 'momentum-macd', title: 'MACD 动量及衰减', category: 'momentum',
    summary: 'MACD 衡量快慢均线差，信号线及柱值描述动量变化；柱值收缩不等于价格已经反转。',
    signals: ['观察 MACD、信号线相对位置及柱值正负。', '背离可提示动量减弱，需要价格确认。'],
    timeframes: [...allTimeframes], timeframeNotes: '每个周期独立计算；12 / 26 / 9 是默认长度，不代表所有币种和周期上的最优设置。',
    limitations: ['价格继续创新高时动量也可能减弱。', 'MACD 绝对值不可直接跨币价或周期比较。'],
    implementationNotes: ['用当前周期 ATR 缩放柱值并限制贡献，避免和均线信号重复主导。'],
    sources: [source('Moving average convergence divergence (MACD)', 'TradingView', 'https://www.tradingview.com/support/solutions/43000502344-moving-average-convergence-divergence-macd-indicator/')],
  },
  {
    id: 'momentum-rsi-regime', title: 'RSI 结合趋势状态', category: 'momentum',
    summary: 'RSI 用涨跌幅的平滑比值刻画动量。超买或超卖描述近期强弱，不能直接等价为反转。',
    signals: ['用 14 根已收盘 K 线的 Wilder 平滑计算 RSI。', '结合趋势、背离和价格结构解释高低读数。'],
    timeframes: [...allTimeframes], timeframeNotes: '分钟图到周线均需重新计算；短周期读数不应代替长周期状态。',
    limitations: ['趋势延续时极端读数可持续存在。', '背离不保证出现可盈利的反向行情。'],
    implementationNotes: ['较强趋势中降低 RSI 反转贡献；完全横盘按中性 50 处理。'],
    sources: [source('Relative Strength Index (RSI)', 'TradingView', 'https://www.tradingview.com/support/solutions/43000502338-relative-strength-index-rsi/')],
  },
  {
    id: 'volatility-atr', title: 'ATR 波动尺度', category: 'volatility',
    summary: '真实波幅考虑当根高低差以及与前收盘价的距离；ATR 平滑真实波幅，只衡量波动，不决定涨跌。',
    signals: ['ATR 上升表示近期波幅增大。', '按价格或 ATR 归一化后再比较不同币种。'],
    timeframes: [...allTimeframes], timeframeNotes: '每个周期独立估计 ATR；分钟 ATR 不能直接当作日线波幅。',
    limitations: ['历史平均波幅不能涵盖所有未来跳跃。', 'ATR 倍数形成的范围没有天然概率覆盖保证。'],
    implementationNotes: ['用于指标尺度、情景影线与随预测步长扩大的范围。', '显示为情景范围，并以到期数据检验覆盖率。'],
    sources: [source('Average True Range (ATR)', 'TradingView', 'https://www.tradingview.com/support/solutions/43000501823-average-true-range-atr/')],
  },
  {
    id: 'volatility-bollinger', title: '布林带与行情状态', category: 'volatility',
    summary: '布林带提供相对高低及带宽信息。触轨不是独立买卖信号；趋势中价格可以持续沿轨运行。',
    signals: ['带宽刻画收缩或扩张，带内位置提供相对价格信息。', '趋势延续与均值回归情景需要结合其他类别的证据。'],
    timeframes: [...allTimeframes], timeframeNotes: '可用于不同长度的 K 线，但每根需有足够交易活动；20 / 2 仅为默认参数。',
    limitations: ['两倍标准差的价格带不能直接称为 95% 预测区间。', '多个高度相关指标不会自动提升证据强度。'],
    implementationNotes: ['仅在趋势较弱时给予带内均值回归较高权重；不宣称带宽为概率。'],
    sources: [source('Bollinger Bands Rules', 'John Bollinger', 'https://www.bollingerbands.com/bollinger-band-rules', 'original-author')],
  },
  {
    id: 'volume-confirmation', title: '量价确认及衰竭', category: 'volume',
    summary: '成交量帮助解释价格运动的参与程度。放量可能伴随趋势延续，也可能出现在行情衰竭处。',
    signals: ['比较当前成交量与近期同周期历史量。', '价格突破伴随量变时，需要结合收盘位置和随后走势。'],
    timeframes: [...allTimeframes], timeframeNotes: '仅比较相同交易所、币对、周期、成交量单位的完整 K 线。',
    limitations: ['高量本身没有方向信息。', '跨交易所的成交量不可直接当作同一序列拼接。'],
    implementationNotes: ['以当根量 / 前 20 根均量调节价格信号；只提供有限权重，不独立决定方向。'],
    sources: [source('Volume', 'TradingView', 'https://www.tradingview.com/support/solutions/43000591617-volume/')],
  },
  {
    id: 'pattern-engulfing', title: '吞没形态及确认', category: 'pattern',
    summary: '看涨吞没关注后一根阳线实体覆盖前一根阴线实体，通常结合此前下降趋势识别；实体吞没不要求影线全部覆盖。',
    signals: ['先检查相邻已收盘 K 线开收盘关系。', '结合此前趋势解释形态，反向吞没按对称结构检查。'],
    timeframes: [...allTimeframes], timeframeNotes: '各周期独立识别；低流动性短周期的形态不能套用其他市场胜率。',
    limitations: ['只有实体条件不等于完整反转确认。', '形态定义不提供未来命中率。'],
    implementationNotes: ['当前引擎仅把两根实体吞没作为低权重辅助特征，未实现完整形态交易系统。'],
    sources: [source('Engulfing - Bullish', 'TradingView', 'https://www.tradingview.com/support/solutions/43000583771-engulfing-bullish/')],
  },
  {
    id: 'timeframe-closed-bars', title: '多周期与已收盘数据', category: 'timeframe',
    summary: '未结束的高周期 K 线会随实时行情改变；把其最终值提前带入低周期历史数据会产生前视偏差和重绘。',
    signals: ['按当前周期重新计算指标与预测时长。', '引入高周期背景时只使用当时已收盘的数据。'],
    timeframes: [...allTimeframes], timeframeNotes: '1m / 5m / 15m / 1h / 4h / 1d / 1w 分别保存，按各自收盘时间复盘。',
    limitations: ['多周期共振不意味着信号相互独立。', '未确认高周期值会使历史结果看起来好于实时体验。'],
    implementationNotes: ['当前版本按图表周期独立预测，不宣称已经融合上级周期数据。', '输入只取已收盘 K 线，生成时固定行情快照。'],
    sources: [source('Other timeframes and data', 'TradingView Pine Script', 'https://www.tradingview.com/pine-script-docs/concepts/other-timeframes-and-data/')],
  },
  {
    id: 'evaluation-out-of-sample', title: '到期复盘与朴素基线', category: 'evaluation',
    summary: '预测评估应使用生成时不可见的后续数据；按时间向前滚动评估，并对实际多步预测跨度计量误差。',
    signals: ['同时报告方向命中率、价格误差、范围覆盖率与样本数。', '比较保持最后收盘价不变的朴素基线。'],
    timeframes: [...allTimeframes], timeframeNotes: '按周期、预测步数和模型版本分组；一分钟和一周的预测不可当作相同样本。',
    limitations: ['训练内拟合误差不代表真实未来误差。', 'MAPE 在实际价格接近零时不稳定；方向准确率不等于交易收益率。'],
    implementationNotes: ['生成时保存输入、输出、阈值、来源和版本；到期后以同源完整行情评估。', '无到期样本显示待验证，不能以零样本制造准确率。'],
    sources: [source('Forecasting: Principles and Practice — The forecaster’s toolbox', 'Rob J Hyndman and George Athanasopoulos', 'https://otexts.com/fpp3/toolbox.html', 'original-author')],
  },
  {
    id: 'evaluation-overfitting', title: '调参与回测过拟合', category: 'evaluation',
    summary: '反复比较大量参数后挑出历史最佳策略，可能选中噪声；样本内最佳表现不保证样本外优势。',
    signals: ['记录尝试过的参数和策略版本。', '保留后续未参与调参的数据检验新版本。'],
    timeframes: [...allTimeframes], timeframeNotes: '各周期独立调参仍属于多次尝试，应一并记录。',
    limitations: ['一段高命中率不足以证明泛化能力。', '重叠预测窗口包含相关结果，不能视为完全独立的样本。'],
    implementationNotes: ['权重、预测跨度或规则变化必须升级模型版本；旧预测不回写新参数。', '启发式综合分数不展示为上涨概率。'],
    sources: [source('The Probability of Backtest Overfitting', 'David H. Bailey, Jonathan M. Borwein, Marcos López de Prado and Qiji Jim Zhu', 'https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf', 'original-research')],
  },
  {
    id: 'pattern-evidence-boundary', title: '技术形态研究的证据边界', category: 'pattern',
    summary: 'Lo、Mamaysky、Wang 在历史美股样本中发现部分形态含增量信息，并给出自动化识别方法；这不是加密市场胜率保证。',
    signals: ['将主观图形转成可复现的数值条件。', '分别检验形态条件下和无条件结果。'],
    timeframes: ['1d', '1w'], timeframeNotes: '原研究为 1962—1996 年美股日频背景；不能直接外推为加密分钟图的有效性证据。',
    limitations: ['市场、年代、频率与交易成本差异都影响适用性。', '有统计信息不等于可盈利策略。'],
    implementationNotes: ['作为证据边界说明，不向本产品引入论文中的任何胜率。'],
    sources: [source('Foundations of Technical Analysis: Computational Algorithms, Statistical Inference, and Empirical Implementation', 'Andrew W. Lo, Harry Mamaysky and Jiang Wang / NBER', 'https://www.nber.org/papers/w7613', 'original-research')],
  },
];
