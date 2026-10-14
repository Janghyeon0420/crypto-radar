'use client';

import { useEffect, useState } from 'react';
import type { ForecastResponse, ForecastRow } from '@/lib/indicators/forecast';
import { formatPercent, formatPrice, trendColor } from '@/lib/format';

const BIAS = {
  bullish: { label: '看多', cls: 'bg-emerald-500/10 text-emerald-400' },
  bearish: { label: '看空', cls: 'bg-rose-500/10 text-rose-400' },
  neutral: { label: '震荡', cls: 'bg-zinc-800 text-zinc-400' },
};

function duration(hours: number): string {
  return hours < 24 ? `${Math.round(hours)} 小时` : `${(hours / 24).toFixed(1).replace(/\.0$/, '')} 天`;
}

function timestamp(time: number): string {
  return new Date(time).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

function ForecastTableRow({ row }: { row: ForecastRow }) {
  const bias = row.bias ? BIAS[row.bias] : null;
  return (
    <tr className="border-t border-zinc-800/70 align-top">
      <th scope="row" className="px-4 py-3 text-left font-normal">
        <div className="font-medium text-zinc-200">{row.label} <span className="ml-1 font-normal text-zinc-500">{row.window}</span></div>
        <div className="mt-1 text-[10px] text-zinc-500">{row.interval} K 线 · 基准 {formatPrice(row.referencePrice)}</div>
        {row.asOf && <div className="mt-0.5 text-[10px] text-zinc-600">收盘 {timestamp(row.asOf)}</div>}
      </th>
      {row.status !== 'ready' ? (
        <td colSpan={5} className="px-3 py-3 text-zinc-500">
          <p>{row.reason}</p>
          {row.samples > 0 && <p className="mt-1 text-[10px]">{row.samples} 个观测 / {row.nonOverlappingSamples} 个不重叠窗口</p>}
        </td>
      ) : (
        <>
          <td className="px-3 py-3">
            {bias && <span className={`inline-block rounded px-2 py-1 font-medium ${bias.cls}`}>{bias.label}</span>}
            <div className="mt-1 text-[10px] text-zinc-600">历史类比</div>
          </td>
          <td className="px-3 py-3 font-mono tabular-nums">
            <div className="text-zinc-200">{formatPrice(row.target)} <span className={trendColor(row.changePercent ?? 0)}>{formatPercent(row.changePercent)}</span></div>
            <div className="mt-1 text-[10px] text-zinc-500">{row.range?.map(formatPrice).join(' – ')}</div>
            <div className="mt-0.5 font-sans text-[10px] text-zinc-600">期末价中位数 / P25–P75 区间</div>
          </td>
          <td className="px-3 py-3">
            <div className="text-zinc-300">{row.touchHours ? row.touchHours.map(duration).join(' – ') : row.bias === 'neutral' ? '等待方向' : '触达样本不足'}</div>
            <div className="mt-1 text-[10px] text-zinc-500">{row.bias !== 'neutral' ? `仅触达的 ${row.touchSamples}/${row.samples} 个观测` : '无方向性触达预估'}</div>
            {row.expiresAt && <div className="mt-0.5 text-[10px] text-zinc-600">窗口至 {timestamp(row.expiresAt)}</div>}
          </td>
          <td className="px-3 py-3">
            <div className="font-mono text-amber-400/90">{row.invalidation === null ? '—' : `${row.bias === 'bullish' ? '≤' : '≥'} ${formatPrice(row.invalidation)}`}</div>
            <div className="mt-1 text-[10px] text-zinc-500">{row.rewardRisk === null ? '震荡不设方向失效价' : `名义盈亏比 ${row.rewardRisk.toFixed(2)} : 1`}</div>
          </td>
          <td className="max-w-48 px-3 py-3">
            <div className="text-zinc-400">{row.samples} 个观测 <span className="text-zinc-600">/ {row.nonOverlappingSamples} 个不重叠</span></div>
            <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">{row.reason}</p>
          </td>
        </>
      )}
    </tr>
  );
}

export function ForecastPanel({ symbol }: { symbol: string }) {
  const [collapsed, setCollapsed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    key: string; data: ForecastResponse | null; error: string | null;
  }>({ key: '', data: null, error: null });
  const [pending, setPending] = useState('');
  const key = `${symbol}|${revision}`;
  const data = result.key === key ? result.data : null;
  const error = result.key === key ? result.error : null;
  const loading = Boolean(symbol) && (result.key !== key || pending === key);

  useEffect(() => {
    if (!symbol) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      setPending(key);
      try {
        const response = await fetch(`/api/market/forecast?symbol=${encodeURIComponent(symbol)}`, { signal: controller.signal });
        const json = await response.json();
        if (!response.ok) throw new Error(json.error ?? `HTTP ${response.status}`);
        if (json.symbol !== symbol) throw new Error('币种数据不匹配，请刷新');
        if (!controller.signal.aborted) setResult({ key, data: json, error: null });
      } catch (err) {
        if (!controller.signal.aborted) {
          setResult({ key, data: null, error: err instanceof Error ? err.message : '预判加载失败' });
        }
      } finally {
        if (!controller.signal.aborted) {
          setPending('');
          timer = setTimeout(load, 60_000);
        }
      }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [symbol, key]);

  return (
    <section aria-label={`${symbol} 趋势预判`} className="shrink-0 border-t border-zinc-800 bg-zinc-950">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <button type="button" onClick={() => setCollapsed((value) => !value)} aria-expanded={!collapsed} aria-controls="forecast-content" className="flex items-center gap-2 text-xs font-medium text-zinc-200">
          <span className="text-zinc-500" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
          {symbol} 趋势预判
          <span className="rounded border border-amber-500/20 px-1.5 py-0.5 text-[10px] font-normal text-amber-400/80">实验性</span>
        </button>
        <div className="flex items-center gap-3 text-[10px] text-zinc-500">
          {data && <span>{data.source.toUpperCase()} · {symbol.endsWith('USDC') ? 'USDC' : 'USDT'} · 更新 {timestamp(data.generatedAt)}</span>}
          <button type="button" disabled={loading || !symbol} onClick={() => setRevision((value) => value + 1)} className="text-zinc-400 hover:text-zinc-100 disabled:opacity-40">{loading ? '计算中…' : '刷新'}</button>
        </div>
      </div>
      {!collapsed && (
        <div id="forecast-content" className="max-h-[40vh] overflow-auto">
          {!symbol && <p className="px-4 pb-4 text-xs text-zinc-500">选择币种后查看趋势预判。</p>}
          {loading && !data && <p role="status" className="px-4 pb-4 text-xs text-zinc-500">正在匹配三个周期的历史形态…</p>}
          {error && <p role="alert" className="px-4 pb-4 text-xs text-rose-400">{error}，可点击刷新重试。</p>}
          {data && (
            <>
              <table className="w-full min-w-[940px] text-xs">
                <caption className="sr-only">{symbol} 短期、中期、长期方向、目标区间和预计触达时间</caption>
                <thead className="text-left text-[10px] text-zinc-500">
                  <tr>{['周期 / 收盘基准价', '方向', '目标价 / 涨跌幅', '预计触达时间（条件式）', '失效参考 / 盈亏比', '样本 / 当前形态'].map((label) => <th scope="col" key={label} className="px-3 pb-2 font-normal first:pl-4">{label}</th>)}</tr>
                </thead>
                <tbody>{data.rows.map((row) => <ForecastTableRow key={row.id} row={row} />)}</tbody>
              </table>
              <p className="border-t border-zinc-800/70 px-4 py-2 text-[10px] leading-relaxed text-zinc-500">
                历史类比情景，尚未通过样本外回测。区间不代表未来覆盖率；时间仅统计历史上触达目标的观测，未触达者不计入，不能视作到价承诺或胜率。
              </p>
              <details className="px-4 pb-3 text-[10px] leading-relaxed text-zinc-500">
                <summary className="cursor-pointer text-zinc-400">计算口径与失效条件</summary>
                <p className="mt-2">使用已收盘 K 线，按价格与 MA50、MA20 与 MA50 的关系及 RSI 档位匹配历史，同时筛选 ATR 相对波动为当前的 0.5–2 倍。历史对数收益按 ATR 归一化，再映射到本行基准价；目标为窗口期末价中位数，区间为 P25–P75。中位收益超过 ±0.5 ATR 才标记看多或看空。</p>
                <p className="mt-1">触达时间为到达中位目标的历史观测的 P25–P75，按 K 线粒度统计，自本行收盘时间起算。观测有重叠，不重叠窗口数也不代表统计独立样本；少于 30 个观测或 3 个不重叠窗口不输出预测，少于 10 个触达观测不输出时间。</p>
                <p className="mt-1">失效参考取历史窗口内不利波动的尾部分位（多头 P10 / 空头 P90，至少 1 ATR）。到达该价、窗口到期或形态变化时应重新评估。名义盈亏比未计手续费、滑点，也未验证目标与失效价的先后触达。每分钟刷新，无自动下单。</p>
              </details>
            </>
          )}
        </div>
      )}
    </section>
  );
}
