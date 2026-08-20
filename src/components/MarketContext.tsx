'use client';

import { useEffect, useState } from 'react';
import type { DerivativesSnapshot, SentimentSnapshot } from '@/lib/datasources/types';
import { formatCompact } from '@/lib/format';
import { countdownToMeeting, useMacro } from '@/lib/hooks/useMacro';

/**
 * 衍生品、市场情绪与美联储政策。三者都是"环境变量"，
 * 用来给单币种的技术面提供背景。
 *
 * 政策利率放在这一行而不是只放宏观标签页里，是因为它属于"看盘时应该一直在余光里"
 * 的那类信息——尤其是议息倒计时：议息夜前后的行情性质和平时完全不同，
 * 需要翻标签页才能看到的话，多半就会忘。
 */
export function MarketContext({ symbol }: { symbol: string }) {
  const [deriv, setDeriv] = useState<DerivativesSnapshot | null>(null);
  const [sentiment, setSentiment] = useState<SentimentSnapshot | null>(null);
  const { macro } = useMacro();

  useEffect(() => {
    fetch(`/api/derivatives?symbol=${symbol}`)
      .then((r) => r.json())
      .then((d: { derivatives: DerivativesSnapshot | null }) => setDeriv(d.derivatives))
      .catch(() => setDeriv(null));
  }, [symbol]);

  useEffect(() => {
    fetch('/api/sentiment')
      .then((r) => r.json())
      .then((d: { sentiment: SentimentSnapshot | null }) => setSentiment(d.sentiment))
      .catch(() => setSentiment(null));
  }, []);

  return (
    <div className="grid grid-cols-5 gap-4 p-4 text-sm">
      <div>
        <p className="text-xs text-zinc-500">资金费率</p>
        {deriv ? (
          <>
            <p
              className={`font-mono tabular-nums ${deriv.fundingRate >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}
            >
              {(deriv.fundingRate * 100).toFixed(4)}%
            </p>
            <p className="text-[11px] text-zinc-600">
              年化 {(deriv.fundingRate * 3 * 365 * 100).toFixed(1)}%
            </p>
          </>
        ) : (
          <p className="text-zinc-600">无合约</p>
        )}
      </div>

      <div>
        <p className="text-xs text-zinc-500">未平仓量</p>
        <p className="font-mono text-zinc-100 tabular-nums">
          {deriv ? formatCompact(deriv.openInterest) : '—'}
        </p>
        <p className="text-[11px] text-zinc-600">{deriv ? deriv.source.toUpperCase() : ''}</p>
      </div>

      <div>
        <p className="text-xs text-zinc-500">恐惧贪婪</p>
        {sentiment ? (
          <>
            <p className={`font-mono tabular-nums ${fngColor(sentiment.fearGreed)}`}>
              {sentiment.fearGreed}
            </p>
            <p className="text-[11px] text-zinc-600">{sentiment.classification}</p>
          </>
        ) : (
          <p className="text-zinc-600">—</p>
        )}
      </div>

      <div>
        <p className="text-xs text-zinc-500">联邦基金利率</p>
        {macro?.policyRate ? (
          <>
            <p className="font-mono text-zinc-100 tabular-nums">
              {macro.policyRate.targetLow.toFixed(2)}–{macro.policyRate.targetHigh.toFixed(2)}%
            </p>
            <p className="text-[11px] text-zinc-600">
              EFFR {macro.policyRate.effectiveRate.toFixed(2)}%
            </p>
          </>
        ) : (
          <p className="text-zinc-600">—</p>
        )}
      </div>

      <div>
        <p className="text-xs text-zinc-500">下次议息</p>
        {macro?.nextMeeting ? (
          <>
            <p className="font-mono text-amber-400 tabular-nums">
              {countdownToMeeting(macro.nextMeeting.decisionAt)}
            </p>
            <p className="text-[11px] text-zinc-600">
              {macro.nextMeeting.label.replace(/^\d+ 年 /, '')}
              {macro.nextMeeting.hasProjections && ' · 含点阵图'}
            </p>
          </>
        ) : (
          <p className="text-zinc-600">—</p>
        )}
      </div>
    </div>
  );
}

// 低分=恐惧（潜在买点）用暖色，高分=贪婪（潜在风险）用冷色，与"涨绿跌红"是两套语义，故意区分开
const fngColor = (v: number) =>
  v <= 25 ? 'text-orange-400' : v >= 75 ? 'text-sky-400' : 'text-zinc-100';
