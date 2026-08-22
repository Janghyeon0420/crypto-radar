/**
 * Anthropic 供应商。
 *
 * 同时覆盖两种场景：
 *   1. 官方 API —— 只配 ANTHROPIC_API_KEY
 *   2. Anthropic 格式的中转站 —— 额外配 ANTHROPIC_BASE_URL
 *
 * 中转站的兼容性有强弱之分。若中转站不支持 structured outputs（messages.parse），
 * 会自动降级为"prompt 里附 schema + 自行校验"的模式，与 DeepSeek 走同一套兜底逻辑。
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { parseAndValidate } from './json-repair';
import type { GenerateRequest, LlmProvider } from './types';

const DEFAULT_MODEL = 'claude-opus-5';

export function createAnthropicProvider(): LlmProvider {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN;
  const baseURL = process.env.ANTHROPIC_BASE_URL?.trim() || undefined;
  const model = process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;

  const client = new Anthropic({ apiKey, baseURL });

  return {
    id: 'anthropic',
    label: baseURL ? `Anthropic 中转（${model}）` : `Anthropic（${model}）`,
    model,
    viaRelay: Boolean(baseURL),

    async generate<T>(req: GenerateRequest<T>): Promise<T> {
      try {
        const response = await client.messages.parse({
          model,
          max_tokens: req.maxTokens ?? 8000,
          // 需要权衡与取舍的任务（研判）才开思考；归类汇总类任务关掉，更快更便宜
          ...(req.thinking === false ? {} : { thinking: { type: 'adaptive' as const } }),
          output_config: {
            effort: 'medium',
            format: zodOutputFormat(req.schema),
          },
          system: [
            {
              type: 'text',
              text: req.system,
              // system prompt 完全固定，缓存它可省下重复调用的输入成本
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages: [{ role: 'user', content: req.user }],
        });

        if (!response.parsed_output) {
          throw new Error('模型输出未通过 schema 校验');
        }
        return response.parsed_output;
      } catch (err) {
        // 中转站常见不支持 output_config / thinking 这类较新参数，
        // 表现为 400。这种情况降级到纯 prompt 约束 + 本地校验，而不是直接失败。
        if (isUnsupportedParamError(err)) {
          console.warn('[anthropic] 该端点不支持 structured outputs，降级为 prompt 约束模式');
          return generateFallback(client, model, req);
        }
        throw err;
      }
    },
  };
}

function isUnsupportedParamError(err: unknown): boolean {
  if (err instanceof Anthropic.APIError) {
    // 400 = 参数不被接受；404 = 中转站未实现该路由
    return err.status === 400 || err.status === 404;
  }
  return false;
}

/** 降级路径：把 schema 写进 prompt，让模型直接吐 JSON，再本地校验 */
async function generateFallback<T>(
  client: Anthropic,
  model: string,
  req: GenerateRequest<T>,
): Promise<T> {
  const { buildSchemaInstruction } = await import('./schema-prompt');

  const response = await client.messages.create({
    model,
    max_tokens: req.maxTokens ?? 8000,
    system: req.system,
    messages: [
      {
        role: 'user',
        content: `${req.user}\n\n${buildSchemaInstruction(req.schema, req.constraints)}`,
      },
    ],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  return parseAndValidate(text, req.schema);
}
