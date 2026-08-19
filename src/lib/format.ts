/** 展示层格式化。加密币价格跨度极大（BTC 六位数，SHIB 小数点后八位），需要自适应精度。 */

export function formatPrice(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.0001) return n.toFixed(6);
  return n.toExponential(4);
}

export function formatCompact(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toFixed(2);
}

export function formatPercent(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

/** 涨跌配色。国际惯例绿涨红跌——与币安网页端默认一致，避免看盘时的方向误读。 */
export const trendColor = (n: number) =>
  n > 0 ? 'text-emerald-400' : n < 0 ? 'text-rose-400' : 'text-zinc-400';
