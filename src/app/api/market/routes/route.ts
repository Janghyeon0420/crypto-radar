import { NextResponse } from 'next/server';
import { resolveExchange } from '@/lib/datasources/market';

/**
 * 查询一组币种各自的数据来源。
 *
 * 前端需要它来决定「这个币的实时行情该连哪家的 WebSocket」。
 * 单独一个轻量接口，而不是让前端去解析 /api/market/symbols 的 900 条列表——
 * 那个响应有几十 KB，只为查四五个币的归属不值得。
 *
 * 更重要的是**路由规则只有一份**：前端不自己维护「哪些币在 OKX」的名单，
 * 否则两处规则迟早不一致，而那种不一致的表现是「某个币的价格不动了」，
 * 极难联想到是路由判断分歧。
 */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get('symbols') ?? '';
  const symbols = raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z0-9]{5,20}$/.test(s))
    .slice(0, 50);

  const entries = await Promise.all(
    symbols.map(async (s) => [s, await resolveExchange(s)] as const),
  );

  return NextResponse.json({ routes: Object.fromEntries(entries) });
}
