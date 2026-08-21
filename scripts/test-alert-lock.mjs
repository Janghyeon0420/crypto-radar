/**
 * 告警单实例锁。
 *
 * 这把锁存在的意义是防「两个进程对同一份 data/ 各跑一套轮询」，
 * 而它自己出错的后果分两种，都很隐蔽：
 *   - 锁太严（死锁不自愈）→ 告警彻底不工作，界面上却看不出原因
 *   - 锁太松（该拦没拦）  → 通知发两遍，事件文件被交替覆盖
 * 两种都不会抛异常，所以只能靠测试钉住。
 */
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireLock, refreshLock, releaseLock, staleAfter } from '../src/lib/alerts/lock.ts';

const dir = await mkdtemp(path.join(tmpdir(), 'radar-lock-'));
const FILE = path.join(dir, 'alerts.lock');
const POLL = 60;

let pass = 0;
const failures = [];
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else failures.push(name);
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  if (!ok) console.log(`      实际 ${JSON.stringify(actual)}  期望 ${JSON.stringify(expected)}`);
};

/** 伪造一个别的进程持有的锁 */
const plant = (pid, ageMs) =>
  writeFile(
    FILE,
    JSON.stringify({ pid, heartbeatAt: Date.now() - ageMs, startedAt: Date.now() - ageMs }),
  );

console.log('=== 基本获取与释放 ===');
{
  check('无锁时可获得', (await acquireLock(POLL, FILE)).acquired, true);
  check('锁文件记录的是本进程', JSON.parse(await readFile(FILE, 'utf8')).pid, process.pid);
  check('同一进程再取仍成功（重启 worker 不该被自己挡住）', (await acquireLock(POLL, FILE)).acquired, true);
  await releaseLock(FILE);
  check('释放后锁文件已删除', await readFile(FILE, 'utf8').then(() => true, () => false), false);
}

console.log('\n=== 被别的活进程持有 ===');
{
  // pid 1 在任何 Unix 上都活着，用它模拟一个健在的持有者
  await plant(1, 5_000);
  const r = await acquireLock(POLL, FILE);
  check('拿不到锁', r.acquired, false);
  check('并且说得出是谁占着', r.heldBy?.pid, 1);
}

console.log('\n=== 持有者已消失：锁必须能自愈 ===');
{
  // 这是最关键的一条：kill -9 不会给进程清理的机会，
  // 若锁不能自愈，告警会永久停摆而界面毫无提示
  const deadPid = 999_999; // 超出 macOS/Linux 默认 pid 上限，必然不存在
  await plant(deadPid, 5_000);
  check('持有者进程不存在，可接管', (await acquireLock(POLL, FILE)).acquired, true);
  await releaseLock(FILE);
}

console.log('\n=== 心跳过期 ===');
{
  await plant(1, staleAfter(POLL) + 1000);
  check('进程虽在但久未续期，可接管', (await acquireLock(POLL, FILE)).acquired, true);
  await releaseLock(FILE);

  await plant(1, staleAfter(POLL) - 5_000);
  check('刚过一半续期周期，不可接管', (await acquireLock(POLL, FILE)).acquired, false);
  check('过期阈值不小于 90 秒（轮询设得很短时留足余量）', staleAfter(5), 90_000);
  check('过期阈值为轮询间隔的 3 倍', staleAfter(60), 180_000);
}

console.log('\n=== 续期 ===');
{
  // 上一段刻意留了一个别人持有的锁，这里必须先清掉再取，否则测的是别的东西
  await rm(FILE, { force: true });
  check('取得锁', (await acquireLock(POLL, FILE)).acquired, true);
  const before = JSON.parse(await readFile(FILE, 'utf8'));
  await new Promise((r) => setTimeout(r, 20));
  await refreshLock(FILE);
  const after = JSON.parse(await readFile(FILE, 'utf8'));
  check('心跳时间前移', after.heartbeatAt > before.heartbeatAt, true);
  check('startedAt 原样保留（用于显示已运行多久）', after.startedAt, before.startedAt);

  // 锁已被别人接管时不该强行写回，否则两个进程会来回抢
  await plant(1, 1_000);
  await refreshLock(FILE);
  check('别人持有时续期不篡改锁', JSON.parse(await readFile(FILE, 'utf8')).pid, 1);

  await releaseLock(FILE);
  check('释放不删别人的锁', JSON.parse(await readFile(FILE, 'utf8')).pid, 1);
}

console.log('\n=== 锁文件损坏 ===');
{
  // 磁盘写到一半断电之类。损坏的锁不该让告警永久停摆
  await writeFile(FILE, '{ 这不是 JSON');
  check('内容损坏时视为无锁，可获得', (await acquireLock(POLL, FILE)).acquired, true);
  await releaseLock(FILE);
}

await rm(dir, { recursive: true, force: true });
console.log(`\n通过 ${pass} / 失败 ${failures.length}`);
process.exit(failures.length ? 1 : 0);
