/**
 * 研判入口。供应商无关——具体调哪家由 providers/ 决定。
 * 只在服务端运行：API Key 绝不能进浏览器。
 */

import { getProvider } from './providers';
import { SYSTEM_PROMPT, buildUserPrompt, type AnalysisInput } from './prompt';
import type { Analysis } from './schema';

export async function runAnalysis(input: AnalysisInput): Promise<Analysis> {
  const provider = getProvider();
  const started = Date.now();

  const analysis = await provider.generate(SYSTEM_PROMPT, buildUserPrompt(input));

  console.log(
    `[analysis] ${input.symbol} 研判完成 · ${provider.label} · ${Date.now() - started}ms`,
  );
  return analysis;
}

export { isAnalysisAvailable, describeProvider, ProviderNotConfiguredError } from './providers';
