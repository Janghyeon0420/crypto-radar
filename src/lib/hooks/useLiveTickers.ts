'use client';

import { useEffect, useRef, useState } from 'react';
import { BinanceStream, type MiniTick } from '../ws/binance-stream';

/**
 * 订阅一组币种的实时行情。
 *
 * 返回 symbol -> MiniTick 的 map。组件用它做实时价格更新，
 * 而 24h 统计等仍走 REST 兜底——WebSocket 只在有成交时推送，
 * 冷门币可能几分钟不动，光靠 WS 会让面板长时间空着。
 *
 * **币安没有的币种（如 HYPE，数据来自 OKX）走 REST 轮询兜底**。
 * 实测把 `hypeusdt@miniTicker` 混进币安组合流不会拒连、也不影响其它币，
 * 但那一路永远收不到数据——于是那个币的价格会一直停在首屏那一刻，
 * 看上去像「行情不动了」而不是「没有数据源」。这种静默失真必须避免。
 */
const REST_POLL_MS = 10_000;

export function useLiveTickers(symbols: string[]): Record<string, MiniTick> {
  const [ticks, setTicks] = useState<Record<string, MiniTick>>({});
  const streamRef = useRef<BinanceStream | null>(null);

  useEffect(() => {
    const stream = new BinanceStream();
    streamRef.current = stream;
    const unsubscribe = stream.subscribe((tick) => {
      setTicks((prev) => ({ ...prev, [tick.symbol]: tick }));
    });
    return () => {
      unsubscribe();
      stream.close();
      streamRef.current = null;
    };
  }, []);

  // symbols 变化时只改订阅，不重建连接对象
  useEffect(() => {
    streamRef.current?.setSymbols(symbols);
  }, [symbols]);

  /**
   * REST 兜底轮询。
   *
   * 对所有币种都跑，而不是只对 OKX 的——因为「哪个币在哪家」是服务端的判断，
   * 前端不该自己维护一份可能过期的名单。多几个 REST 请求的代价，
   * 小于两处路由规则不一致带来的困惑。
   *
   * WS 推来的数据更新鲜，所以只在该币还没有 WS 数据、
   * 或 REST 的时间戳更新时才覆盖。
   */
  const key = [...symbols].sort().join(',');
  useEffect(() => {
    if (!key) return;
    const ac = new AbortController();

    const poll = async () => {
      try {
        const res = await fetch(`/api/market/tickers?symbols=${key}`, { signal: ac.signal });
        if (!res.ok) return;
        const data: { tickers: { symbol: string; last: number; high24h: number; low24h: number; quoteVolume24h: number; changePercent: number }[] } =
          await res.json();

        setTicks((prev) => {
          const next = { ...prev };
          for (const t of data.tickers) {
            const existing = next[t.symbol];
            // WS 每秒都在推，比 10 秒一次的轮询新鲜得多，别用旧数据盖掉它
            if (existing && Date.now() - existing.eventTime < REST_POLL_MS) continue;
            next[t.symbol] = {
              symbol: t.symbol,
              last: t.last,
              // MiniTick 用 open24h 反推涨跌幅，这里由 changePercent 还原
              open24h: t.changePercent !== 0 ? t.last / (1 + t.changePercent / 100) : t.last,
              high24h: t.high24h,
              low24h: t.low24h,
              volume24h: t.quoteVolume24h,
              eventTime: Date.now(),
            };
          }
          return next;
        });
      } catch {
        // 轮询失败静默处理：WS 仍在工作，下一轮会自愈
      }
    };

    const first = setTimeout(poll, 0);
    const timer = setInterval(poll, REST_POLL_MS);
    return () => {
      ac.abort();
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [key]);

  return ticks;
}
