'use client';

/**
 * 币安实时行情 WebSocket。
 *
 * 用 data-stream.binance.vision 而非 stream.binance.com——后者在受限网络下直接超时
 * （实测见 docs/DATA-SOURCES.md）。该镜像同样是币安官方公开数据流，不做地理封锁。
 *
 * 浏览器直连而不经服务端转发：WebSocket 从用户浏览器出去，少一跳延迟，
 * 而且这是公开数据流，不涉及任何凭据，没有必要让服务端当中间人。
 */

import { BINANCE_WS } from '../datasources/binance-vision';

export interface MiniTick {
  symbol: string;
  last: number;
  open24h: number;
  high24h: number;
  low24h: number;
  volume24h: number;
  eventTime: number;
}

interface RawMiniTicker {
  e: string;
  E: number;
  s: string;
  c: string;
  o: string;
  h: string;
  l: string;
  q: string;
}

type Listener = (tick: MiniTick) => void;

/**
 * 单连接多路复用。所有自选币共用一条 combined stream，
 * 比每个币开一条连接省资源，也避免浏览器的并发连接数限制。
 */
export class BinanceStream {
  private ws: WebSocket | null = null;
  private symbols: string[] = [];
  private listeners = new Set<Listener>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 更新订阅的币种集合。变化时重连——combined stream 的订阅在 URL 里。 */
  setSymbols(symbols: string[]) {
    const next = [...symbols].sort();
    if (next.join(',') === [...this.symbols].sort().join(',')) return;
    this.symbols = symbols;
    this.connect();
  }

  private connect() {
    this.closedByUser = false;
    this.cleanup();
    if (this.symbols.length === 0) return;

    const streams = this.symbols.map((s) => `${s.toLowerCase()}@miniTicker`).join('/');
    const ws = new WebSocket(`${BINANCE_WS}/stream?streams=${streams}`);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data as string) as { data?: RawMiniTicker };
        const d = payload.data;
        if (!d || d.e !== '24hrMiniTicker') return;
        const tick: MiniTick = {
          symbol: d.s,
          last: +d.c,
          open24h: +d.o,
          high24h: +d.h,
          low24h: +d.l,
          volume24h: +d.q,
          eventTime: d.E,
        };
        this.listeners.forEach((fn) => fn(tick));
      } catch {
        // 单条消息解析失败不该拖垮整条流，丢弃即可
      }
    };

    ws.onclose = () => {
      if (!this.closedByUser) this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  /** 指数退避重连，上限 30 秒——币安会定期主动断开长连接，重连是常态而非异常 */
  private scheduleReconnect() {
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30_000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private cleanup() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
      this.ws = null;
    }
  }

  close() {
    this.closedByUser = true;
    this.cleanup();
    this.listeners.clear();
  }
}
