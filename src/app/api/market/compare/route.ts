import { NextResponse } from 'next/server';
import { fetchCandles } from '@/lib/datasources/market';
import { apiError } from '@/lib/api-error';

/**
 * 多币种横向对比。
 *
 * 一次 1h K 线请求（168 根 = 7 天）就能同时算出 1h / 24h / 7d 三个窗口，
 * 不必为每个窗口各拉一次。窗口选这三个是因为它们对应三种不同的问题：
 * 刚刚发生了什么、今天谁强、这一周资金往哪流。
 *
 * 相对强弱以 BTC 为基准：加密市场高度同涨同跌，
 * 「涨了 5%」本身说明不了什么，「比 BTC 多涨 3%」才是信息。
 */
const WINDOWS = { h1: 1, h24: 24, d7: 168 } as const;

export interface CompareRow {
  symbol: string;
  price: number;
  /** 各窗口涨跌幅 % */
  returns: { h1: number | null; h24: number | null; d7: number | null };
  /** 相对 BTC 的超额收益（百分点）。BTC 自身为 0 */
  relative: { h1: number | null; h24: number | null; d7: number | null };
}

const changeOver = (closes: number[], bars: number): number | null => {
  if (closes.length <= bars) return null;
  const from = closes[closes.length - 1 - bars];
  const to = closes[closes.length - 1];
  return from > 0 ? ((to - from) / from) * 100 : null;
};

export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get('symbols') ?? '';
  const symbols = raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z0-9]{5,20}$/.test(s))
    .slice(0, 20);

  if (symbols.length === 0) {
    return NextResponse.json({ error: '缺少 symbols 参数' }, { status: 400 });
  }

  try {
    const sets = await Promise.all(
      symbols.map((s) =>
        fetchCandles(s, '1h', 200).catch(() => [] as Awaited<ReturnType<typeof fetchCandles>>),
      ),
    );

    const closesBySymbol = new Map(sets.map((c, i) => [symbols[i], c.map((k) => k.close)]));
    const btc = closesBySymbol.get('BTCUSDT');
    // 自选里没有 BTC 时，相对强弱无从谈起——如实返回 null 而不是拿别的币当基准
    const btcReturns = btc
      ? {
          h1: changeOver(btc, WINDOWS.h1),
          h24: changeOver(btc, WINDOWS.h24),
          d7: changeOver(btc, WINDOWS.d7),
        }
      : null;

    const rows: CompareRow[] = symbols
      .map((symbol) => {
        const closes = closesBySymbol.get(symbol) ?? [];
        if (closes.length === 0) return null;

        const returns = {
          h1: changeOver(closes, WINDOWS.h1),
          h24: changeOver(closes, WINDOWS.h24),
          d7: changeOver(closes, WINDOWS.d7),
        };
        const rel = (k: keyof typeof returns) =>
          btcReturns && returns[k] !== null && btcReturns[k] !== null
            ? returns[k]! - btcReturns[k]!
            : null;

        return {
          symbol,
          price: closes[closes.length - 1],
          returns,
          relative: { h1: rel('h1'), h24: rel('h24'), d7: rel('d7') },
        };
      })
      .filter((r): r is CompareRow => r !== null);

    return NextResponse.json({ rows, benchmark: btcReturns ? 'BTCUSDT' : null });
  } catch (err) {
    return apiError(err, 'binance.vision');
  }
}
