'use client';

import { useCallback, useEffect, useState } from 'react';
import { ALERT_LABELS, NEEDS_THRESHOLD, type AlertKind, type AlertRule } from '@/lib/alerts/types';
import type { AlertEvent } from '@/lib/alerts/types';
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

/** 服务端化之前，规则由 zustand persist 存在这个 key 下 */
const LEGACY_KEY = 'crypto-radar-alerts';

function readLegacyRules(): AlertRule[] {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const rules = parsed?.state?.rules;
    return Array.isArray(rules) ? rules : [];
  } catch {
    return [];
  }
}

interface WorkerStatus {
  running: boolean;
  reason: string | null;
  pollSeconds: number;
  lastRunAt: number | null;
  lastError: string | null;
  lastRuleCount: number;
  notifier: 'telegram' | null;
}

export function AlertsPanel({
  symbol,
  interval,
  currentPrice,
  events,
  onEventsChanged,
}: {
  symbol: string;
  interval: string;
  currentPrice?: number;
  events: AlertEvent[];
  onEventsChanged: () => void;
}) {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [status, setStatus] = useState<WorkerStatus | null>(null);
  const [kind, setKind] = useState<AlertKind>('price_above');
  const [threshold, setThreshold] = useState('');
  const [once, setOnce] = useState(true);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  /** 本次迁移了多少条旧规则，用于给用户一个明确交代 */
  const [migrated, setMigrated] = useState(0);
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'default',
  );

  const loadRules = useCallback(async () => {
    const res = await fetch('/api/alerts/rules');
    if (!res.ok) return;
    const serverRules: AlertRule[] = (await res.json()).rules;

    // 一次性迁移：告警规则原先存在浏览器 localStorage，
    // 服务端化后必须搬上来，否则用户之前建的规则会静默失效——
    // 那比没有这个功能更糟，因为用户以为还在监控。
    if (serverRules.length === 0) {
      const local = readLegacyRules();
      if (local.length > 0) {
        const imported = await fetch('/api/alerts/rules', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ rules: local }),
        });
        if (imported.ok) {
          setRules((await imported.json()).rules);
          setMigrated(local.length);
          localStorage.removeItem(LEGACY_KEY);
          return;
        }
      }
    }
    setRules(serverRules);
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    const loadStatus = () =>
      fetch('/api/alerts/status', { signal: ac.signal })
        .then((r) => r.json())
        .then((d) => setStatus(d.worker))
        .catch(() => {});

    // 推迟到渲染提交之后，避免同步 setState 引发级联渲染
    const first = setTimeout(() => {
      void loadRules();
      void loadStatus();
    }, 0);
    // 轮询进程状态，让用户能看出告警是否真的在跑
    const t = setInterval(() => void loadStatus(), 30_000);
    return () => {
      ac.abort();
      clearTimeout(first);
      clearInterval(t);
    };
  }, [loadRules]);

  const symbolRules = rules.filter((r) => r.symbol === symbol);
  const needsThreshold = NEEDS_THRESHOLD.includes(kind);

  const submit = async () => {
    const value = threshold.trim() ? Number(threshold) : DEFAULT_THRESHOLD[kind];
    if (needsThreshold && (value == null || !Number.isFinite(value))) return;
    setBusy(true);
    try {
      const res = await fetch('/api/alerts/rules', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol, kind, threshold: value, interval, once }),
      });
      if (res.ok) {
        setRules((await res.json()).rules);
        setThreshold('');
      }
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (id: string) => {
    const res = await fetch('/api/alerts/rules', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (res.ok) setRules((await res.json()).rules);
  };

  const remove = async (id: string) => {
    const res = await fetch(`/api/alerts/rules?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (res.ok) setRules((await res.json()).rules);
  };

  const clearEvents = async () => {
    await fetch('/api/alerts/events', { method: 'DELETE' });
    onEventsChanged();
  };

  const testNotify = async () => {
    setTestResult('发送中…');
    try {
      const res = await fetch('/api/alerts/test', { method: 'POST' });
      const d = await res.json();
      setTestResult(d.detail ?? (d.ok ? '已发送' : '失败'));
    } catch (err) {
      setTestResult(err instanceof Error ? err.message : String(err));
    }
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

      {migrated > 0 && (
        <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-300/90 ring-1 ring-emerald-500/20">
          已把浏览器中保存的 {migrated} 条旧规则迁移到服务端，现在关掉页面也会继续监控
        </p>
      )}

      {/* 轮询状态。告警的核心承诺是"关掉页面也在跑"，
          必须让用户能一眼确认它确实在跑，否则这个承诺无从验证 */}
      {status && (
        <div className="rounded-lg bg-zinc-900 px-3 py-2 text-[11px] leading-relaxed">
          <div className="flex items-center gap-1.5">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                status.running ? 'bg-emerald-500' : 'bg-zinc-600'
              }`}
            />
            <span className={status.running ? 'text-emerald-400/90' : 'text-zinc-500'}>
              {status.running
                ? `服务端监控中 · 每 ${status.pollSeconds} 秒`
                : `未运行${status.reason ? ` · ${status.reason}` : ''}`}
            </span>
          </div>
          <p className="mt-1 text-zinc-500">
            {status.notifier === 'telegram' ? (
              <>
                通知出口 Telegram ·{' '}
                <button onClick={testNotify} className="text-sky-400 hover:text-sky-300">
                  发送测试
                </button>
              </>
            ) : (
              <>未配置 Telegram，触发仅记录在此处（配置方法见 .env.example）</>
            )}
          </p>
          {status.lastRunAt && (
            <p className="mt-0.5 text-zinc-600">
              上次求值 {timeAgo(status.lastRunAt)} · {status.lastRuleCount} 条启用中
            </p>
          )}
          {status.lastError && <p className="mt-0.5 text-amber-500/80">{status.lastError}</p>}
          {testResult && <p className="mt-0.5 text-zinc-400">{testResult}</p>}
        </div>
      )}

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
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
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
            disabled={busy}
            className="rounded bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-900 hover:bg-white disabled:bg-zinc-700 disabled:text-zinc-400"
          >
            添加
          </button>
        </div>
        <p className="text-[11px] text-zinc-600">
          在 {symbol.replace(/USDT$/, '')} · {interval} 上求值
        </p>
      </div>

      {/* 规则列表 */}
      {symbolRules.length > 0 ? (
        <ul className="space-y-1">
          {symbolRules.map((r) => (
            <li key={r.id} className="group flex items-center justify-between text-xs">
              <button
                onClick={() => toggle(r.id)}
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
                onClick={() => remove(r.id)}
                className="hidden text-zinc-600 hover:text-rose-400 group-hover:block"
                aria-label="删除规则"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-zinc-600">{symbol.replace(/USDT$/, '')} 暂无告警规则</p>
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
