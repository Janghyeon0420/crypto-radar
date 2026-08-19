import { NextResponse } from 'next/server';
import { fetchNews, filterNewsByAsset } from '@/lib/datasources/news';

/** RSS 必须服务端拉，浏览器直连会被 CORS 拦。asset 传 BTC/ETH 等做关键词过滤。 */
export async function GET(req: Request) {
  const asset = new URL(req.url).searchParams.get('asset')?.toUpperCase();
  const all = await fetchNews(60);
  const filtered = asset ? filterNewsByAsset(all, asset) : all;
  return NextResponse.json({ news: filtered.slice(0, 30), total: all.length });
}
