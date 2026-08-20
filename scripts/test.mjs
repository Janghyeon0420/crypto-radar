#!/usr/bin/env node
/**
 * 测试入口。
 *
 * 在此之前，三个测试脚本只能靠人肉记住命令逐个敲——那等于没有测试：
 * 没人会在改完代码后想起来跑三条不同的命令。
 *
 * 跑法：
 *   npm test              离线测试，秒级返回，改完代码随手跑
 *   npm run test:live     额外跑依赖真实网络的测试（拉美联储页面等）
 *   npx tsx scripts/test-cache.mjs   单跑某一个
 *
 * 约定：
 *   scripts/test-*.mjs          会被自动发现，无需在这里登记
 *   scripts/test-*.live.mjs     依赖外部网络，默认跳过
 * 退出码非 0 即视为失败，所以每个测试脚本必须在失败时 process.exit(1)。
 *
 * 不引入 vitest/jest：这些脚本各自只有几十行断言，
 * 为它们装一整套测试框架属于过度设计。
 *
 * 但 tsx 是必需的：测试直接 import src/ 下的 .ts 源码，
 * 而这些源码内部用无扩展名的相对导入（`./http`）——Node 原生的类型剥离
 * 能处理类型，处理不了这种解析。只有当被测模块恰好只导入类型时才碰巧能跑，
 * 那种「有时能跑」比明确不能跑更糟。
 */

import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

const TSX = path.join(SCRIPTS_DIR, '..', 'node_modules', '.bin', 'tsx');

/** tsx 缺失时报错的是一句 ENOENT，看不出要装什么，这里提前给出能照做的提示 */
function checkTsx() {
  if (existsSync(TSX)) return;
  console.error('\n找不到 tsx（测试用它加载 .ts 源码）。先跑 npm install。\n');
  process.exit(1);
}

const runFile = (file) =>
  new Promise((resolve) => {
    const child = spawn(TSX, [path.join(SCRIPTS_DIR, file)], { stdio: 'inherit' });
    child.on('close', (code) => resolve(code ?? 1));
    // 脚本本身跑不起来（文件不存在、语法错误）同样算失败
    child.on('error', () => resolve(1));
  });

async function main() {
  checkTsx();

  const includeLive = process.argv.includes('--live') || process.env.TEST_LIVE === '1';

  const all = (await readdir(SCRIPTS_DIR))
    .filter((f) => f.startsWith('test-') && f.endsWith('.mjs'))
    .sort();
  const live = all.filter((f) => f.endsWith('.live.mjs'));
  const offline = all.filter((f) => !f.endsWith('.live.mjs'));
  const selected = includeLive ? [...offline, ...live] : offline;

  if (selected.length === 0) {
    console.error('没有发现任何测试脚本（scripts/test-*.mjs）');
    process.exit(1);
  }

  const failed = [];
  for (const file of selected) {
    console.log(`\n${'━'.repeat(60)}\n▶ ${file}\n${'━'.repeat(60)}`);
    const code = await runFile(file);
    if (code !== 0) failed.push(file);
  }

  console.log(`\n${'━'.repeat(60)}`);
  for (const file of selected) {
    console.log(`  ${failed.includes(file) ? '✗ 失败' : '✓ 通过'}  ${file}`);
  }
  // 跳过的也要显示出来：静默跳过的测试等于不存在的测试
  if (!includeLive) {
    for (const file of live) console.log(`  ○ 跳过  ${file}（需网络，npm run test:live）`);
  }
  console.log(
    `\n${selected.length - failed.length} 通过 / ${failed.length} 失败` +
      (includeLive ? '' : ` / ${live.length} 跳过`),
  );

  process.exit(failed.length ? 1 : 0);
}

await main();
