'use client';

import { useMemo, useState } from 'react';
import { describeDca, WEEKDAY_LABEL } from '@/lib/steady/plan';
import {
  BEAR_SHOCK,
  BUDGET_FRACTION,
  PROFILE_PRESETS,
  defaultBeta,
  deriveTargets,
  maxCryptoShare,
  sleeveLoss,
  stressLoss,
  type StressAsset,
} from '@/lib/steady/risk';
import { isStable, type Plan } from '@/lib/steady/schema';
import type { SteadySummary } from '@/lib/steady/types';
import { Button, Card, Explain, TONE_BOX, TONE_TEXT, inputCls, pct, type Tone } from './ui';

type Profile = Plan['profile'];

interface Draft {
  profile: Profile;
  maxLoss: string;
  targets: { asset: string; weight: string }[];
  dcaAmount: string;
  dcaFrequency: 'weekly' | 'monthly';
  dcaDay: string;
  band: string;
  ifLimitHit: string;
}

const toDraftTargets = (t: { asset: string; weightPct: number }[]) =>
  t.map((x) => ({ asset: x.asset, weight: String(x.weightPct) }));

function initialDraft(plan: Plan | null): Draft {
  if (plan) {
    return {
      profile: plan.profile,
      maxLoss: String(plan.maxLossPct),
      targets: toDraftTargets(plan.targets),
      dcaAmount: String(plan.dca.amount),
      dcaFrequency: plan.dca.frequency,
      dcaDay: String(plan.dca.day),
      band: String(plan.rebalanceBandPct),
      ifLimitHit: plan.ifLimitHit,
    };
  }
  // 第一次：默认「稳健」档，配置由底线反推——不让新手面对一张空白表格
  const p = PROFILE_PRESETS.balanced;
  return {
    profile: 'balanced',
    maxLoss: String(p.maxLossPct),
    targets: toDraftTargets(deriveTargets(p.maxLossPct)),
    dcaAmount: '0',
    dcaFrequency: 'weekly',
    dcaDay: '1',
    band: '5',
    ifLimitHit: '',
  };
}

function draftToPlan(d: Draft): Plan {
  return {
    profile: d.profile,
    maxLossPct: Number(d.maxLoss),
    targets: d.targets
      .filter((t) => t.asset.trim())
      .map((t) => ({ asset: t.asset.trim().toUpperCase(), weightPct: Number(t.weight) || 0 })),
    rebalanceBandPct: Number(d.band),
    dca: { amount: Number(d.dcaAmount) || 0, frequency: d.dcaFrequency, day: Number(d.dcaDay) },
    ifLimitHit: d.ifLimitHit.trim(),
  };
}

/** 建计划时的实时检查。用默认 beta（还没有持仓历史可算），界面上标注「估计」 */
function liveCheck(d: Draft) {
  const items: StressAsset[] = d.targets
    .filter((t) => t.asset.trim())
    .map((t) => ({
      asset: t.asset.trim().toUpperCase(),
      weight: (Number(t.weight) || 0) / 100,
      beta: defaultBeta(t.asset.trim().toUpperCase()),
    }));
  const maxLoss = Number(d.maxLoss) || 0;
  const loss = -stressLoss(items, BEAR_SHOCK) * 100;
  const sleeve = sleeveLoss(items, BEAR_SHOCK);
  const cryptoShare = items.filter((i) => !isStable(i.asset)).reduce((s, i) => s + i.weight, 0) * 100;
  const sum = d.targets.reduce((s, t) => s + (Number(t.weight) || 0), 0);
  return {
    loss,
    maxLoss,
    cryptoShare,
    maxShare: sleeve != null ? maxCryptoShare((maxLoss / 100) * BUDGET_FRACTION, sleeve) * 100 : null,
    sum,
    tone: (loss > maxLoss ? 'bad' : loss > maxLoss * 0.8 ? 'warn' : 'good') as Tone,
  };
}

// ───────────────────────── 编辑器（同时是首次引导）─────────────────────────

