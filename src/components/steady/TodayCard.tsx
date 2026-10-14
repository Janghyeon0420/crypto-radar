'use client';

import type { Action, ActionLevel } from '@/lib/steady/actions';
import { Card, TONE_BOX, TONE_TEXT, type Tone } from './ui';

const LEVEL: Record<ActionLevel, { tone: Tone; icon: string; label: string }> = {
  alert: { tone: 'bad', icon: '!', label: '需要你现在看一眼' },
  warn: { tone: 'warn', icon: '!', label: '有一项接近你的底线' },
  info: { tone: 'info', icon: 'i', label: '按计划，今天有一件小事' },
  ok: { tone: 'good', icon: '✓', label: '一切在计划之内' },
};

/**
 * 今日行动。整页最重要的一块：回答「我今天要不要做点什么」。
 *
 * 绝大多数日子答案是「不用」，而且要敢于明说——一个永远在提示「注意！」的界面，
 * 会让人养成每天盯盘的习惯，而盯盘本身就是追涨杀跌的起点。
 */
export function TodayCard({ actions }: { actions: Action[] }) {
  const top = actions[0]?.level ?? 'ok';
  const head = LEVEL[top];

  return (
    <Card title="今天要做什么" hint={head.label}>
      <ul className="space-y-2.5">
        {actions.map((a) => {
          const l = LEVEL[a.level];
          return (
            <li key={a.id} className={`rounded-lg p-3 ring-1 ${TONE_BOX[l.tone]}`}>
              <div className="flex gap-2.5">
                <span
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-950/60 text-[11px] font-bold ${TONE_TEXT[l.tone]}`}
                  aria-hidden
                >
                  {l.icon}
                </span>
                <div className="min-w-0">
                  <p className={`text-sm font-medium ${TONE_TEXT[l.tone]}`}>{a.title}</p>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-300">{a.detail}</p>
                  <details className="mt-1.5">
                    <summary className="cursor-pointer select-none text-[11px] text-zinc-500 hover:text-zinc-300">
                      为什么会出现这条？
                    </summary>
                    <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">{a.why}</p>
                  </details>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
