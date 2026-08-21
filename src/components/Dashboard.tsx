'use client';

import { useEffect, useMemo, useState } from 'react';
import { useWatchlist } from '@/lib/stores/watchlist';
import { useLiveTickers } from '@/lib/hooks/useLiveTickers';
import { INTERVALS, type Candle, type Interval } from '@/lib/datasources/types';
import type { TechnicalSnapshot } from '@/lib/indicators/summary';
import { ema, sma, bollinger } from '@/lib/indicators';
import { formatPercent, formatPrice, trendColor } from '@/lib/format';
import { Watchlist } from './Watchlist';
import { SymbolSearch } from './SymbolSearch';
import { PriceChart } from './PriceChart';
import { IndicatorPanel } from './IndicatorPanel';
import { AnalysisPanel } from './AnalysisPanel';
import { NewsPanel } from './NewsPanel';
import { MarketContext } from './MarketContext';
import { SourceHealthBar } from './SourceHealthBar';
import { AlertsPanel } from './AlertsPanel';
import { MacroPanel } from './MacroPanel';
import { ResonancePanel } from './ResonancePanel';
import { MicrostructurePanel } from './MicrostructurePanel';
import { AccuracyPanel } from './AccuracyPanel';
import { useAlertEvents } from '@/lib/hooks/useAlertEngine';

type PanelTab = 'indicators' | 'analysis' | 'macro' | 'alerts';

const TABS: { id: PanelTab; label: string }[] = [
  { id: 'indicators', label: '技术面' },
  { id: 'analysis', label: 'AI 研判' },
  { id: 'macro', label: '宏观' },
  { id: 'alerts', label: '告警' },
];

interface KlineResponse {
  candles: Candle[];
  technical: TechnicalSnapshot | null;
}