export function PlanEditor({
  initial,
  firstRun,
  onSave,
  onCancel,
}: {
  initial: Plan | null;
  firstRun?: boolean;
  /** 返回错误文案；成功返回 null */
  onSave: (plan: Plan) => Promise<string | null>;
  onCancel?: () => void;
}) {
  const [d, setD] = useState<Draft>(() => initialDraft(initial));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const check = useMemo(() => liveCheck(d), [d]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));

  const pickPreset = (profile: Exclude<Profile, 'custom'>) => {
    const p = PROFILE_PRESETS[profile];
    setD((prev) => ({
      ...prev,
      profile,
      maxLoss: String(p.maxLossPct),
      targets: toDraftTargets(deriveTargets(p.maxLossPct)),
    }));
  };

  const setMaxLoss = (v: string) => {
    const n = Number(v);
    const preset = (Object.keys(PROFILE_PRESETS) as Exclude<Profile, 'custom'>[]).find(
      (k) => PROFILE_PRESETS[k].maxLossPct === n,
    );
    setD((p) => ({ ...p, maxLoss: v, profile: preset ?? 'custom' }));
  };

  const setTarget = (i: number, patch: Partial<{ asset: string; weight: string }>) =>
    setD((p) => ({
      ...p,
      profile: 'custom',
      targets: p.targets.map((t, j) => (j === i ? { ...t, ...patch } : t)),
    }));

  const submit = async () => {
    setSaving(true);
    setError(null);
    const err = await onSave(draftToPlan(d));
    setSaving(false);
    if (err) setError(err);
  };

  const sumOk = Math.abs(check.sum - 100) <= 0.5;

  return (
    <Card
      title={firstRun ? '第一步：写下你的底线' : '修改我的计划'}
      hint={
        firstRun
          ? '稳健投资的第一步不是选币，而是在行情冲昏头脑之前，先定好规则。'
          : '改的是你自己的规则。保存后，所有提示都会按新规则重算。'
      }
    >
      <div className="space-y-5">
        {/* 1. 底线 */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-zinc-200">① 这笔钱，最多能接受暂时亏掉多少？</p>
          <div className="grid grid-cols-3 gap-2">
            {(Object.keys(PROFILE_PRESETS) as Exclude<Profile, 'custom'>[]).map((k) => {
              const p = PROFILE_PRESETS[k];
              const on = d.profile === k;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => pickPreset(k)}
                  className={`rounded-lg px-2 py-2 text-left ring-1 transition-colors ${
                    on ? 'bg-zinc-100 text-zinc-900 ring-zinc-100' : 'bg-zinc-950 text-zinc-300 ring-zinc-800 hover:ring-zinc-600'
                  }`}
                >
                  <span className="block text-xs font-medium">
                    {p.label} · {p.maxLossPct}%
                  </span>
                  <span className={`mt-0.5 block text-[10px] leading-snug ${on ? 'text-zinc-600' : 'text-zinc-500'}`}>
                    {p.hint}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <span>或自己填：</span>
            <input
              className={`${inputCls} !w-20 font-mono`}
              inputMode="decimal"
              value={d.maxLoss}
              onChange={(e) => setMaxLoss(e.target.value)}
              aria-label="最大可接受亏损百分比"
            />
            <span>%（5–80）</span>
          </div>
          <p className="text-[11px] leading-relaxed text-zinc-500">
            建议只放「亏光了也不影响生活」的钱。这里的亏损指<b className="text-zinc-400">这个组合本身</b>从高点往下的跌幅。
          </p>
        </div>

        {/* 2. 配置 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium text-zinc-200">② 按底线反推出的目标配置</p>
            <button
              type="button"
              className="text-[11px] text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline"
              onClick={() => {
                const n = Number(d.maxLoss);
                if (Number.isFinite(n) && n >= 5 && n <= 80) {
                  setD((p) => ({ ...p, targets: toDraftTargets(deriveTargets(n)) }));
                }
              }}
            >
              按底线重新反推
            </button>
          </div>
          <div className="space-y-1.5">
            {d.targets.map((t, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  className={`${inputCls} !w-24 font-mono uppercase`}
                  value={t.asset}
                  placeholder="币种"
                  onChange={(e) => setTarget(i, { asset: e.target.value.toUpperCase() })}
                  aria-label="币种"
                />
                <input
                  className={`${inputCls} !w-20 font-mono`}
                  inputMode="decimal"
                  value={t.weight}
                  onChange={(e) => setTarget(i, { weight: e.target.value })}
                  aria-label="目标占比"
                />
                <span className="text-xs text-zinc-500">%</span>
                {isStable(t.asset.trim().toUpperCase()) && (
                  <span className="text-[11px] text-zinc-600">稳定币（视为现金）</span>
                )}
                <button
                  type="button"
                  className="ml-auto text-[11px] text-zinc-600 hover:text-rose-400"
                  onClick={() => setD((p) => ({ ...p, profile: 'custom', targets: p.targets.filter((_, j) => j !== i) }))}
                >
                  删除
                </button>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between">
            <button
              type="button"
              className="text-[11px] text-zinc-500 hover:text-zinc-300"
              onClick={() => setD((p) => ({ ...p, profile: 'custom', targets: [...p.targets, { asset: '', weight: '0' }] }))}
            >
              + 加一个币种
            </button>
            <span className={`font-mono text-[11px] ${sumOk ? 'text-zinc-500' : 'text-rose-400'}`}>
              合计 {check.sum.toFixed(1)}%{sumOk ? '' : '（必须是 100%）'}
            </span>
          </div>

          {/* 实时自检：先看风险，再决定 */}
          <div className={`rounded-lg p-3 ring-1 ${TONE_BOX[check.tone]}`}>
            <p className={`text-xs font-medium ${TONE_TEXT[check.tone]}`}>
              熊市情景（BTC 跌 75%）下，这个配置约亏 {pct(check.loss, 1)}
              ，你的底线是 {pct(check.maxLoss, 0)}
              {check.loss > check.maxLoss ? ' —— 超出了' : check.tone === 'warn' ? ' —— 已很接近' : ' —— 在底线之内'}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">
              加密资产占 {pct(check.cryptoShare, 0)}
              {check.maxShare != null && `；按你的底线并留 20% 安全垫，最多约 ${pct(check.maxShare, 0)}`}。其余放稳定币。
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">
              这是情景压力，不是预测；beta 为默认估计值（BTC 1、ETH 1.2、其他 1.5），录入持仓后会改用实测值。
            </p>
          </div>
        </div>

        {/* 3. 定投 */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-zinc-200">③ 每期定投多少？（不想设就填 0）</p>
          <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
            <select
              className={`${inputCls} !w-20`}
              value={d.dcaFrequency}
              onChange={(e) => {
                const f = e.target.value as 'weekly' | 'monthly';
                setD((p) => ({ ...p, dcaFrequency: f, dcaDay: '1' }));
              }}
              aria-label="定投频率"
            >
              <option value="weekly">每周</option>
              <option value="monthly">每月</option>
            </select>
            <select
              className={`${inputCls} !w-24`}
              value={d.dcaDay}
              onChange={(e) => set('dcaDay', e.target.value)}
              aria-label="定投日"
            >
              {d.dcaFrequency === 'weekly'
                ? [1, 2, 3, 4, 5, 6, 7].map((n) => (
                    <option key={n} value={n}>
                      {WEEKDAY_LABEL[n]}
                    </option>
                  ))
                : Array.from({ length: 28 }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {n} 日
                    </option>
                  ))}
            </select>
            <input
              className={`${inputCls} !w-24 font-mono`}
              inputMode="decimal"
              value={d.dcaAmount}
              onChange={(e) => set('dcaAmount', e.target.value)}
              aria-label="每期投入金额"
            />
            <span>USDT</span>
          </div>
        </div>

        {/* 4. 预案 + 容忍带 */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-zinc-200">④ 写下预案：回撤到底线时，我（在冷静的现在）决定怎么做</p>
          <textarea
            className={`${inputCls} min-h-16 leading-relaxed`}
            value={d.ifLimitHit}
            maxLength={300}
            placeholder="例如：不卖出、暂停加仓、继续按计划定投，并在一周后再看一次。"
            onChange={(e) => set('ifLimitHit', e.target.value)}
          />
          <p className="text-[11px] leading-relaxed text-zinc-500">
            人在亏损的当下最容易做出后悔的决定，所以决定要在亏损之前写好。回撤真的到了，这段话会原样出现在「今天要做什么」里。
          </p>
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <span>再平衡容忍带：偏离目标超过</span>
            <input
              className={`${inputCls} !w-16 font-mono`}
              inputMode="decimal"
              value={d.band}
              onChange={(e) => set('band', e.target.value)}
              aria-label="再平衡容忍带"
            />
            <span>个百分点才提醒</span>
          </div>
        </div>

        {error && (
          <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-xs leading-relaxed text-rose-400 ring-1 ring-rose-500/20">
            {error}
          </p>
        )}

        <div className="flex items-center gap-2">
          <Button variant="primary" onClick={submit} disabled={saving || !sumOk}>
            {saving ? '保存中…' : firstRun ? '保存我的底线' : '保存修改'}
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

export function PlanPanel({
  plan,
  budget,
  onEdit,
}: {
  plan: Plan;
  budget: SteadySummary['budget'];
  onEdit: () => void;
}) {
  // 有持仓时用实测 beta 算的结果；还没录持仓时，用默认 beta 估计——这个检查只依赖计划本身，不该等持仓
  const estimated = budget == null;
  const planLoss =
    budget?.planTailLossPct ??
    -stressLoss(
      plan.targets.map((t) => ({ asset: t.asset, weight: t.weightPct / 100, beta: defaultBeta(t.asset) })),
      BEAR_SHOCK,
    ) * 100;
  const tone: Tone =
    planLoss > plan.maxLossPct ? 'bad' : planLoss > plan.maxLossPct * 0.8 ? 'warn' : 'good';

  return (
    <Card
      title="我的底线"
      hint="你在冷静时写下的规则。今天的提示都来自它。"
      action={<Button onClick={onEdit}>修改</Button>}
    >
      <div className="space-y-3">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-2xl tabular-nums text-zinc-100">-{pct(plan.maxLossPct, 0)}</span>
          <span className="text-xs text-zinc-500">是我能接受的最大暂时亏损</span>
        </div>

        <p className={`text-xs leading-relaxed ${TONE_TEXT[tone]}`}>
          你的目标配置在熊市情景下约亏 {pct(planLoss, 1)}
          {estimated ? '（按默认 beta 估计）' : ''}
          {tone === 'bad' ? '，超出了这条底线——计划与底线自相矛盾，建议调整其一。' : '，在底线之内。'}
        </p>

        <div className="space-y-1.5">
          <p className="text-[11px] text-zinc-500">目标配置</p>
          {plan.targets.map((t) => (
            <div key={t.asset} className="flex items-center gap-2 text-xs">
              <span className="w-12 font-mono text-zinc-300">{t.asset}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-800">
                <div
                  className={isStable(t.asset) ? 'h-full bg-zinc-500' : 'h-full bg-sky-500/80'}
                  style={{ width: `${Math.min(100, t.weightPct)}%` }}
                />
              </div>
              <span className="w-10 text-right font-mono tabular-nums text-zinc-400">{t.weightPct}%</span>
            </div>
          ))}
        </div>

        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
          <dt className="text-zinc-500">定投</dt>
          <dd className="text-right text-zinc-300">{describeDca(plan.dca)}</dd>
          <dt className="text-zinc-500">再平衡容忍带</dt>
          <dd className="text-right text-zinc-300">±{plan.rebalanceBandPct} 个百分点</dd>
        </dl>

        <div className="rounded-lg bg-zinc-950/60 p-2.5 ring-1 ring-zinc-800/80">
          <p className="text-[11px] text-zinc-500">触及底线时，我的预案</p>
          <p className="mt-1 text-xs leading-relaxed text-zinc-300">
            {plan.ifLimitHit || '（还没写。趁现在冷静，建议补上。）'}
          </p>
        </div>

        {budget?.maxCryptoSharePct != null && (
          <Explain summary="这个配置是怎么反推出来的？">
            <p>
              先算「每 1 块钱放进你现在这批币里，在熊市情景（BTC 跌 75%）下会亏多少」，再用你的底线
              {pct(plan.maxLossPct, 0)} 的 80%（留 20% 安全垫，因为熊市基准只是假设，下一次可能更深）去除它，
              得到加密资产在整个组合里最多能占多少。其余放稳定币。
            </p>
            <p>
              这是你自己设定的底线的算术推论，不是荐股：它不告诉你买什么，只告诉你「按你自己的底线，
              放多少进风险资产才不会超预算」。当前持仓里加密资产占 {pct(budget.currentCryptoSharePct, 0)}，
              按底线上限约 {pct(budget.maxCryptoSharePct, 0)}。
            </p>
          </Explain>
        )}
      </div>
    </Card>
  );
}
