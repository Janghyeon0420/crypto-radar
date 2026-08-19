/**
 * 调用 Claude 做综合研判。
 *
 * 只在服务端运行（app/api/analysis）——API Key 绝不能进浏览器。
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { AnalysisSchema, type Analysis } from './schema';
import { SYSTEM_PROMPT, buildUserPrompt, type AnalysisInput } from './prompt';

/** 客户端惰性创建：没配 key 时不应在模块加载阶段就抛错 */
let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

export class MissingApiKeyError extends Error {
  constructor() {
    super('未配置 ANTHROPIC_API_KEY，LLM 研判不可用。其余看板功能不受影响。');
    this.name = 'MissingApiKeyError';
  }
}

export function isAnalysisAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export async function runAnalysis(input: AnalysisInput): Promise<Analysis> {
  if (!isAnalysisAvailable()) throw new MissingApiKeyError();

  const response = await getClient().messages.parse({
    model: 'claude-opus-5',
    max_tokens: 8000,
    // 研判要权衡多周期共振与信号冲突，属于"稍微复杂"的推理，开自适应思考
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'medium',
      format: zodOutputFormat(AnalysisSchema),
    },
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        // system prompt 完全固定，缓存它可以让高频刷新的研判省下这部分输入成本
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: buildUserPrompt(input) }],
  });

  if (!response.parsed_output) {
    throw new Error('模型输出未能通过 schema 校验');
  }
  return response.parsed_output;
}
