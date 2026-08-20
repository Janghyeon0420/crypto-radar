'use client';

import { useEffect, useState } from 'react';
import type { MacroSnapshot } from '../datasources/types';

/**
 * 宏观快照（美联储）。
 *
 * 有两个组件同时需要它：图表下方的环境条要利率与议息倒计时，
 * 宏观面板还要资讯列表。所以在模块级共享一次请求，
 * 而不是各拉各的——同一份数据没必要跑两趟。
 *
 * 数据本身变化极慢（利率每业务日一次、议息几周一次），
 * 前端缓存 10 分钟，切换币种、来回切标签页都不会重新请求。
 */
const TTL_MS = 10 * 60_000;

let cached: { at: number; data: MacroSnapshot } | null = null;
let inflight: Promise<MacroSnapshot> | null = null;

function load(): Promise<MacroSnapshot> {
  if (cached && Date.now() - cached.at < TTL_MS) return Promise.resolve(cached.data);
  // 已有请求在途时复用它，避免两个组件同时挂载各发一次
  if (inflight) return inflight;

  inflight = fetch('/api/macro')
    .then((r) => r.json())
    .then((data: MacroSnapshot) => {
      cached = { at: Date.now(), data };
      return data;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function useMacro(): { macro: MacroSnapshot | null; loading: boolean } {
  const [macro, setMacro] = useState<MacroSnapshot | null>(cached?.data ?? null);
  const [loading, setLoading] = useState(!macro);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((d) => {
        if (cancelled) return;
        setMacro(d);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { macro, loading };
}

/** 距下次议息还有多久。返回 null 表示日历不可用。 */
export function countdownToMeeting(decisionAt: number): string {
  const ms = decisionAt - Date.now();
  if (ms <= 0) return '进行中';
  const days = Math.floor(ms / 86400_000);
  if (days >= 1) return `${days} 天后`;
  const hours = Math.floor(ms / 3600_000);
  return hours >= 1 ? `${hours} 小时后` : '不到 1 小时';
}
