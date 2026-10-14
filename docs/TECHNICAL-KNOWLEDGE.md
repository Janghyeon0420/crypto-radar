# 技术预测知识库

版本：`technical-knowledge-2026-10-12-v1`。检索与核验日期：**2026-10-12**。

这是从公开网络检索后精选的 11 条知识记录，覆盖指标、K 线形态、周期处理和预测评估；不声称穷尽全网。采用工具提供方官方说明、指标原作者及原始研究，保存摘要与来源，不复制整篇文章或图表。当前为随代码发布的静态知识快照，不会自动持续抓取外部文章。

机器可读内容位于 `src/lib/forecast/knowledge.ts`，导出 `knowledgeVersion` 和 `knowledgeEntries`。每条包含稳定 ID、中文摘要、可观察信号、适用周期、限制、产品实现说明及带检索日期的来源。`implementationNotes` 是本产品的解释或设计选择，不是来源声称已经验证过的结果。

## 已核验来源与用途

以下链接均在上述日期检索核验。

| 知识 ID | 信号与使用限制 | 一手来源 |
| --- | --- | --- |
| `trend-moving-averages` | SMA / EMA 描述趋势，交叉有滞后；不要把均线和 MACD 视为独立证据。 | [TradingView：Moving Averages](https://www.tradingview.com/support/solutions/43000502589-moving-averages/) |
| `momentum-macd` | 观察均线差及柱值变化，不能由动量减弱直接推出价格反转。 | [TradingView：MACD](https://www.tradingview.com/support/solutions/43000502344-moving-average-convergence-divergence-macd-indicator/) |
| `momentum-rsi-regime` | 用趋势背景解释 RSI 强弱，极端读数不是自动反转指令。 | [TradingView：RSI](https://www.tradingview.com/support/solutions/43000502338-relative-strength-index-rsi/) |
| `volatility-atr` | ATR 提供波动尺度，不能独立给出价格方向。 | [TradingView：ATR](https://www.tradingview.com/support/solutions/43000501823-average-true-range-atr/) |
| `volatility-bollinger` | 触轨不直接构成交易信号；价格带不等于校准过的概率区间。 | [John Bollinger：Bollinger Bands Rules](https://www.bollingerbands.com/bollinger-band-rules) |
| `volume-confirmation` | 量价结合识别参与度；放量也可能伴随衰竭。 | [TradingView：Volume](https://www.tradingview.com/support/solutions/43000591617-volume/) |
| `pattern-engulfing` | 识别实体吞没并考虑前序趋势，不从形态名称推导准确率。 | [TradingView：Engulfing — Bullish](https://www.tradingview.com/support/solutions/43000583771-engulfing-bullish/) |
| `timeframe-closed-bars` | 多周期数据按当时是否收盘对齐，防止未确认值重绘和未来信息泄漏。 | [TradingView：Other timeframes and data](https://www.tradingview.com/pine-script-docs/concepts/other-timeframes-and-data/) |
| `evaluation-out-of-sample` | 按时间推进评估多步误差，和朴素预测比较。 | [Hyndman / Athanasopoulos：The forecaster’s toolbox](https://otexts.com/fpp3/toolbox.html) |
| `evaluation-overfitting` | 多次试验可能挑中历史噪声，需要样本外证据。 | [Bailey 等：The Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf) |
| `pattern-evidence-boundary` | 历史美股形态研究只作研究方法参考，不能作为加密资产胜率依据。 | [Lo / Mamaysky / Wang：NBER Working Paper 7613](https://www.nber.org/papers/w7613) |

## 本产品的周期策略

以下是产品初始化假设，**没有经过样本外校准，来源不保证这些参数最优**。执行参数以 `src/lib/forecast/engine.ts` 的 `PROFILES` 为准。

| 图表周期 | 预测根数 / 跨度 | 快 / 慢 EMA | 产品设计意图 |
| --- | --- | --- | --- |
| 1m | 12 根 / 12 分钟 | 8 / 21 | 更快衰减，限制短期价格噪声的持续外推。 |
| 5m | 12 根 / 1 小时 | 10 / 26 | 短期动量与区间回归并用。 |
| 15m | 8 根 / 2 小时 | 12 / 26 | 兼顾日内动量和价格偏离。 |
| 1h | 12 根 / 12 小时 | 12 / 36 | 增加趋势贡献。 |
| 4h | 6 根 / 1 天 | 16 / 48 | 中短期趋势情景。 |
| 1d | 7 根 / 1 周 | 20 / 50 | 以中期趋势为主，降低反转贡献。 |
| 1w | 4 根 / 4 周 | 13 / 40 | 更慢衰减，保留更宽的情景范围。 |

各周期用自身已收盘的 OHLCV 重新计算。当前版本是各周期独立预测，并未实现上级周期数据融合。预测跨度按预测 K 线本身计量；在当前 K 线已经开始时，预测从下一根完整 K 线开始，不能把已发生的部分伪装成预测。

## 从知识到可复盘情景

1. 固定输入快照。保存币对、交易所、周期、已收盘行情、锚点、生成时间及知识/模型版本。
2. 计算趋势、MACD、RSI、布林位置、量比、吞没和 ATR。组合参数为透明启发式规则，并非已训练的概率模型。强趋势时减少反转因素；相关指标的组合不能称作独立投票。
3. 生成未来 OHLC 情景。影线和范围是模型设定的展示路径，不是对每一笔未来成交的承诺。ATR 范围随步长扩大，但只有实际覆盖率可用于检验它；当前不称作置信区间。
4. 到期后匹配同币对、同交易所、同周期的完整实际 K 线，再评价原始预测。缺失数据时保留待复盘状态；不以另一家交易所的数据冒充同源结果。

上面是本产品的实现口径，不是把检索文章直接交给模型猜测实时行情。每条预测记录保存 `knowledgeIds`，可以追溯当时使用的规则依据和版本。

## 复盘指标与阅读方式

下面公式是本产品对可审计评估的具体定义，所有判定阈值必须在生成时固定。

- **方向命中率**：用锚点到最终收盘的变化判定上涨 / 下跌 / 中性，和生成时的方向比较；分母只含已完成复盘记录，同时显示样本数。
- **路径价格误差 MAPE**：每根 `100 × |预测收盘 − 实际收盘| / 实际收盘` 的平均。价格必须严格为正；低误差不必然意味着方向判断更好。
- **情景范围覆盖率**：实际收盘落在当根保存的上下界内的比例；不把它称作整根高低价覆盖或未来概率保证。
- **朴素基线误差**：所有未来收盘都预测为生成时最后已收盘价格，用相同实际路径计算 MAPE。
- **相对基线改善**：`1 − 模型误差 / 基线误差`，基线误差为零时记为不可计算。正值代表该误差口径下优于基线，负值代表较差。

还要按周期、模型版本、交易所及预测跨度查看结果。方向准确率不等于扣除手续费、滑点和资金费后的收益率。没有成熟样本时只能显示待验证；不能填入行业经验胜率。相邻预测存在重叠，样本量也不能直接当作独立试验次数。

## 更新与验证

新增材料先核实作者、原文、时间与适用市场，记录 URL 和检索日期；把原文观点和产品推断分开。拒绝无可验证证据的固定胜率宣传。更新规则或摘要时升级知识版本，改变参数和预测算法时升级模型版本，历史记录保持其生成时版本。

比较新旧版本时，以历史窗口生成预测，再在窗口之后的完整行情检验；调参区间与最终评估区间分开。保存所有候选版本而非只保留表现最好的版本。这份知识库提供定义和评估纪律，预测是否有效要由实际到期数据回答。
