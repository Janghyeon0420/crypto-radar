/**
 * OpenAI 兼容供应商。
 *
 * 覆盖两类实际用途：
 *   1. DeepSeek —— api.deepseek.com，在中国大陆直连可达，无需代理
 *   2. OpenAI 格式的中转站 —— 国内多数中转站是这种形态，
 *      往往还能用 claude-* 或 gpt-* 的模型名转发到对应上游
 *
 * 与 Anthropic 路径的关键差异：这些端点普遍只支持 json_object 模式
 * （保证语法合法，不保证符合 schema），因此这里必须自己做校验和重试。
 */

import OpenAI from 'openai';
import { AnalysisSchema, type Analysis } from '../schema';
import { JsonExtractionError, parseAndValidate } from './json-repair';
import { buildSchemaInstruction } from './schema-prompt';
import type { LlmProvider } from './types';

export interface OpenAiCompatibleConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  label: string;
  viaRelay: boolean;
}

/** 校验失败时的重试次数。多数失败一次重试就能修好，再多就是模型能力问题了。 */
const MAX_ATTEMPTS = 2;

export function createOpenAiCompatibleProvider(cfg: OpenAiCompatibleConfig): LlmProvider {
  const client = new OpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseURL,
    // LLM 推理耗时长，且研判是手动触发的低频操作，给足超时
    timeout: 180_000,
    maxRetries: 1,
  });

  return {
    id: 'openai-compatible',
    label: cfg.label,
    model: cfg.model,
    viaRelay: cfg.viaRelay,

    async generate(system, user): Promise<Analysis> {
      // deepseek-reasoner 等推理模型不支持 response_format，
      // 对这类模型改为纯 prompt 约束，靠 json-repair 兜底提取
      const supportsJsonMode = !/reasoner|\bo1\b|\bo3\b/i.test(cfg.model);

      let lastError: unknown;
      let repairHint = '';

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const completion = await client.chat.completions.create({
            model: cfg.model,
            // JSON 结构较大，给足输出空间，否则会在中途被截断成非法 JSON
            max_tokens: 8000,
            // 研判需要稳定输出，不要发散
            temperature: 0.3,
            ...(supportsJsonMode ? { response_format: { type: 'json_object' as const } } : {}),
            messages: [
              { role: 'system', content: system },
              {
                role: 'user',
                // DeepSeek 要求 prompt 中出现 "json" 字样才会遵守 response_format，
                // buildSchemaInstruction 里已包含该词
                content: `${user}\n\n${buildSchemaInstruction()}${repairHint}`,
              },
            ],
          });

          const text = completion.choices[0]?.message?.content ?? '';
          return parseAndValidate(text, AnalysisSchema);
        } catch (err) {
          lastError = err;

          // 只有"输出格式不对"才值得重试；网络或鉴权错误重试没有意义
          if (!(err instanceof JsonExtractionError) || attempt === MAX_ATTEMPTS) {
            break;
          }
          console.warn(`[${cfg.label}] 第 ${attempt} 次输出校验失败，重试中：${err.message}`);
          // 把具体的字段错误反馈回去，比单纯重试有效得多
          repairHint = `\n\n注意：你上一次的输出有以下问题，请修正后重新输出完整 JSON：\n${err.message}`;
        }
      }

      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    },
  };
}

/** DeepSeek 预设 */
export function createDeepSeekProvider(): LlmProvider {
  // 实测 2026-08 可用模型为 deepseek-v4-pro / deepseek-v4-flash；
  // 旧的 deepseek-chat / deepseek-reasoner 已不在 /models 列表中。
  // pro 推理更充分，适合研判这种需要权衡多维证据的任务。
  const model = process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-v4-pro';
  return createOpenAiCompatibleProvider({
    apiKey: process.env.DEEPSEEK_API_KEY!,
    baseURL: process.env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com',
    model,
    label: `DeepSeek（${model}）`,
    viaRelay: false,
  });
}

/** 通用 OpenAI 格式端点（中转站 / OpenAI 官方） */
export function createGenericOpenAiProvider(): LlmProvider {
  const model = process.env.OPENAI_MODEL?.trim() || 'gpt-4o';
  const baseURL = process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1';
  const isOfficial = baseURL.startsWith('https://api.openai.com');
  return createOpenAiCompatibleProvider({
    apiKey: process.env.OPENAI_API_KEY!,
    baseURL,
    model,
    label: isOfficial ? `OpenAI（${model}）` : `中转站（${model}）`,
    viaRelay: !isOfficial,
  });
}
