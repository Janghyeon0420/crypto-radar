import { NextResponse } from 'next/server';
import { SteadyUpdateSchema } from '@/lib/steady/schema';
import { checkLocalRequest, lanAllowed } from '@/lib/steady/guard';
import { readState, updateState } from '@/lib/steady/store';
import { buildSummary } from '@/lib/steady/summary';

/**
 * 稳健驾驶舱：读取 = 计划 + 持仓 + 实时估值 + 风险体检 + 今日行动；写入 = 更新计划或持仓。
 *
 * 返回的永远是「刚算出来的完整视图」：PUT 保存后直接把新视图带回去，
 * 前端不必再发一次 GET，也不会出现「保存了但界面还是旧数字」的瞬间。
 *
 * 这里存的是持仓与投资计划——第一份财务数据，所以两个方法都先过本机访问保护（见 guard.ts）。
 */

const noStore = { 'cache-control': 'no-store' };

function denied(reason: string) {
  return NextResponse.json({ error: reason, code: 'LOCAL_ONLY' }, { status: 403, headers: noStore });
}

export async function GET(req: Request) {
  const guard = checkLocalRequest(req.headers, { allowLan: lanAllowed() });
  if (!guard.ok) return denied(guard.reason);

  try {
    return NextResponse.json(await buildSummary(await readState()), { headers: noStore });
  } catch (err) {
    console.warn('[steady] 读取失败：', err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `读取失败：${message}` }, { status: 500, headers: noStore });
  }
}

export async function PUT(req: Request) {
  const guard = checkLocalRequest(req.headers, { allowLan: lanAllowed() });
  if (!guard.ok) return denied(guard.reason);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: '请求体必须是 JSON' }, { status: 400, headers: noStore });
  }

  const parsed = SteadyUpdateSchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(根)'}：${i.message}`)
      .join('；');
    return NextResponse.json({ error: `数据不合法：${issues}` }, { status: 400, headers: noStore });
  }

  try {
    const state = await updateState(parsed.data);
    return NextResponse.json(await buildSummary(state), { headers: noStore });
  } catch (err) {
    console.warn('[steady] 保存失败：', err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `保存失败：${message}` }, { status: 500, headers: noStore });
  }
}
