'use client';

import type { SteadySummary } from '@/lib/steady/types';
import { Card, Explain, Stat, TONE_TEXT, pct, usd, type Tone } from './ui';

/** 跌幅（正数）相对底线的颜色：超过底线红，超过底线的 80% 黄，其余中性 */
const lossTone = (loss: number | null, max: number | null): Tone => {
  if (loss == null || max == null) return 'muted';
  if (loss > max) return 'bad';
  if (loss > max * 0.8) return 'warn';
  return 'muted';
};

/**
 * 风险体检。两类数字严格分开，标题就写明：
 *   - 历史回放：按你现在的比例，在已有历史上重放，是**事实**，但样本只有那一段历史；
 *   - 压力测试：假设 BTC 再跌 X%，是**假设**，不是预测。
 * 币安日线只能回溯约 2.7 年，覆盖不到真正的熊市，所以只看回放会低估风险——
 * 这条局限直接写在界面上，而不是藏在文档里。
 */
export function RiskPanel({ summary }: { summary: SteadySummary }) {
  const { replay, stress, betas, budget, plan, portfolio } = summary;
  const max = plan?.maxLossPct ?? null;

  if (!portfolio || portfolio.total <= 0) {
    return (
      <Card title="风险体检" hint="先看风险，再谈机会">
        <p className="text-xs leading-relaxed text-zinc-500">录入持仓后，这里会显示历史回放与压力测试。</p>
      </Card>
    );
  }

  return (
    <Card title="风险体检" hint="先看风险，再谈机会。这里不预测价格，只回答：最坏会亏多少。">
      <div className="space-y-5">
        {/* A. 历史回放 */}
        <div className="space-y-2">
          <div>
            <p className="text-xs font-medium text-zinc-200">① 历史回放：如果过去一直按现在的比例持有</p>
            <p className="text-[11px] text-zinc-500">事实，但样本只有已有的那一段历史。</p>
          </div>
          {replay ? (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat
                  label="最大回撤"
                  value={`-${pct(replay.maxDrawdownPct, 1)}`}
                  sub={`${replay.maxDrawdownFrom} → ${replay.maxDrawdownTo}`}
                  tone={lossTone(replay.maxDrawdownPct, max)}
                />
                <Stat
                  label="现在距高点"
                  value={replay.currentDrawdownPct < 0.05 ? '在高点' : `-${pct(replay.currentDrawdownPct, 1)}`}
                  sub="从这段历史的最高净值算起"
                  tone={lossTone(replay.currentDrawdownPct, max)}
                />
                <Stat
                  label="最差的 30 天"
                  value={replay.worst30dPct == null ? '—' : `-${pct(replay.worst30dPct, 1)}`}
                  sub="任意连续 30 天里的最大跌幅"
                  tone={lossTone(replay.worst30dPct, max)}
                />
                <Stat
                  label="年化波动"
                  value={pct(replay.annualVolPct, 0)}
                  sub="数字越大，净值上下摇得越厉害"
                />
              </div>
              <p className="text-[11px] leading-relaxed text-zinc-600">
                回放覆盖 {replay.windowDays} 天
                {replay.limitedBy ? `（受 ${replay.limitedBy} 的历史长度限制）` : ''}，每日再平衡、忽略手续费与滑点，
                是风险画像，不是收益承诺。
                {replay.windowDays < 1100 &&
                  '币安日线只能回溯约 2.7 年，没有覆盖到真正的熊市（BTC 历轮熊市跌幅约 75%–85%），所以只看这一栏会低估风险——请同时看下面的压力测试。'}
              </p>
            </>
          ) : (
            <p className="text-xs leading-relaxed text-zinc-500">
              {portfolio.cryptoPct <= 0
                ? '目前全是稳定币，没有价格波动可回放。'
                : '历史数据不足或没取到，暂时无法回放（见页面底部的「数据缺口」）。'}
            </p>
          )}
        </div>

        {/* B. 压力测试 */}
        <div className="space-y-2">
          <div>
            <p className="text-xs font-medium text-zinc-200">② 压力测试：如果 BTC 再跌……</p>
            <p className="text-[11px] text-zinc-500">假设情景，不是预测。其他币按各自的 beta 跟着跌，稳定币不动。</p>
          </div>
          <div className="space-y-1.5">
            {stress.map((s) => {
              const tone = lossTone(s.lossPct, max);
              return (
                <div
                  key={s.shockPct}
                  className={`rounded-lg px-3 py-2 ring-1 ${s.isBear ? 'bg-zinc-950/80 ring-zinc-700' : 'bg-zinc-950/40 ring-zinc-800/70'}`}
                >
                  <div className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="text-zinc-300">
                      BTC {s.shockPct}%
                      {s.isBear && <span className="ml-1.5 text-[10px] text-zinc-500">熊市基准</span>}
                    </span>
                    <span className={`font-mono tabular-nums ${TONE_TEXT[tone === 'muted' ? 'info' : tone]}`}>
                      组合约 -{pct(s.lossPct, 1)} · {usd(s.lossValue, 0)} USDT
                    </span>
                  </div>
                  <div className="relative mt-1.5 h-1.5 overflow-hidden rounded-full bg-zinc-800">
                    <div
                      className={tone === 'bad' ? 'h-full bg-rose-500/80' : tone === 'warn' ? 'h-full bg-amber-500/80' : 'h-full bg-sky-500/70'}
                      style={{ width: `${Math.min(100, s.lossPct)}%` }}
                    />
                    {max != null && (
                      <div
                        className="absolute top-0 h-full w-px bg-zinc-200/70"
                        style={{ left: `${Math.min(100, max)}%` }}
                        title={`你的底线 ${max}%`}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {max != null && (
            <p className="text-[11px] text-zinc-600">竖线 = 你的底线（{pct(max, 0)}）。进度条越过它，说明这个情景下你的组合会亏过头。</p>
          )}
          {betas.length > 0 && (
            <p className="text-[11px] text-zinc-600">
              各币 beta（BTC 跌 1% 它大约跌多少）：
              {betas.map((b) => `${b.asset} ${b.beta.toFixed(2)}${b.estimated ? '（估计）' : ''}`).join('，')}
            </p>
          )}
        </div>

        {/* C. 风险预算 */}
        {plan && budget && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-zinc-200">③ 风险预算：按你自己的底线反推</p>
            <div className="rounded-lg bg-zinc-950/60 p-3 text-xs leading-relaxed text-zinc-300 ring-1 ring-zinc-800/80">
              <p>
                你的底线是 <b>-{pct(plan.maxLossPct, 0)}</b>。按熊市基准并留 20% 安全垫，加密资产最多能占整个组合的{' '}
                <b className={budget.currentCryptoSharePct > (budget.maxCryptoSharePct ?? 100) ? 'text-rose-400' : 'text-emerald-400'}>
                  {budget.maxCryptoSharePct != null ? `约 ${pct(budget.maxCryptoSharePct, 0)}` : '—'}
                </b>
                ；你现在是 <b>{pct(budget.currentCryptoSharePct, 0)}</b>。
              </p>
              <p className="mt-1 text-zinc-500">
                你的目标配置里加密占 {pct(budget.planCryptoSharePct, 0)}，熊市情景下约亏 {pct(budget.planTailLossPct, 1)}。
              </p>
            </div>
          </div>
        )}

        <Explain summary="这些词是什么意思？">
          <p>
            <b className="text-zinc-400">回撤</b>：从最高点往下跌了多少。-30% 意味着 1 万块的组合暂时只剩 7 千。
            回撤是「持有期间的真实体验」，比涨了多少更能决定你会不会半路放弃。
          </p>
          <p>
            <b className="text-zinc-400">波动</b>：价格上下摇摆的幅度。波动大，不等于一定亏，但意味着途中的坐过山车更剧烈。
          </p>
          <p>
            <b className="text-zinc-400">beta</b>：这个币相对 BTC 的「放大倍数」。ETH 的 beta 约 1.2，
            意味着 BTC 跌 10% 时 ETH 往往跌约 12%。
          </p>
          <p>
            <b className="text-zinc-400">为什么用 -75% 当熊市基准</b>：BTC 历轮熊市从高点到低点大约跌了 75%–85%
            （机构资料如 iShares 称其三次最大回撤平均约 80%）。取 75% 是偏温和的一端。
            它是历史量级的参考，不是对未来的预测——下一次可能更浅，也可能更深。
          </p>
        </Explain>
      </div>
    </Card>
  );
}
