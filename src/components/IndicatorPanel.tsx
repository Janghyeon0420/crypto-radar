'use client';

import type { TechnicalSnapshot } from '@/lib/indicators/summary';
import { formatPrice } from '@/lib/format';

const BIAS_STYLE = {
  bullish: { label: '偏多', cls: 'bg-emerald-500/15 text-emerald-400 ring-emerald-500/30' },
  bearish: { label: '偏空', cls: 'bg-rose-500/15 text-rose-400 ring-rose-500/30' },
  neutral: { label: '中性', cls: 'bg-zinc-500/15 text-zinc-400 ring-zinc-500/30' },
} as const;

/** 技术面快照。数值全部来自服务端计算，这里只负责呈现。 */
export function IndicatorPanel({ tech }: { tech: TechnicalSnapshot | null }) {
  if (!tech) {
    return (
      <p className="p-4 text-sm text-zinc-600">
        K 线数据不足 60 根，无法计算技术指标
      </p>
    );
  }

  const bias = BIAS_STYLE[tech.bias];

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-zinc-500">规则引擎倾向</span>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${bias.cls}`}>
          {bias.label}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm">
        <Row label="RSI(14)" value={tech.rsi14.toFixed(1)} hint={rsiHint(tech.rsiState)} />
        <Row label="MACD 柱" value={tech.macd.histogram.toFixed(4)} hint={crossHint(tech.macd.cross)} />
        <Row label="MA20" value={formatPrice(tech.ma.ma20)} />
        <Row label="MA50" value={formatPrice(tech.ma.ma50)} />
        <Row label="MA200" value={formatPrice(tech.ma.ma200)} />
        <Row label="%B" value={tech.bollinger.percentB.toFixed(2)} hint={tech.bollinger.squeeze ? '带宽挤压' : undefined} />
        <Row label="ATR%" value={`${tech.volatility.atrPercent.toFixed(2)}%`} />
        <Row label="量比" value={`${tech.volume.ratio20.toFixed(2)}×`} hint={tech.volume.ratio20 >= 1.5 ? '放量' : undefined} />
      </dl>

      <div className="grid grid-cols-2 gap-4 border-t border-zinc-800 pt-3 text-sm">
        <div>
          <p className="mb-1 text-xs text-zinc-500">支撑</p>
          {tech.levels.supports.length ? (
            tech.levels.supports.map((v) => (
              <p key={v} className="font-mono text-emerald-400 tabular-nums">{formatPrice(v)}</p>
            ))
          ) : (
            <p className="text-zinc-600">未识别</p>
          )}
        </div>
        <div>
          <p className="mb-1 text-xs text-zinc-500">阻力</p>
          {tech.levels.resistances.length ? (
            tech.levels.resistances.map((v) => (
              <p key={v} className="font-mono text-rose-400 tabular-nums">{formatPrice(v)}</p>
            ))
          ) : (
            <p className="text-zinc-600">未识别</p>
          )}
        </div>
      </div>

      <ul className="space-y-1 border-t border-zinc-800 pt-3 text-xs text-zinc-400">
        {tech.reasons.map((r) => (
          <li key={r} className="flex gap-1.5">
            <span className="text-zinc-600">·</span>
            {r}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="font-mono text-zinc-100 tabular-nums">
        {value}
        {hint && <span className="ml-1.5 font-sans text-xs text-amber-400">{hint}</span>}
      </dd>
    </div>
  );
}

const rsiHint = (s: string) =>
  s === 'overbought' ? '超买' : s === 'oversold' ? '超卖' : undefined;
const crossHint = (c: string) => (c === 'golden' ? '金叉' : c === 'death' ? '死叉' : undefined);
