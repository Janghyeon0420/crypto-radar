/**
 * data/ 目录的定期快照。
 *
 * 为什么需要：`analyses.json` 是这个项目最有价值的资产——
 * 置信度校准、准确率回测全靠它一条条攒出来，攒几周才够用。
 * 而它现在是单机单副本、被 .gitignore 排除、没有任何快照。
 * 误删一次或者写盘写到一半断电，几周的样本就没了，一切从头开始。
 *
 * ⚠️ **同盘快照不等于异地备份**。这里做的事只防两种情况：
 * 误删、以及写入过程被打断导致文件损坏。硬盘坏了、机器丢了，
 * 它一点忙都帮不上。真要防那个，把 DATA_BACKUP_DIR 指到
 * 外接盘或同步盘（iCloud / Dropbox / 坚果云都行）。
 * 这一点必须说清楚——以为自己有备份而其实没有，比明知没有更危险。
 */

import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = path.join(process.cwd(), 'data');

/** 需要快照的文件。锁文件与备份目录本身不在其中 */
const FILES = ['analyses.json', 'alert-rules.json', 'alert-events.json'];

/** 保留多少份。每天一份，两周足够覆盖「上周好像还在」这类回溯需求 */
const KEEP = 14;

export const backupDir = () =>
  process.env.DATA_BACKUP_DIR?.trim() || path.join(DATA_DIR, 'backups');

export interface BackupResult {
  dir: string;
  files: string[];
  /** 因为源文件不存在而跳过的（首次运行时 alert-events 可能还没有） */
  skipped: string[];
  pruned: number;
}

/**
 * 打一份快照。
 *
 * 用「日期」而不是「时间戳」做目录名：一天一份就够，
 * 而且这样重复调用是幂等的——worker 每轮都调用也不会堆出上千个目录。
 */
export async function backupDataFiles(now = new Date()): Promise<BackupResult | null> {
  const stamp = now.toISOString().slice(0, 10);
  const root = backupDir();
  const dest = path.join(root, stamp);

  const files: string[] = [];
  const skipped: string[] = [];

  await mkdir(dest, { recursive: true });

  for (const name of FILES) {
    const src = path.join(DATA_DIR, name);
    try {
      await stat(src);
    } catch {
      skipped.push(name);
      continue;
    }
    // copyFile 不是原子的，但源文件的写入本身已经串行化（store.ts），
    // 且这里只是快照——真正的一致性保证在写入侧，不在这里
    await copyFile(src, path.join(dest, name));
    files.push(name);
  }

  // 一个文件都没备份到时把空目录删掉，不留下误导性的痕迹
  if (files.length === 0) {
    await rm(dest, { recursive: true, force: true }).catch(() => {});
    return null;
  }

  return { dir: dest, files, skipped, pruned: await prune(root) };
}

/** 只保留最近 KEEP 份。目录名是日期，字典序即时间序 */
async function prune(root: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return 0;
  }

  const snapshots = entries.filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e)).sort();
  const excess = snapshots.slice(0, Math.max(0, snapshots.length - KEEP));
  for (const dir of excess) {
    await rm(path.join(root, dir), { recursive: true, force: true }).catch(() => {});
  }
  return excess.length;
}
