/**
 * LLM 研判的输出契约。
 *
 * 用 Zod + structured outputs 强约束模型输出，而不是让它自由写一段文字再去解析——
 * 看板需要把结论渲染成卡片、进度条、标签，自由文本没法稳定驱动 UI。
 */

import { z } from 'zod';

export const AnalysisSchema = z.object({
  /** 一句话结论，直接显示在卡片标题 */
  headline: z.string().describe('一句话概括当前走势判断，不超过 40 字'),

  direction: z
    .enum(['bullish', 'bearish', 'neutral'])
    .describe('综合研判方向：看涨 / 看跌 / 震荡'),

  confidence: z
    .number()
    .describe('对该判断的置信度，0-100 的整数。证据冲突或数据不足时必须给低分'),

  timeframe: z
    .enum(['intraday', 'short', 'medium'])
    .describe('该判断适用的时间尺度：日内 / 数日 / 数周'),

  /** 分维度拆解，让用户看到结论是怎么来的 */
  factors: z
    .array(
      z.object({
        dimension: z
          .enum(['technical', 'momentum', 'volume', 'derivatives', 'sentiment', 'news', 'macro'])
          .describe('该因子属于哪个分析维度。macro = 美联储政策与流动性环境'),
        stance: z.enum(['bullish', 'bearish', 'neutral']).describe('该因子的方向'),
        weight: z.number().describe('该因子在本次判断中的权重，0-1'),
        note: z.string().describe('该因子的具体依据，引用给定数据中的实际数值'),
      }),
    )
    .describe('支撑结论的各维度因子，至少 3 条'),

  /** 关键价位，直接画到图上 */
  levels: z.object({
    supports: z.array(z.number()).describe('关键支撑价位，从近到远'),
    resistances: z.array(z.number()).describe('关键阻力价位，从近到远'),
    invalidation: z
      .number()
      .describe('该判断的失效价位——跌破/突破此价则结论不再成立'),
  }),

  /** 情景推演，比单点预测更诚实 */
  scenarios: z
    .array(
      z.object({
        name: z.string().describe('情景名称，如「站稳支撑后反弹」'),
        probability: z.number().describe('主观概率 0-100，所有情景加总应接近 100'),
        trigger: z.string().describe('触发该情景的可观察条件'),
        target: z.string().describe('该情景下的价格区间描述'),
      }),
    )
    .describe('2-3 个可能的后续情景及其概率'),

  /** 需要盯的风险，避免只给乐观叙事 */
  risks: z.array(z.string()).describe('会削弱该判断的风险点，至少 2 条'),

  /** 数据缺口，让用户知道模型没看到什么 */
  dataGaps: z.array(z.string()).describe('本次分析缺失或不可靠的数据，没有则返回空数组'),
});

export type Analysis = z.infer<typeof AnalysisSchema>;

/**
 * schema 表达不了、但模型必须遵守的约束。
 *
 * 只有走 prompt 约束模式的供应商（DeepSeek 及多数中转站）会读到它——
 * 放在这里而不是 schema-prompt.ts，是因为它属于「研判的输出契约」，
 * 与 AnalysisSchema 是同一件事的两半，改字段时应当一起改。
 */
export const ANALYSIS_CONSTRAINTS = [
  'confidence 是 0-100 的整数',
  'factors 至少 3 条，每条的 note 必须引用输入数据中的具体数值',
  'scenarios 有 2-3 个，probability 之和应接近 100',
  'risks 至少 2 条',
  'dataGaps 在无缺失时返回空数组 []，不要省略该字段',
  'weight 和 probability 用数字，不要写成字符串',
];
