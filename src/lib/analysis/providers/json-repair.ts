/**
 * 从模型的自由文本响应中提取并校验 JSON。
 *
 * 只有 Anthropic 的 structured outputs 能保证返回值严格符合 schema。
 * 走 json_object 模式的供应商（DeepSeek 及多数中转站）只保证"语法是合法 JSON"，
 * 实际返回里仍常见三种问题，这里逐一处理：
 *   1. 被 ```json 代码块包裹
 *   2. JSON 前后带解释性文字
 *   3. 返回空内容（DeepSeek 已知边界情况）
 */

import type { z } from 'zod';

export class JsonExtractionError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = 'JsonExtractionError';
  }
}

/** 从可能含杂质的文本中抠出 JSON 对象 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new JsonExtractionError('模型返回了空内容', text);

  // 先试直接解析——正常情况下这一步就成功了
  try {
    return JSON.parse(trimmed);
  } catch {
    // 继续尝试修复
  }

  // 剥掉 markdown 代码块围栏
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // 继续
    }
  }

  // 取第一个 { 到最后一个 } 之间的内容，去掉前后的解释文字
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // 放弃
    }
  }

  throw new JsonExtractionError('无法从模型响应中解析出 JSON', text);
}

/**
 * 提取 + schema 校验。
 * 校验失败时把具体的字段错误一并抛出，供调用方在重试时反馈给模型。
 */
export function parseAndValidate<T>(text: string, schema: z.ZodType<T>): T {
  const json = extractJson(text);
  const result = schema.safeParse(json);
  if (result.success) return result.data;

  const issues = result.error.issues
    .slice(0, 8)
    .map((i) => `  - ${i.path.join('.') || '(根)'}: ${i.message}`)
    .join('\n');
  throw new JsonExtractionError(`JSON 不符合 schema：\n${issues}`, text);
}
