'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { BinanceStream, type MiniTick } from '../ws/binance-stream';
import { OkxStream } from '../ws/okx-stream';

/**
 * 订阅一组币种的实时行情。
 *
 * 返回 symbol -> MiniTick 的 map。两条 WebSocket 并存：
 * 币安一条、OKX 一条，按服务端给出的路由把币种分到各自的流里。
 * 上层拿到的是同一个 MiniTick，不需要知道数据来自哪家。
 *
 * **路由只信服务端**（/api/market/routes）。前端不自己维护
 * 「哪些币在 OKX」的名单——两处规则迟早不一致，而那种不一致的表现是
 * 「某个币的价格不动了」，几乎不可能联想到是路由判断分歧。
 *
 * REST 轮询继续保留作为兜底：WebSocket 只在有成交时推送，
 * 冷门币可能几分钟不动；路由还没拉到时也靠它先把价格填上。
 */
const REST_POLL_MS = 10_000;

export function useLiveTickers(symbols: string[]): Record<string, MiniTick> {
  const [ticks, setTicks] = useState<Record<string, MiniTick>>({});
  const [routes, setRoutes] = useState<Record<string, string>>({});
  const binanceRef = useRef<BinanceStream | null>(null);
  const okxRef = useRef<OkxStream | null>(null);

  const key = useMemo(() => [...symbols].sort().join(','), [symbols]);

  // 两条流各建一次，symbols 变化只改订阅
  useEffect(() => {
    const binance = new BinanceStream();
    const okx = new OkxStream();
    binanceRef.current = binance;
    okxRef.current = okx;

    const onTick = (tick: MiniTick) => setTicks((prev) => ({ ...prev, [tick.symbol]: tick }));
    const offB = binance.subscribe(onTick);
    const offO = okx.subscribe(onTick);

    return () => {
      offB();
      offO();
      binance.close();
      okx.close();
      binanceRef.current = null;
      okxRef.current = null;
    };
  }, []);

  // 查询路由。失败时全部按币安处理——绝大多数币在币安，
  // 猜错的代价是那一路收不到数据，而 REST 轮询会兜住
  useEffect(() => {
    if (!key) return;
    const ac = new AbortController();
    fetch(`/api/market/routes?symbols=${key}`, { signal: ac.signal })
      .then((r) => r.json())
      .then((d: { routes?: Record<string, string> }) => setRoutes(d.routes ?? {}))
      .catch(() => {});
    return () => ac.abort();
  }, [key]);

  // 按路由分流
  useEffect(() => {
    if (!key) return;
    const list = key.split(',');
    binanceRef.current?.setSymbols(list.filter((s) => routes[s] !== 'okx'));
    okxRef.current?.setSymbols(list.filter((s) => routes[s] === 'okx'));
  }, [key, routes]);

  /**
   * REST 兜底轮询。
   *
   * 对所有币种都跑，不区分来源：路由还没返回时它是唯一的价格来源，
   * 而 WS 推来的数据更新鲜，所以只在该币的 WS 数据已经过期时才覆盖。
   */
  useEffect(() => {
    if (!key) return;
    const ac = new AbortController();

    const poll = async () => {
      try {
        const res = await fetch(`/api/market/tickers?symbols=${key}`, { signal: ac.signal });
        if (!res.ok) return;
        const data: {
          tickers: {
            symbol: string;
            last: number;
            high24h: number;
            low24h: number;
            quoteVolume24h: number;
            changePercent: number;
          }[];
        } = await res.json();

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