export function Dashboard() {
  const { symbols, active } = useWatchlist();
  const [interval, setIntervalState] = useState<Interval>('1h');
  const [showOverlays, setShowOverlays] = useState(true);
  const [tab, setTab] = useState<PanelTab>('indicators');
  /** 研判完成后自增，用于让准确率面板重新拉取（新记录刚落盘） */
  const [analysisVersion, setAnalysisVersion] = useState(0);

  /**
   * K 线请求结果连同它对应的 (币种, 周期) 一起存。
   * loading 由"已加载的 key 是否等于当前 key"推导出来，而不是单独一个 state——
   * 这样切换币种时不会出现旧币数据配新币标题的错位，
   * 也避免在 effect 里同步 setState 触发级联渲染。
   */
  const [result, setResult] = useState<{
    key: string;
    data: KlineResponse | null;
    error: string | null;
  }>({ key: '', data: null, error: null });

  const requestKey = active ? `${active}|${interval}` : '';
  const loading = Boolean(active) && result.key !== requestKey;
  const data = result.key === requestKey ? result.data : null;
  const error = result.key === requestKey ? result.error : null;

  const ticks = useLiveTickers(active ? [active] : []);
  const live = ticks[active];

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    const load = async () => {
      try {
        const res = await fetch(`/api/market/klines?symbol=${active}&interval=${interval}&limit=500`);
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        if (!cancelled) setResult({ key: requestKey, data: json, error: null });
      } catch (err) {
        if (!cancelled) {
          setResult({
            key: requestKey,
            data: null,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    };

    load();
    // 定时重拉，让 K 线随新收盘的蜡烛推进。周期越短刷新越频繁。
    const period = interval === '1m' ? 15_000 : interval === '5m' ? 30_000 : 60_000;
    const timer = setInterval(load, period);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active, interval, requestKey]);

  // 叠加线在前端算：这几条线依赖的收盘价数组已经在手上，
  // 再往返一次服务端不划算，而且开关叠加时可以零延迟响应。
  const overlays = useMemo(() => {
    if (!data?.candles.length || !showOverlays) return [];
    const close = data.candles.map((c) => c.close);
    const bb = bollinger(close, 20, 2);
    return [
      { label: 'MA20', color: '#60a5fa', data: sma(close, 20) },
      { label: 'MA50', color: '#c084fc', data: sma(close, 50) },
      { label: 'EMA12', color: '#fbbf24', data: ema(close, 12) },
      { label: 'BOLL 上轨', color: '#3f3f46', data: bb.upper },
      { label: 'BOLL 下轨', color: '#3f3f46', data: bb.lower },
    ];
  }, [data, showOverlays]);

  // 告警统一在这里求值，保证一次数据更新只触发一次
  // 告警求值已全部移到服务端，这里只订阅结果并对新事件弹桌面通知
  const { events: alertEvents, refresh: refreshAlertEvents } = useAlertEvents();

  const price = live?.last ?? data?.technical?.price;
  const changePercent = live ? ((live.last - live.open24h) / live.open24h) * 100 : undefined;
  const baseAsset = active.replace(/USDT$|USDC$/, '');

  return (
    <div className="flex h-dvh flex-col bg-zinc-950 text-zinc-100">
      <header className="flex shrink-0 items-center justify-between gap-6 border-b border-zinc-800 px-5 py-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-sm font-semibold tracking-tight">Crypto Radar</h1>
          <span className="text-xs text-zinc-600">行情 · 技术面 · 资讯 · AI 研判</span>
        </div>
        <SourceHealthBar />
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 左栏：自选 */}
        <aside className="flex w-64 shrink-0 flex-col gap-3 border-r border-zinc-800 p-3">
          <SymbolSearch />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <Watchlist />
          </div>
          <p className="text-[11px] leading-relaxed text-zinc-700">
            自选保存在本地浏览器，共 {symbols.length} 个币种
          </p>
        </aside>

        {/* 中栏：主图 */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between border-b border-zinc-800 px-5 py-3">
            <div className="flex items-baseline gap-4">
              <h2 className="text-lg font-medium">{active || '未选择'}</h2>
              {price != null && (
                <>
                  <span className="font-mono text-xl tabular-nums">{formatPrice(price)}</span>
                  {changePercent != null && (
                    <span className={`font-mono text-sm tabular-nums ${trendColor(changePercent)}`}>
                      {formatPercent(changePercent)}
                    </span>
                  )}
                </>
              )}
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={() => setShowOverlays((v) => !v)}
                className={`text-xs ${showOverlays ? 'text-zinc-300' : 'text-zinc-600'} hover:text-zinc-100`}
              >
                均线/布林
              </button>
              <div className="flex gap-0.5 rounded-lg bg-zinc-900 p-0.5">
                {INTERVALS.map((iv) => (
                  <button
                    key={iv}
                    onClick={() => setIntervalState(iv)}
                    className={`rounded px-2 py-1 text-xs transition-colors ${
                      interval === iv
                        ? 'bg-zinc-700 text-zinc-100'
                        : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    {iv}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="relative min-h-0 flex-1">
            {error && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-zinc-950/80">
                <p className="max-w-md rounded-lg bg-rose-500/10 px-4 py-3 text-sm text-rose-400 ring-1 ring-rose-500/20">
                  {error}
                </p>
              </div>
            )}
            {loading && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-600">
                加载 K 线…
              </div>
            )}
            {data && <PriceChart candles={data.candles} overlays={overlays} />}
          </div>

          <div className="shrink-0 border-t border-zinc-800">
            <MarketContext symbol={active} />
          </div>
        </main>

        {/* 右栏：分析。分页而非全部纵向堆叠——四块内容叠起来滚动条太长，找东西费劲 */}
        <aside className="flex w-96 shrink-0 flex-col border-l border-zinc-800">
          <nav className="flex shrink-0 border-b border-zinc-800">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex-1 px-2 py-2.5 text-xs transition-colors ${
                  tab === t.id
                    ? 'border-b-2 border-zinc-100 text-zinc-100'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === 'indicators' && (
              <>
                <ResonancePanel symbol={active} />
                <MicrostructurePanel symbol={active} />
                <IndicatorPanel tech={data?.technical ?? null} />
                <div className="border-t border-zinc-800">
                  <NewsPanel baseAsset={baseAsset} />
                </div>
              </>
            )}
            {tab === 'analysis' && (
              <>
                <AnalysisPanel
                  symbol={active}
                  onAnalyzed={() => setAnalysisVersion((v) => v + 1)}
                />
                <div className="border-t border-zinc-800">
                  <AccuracyPanel symbol={active} refreshKey={analysisVersion} />
                </div>
              </>
            )}
            {tab === 'macro' && <MacroPanel />}
            {tab === 'alerts' && (
              <AlertsPanel
                symbol={active}
                interval={interval}
                currentPrice={price}
                events={alertEvents}
                onEventsChanged={refreshAlertEvents}
              />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
