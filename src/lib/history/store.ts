/**
 * 研判历史的持久化。
 *
 * 用服务端 JSON 文件而不是浏览器 localStorage，原因有二：
 *   1. 准确率评估需要在研判发生数天后去拉当时之后的行情，这是服务端的活；
 *   2. 历史记录不该因为清一次浏览器缓存就全没了——它是这个功能的全部价值所在。
 *
 * 单人本地工具，文件存储足够；上数据库属于过度设计。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AnalysisRecord } from './types';

const DATA_DIR = path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'analyses.json');

/**
 * 写操作串行化。Next.js 的路由处理是并发的，
 * 两个请求同时 read-modify-write 会丢记录。
 */
let writeChain: Promise<unknown> = Promise.resolve();

export async function readRecords(): Promise<AnalysisRecord[]> {
  try {
    const raw = await readFile(FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // 文件不存在或损坏都视为空历史，不该让看板挂掉
    return [];
  }
}

async function writeRecords(records: AnalysisRecord[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(records, null, 2), 'utf8');
}

export function appendRecord(record: AnalysisRecord): Promise<void> {
  const task = writeChain.then(async () => {
    const records = await readRecords();
    records.push(record);
    // 只保留最近 500 条，避免文件无限增长；这个量足够算出稳定的准确率
    await writeRecords(records.slice(-500));
  });
  writeChain = task.catch(() => {});
  return task;
}

export function updateRecords(
  updater: (records: AnalysisRecord[]) => AnalysisRecord[],
): Promise<AnalysisRecord[]> {
  const task = writeChain.then(async () => {
    const next = updater(await readRecords());
    await writeRecords(next);
    return next;
  });
  writeChain = task.catch(() => []);
  return task;
}
