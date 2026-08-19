import { NextResponse } from 'next/server';
import { fetchFearGreed, fetchFearGreedHistory } from '@/lib/datasources/sentiment';

export async function GET(req: Request) {
  const withHistory = new URL(req.url).searchParams.get('history') === '1';
  const [current, history] = await Promise.all([
    fetchFearGreed(),
    withHistory ? fetchFearGreedHistory(30) : Promise.resolve([]),
  ]);
  return NextResponse.json({ sentiment: current, history });
}
