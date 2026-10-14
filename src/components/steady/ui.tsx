/**
 * 驾驶舱共用的小部件与格式化。样式沿用现有看板的 zinc 深色风格。
 */

import type { ReactNode } from 'react';

export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'muted';

export const TONE_TEXT: Record<Tone, string> = {
  good: 'text-emerald-400',
  warn: 'text-amber-400',
  bad: 'text-rose-400',
  info: 'text-sky-400',
  muted: 'text-zinc-400',
};

export const TONE_BOX: Record<Tone, string> = {
  good: 'bg-emerald-500/10 ring-emerald-500/20',
  warn: 'bg-amber-500/10 ring-amber-500/20',
  bad: 'bg-rose-500/10 ring-rose-500/25',
  info: 'bg-sky-500/10 ring-sky-500/20',
  muted: 'bg-zinc-900/60 ring-zinc-800',
};

export const usd = (n: number | null | undefined, digits?: number): string => {
  if (n == null || !Number.isFinite(n)) return '—';
  const d = digits ?? (Math.abs(n) < 100 ? 2 : 0);
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
};

export const pct = (n: number | null | undefined, digits = 1): string =>
  n == null || !Number.isFinite(n) ? '—' : `${n.toFixed(digits)}%`;

export const signedPct = (n: number | null | undefined, digits = 1): string =>
  n == null || !Number.isFinite(n) ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;

export function Card({
  title,
  hint,
  action,
  children,
  className = '',
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-xl bg-zinc-900/50 p-4 ring-1 ring-zinc-800 ${className}`}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-zinc-100">{title}</h2>
          {hint && <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone = 'muted',
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: Tone;
}) {
  return (
    <div className="rounded-lg bg-zinc-950/60 px-3 py-2.5 ring-1 ring-zinc-800/80">
      <p className="text-[11px] text-zinc-500">{label}</p>
      <p className={`mt-0.5 font-mono text-lg tabular-nums ${TONE_TEXT[tone]}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[11px] leading-snug text-zinc-600">{sub}</p>}
    </div>
  );
}

/** 「这是什么意思」式的折叠解释。新手不该被术语挡在门外，但也不该被解释塞满首屏 */
export function Explain({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="group text-[11px] leading-relaxed text-zinc-500">
      <summary className="cursor-pointer select-none text-zinc-500 hover:text-zinc-300">
        {summary}
      </summary>
      <div className="mt-1.5 space-y-1.5 border-l border-zinc-800 pl-3 text-zinc-500">{children}</div>
    </details>
  );
}

export function Button({
  children,
  onClick,
  variant = 'ghost',
  disabled,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'ghost' | 'danger';
  disabled?: boolean;
  type?: 'button' | 'submit';
}) {
  const style = {
    primary: 'bg-zinc-100 text-zinc-900 hover:bg-white disabled:bg-zinc-700 disabled:text-zinc-400',
    ghost: 'bg-zinc-800/80 text-zinc-300 hover:bg-zinc-700 disabled:text-zinc-600',
    danger: 'bg-transparent text-rose-400 hover:bg-rose-500/10 disabled:text-zinc-600',
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed ${style}`}
    >
      {children}
    </button>
  );
}

export const inputCls =
  'w-full rounded-lg bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-200 ring-1 ring-zinc-800 placeholder:text-zinc-600 focus:outline-none focus:ring-zinc-500';
