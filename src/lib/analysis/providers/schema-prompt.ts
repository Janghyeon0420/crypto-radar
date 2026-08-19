/**
 * 把 Zod schema 转成给模型看的格式说明。
 *
 * 供 DeepSeek 及其它只有 json_object 模式、没有 schema 强校验的供应商使用。
 * 这些供应商只保证"返回的是合法 JSON"，字段对不对全靠 prompt 引导 + 本地校验，
 * 所以这段说明写得越具体，重试次数越少。
 */

import { z } from 'zod';
import { AnalysisSchema } from '../schema';

let cached: string | null = null;

export function buildSchemaInstruction(): string {
  if (cached) return cached;

  const jsonSchema = z.toJSONSchema(AnalysisSchema);

  cached = `## 输出格式要求

你必须只输出一个 JSON 对象，不要输出任何其它文字，不要用 markdown 代码块包裹。

该 JSON 必须严格符合以下 JSON Schema：

${JSON.stringify(jsonSchema, null, 2)}

补充约束（这些是 schema 表达不了但必须遵守的）：
- confidence 是 0-100 的整数
- factors 至少 3 条，每条的 note 必须引用输入数据中的具体数值
- scenarios 有 2-3 个，probability 之和应接近 100
- risks 至少 2 条
- dataGaps 在无缺失时返回空数组 []，不要省略该字段
- weight 和 probability 用数字，不要写成字符串
- 所有文本字段用中文

直接输出 JSON：`;

  return cached;
}
