import { NextResponse } from 'next/server';
import { fetchDerivatives } from '@/lib/datasources/okx';
import { apiError } from '@/lib/api-error';

export async function GET(req: Request) {
  const symbol = (new URL(req.url).searchParams.get('symbol') ?? 'BTCUSDT').toUpperCase();
  try {
    // 无对应永续合约时返回 null 而非报错——很多小币确实没有合约，这是正常状态
    return NextResponse.json({ derivatives: await fetchDerivatives(symbol) });
  } catch (err) {
    return apiError(err, 'okx');
  }
}
