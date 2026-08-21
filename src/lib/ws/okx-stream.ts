'use client';

/**
 * OKX 实时行情 WebSocket。
 *
 * 与币安那条流并存，不是替代：币安没有的币种（如 HYPE）走这里。
 * 对外发出的是同一个 `MiniTick`，上层不需要区分数据来自哪家。
 *
 * 三处与币安不同，每一处写错都只表现为「行情不动了」而不会报错：
 *
 *   1. **订阅靠消息而非 URL**。连上之后再发 subscribe，
 *      所以重连后必须重新订阅——币安是把订阅写在 URL 里，重连自动带上。
 *   2. **必须自己发心跳**。OKX 规定 30 秒无数据即断开，客户端要定期发
 *      字面量 "ping"（不是 JSON），服务端回 "pong"。币安是服务端管的。
 *   3. **连接频率受限**（每 IP 每秒 3 次）。实测短时间内反复重连会被拒，
 *      表现为 code 1006。所以退避从 2 秒起，比币安那条更保守。
 */

import type { MiniTick } from './binance-stream';

const OKX_WS = 'wss://ws.okx.com:8443/ws/v5/public';

/** 心跳间隔。OKX 的超时是 30 秒，取 20 秒留足余量 */
const PING_INTERVAL_MS = 20_000;

interface OkxTickerData {
  instId: string;
  last: string;
  open24h: string;
  high24h: string;
  low24h: string;
  volCcy24h: string;
  ts: string;
}

type Listener = (tick: MiniTick) => void;

/** BTCUSDT -> BTC-USDT */
const toInstId = (symbol: string): string | null => {
  const m = /^([A-Z0-9]+)(USDT|USDC)$/.exec(symbol);
  return m ? `${m[1]}-${m[2]}` : null;
};

/** BTC-USDT -> BTCUSDT */
const fromInstId = (instId: string): string => instId.replace('-', '');

export class OkxStream {
  private ws: WebSocket | null = null;
  private symbols: string[] = [];
  private listeners = new Set<Listener>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closedByUser = false;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setSymbols(symbols: string[]) {
    const next = [...symbols].sort();
    if (next.join(',') === [...this.symbols].sort().join(',')) return;
    this.symbols = symbols;

    // 已连接时只改订阅，不重连——OKX 的连接频率有限制，
    // 每次改自选都重连很容易撞上
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscribe();
      return;
    }
    this.connect();
  }

  private sendSubscribe() {
    const args = this.symbols
      .map(toInstId)
      .filter((id): id is string => id !== null)
      .map((instId) => ({ channel: 'tickers', instId }));
    if (args.length === 0) return;
    this.ws?.send(JSON.stringify({ op: 'subscribe', args }));
  }

  private connect() {
    this.closedByUser = false;
    this.cleanup();
    if (this.symbols.length === 0) return;

    const ws = new WebSocket(OKX_WS);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      // 订阅必须在连上之后发，且重连后要重发
      this.sendSubscribe();
      // 心跳发字面量 ping，不是 JSON——发成 JSON 服务端不认，
      // 30 秒后静默断开，看起来就像「网络不稳定」
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('ping');
      }, PING_INTERVAL_MS);
    };

    ws.onmessage = (event) => {
      const raw = event.data as string;
      if (raw === 'pong') return;
      try {
        const msg = JSON.parse(raw) as {
          event?: string;
          arg?: { channel?: string };
          data?: OkxTickerData[];
        };
        if (msg.event || msg.arg?.channel !== 'tickers' || !msg.data) return;

        for (const d of msg.data) {
          const open = +d.open24h;
          this.listeners.forEach((fn) =>
            fn({
              symbol: fromInstId(d.instId),
              last: +d.last,
              open24h: open,
              high24h: +d.high24h,
              low24h: +d.low24h,
              volume24h: +d.volCcy24h,
              eventTime: +d.ts,
            }),
          );
        }
      } catch {
        // 单条消息解析失败不该拖垮整条流
      }
    };

    ws.onclose = () => {
      if (!this.closedByUser) this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  /**
   * 指数退避重连，起步 2 秒、上限 30 秒。
   * 比币安那条起步慢一倍：OKX 每 IP 每秒只允许 3 次连接请求，
   * 实测过于积极的重连会被直接拒（code 1006），越急越连不上。
   */
  private scheduleReconnect() {
    const delay = Math.min(2000 * 2 ** this.reconnectAttempts, 30_000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private cleanup() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
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
