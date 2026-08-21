'use client';

/**
 * OKX 盘口与主动成交流。
 *
 * 与 microstructure.ts（币安）对外发出同一个 `Microstructure`，
 * 由 useMicrostructure 按数据来源挑用哪一条。
 *
 * 三处与币安不同：
 *   1. 订阅靠消息、重连后要重发（币安写在 URL 里）
 *   2. 必须自己发字面量 "ping" 心跳，30 秒不发就断
 *   3. **主动方向是直给的**：trades 的 side 就是 taker 方向，
 *      buy = 主动买入。币安给的是 `m`（买方是否为挂单方），要取反——
 *      那个取反是最容易写错的地方，OKX 这里反而省心
 */

import type { Microstructure } from './microstructure';

const OKX_WS = 'wss://ws.okx.com:8443/ws/v5/public';
const PING_INTERVAL_MS = 20_000;
const WINDOW_MS = 60_000;
const EMIT_INTERVAL_MS = 500;

interface OkxBooks5 {
  bids: [string, string, string, string][];
  asks: [string, string, string, string][];
}

interface OkxTrade {
  px: string;
  sz: string;
  side: 'buy' | 'sell';
  ts: string;
}

type Listener = (m: Microstructure) => void;

const toInstId = (symbol: string): string | null => {
  const m = /^([A-Z0-9]+)(USDT|USDC)$/.exec(symbol);
  return m ? `${m[1]}-${m[2]}` : null;
};

export class OkxMicrostructureStream {
  private ws: WebSocket | null = null;
  private symbol = '';
  private listeners = new Set<Listener>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private emitTimer: ReturnType<typeof setInterval> | null = null;
  private closedByUser = false;

  private trades: { t: number; qty: number; quote: number; takerBuy: boolean }[] = [];
  private book: { bid: number; bidQty: number; ask: number; askQty: number } | null = null;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setSymbol(symbol: string) {
    if (symbol === this.symbol) return;
    this.symbol = symbol;
    // 换币种时窗口必须清空，否则会算出两个币的混合物
    this.trades = [];
    this.book = null;
    this.connect();
  }

  private connect() {
    this.closedByUser = false;
    this.cleanup();
    const instId = this.symbol ? toInstId(this.symbol) : null;
    if (!instId) return;

    const ws = new WebSocket(OKX_WS);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      ws.send(
        JSON.stringify({
          op: 'subscribe',
          args: [
            { channel: 'books5', instId },
            { channel: 'trades', instId },
          ],
        }),
      );
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
          data?: (OkxBooks5 | OkxTrade)[];
        };
        if (msg.event || !msg.data) return;

        if (msg.arg?.channel === 'books5') {
          const b = msg.data[0] as OkxBooks5;
          if (b.bids?.[0] && b.asks?.[0]) {
            this.book = {
              bid: +b.bids[0][0],
              bidQty: +b.bids[0][1],
              ask: +b.asks[0][0],
              askQty: +b.asks[0][1],
            };
          }
        } else if (msg.arg?.channel === 'trades') {
          for (const t of msg.data as OkxTrade[]) {
            const qty = +t.sz;
            this.trades.push({
              t: +t.ts,
              qty,
              quote: qty * +t.px,
              // side 直接就是 taker 方向，不需要像币安那样取反
              takerBuy: t.side === 'buy',
            });
          }
        }
      } catch {
        // 单条消息解析失败不该拖垮整条流
      }
    };

    ws.onclose = () => {
      if (!this.closedByUser) this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();

    this.emitTimer = setInterval(() => this.emit(), EMIT_INTERVAL_MS);
  }

  private emit() {
    if (!this.book) return;
    const now = Date.now();
    this.trades = this.trades.filter((t) => now - t.t <= WINDOW_MS);

    const buyQty = this.trades.filter((t) => t.takerBuy).reduce((a, t) => a + t.qty, 0);
    const totalQty = this.trades.reduce((a, t) => a + t.qty, 0);
    const { bid, ask, bidQty, askQty } = this.book;
    const mid = (bid + ask) / 2;

    const m: Microstructure = {
      symbol: this.symbol,
      bid,
      ask,
      spreadBps: mid > 0 ? ((ask - bid) / mid) * 10_000 : 0,
      imbalance: bidQty + askQty > 0 ? (bidQty - askQty) / (bidQty + askQty) : 0,
      takerBuyRatio: this.trades.length >= 10 && totalQty > 0 ? (buyQty / totalQty) * 100 : null,
      tradeCount: this.trades.length,
      turnover: this.trades.reduce((a, t) => a + t.quote, 0),
      updatedAt: now,
    };
    this.listeners.forEach((fn) => fn(m));
  }

  /** 起步 2 秒：OKX 每 IP 每秒只允许 3 次连接请求，越急越连不上 */
  private scheduleReconnect() {
    const delay = Math.min(2000 * 2 ** this.reconnectAttempts, 30_000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private cleanup() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.emitTimer) clearInterval(this.emitTimer);
    this.pingTimer = null;
    this.emitTimer = null;
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
