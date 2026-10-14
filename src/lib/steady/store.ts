/**
 * 投资计划与持仓的持久化（data/steady.json）。
 *
 * 沿用 history/store.ts 的做法（服务端 JSON 文件 + 写操作串行化），但这里多做三件事，
 * 因为这份数据与研判历史性质不同——研判历史丢了可以重新攒，持仓与计划是用户手填的：
 *   1. **原子写**：先写临时文件再 rename，进程在写到一半被杀（断电、launchd 重启）
 *      也只会留下旧版本，不会得到半个 JSON。
 *   2. **损坏不覆盖**：文件解析失败时，先把它改名留档再当空状态处理。
 *      history/store.ts 的「损坏就当空」在那里是合理的，在这里会让用户下一次保存时
 *      悄悄抹掉唯一的一份手填数据。
 *   3. **校验**：读出来也过一遍 Zod，手改文件改坏了能被发现，而不是带着脏数据去算风险。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  SteadyStateSchema,
  emptyState,
  type Holding,
  type Plan,
  type SteadyState,
} from './schema';

const DATA_DIR = path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'steady.json');

let writeChain: Promise<unknown> = Promise.resolve();

export async function readState(): Promise<SteadyState> {
  let raw: string;
  try {
    raw = await readFile(FILE, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
    // 权限错误之类：抛出去让接口返回 500，而不是当成「还没有数据」然后在保存时覆盖它
    throw err;
  }

  try {
    return SteadyStateSchema.parse(JSON.parse(raw));
  } catch (err) {
    const saved = `${FILE.replace(/\.json$/, '')}.corrupt-${Date.now()}.json`;
    await rename(FILE, saved).catch(() => {});
    console.warn(
      `[steady] ${path.basename(FILE)} 损坏或格式不符，已改名为 ${path.basename(saved)}：${describeParseError(err)}`,
    );
    return emptyState();
  }
}

/** Zod 的完整报错是一大段 JSON，日志里只要「哪个字段不对」 */
function describeParseError(err: unknown): string {
  const issues = (err as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
  if (Array.isArray(issues)) {
    return issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`)
      .join('；');
  }
  return err instanceof Error ? err.message.slice(0, 160) : String(err);
}

async function writeState(state: SteadyState): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  // 0600：这是财务数据，不需要被这台机器上的其他账户读到
  await writeFile(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, FILE);
}

export function updateState(patch: {
  plan?: Plan | null;
  holdings?: Holding[];
}): Promise<SteadyState> {
  const task = writeChain.then(async () => {
    const cur = await readState();
    const next: SteadyState = {
      ...cur,
      ...(patch.plan !== undefined ? { plan: patch.plan } : {}),
      ...(patch.holdings !== undefined ? { holdings: patch.holdings } : {}),
      updatedAt: Date.now(),
    };
    await writeState(next);
    return next;
  });
  writeChain = task.catch(() => {});
  return task;
}
