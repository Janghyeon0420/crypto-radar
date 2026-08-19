/**
 * LLM 供应商抽象。
 *
 * 存在的理由：不同供应商在"结构化输出"上的能力差距很大——
 * Anthropic 有原生 structured outputs（schema 强校验），
 * DeepSeek 只有 json_object 模式（保证语法合法，但不保证字段符合 schema）。
 * 上层不该关心这些差异，它只想拿到一个通过校验的 Analysis 对象。
 * 把差异关在各自的 provider 里，切换供应商时研判逻辑、prompt、UI 都不用动。
 */

import type { Analysis } from '../schema';

export interface LlmProvider {
  /** 供应商标识，用于日志和界面显示 */
  id: 'anthropic' | 'openai-compatible';
  /** 展示名，含实际使用的模型 */
  label: string;
  model: string;
  /** 是否经由第三方中转站 */
  viaRelay: boolean;
  /**
   * 生成研判。实现方负责保证返回值已通过 AnalysisSchema 校验，
   * 校验不通过应自行重试或抛错，不要把脏数据交给上层。
   */
  generate(system: string, user: string): Promise<Analysis>;
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
