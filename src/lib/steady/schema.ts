/**
 * 稳健驾驶舱的数据契约：投资计划 + 手动录入的持仓。
 *
 * 持仓为什么是手动录入而不是连交易所 API：
 *   - 本项目的边界是「只读公开行情，不接账户」（README「已知边界」）。接 API Key 意味着
 *     本地要存密钥、要承担「读权限被滥用」的责任，而稳健投资的用户恰恰最不该为此冒险。
 *   - 手动录入对「稳健」这个目标够用：持仓变化的频率是每月一两次，不是每秒。
 *
 * 计划（Plan）是这个功能的核心：用户在**还没被行情冲昏头脑之前**，先白纸黑字写下底线。
 * 之后所有提示都是「你的计划说了什么」，而不是「我觉得你该怎么做」。
 */

import { z } from 'zod';

/** 视为「现金」的稳定币。价格按 1 计，但脱锚风险在界面上会单独提示 */
export const STABLES = ['USDT', 'USDC', 'FDUSD', 'DAI', 'TUSD'] as const;
export const isStable = (asset: string): boolean => (STABLES as readonly string[]).includes(asset);

const assetCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{2,12}$/, '币种代码只能是 2-12 位字母或数字');

const money = z.number().finite().min(0).max(1e12);

export const HoldingSchema = z.object({
  asset: assetCode,
  quantity: money,
  /** 平均买入成本（USDT/枚）。可不填——只影响盈亏显示，不影响风险计算 */
  avgCost: z.number().finite().min(0).max(1e9).optional(),
});
export type Holding = z.infer<typeof HoldingSchema>;

export const TargetSchema = z.object({
  asset: assetCode,
  weightPct: z.number().finite().min(0).max(100),
});
export type Target = z.infer<typeof TargetSchema>;

export const DcaSchema = z
  .object({
    /** 每期投入（USDT 计价）。0 表示不启用定投提醒 */
    amount: money,
    frequency: z.enum(['weekly', 'monthly']),
    /** weekly: 1-7（周一=1 … 周日=7）；monthly: 1-28（避开 29-31，每个月都有这一天） */
    day: z.number().int().min(1).max(28),
  })
  .refine((d) => d.frequency !== 'weekly' || d.day <= 7, {
    message: '每周定投的 day 必须是 1-7（周一到周日）',
    path: ['day'],
  });
export type Dca = z.infer<typeof DcaSchema>;

/** 权重之和允许的误差：滑块取整后合计 99.9 / 100.1 都算 100 */
const WEIGHT_TOLERANCE = 0.5;

export const PlanSchema = z.object({
  /** 预设档位。用户手动改过配置就是 custom，不假装它还是某个预设 */
  profile: z.enum(['conservative', 'balanced', 'growth', 'custom']),
  /**
   * 这笔钱最多能接受暂时亏掉多少（%）。
   * 下限 5：低于这个数意味着几乎只能持有稳定币，工具没有存在的意义；
   * 上限 80：超过它与「稳健」自相矛盾，且 BTC 历史上多次回撤接近这个量级。
   */
  maxLossPct: z.number().finite().min(5).max(80),
  targets: z
    .array(TargetSchema)
    .min(1)
    .max(12)
    .refine((t) => Math.abs(t.reduce((s, x) => s + x.weightPct, 0) - 100) <= WEIGHT_TOLERANCE, {
      message: '目标配置的权重之和必须是 100%',
    })
    .refine((t) => new Set(t.map((x) => x.asset)).size === t.length, {
      message: '目标配置里有重复的币种',
    }),
  /** 某个资产的实际占比偏离目标超过多少个百分点，才提示再平衡 */
  rebalanceBandPct: z.number().finite().min(1).max(25),
  dca: DcaSchema,
  /**
   * 预案：回撤触及底线时，我（在冷静时）决定怎么做。
   * 这是「事前承诺」——人在亏损的当下最容易做出后悔的决定，所以决定要在亏损之前写好。
   */
  ifLimitHit: z.string().max(300),
});
export type Plan = z.infer<typeof PlanSchema>;

export const SteadyStateSchema = z.object({
  version: z.literal(1),
  plan: PlanSchema.nullable(),
  holdings: z
    .array(HoldingSchema)
    .max(60)
    .refine((h) => new Set(h.map((x) => x.asset)).size === h.length, {
      message: '持仓里有重复的币种，请合并成一行',
    }),
  updatedAt: z.number(),
});
export type SteadyState = z.infer<typeof SteadyStateSchema>;

/** PUT 的请求体：计划与持仓可以分开更新，避免改一项把另一项覆盖掉 */
export const SteadyUpdateSchema = z
  .object({
    plan: PlanSchema.nullable().optional(),
    holdings: SteadyStateSchema.shape.holdings.optional(),
  })
  .refine((b) => b.plan !== undefined || b.holdings !== undefined, {
    message: '请求体里至少要有 plan 或 holdings',
  });

export const emptyState = (): SteadyState => ({
  version: 1,
  plan: null,
  holdings: [],
  updatedAt: 0,
});
