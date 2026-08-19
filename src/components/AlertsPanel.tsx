'use client';

import { useState } from 'react';
import { useAlerts } from '@/lib/stores/alerts';
import { ALERT_LABELS, NEEDS_THRESHOLD, type AlertKind } from '@/lib/alerts/types';
import { formatPrice, timeAgo } from '@/lib/format';

const KINDS: AlertKind[] = [
  'price_above',
  'price_below',
  'rsi_above',
  'rsi_below',
  'macd_cross',
  'bb_squeeze_release',
  'volume_spike',
];

/** 各类规则的默认阈值，减少每次新建都要手填的麻烦 */
const DEFAULT_THRESHOLD: Partial<Record<AlertKind, number>> = {
  rsi_above: 70,
  rsi_below: 30,
  volume_spike: 2,
};

export function AlertsPanel({
  symbol,
  interval,
  currentPrice,
}: {
  symbol: string;
  interval: string;
  currentPrice?: number;
}) {
  const { rules, events, addRule, removeRule, toggleRule, clearEvents } = useAlerts();
  const [kind, setKind] = useState<AlertKind>('price_above');
  const [threshold, setThreshold] = useState('');
  const [once, setOnce] = useState(true);
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'default',
  );

  const symbolRules = rules.filter((r) => r.symbol === symbol);
  const needsThreshold = NEEDS_THRESHOLD.includes(kind);

  const submit = () => {
    const value = threshold.trim() ? Number(threshold) : DEFAULT_THRESHOLD[kind];
    if (needsThreshold && (value == null || !Number.isFinite(value))) return;
    addRule({ symbol, kind, threshold: value, interval, once });
    setThreshold('');
  };

  const requestPermission = async () => {
    if (typeof Notification === 'undefined') return;
    setPermission(await Notification.requestPermission());
  };

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-200">告警</h3>
        {permission !== 'granted' && (
          <button onClick={requestPermission} className="text-xs text-sky-400 hover:text-sky-300">
            开启桌面通知
          </button>
        )}
      </div>

      {/* 新建规则 */}
      <div className="space-y-2 rounded-lg bg-zinc-900 p-3">
        <select
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as AlertKind);
            setThreshold('');
          }}
          className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100 focus:border-zinc-600 focus:outline-none"
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {ALERT_LABELS[k]}
            </option>
          ))}
        </select>

        {needsThreshold && (
          <input
            type="number"
            step="any"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder={
              kind.startsWith('price')
                ? currentPrice
                  ? `当前 ${formatPrice(currentPrice)}`
                  : '目标价格'
                : String(DEFAULT_THRESHOLD[kind] ?? '')
            }
            className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
          />
        )}

        <div className="flex items-center justify-between">
          <label className="flex items-center gap-1.5 text-xs text-zinc-500">
            <input
              type="checkbox"
              checked={once}
              onChange={(e) => setOnce(e.target.checked)}
              className="accent-zinc-400"
            />
            只提醒一次
          </label>
          <button
            onClick={submit}
            className="rounded bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-900 hover:bg-white"
          >
            添加
          </button>
        </div>
        <p className="text-[11px] text-zinc-600">
          在 {symbol.replace(/USDT$/, '')} · {interval} 上求值
        </p>
      </div>

      {/* 规则列表 */}
      {symbolRules.length > 0 && (
        <ul className="space-y-1">
          {symbolRules.map((r) => (
            <li key={r.id} className="group flex items-center justify-between text-xs">
              <button
                onClick={() => toggleRule(r.id)}
                className={`flex items-center gap-1.5 ${r.enabled ? 'text-zinc-300' : 'text-zinc-600 line-through'}`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${r.enabled ? 'bg-emerald-500' : 'bg-zinc-700'}`}
                />
                {ALERT_LABELS[r.kind]}
                {r.threshold != null && (
                  <span className="font-mono">
                    {r.kind.startsWith('price') ? formatPrice(r.threshold) : r.threshold}
                  </span>
                )}
                <span className="text-zinc-600">{r.interval}</span>
              </button>
              <button
                onClick={() => removeRule(r.id)}
                className="hidden text-zinc-600 hover:text-rose-400 group-hover:block"
                aria-label="删除规则"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {symbolRules.length === 0 && (
        <p className="text-xs text-zinc-600">
          {symbol.replace(/USDT$/, '')} 暂无告警规则
        </p>
      )}

      {/* 触发历史 */}
      {events.length > 0 && (
        <div className="border-t border-zinc-800 pt-3">
          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-xs uppercase tracking-wide text-zinc-500">最近触发</p>
            <button onClick={clearEvents} className="text-xs text-zinc-600 hover:text-zinc-400">
              清空
            </button>
          </div>
          <ul className="space-y-1.5">
            {events.slice(0, 8).map((e) => (
              <li key={e.id} className="text-xs">
                <p className="text-zinc-300">{e.message}</p>
                <p className="text-[11px] text-zinc-600">{timeAgo(e.triggeredAt)}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
