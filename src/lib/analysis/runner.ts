/**
 * 研判入口。供应商无关——具体调哪家由 providers/ 决定。
 * 只在服务端运行：API Key 绝不能进浏览器。
 */

import { getProvider } from './providers';
import { SYSTEM_PROMPT, buildUserPrompt, type AnalysisInput } from './prompt';
import { AnalysisSchema, ANALYSIS_CONSTRAINTS, type Analysis } from './schema';

export async function runAnalysis(input: AnalysisInput): Promise<Analysis> {
  const provider = getProvider();
  const started = Date.now();

  const analysis = await provider.generate({
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(input),
    schema: AnalysisSchema,
    constraints: ANALYSIS_CONSTRAINTS,
    // 研判要权衡多周期共振与信号冲突，属于需要推理的任务
    thinking: true,
  });

  console.log(
    `[analysis] ${input.symbol} 研判完成 · ${provider.label} · ${Date.now() - started}ms`,
  );
  return analysis;
}

export { isAnalysisAvailable, describeProvider, ProviderNotConfiguredError } from './providers';
