'use client';

import type { SteadySummary } from '@/lib/steady/types';
import { Card, Explain, Stat, pct, signedPct } from './ui';

const volLabel = (p: number | null) =>
  p == null ? '—' : p >= 80 ? '偏躁动' : p <= 20 ? '偏平静' : '正常';

/**
 * 市场环境：只描述，不预测。
 *
 * 这几项是 BTC 价格本身算出来的「现在是什么状态」。项目的四次回测（docs/ROADMAP.md）
 * 都没有测出它们对后续涨跌有可靠的预测力，所以这里不配涨跌配色、不说「该买/该卖」——
 * 它的用途只是帮你校准心理预期：现在是平静期还是躁动期，离高点有多远。
 */
export function EnvironmentStrip({ env }: { env: NonNullable<SteadySummary['environment']> }) {
  return (
    <Card title="市场环境" hint="只描述现在是什么状态，不预测明天。">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat
            label="BTC 距一年高点"
            value={env.drawdownFromHighPct > -0.05 ? '在高点' : `${env.drawdownFromHighPct.toFixed(1)}%`}
            sub="近 365 天最高收盘"
          />
          <Stat
            label="距 200 日均线"
            value={signedPct(env.distFromSma200Pct, 1)}
            sub={env.distFromSma200Pct == null ? '历史不足 200 天' : env.distFromSma200Pct >= 0 ? '在均线上方' : '在均线下方'}
          />
          <Stat
            label="近 30 日波动（年化）"
            value={pct(env.vol30Pct, 0)}
            sub={`${volLabel(env.volPercentile)}${env.volPercentile != null ? `（历史第 ${env.volPercentile.toFixed(0)} 百分位）` : ''}`}
          />
          <Stat
            label="市场情绪"
            value={env.fearGreed != null ? String(env.fearGreed) : '—'}
            sub={env.fearGreedLabel ?? '恐惧贪婪指数'}
          />
        </div>
        <Explain summary="这些能帮我判断涨跌吗？">
          <p>
            不能，也不该这么用。本项目对类似的指标做过多次历史回测，没有一个测出稳定的方向预测力。
            它们的价值是校准预期：比如「现在波动在历史高位」意味着接下来净值可能摇得更厉害，
            这时更需要提前想好自己会不会拿得住，而不是赶着做点什么。
          </p>
        </Explain>
      </div>
    </Card>
  );
}
