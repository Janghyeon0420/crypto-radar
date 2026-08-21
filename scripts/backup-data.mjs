#!/usr/bin/env node
/**
 * 手动打一份 data/ 快照。
 *
 * 常驻服务每天会自动做一次（见 alerts/worker.ts），
 * 这个脚本用于「我马上要做一件可能搞砸的事」的场合。
 *
 * 跑法：npm run backup
 *       DATA_BACKUP_DIR=/Volumes/外接盘/radar npm run backup
 */
import { backupDataFiles, backupDir } from '../src/lib/history/backup.ts';

const r = await backupDataFiles();
if (!r) {
  console.log(`data/ 下没有可备份的文件（预期 analyses.json 等）`);
  process.exit(0);
}
console.log(`已备份到 ${r.dir}`);
console.log(`  文件：${r.files.join('、')}`);
if (r.skipped.length) console.log(`  跳过（不存在）：${r.skipped.join('、')}`);
if (r.pruned) console.log(`  清理了 ${r.pruned} 份过期快照`);

if (backupDir().startsWith(process.cwd())) {
  console.log(
    `\n注意：快照与源文件在同一块盘上。这防得住误删和写坏，` +
      `\n防不住硬盘故障或机器丢失。要防那个，把 DATA_BACKUP_DIR 指到外接盘或同步盘。`,
  );
}
