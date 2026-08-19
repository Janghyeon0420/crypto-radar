'use client';

import { useEffect, useRef, useState } from 'react';
import { BinanceStream, type MiniTick } from '../ws/binance-stream';

/**
 * 订阅一组币种的实时行情。
 *
 * 返回 symbol -> MiniTick 的 map。组件用它做实时价格更新，
 * 而 24h 统计等仍走 REST 兜底——WebSocket 只在有成交时推送，
 * 冷门币可能几分钟不动，光靠 WS 会让面板长时间空着。
 */
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

  return ticks;
}
