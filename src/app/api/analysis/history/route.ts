import { NextResponse } from 'next/server';
import { readRecords } from '@/lib/history/store';
import { computeStats, evaluateDueRecords } from '@/lib/history/evaluate';

/** 拉取历史与准确率统计。顺带把到期未评估的记录评估掉。 */
export const maxDuration = 60;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get('symbol')?.toUpperCase();
  // 默认顺手评估到期记录，让准确率随打开页面自动累积，无需手动触发
  const skipEval = searchParams.get('evaluate') === '0';

  if (!skipEval) {
    try {
      // 常驻 worker 也会定期做这件事（见 alerts/worker.ts）。
      // 这里保留是因为：手动 npm run dev 时没有常驻进程，
      // 而打开面板的人正期待看到最新结果
      await evaluateDueRecords();
    } catch (err) {
      console.warn('[history] 评估失败：', err);
    }
  }

  const records = await readRecords();

  const scoped = symbol ? records.filter((r) => r.symbol === symbol) : records;

  return NextResponse.json({
    // 倒序返回，最新的在前
    records: [...scoped].reverse().slice(0, 100),
    stats: computeStats(scoped),
    // 全局统计始终返回，便于对比"这个币"和"整体"的准确率差异
    globalStats: symbol ? computeStats(records) : null,
  });
}
