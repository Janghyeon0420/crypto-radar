'use client';

import { useMicrostructure } from '@/lib/hooks/useMicrostructure';
import { formatCompact, formatPrice } from '@/lib/format';

/**
 * 盘口与主动成交（秒级）。
 *
 * 刻意做得克制：**回测显示主动买卖占比不构成方向信号**
 * （npm run backtest:flow，11 组周期/跨度组合，最好的一组也只有 +1.5pt 且随跨度衰减）。
 * 所以这里不给方向判断、不配进度条、不加涨跌配色暗示——
 * 它回答的是「此刻正在发生什么」：价差是否变宽、这波成交是谁在主动。
 */
export function MicrostructurePanel({
  symbol,
  source,
}: {
  symbol: string;
  /** 该币的数据来自哪家。盘口流只覆盖币安 */
  source?: string;
}) {
  const unsupported = source !== undefined && source !== 'binance';
  const m = useMicrostructure(unsupported ? '' : symbol);

  return (
    <div className="border-b border-zinc-800 px-4 py-3">
      <div className="flex items-center justify-between">
        <span
          className="cursor-help text-xs uppercase tracking-wide text-zinc-500"
          title="来自 WebSocket 的秒级盘口与逐笔成交，统计窗口 60 秒。这是状态描述，不是方向信号——回测显示主动买卖占比不具备预测力。"
        >
          盘口 · 近 60 秒
        </span>
        <span className="text-[11px] text-zinc-600">
          {unsupported ? '不可用' : m ? `${m.tradeCount} 笔 · ${formatCompact(m.turnover)} USDT` : '连接中…'}
        </span>
      </div>

      {/* 说清楚为什么没有，而不是让它一直「连接中…」——
          那种状态看上去像马上就好，实际永远不会好 */}
      {unsupported && (
        <p className="mt-2 text-[11px] leading-relaxed text-zinc-600">
          {symbol.replace(/USDT$|USDC$/, '')} 的行情来自 {String(source).toUpperCase()}，
          而秒级盘口流目前只接了币安。图表、指标、告警、研判均不受影响。
        </p>
      )}

      {m && (
        <>
          <div className="mt-2 grid grid-cols-3 gap-3 text-xs">
            <div>
              <p className="text-[11px] text-zinc-600">买一 / 卖一</p>
              <p className="font-mono text-zinc-300 tabular-nums">
                {formatPrice(m.bid)}
                <span className="text-zinc-600"> / </span>
                {formatPrice(m.ask)}
              </p>
            </div>

            <div>
              <p className="text-[11px] text-zinc-600">价差</p>
              {/* BTC 的价差常常只有一个 tick，在 7 万的价位上不到 0.002 个基点。
                  固定两位小数会显示成 0.00，看着像坏了——按量级自适应精度 */}
              <p className="font-mono text-zinc-300 tabular-nums">
                {m.spreadBps >= 1
                  ? `${m.spreadBps.toFixed(2)} bp`
                  : `${formatPrice(m.ask - m.bid)}（${m.spreadBps.toFixed(3)} bp）`}
              </p>
            </div>

            <div>
              <p className="text-[11px] text-zinc-600">主动买入</p>
              <p className="font-mono text-zinc-300 tabular-nums">
                {m.takerBuyRatio === null ? '成交过少' : `${m.takerBuyRatio.toFixed(0)}%`}
              </p>
            </div>
          </div>

          {/* 主动买卖的比例条。用中性灰而非涨绿跌红——
              那套配色会暗示方向，而这个量并不预示方向 */}
          {m.takerBuyRatio !== null && (
            <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-zinc-800">
              <div className="bg-zinc-400" style={{ width: `${m.takerBuyRatio}%` }} />
              <div className="flex-1 bg-zinc-700" />
            </div>
          )}

          <div className="mt-2 flex items-center gap-2">
            <span className="text-[11px] text-zinc-600">盘口失衡</span>
            <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-800">
              <div className="absolute left-1/2 top-0 h-full w-px bg-zinc-600" />
              <div
                className="absolute top-0 h-full bg-zinc-400"
                style={{
                  left: m.imbalance >= 0 ? '50%' : `${50 + m.imbalance * 50}%`,
                  width: `${Math.abs(m.imbalance) * 50}%`,
                }}
              />
            </div>
            <span className="w-10 shrink-0 text-right font-mono text-[11px] text-zinc-500 tabular-nums">
              {m.imbalance > 0 ? '+' : ''}
              {(m.imbalance * 100).toFixed(0)}
            </span>
          </div>

          <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-600">
            仅最优档，大单常挂在更远的档位上。此处为状态描述，不构成方向判断。
          </p>
        </>
      )}
    </div>
  );
}
