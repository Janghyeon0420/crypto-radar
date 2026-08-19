/**
 * 供应商选择。
 *
 * 优先级：显式的 LLM_PROVIDER > 按已配置的 key 自动推断。
 * 自动推断的顺序把 DeepSeek 排在最前，因为对中国大陆用户它直连可达、
 * 不需要代理，是配置成本最低的一个（见 docs/DATA-SOURCES.md）。
 */

import { createAnthropicProvider } from './anthropic';
import { createDeepSeekProvider, createGenericOpenAiProvider } from './openai-compatible';
import { ProviderNotConfiguredError, type LlmProvider, type ProviderInfo } from './types';

export type ProviderId = 'deepseek' | 'anthropic' | 'openai';

const has = (name: string) => Boolean(process.env[name]?.trim());

/** 按配置推断该用哪个供应商。返回 null 表示一个都没配。 */
export function resolveProviderId(): ProviderId | null {
  const explicit = process.env.LLM_PROVIDER?.trim().toLowerCase();
  if (explicit === 'deepseek') return 'deepseek';
  if (explicit === 'anthropic') return 'anthropic';
  if (explicit === 'openai' || explicit === 'openai-compatible') return 'openai';

  // 未显式指定时按 key 自动推断
  if (has('DEEPSEEK_API_KEY')) return 'deepseek';
  if (has('ANTHROPIC_API_KEY') || has('ANTHROPIC_AUTH_TOKEN')) return 'anthropic';
  if (has('OPENAI_API_KEY')) return 'openai';
  return null;
}

/** 供应商实例按进程缓存，避免每次研判都重建 HTTP 客户端 */
let cached: { id: ProviderId; provider: LlmProvider } | null = null;

export function getProvider(): LlmProvider {
  const id = resolveProviderId();
  if (!id) {
    throw new ProviderNotConfiguredError(
      '未配置任何 LLM 供应商。请在 .env.local 中设置 DEEPSEEK_API_KEY、' +
        'ANTHROPIC_API_KEY 或 OPENAI_API_KEY 之一。详见 .env.example。',
    );
  }

  if (cached?.id === id) return cached.provider;

  const provider = build(id);
  cached = { id, provider };
  return provider;
}

function build(id: ProviderId): LlmProvider {
  switch (id) {
    case 'deepseek':
      if (!has('DEEPSEEK_API_KEY')) {
        throw new ProviderNotConfiguredError('LLM_PROVIDER=deepseek 但未设置 DEEPSEEK_API_KEY');
      }
      return createDeepSeekProvider();

    case 'anthropic':
      if (!has('ANTHROPIC_API_KEY') && !has('ANTHROPIC_AUTH_TOKEN')) {
        throw new ProviderNotConfiguredError('LLM_PROVIDER=anthropic 但未设置 ANTHROPIC_API_KEY');
      }
      return createAnthropicProvider();

    case 'openai':
      if (!has('OPENAI_API_KEY')) {
        throw new ProviderNotConfiguredError('LLM_PROVIDER=openai 但未设置 OPENAI_API_KEY');
      }
      return createGenericOpenAiProvider();
  }
}

export function isAnalysisAvailable(): boolean {
  return resolveProviderId() !== null;
}

/** 供 /api/health 展示当前生效的供应商。不触发网络请求。 */
export function describeProvider(): ProviderInfo {
  const id = resolveProviderId();
  if (!id) {
    return { configured: false, id: null, label: null, model: null, viaRelay: false, needsProxy: false };
  }

  try {
    const p = getProvider();
    return {
      configured: true,
      id,
      label: p.label,
      model: p.model,
      viaRelay: p.viaRelay,
      // DeepSeek 在中国大陆直连可达；Anthropic / OpenAI 官方需要代理。
      // 走中转站时通常也是国内可达的，故不标记为需要代理。
      needsProxy: id !== 'deepseek' && !p.viaRelay,
    };
  } catch {
    return { configured: false, id, label: null, model: null, viaRelay: false, needsProxy: false };
  }
}

export { ProviderNotConfiguredError };
