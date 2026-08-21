/**
 * 告警轮询的单实例锁。
 *
 * 为什么需要：服务常驻之后，很容易在同一台机器上再敲一次 npm run dev。
 * Next 发现 3000 被占用会**自动改用 3001 而不是报错**——于是两个进程
 * 对着同一份 data/ 各跑一套轮询，同一条规则被求值两次、通知发两遍、
 * 事件文件被两边交替覆盖。
 *
 * 这正是当初把求值从浏览器移到服务端时要消灭的那类问题，
 * 靠文档提醒「别同时跑两个」是不够的——恰恰是忘记的时候才会出事。
 *
 * 实现取舍：不用 O_EXCL 独占创建。进程被 kill -9 时没机会清理，
 * 独占创建会留下一个永远解不开的锁，那比重复通知更糟——
 * 用户会发现告警彻底不工作，却看不出原因。
 * 所以改为「持有者要定期续期」：锁过期即视为无主，可被接管。
 */

import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

export interface LockInfo {
  pid: number;
  /** 上次续期时间，判断持有者是否还活着 */
  heartbeatAt: number;
  startedAt: number;
}

export interface LockResult {
  acquired: boolean;
  /** 未获得时说明是谁占着，直接显示给用户 */
  heldBy?: LockInfo;
}

const DEFAULT_FILE = path.join(process.cwd(), 'data', 'alerts.lock');

/**
 * 多久没续期就算无主。
 * 取轮询间隔的 3 倍：偶尔一轮卡住（网络慢）不该被别人抢走，
 * 但进程真的没了也不该让锁悬太久。
 */
export const staleAfter = (pollSeconds: number) => Math.max(pollSeconds * 3, 90) * 1000;

/** 进程是否还活着。signal 0 只做权限与存在性检查，不真的发信号。 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM 表示进程存在但不属于当前用户——仍然算活着
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function read(file: string): Promise<LockInfo | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as LockInfo;
  } catch {
    // 不存在或内容损坏都当作无锁——损坏的锁文件不该让告警永久停摆
    return null;
  }
}

/**
 * 尝试取锁。已被**活着且在续期**的进程持有时返回 acquired=false。
 *
 * 注意这里存在理论上的竞态：两个进程同时读到无锁再同时写入。
 * 不去消除它——单人本地工具，两个进程在同一毫秒启动的概率可以忽略，
 * 而为此引入原子创建会带来上面说的「死锁无法自愈」问题，代价更大。
 */
export async function acquireLock(pollSeconds: number, file = DEFAULT_FILE): Promise<LockResult> {
  const existing = await read(file);

  if (existing && existing.pid !== process.pid) {
    const fresh = Date.now() - existing.heartbeatAt < staleAfter(pollSeconds);
    if (fresh && isAlive(existing.pid)) return { acquired: false, heldBy: existing };
  }

  const info: LockInfo = { pid: process.pid, heartbeatAt: Date.now(), startedAt: Date.now() };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(info, null, 2));
  return { acquired: true };
}

/** 续期。每轮求值后调用，声明「我还在」。 */
export async function refreshLock(file = DEFAULT_FILE): Promise<void> {
  const existing = await read(file);
  // 锁已被别人接管时不要强行写回，否则两边会来回抢
  if (existing && existing.pid !== process.pid) return;
  const info: LockInfo = {
    pid: process.pid,
    heartbeatAt: Date.now(),
    startedAt: existing?.startedAt ?? Date.now(),
  };
  await writeFile(file, JSON.stringify(info, null, 2)).catch(() => {});
}

/** 释放。只删自己持有的锁。 */
export async function releaseLock(file = DEFAULT_FILE): Promise<void> {
  const existing = await read(file);
  if (existing && existing.pid !== process.pid) return;
  await unlink(file).catch(() => {});
}
