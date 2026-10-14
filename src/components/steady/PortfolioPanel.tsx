'use client';

import { useState } from 'react';
import { isStable, type Holding } from '@/lib/steady/schema';
import type { DriftRow } from '@/lib/steady/plan';
import type { SteadySummary } from '@/lib/steady/types';
import { Button, Card, Explain, inputCls, pct, signedPct, usd } from './ui';

interface RowDraft {
  asset: string;
  quantity: string;
  avgCost: string;
}

const toDraft = (h: Holding[]): RowDraft[] =>
  h.length
    ? h.map((x) => ({
        asset: x.asset,
        quantity: String(x.quantity),
        avgCost: x.avgCost != null ? String(x.avgCost) : '',
      }))
    : [
        { asset: 'BTC', quantity: '', avgCost: '' },
        { asset: 'USDT', quantity: '', avgCost: '' },
      ];

function toHoldings(rows: RowDraft[]): Holding[] {
  return rows
    .filter((r) => r.asset.trim() && Number(r.quantity) > 0)
    .map((r) => ({
      asset: r.asset.trim().toUpperCase(),
      quantity: Number(r.quantity),
      ...(Number(r.avgCost) > 0 && !isStable(r.asset.trim().toUpperCase()) ? { avgCost: Number(r.avgCost) } : {}),
    }));
}

// ───────────────────────── 编辑器 ─────────────────────────

export function HoldingsEditor({
  holdings,
  onSave,
  onCancel,
}: {
  holdings: Holding[];
  onSave: (h: Holding[]) => Promise<string | null>;
  onCancel?: () => void;
}) {
  const [rows, setRows] = useState<RowDraft[]>(() => toDraft(holdings));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const patch = (i: number, p: Partial<RowDraft>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));

  const submit = async () => {
    setSaving(true);
    setError(null);
    const err = await onSave(toHoldings(rows));
    setSaving(false);
    if (err) setError(err);
  };

  return (
    <Card
      title="录入我的持仓"
      hint="只存在这台电脑上，不需要交易所 API Key，也不会连接任何账户。稳定币（USDT、USDC…）按 1 美元计。"
    >
      <div className="space-y-2">
        <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 text-[11px] text-zinc-500">
          <span>币种</span>
          <span>数量</span>
          <span>平均成本（USDT，可不填）</span>
          <span />
        </div>
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] items-center gap-2">
            <input
              className={`${inputCls} font-mono uppercase`}
              value={r.asset}
              placeholder="BTC"
              onChange={(e) => patch(i, { asset: e.target.value.toUpperCase() })}
              aria-label="币种"
            />
            <input
              className={`${inputCls} font-mono`}
              inputMode="decimal"
              value={r.quantity}
              placeholder="0.5"
              onChange={(e) => patch(i, { quantity: e.target.value })}
              aria-label="数量"
            />
            <input
              className={`${inputCls} font-mono`}
              inputMode="decimal"
              value={r.avgCost}
              disabled={isStable(r.asset.trim().toUpperCase())}
              placeholder={isStable(r.asset.trim().toUpperCase()) ? '—' : '60000'}
              onChange={(e) => patch(i, { avgCost: e.target.value })}
              aria-label="平均成本"
            />
            <button
              type="button"
              className="text-[11px] text-zinc-600 hover:text-rose-400"
              onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
            >
              删除
            </button>
          </div>
        ))}
        <button
          type="button"
          className="text-[11px] text-zinc-500 hover:text-zinc-300"
          onClick={() => setRows((rs) => [...rs, { asset: '', quantity: '', avgCost: '' }])}
        >
          + 加一行
        </button>

        {error && (
          <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-xs leading-relaxed text-rose-400 ring-1 ring-rose-500/20">
            {error}
          </p>
        )}
        <div className="flex items-center gap-2 pt-1">
          <Button variant="primary" onClick={submit} disabled={saving}>
            {saving ? '保存中…' : '保存持仓'}
          </Button>
          {onCancel && (
            <Button onClick={onCancel} disabled={saving}>
              取消
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

// ───────────────────────── 只读视图 ─────────────────────────

export function PortfolioPanel({
  portfolio,
  drift,
  onEdit,
}: {
  portfolio: NonNullable<SteadySummary['portfolio']>;
  drift: DriftRow[];
  onEdit: () => void;
}) {
  const driftOf = new Map(drift.map((d) => [d.asset, d]));

  return (
    <Card
      title="我的组合"
      hint="市值按实时价格估算；稳定币按 1 美元计。"
      action={<Button onClick={onEdit}>编辑</Button>}
    >
      <div className="space-y-3">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-2xl tabular-nums text-zinc-100">{usd(portfolio.total, 0)}</span>
          <span className="text-xs text-zinc-500">USDT</span>
          <span className="ml-auto text-[11px] text-zinc-500">
            加密 {pct(portfolio.cryptoPct, 0)} · 稳定币 {pct(portfolio.stablePct, 0)}
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[340px] text-xs">
            <thead>
              <tr className="text-left text-[11px] text-zinc-500">
                <th className="pb-1 font-normal">币种</th>
                <th className="hidden pb-1 text-right font-normal sm:table-cell">数量</th>
                <th className="pb-1 text-right font-normal">市值</th>
                <th className="pb-1 text-right font-normal">占比 / 目标</th>
                <th className="pb-1 text-right font-normal">盈亏</th>
              </tr>
            </thead>
            <tbody>
              {portfolio.rows.map((r) => {
                const d = driftOf.get(r.asset);
                const off = d && d.status !== 'ok';
                const weight = r.value != null && portfolio.total > 0 ? (r.value / portfolio.total) * 100 : null;
                return (
                  <tr key={r.asset} className="border-t border-zinc-800/80">
                    <td className="py-1.5 font-mono text-zinc-200">
                      {r.asset}
                      {r.stable && <span className="ml-1 text-[10px] text-zinc-600">现金</span>}
                    </td>
                    <td className="hidden py-1.5 text-right font-mono tabular-nums text-zinc-400 sm:table-cell">
                      {r.quantity.toLocaleString('en-US', { maximumFractionDigits: 6 })}
                    </td>
                    <td className="py-1.5 text-right font-mono tabular-nums text-zinc-200">
                      {r.value != null ? usd(r.value, 0) : <span className="text-amber-400">无行情</span>}
                    </td>
                    <td className="py-1.5 text-right font-mono tabular-nums">
                      <span className={off ? 'text-amber-400' : 'text-zinc-400'}>{pct(weight, 0)}</span>
                      <span className="text-zinc-600"> / {d ? pct(d.targetPct, 0) : '—'}</span>
                    </td>
                    <td
                      className={`py-1.5 text-right font-mono tabular-nums ${
                        r.pnlPct == null ? 'text-zinc-600' : r.pnlPct >= 0 ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {r.pnlPct == null ? '—' : signedPct(r.pnlPct, 1)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {portfolio.unpriced.length > 0 && (
          <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-400 ring-1 ring-amber-500/20">
            查不到 {portfolio.unpriced.join('、')} 的行情，没有计入总值与占比——请核对币种代码（需要是 XXXUSDT 交易对存在的币）。
          </p>
        )}

        <Explain summary="稳定币真的等于现金吗？">
          <p>
            不完全是。稳定币可能短暂脱锚（跌破 1 美元），发行方或你存放的平台也可能出问题。这里按 1 美元计只是为了算账方便，
            并不代表它没有风险。把全部「安全资金」放在同一个稳定币、同一个平台，本身就是一种集中。
          </p>
        </Explain>
      </div>
    </Card>
  );
}
