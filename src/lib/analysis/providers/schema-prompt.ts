/**
 * 把 Zod schema 转成给模型看的格式说明。
 *
 * 供 DeepSeek 及其它只有 json_object 模式、没有 schema 强校验的供应商使用。
 * 这些供应商只保证"返回的是合法 JSON"，字段对不对全靠 prompt 引导 + 本地校验，
 * 所以这段说明写得越具体，重试次数越少。
 */

import { z } from 'zod';

/**
 * 说明文本按 schema 缓存。
 * z.toJSONSchema + JSON.stringify 对研判那种大 schema 不便宜，
 * 而同一个 schema 每次生成的说明完全一样。
 *
 * 用 schema 对象本身作键：各调用方的 constraints 与其 schema 一一对应，
 * 不会出现同一 schema 配不同约束的情况。
 */
const cache = new WeakMap<z.ZodType, string>();

export function buildSchemaInstruction(schema: z.ZodType, constraints: string[] = []): string {
  const hit = cache.get(schema);
  if (hit) return hit;

  const jsonSchema = z.toJSONSchema(schema);

  const extra = [...constraints, '所有文本字段用中文']
    .map((c) => `- ${c}`)
    .join('\n');

  const text = `## 输出格式要求

你必须只输出一个 JSON 对象，不要输出任何其它文字，不要用 markdown 代码块包裹。

该 JSON 必须严格符合以下 JSON Schema：

${JSON.stringify(jsonSchema, null, 2)}

补充约束（这些是 schema 表达不了但必须遵守的）：
${extra}

直接输出 JSON：`;

  cache.set(schema, text);
  return text;
}
