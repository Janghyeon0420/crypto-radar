/**
 * LLM 供应商抽象。
 *
 * 存在的理由：不同供应商在"结构化输出"上的能力差距很大——
 * Anthropic 有原生 structured outputs（schema 强校验），
 * DeepSeek 只有 json_object 模式（保证语法合法，但不保证字段符合 schema）。
 * 上层不该关心这些差异，它只想拿到一个通过校验的对象。
 * 把差异关在各自的 provider 里，切换供应商时业务逻辑、prompt、UI 都不用动。
 */

import type { z } from 'zod';

/**
 * 一次结构化生成请求。
 *
 * schema 由调用方传入而不是写死成研判——同一套供应商适配要服务多种任务
 * （走势研判、资讯汇总……），它们的输出契约不同，但"让模型吐出合法结构"
 * 这件事的做法完全一样。
 */
export interface GenerateRequest<T> {
  system: string;
  user: string;
  /** 输出契约。provider 负责保证返回值已通过它的校验 */
  schema: z.ZodType<T>;
  /**
   * schema 表达不了、但必须遵守的补充约束（如"概率之和接近 100"）。
   * 只有走 prompt 约束模式的供应商会用到，structured outputs 路径忽略它。
   */
  constraints?: string[];
  maxTokens?: number;
  /**
   * 是否需要模型做深度推理。
   * 研判要权衡多周期共振与信号冲突，需要；
   * 资讯归类是"读完一堆标题给个倾向"，不需要——开了只是更慢更贵。
   */
  thinking?: boolean;
}

export interface LlmProvider {
  /** 供应商标识，用于日志和界面显示 */
  id: 'anthropic' | 'openai-compatible';
  /** 展示名，含实际使用的模型 */
  label: string;
  model: string;
  /** 是否经由第三方中转站 */
  viaRelay: boolean;
  /**
   * 生成结构化结果。实现方负责保证返回值已通过 req.schema 校验，
   * 校验不通过应自行重试或抛错，不要把脏数据交给上层。
   */
  generate<T>(req: GenerateRequest<T>): Promise<T>;
}

export class ProviderNotConfiguredError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'ProviderNotConfiguredError';
  }
}

/** 供应商配置的静态描述，用于 /api/health 展示 */
export interface ProviderInfo {
  configured: boolean;
  id: string | null;
  label: string | null;
  model: string | null;
  viaRelay: boolean;
  /** 该供应商在中国大陆是否需要代理，用于界面提示 */
  needsProxy: boolean;
}
