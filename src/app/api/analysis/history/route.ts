import { NextResponse } from 'next/server';
import { readRecords, updateRecords } from '@/lib/history/store';
import { computeStats, evaluatePending } from '@/lib/history/evaluate';

/** 拉取历史与准确率统计。顺带把到期未评估的记录评估掉。 */
export const maxDuration = 60;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get('symbol')?.toUpperCase();
  // 默认顺手评估到期记录，让准确率随打开页面自动累积，无需手动触发
  const skipEval = searchParams.get('evaluate') === '0';

  let records = await readRecords();

  if (!skipEval) {
    try {
      const updated = await evaluatePending(records);
      // 只有确实产生了新评估才写盘，避免每次打开都无谓地重写文件
      if (updated.some((r, i) => r.evaluation !== records[i].evaluation)) {
        records = await updateRecords(() => updated);
      }
    } catch (err) {
      console.warn('[history] 评估失败：', err);
    }
  }

  const scoped = symbol ? records.filter((r) => r.symbol === symbol) : records;

  return NextResponse.json({
    // 倒序返回，最新的在前
    records: [...scoped].reverse().slice(0, 100),
    stats: computeStats(scoped),
    // 全局统计始终返回，便于对比"这个币"和"整体"的准确率差异
    globalStats: symbol ? computeStats(records) : null,
  });
}
