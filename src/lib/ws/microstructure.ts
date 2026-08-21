'use client';

/**
 * 盘口与主动成交的实时流。
 *
 * 这是本项目里**唯一的秒级维度**——其余全部基于 K 线，最快也是分钟级。
 *
 * 定位要说清楚：回测显示主动买卖占比**不构成方向信号**
 * （`npm run backtest:flow`，11 组周期/跨度组合，最高信息量 +1.5pt 且随跨度衰减）。
 * 它的价值在于回答「此刻正在发生什么」：价差是不是突然变宽（流动性变差）、
 * 这波拉升是主动买盘推的还是卖盘撤单造成的。这些是**状态**，不是预测。
 *
 * 只订阅当前选中的币：bookTicker 每次盘口变化都推、aggTrade 每笔成交都推，
 * 给整个自选列表订阅纯属浪费带宽和电量。
 */

import { BINANCE_WS } from '../datasources/binance-vision';

export interface Microstructure {
  symbol: string;
  /** 买一价 / 卖一价 */
  bid: number;
  ask: number;
  /** 价差，单位是基点（万分之一）。加密的正常价差通常在 1 个基点上下 */
  spreadBps: number;
  /**
   * 盘口失衡：(买一量 − 卖一量) / (买一量 + 卖一量)，范围 -1 ~ 1。
   * 只反映最优档，不代表整个盘口——大单常挂在更远的档位上。
   */
  imbalance: number;
  /** 近 60 秒主动买入占比 %，成交太少时为 null */
  takerBuyRatio: number | null;
  /** 近 60 秒的成交笔数 */
  tradeCount: number;
  /** 近 60 秒的成交额（计价币） */
  turnover: number;
  updatedAt: number;
}

interface RawBookTicker {
  s: string;
  b: string;
  B: string;
  a: string;
  A: string;
}

interface RawAggTrade {
  e: string;
  s: string;
  p: string;
  q: string;
  T: number;
  /** 买方是否为挂单方。true = taker 在卖出 */
  m: boolean;
}

/** 主动成交的滚动窗口长度 */
const WINDOW_MS = 60_000;

/** 界面刷新节流。aggTrade 每秒可能几十条，全推给 React 只会烧 CPU */
const EMIT_INTERVAL_MS = 500;

type Listener = (m: Microstructure) => void;

export class MicrostructureStream {
  private ws: WebSocket | null = null;
  private symbol = '';
  private listeners = new Set<Listener>();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private emitTimer: ReturnType<typeof setInterval> | null = null;
  private closedByUser = false;

  /** 滚动窗口内的成交。定期裁剪，不然长时间开着会无限增长 */
  private trades: { t: number; qty: number; quote: number; takerBuy: boolean }[] = [];
  private book: { bid: number; bidQty: number; ask: number; askQty: number } | null = null;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setSymbol(symbol: string) {
    if (symbol === this.symbol) return;
    this.symbol = symbol;
    // 换币种时窗口必须清空——沿用上一个币的成交会算出一个混合物
    this.trades = [];
    this.book = null;
    this.connect();
  }

  private connect() {
    this.closedByUser = false;
    this.cleanup();
    if (!this.symbol) return;

    const s = this.symbol.toLowerCase();
    const ws = new WebSocket(`${BINANCE_WS}/stream?streams=${s}@bookTicker/${s}@aggTrade`);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data as string) as {
          stream?: string;
          data?: RawBookTicker | RawAggTrade;
        };
        const d = payload.data;
        if (!d) return;

        if (payload.stream?.endsWith('@bookTicker')) {
          const b = d as RawBookTicker;
          this.book = { bid: +b.b, bidQty: +b.B, ask: +b.a, askQty: +b.A };
        } else if ((d as RawAggTrade).e === 'aggTrade') {
          const t = d as RawAggTrade;
          const qty = +t.q;
          // m=true 表示买方是挂单方，即这笔是 taker 主动卖出
          this.trades.push({ t: t.T, qty, quote: qty * +t.p, takerBuy: !t.m });
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
    // 先裁剪再统计，否则窗口会一直变长
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
      // 成交笔数太少时比例毫无意义，宁可不给
      takerBuyRatio: this.trades.length >= 10 && totalQty > 0 ? (buyQty / totalQty) * 100 : null,
      tradeCount: this.trades.length,
      turnover: this.trades.reduce((a, t) => a + t.quote, 0),
      updatedAt: now,
    };
    this.listeners.forEach((fn) => fn(m));
  }

  /** 指数退避重连，上限 30 秒——币安会定期主动断开长连接，重连是常态 */
  private scheduleReconnect() {
    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30_000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private cleanup() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.emitTimer) clearInterval(this.emitTimer);
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
