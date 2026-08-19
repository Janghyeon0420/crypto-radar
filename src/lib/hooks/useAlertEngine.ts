'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AlertEvent } from '../alerts/types';

/**
 * 订阅服务端告警事件，并对新事件发出桌面通知。
 *
 * 求值已经全部移到服务端（lib/alerts/worker.ts），浏览器不再自己算。
 * 原因是两边同时求值会重复触发：同一条规则会既进服务端历史又进浏览器历史，
 * 通知也会发两遍。让服务端做唯一的判定方，浏览器只负责呈现。
 *
 * 代价是页面上的通知会滞后一个轮询周期（默认 60 秒）。
 * 对「盯盘提醒」这个用途可以接受，换来的是关掉页面照样收得到。
 */
export function useAlertEvents(pollMs = 20_000) {
  const [events, setEvents] = useState<AlertEvent[]>([]);
  /** 已经弹过通知的事件 id，避免轮询重复弹窗 */
  const notified = useRef<Set<string>>(new Set());
  /** 首次加载不弹通知——否则一打开页面就会被历史事件刷屏 */
  const primed = useRef(false);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch('/api/alerts/events', { signal });
      if (!res.ok) return;
      const data: { events: AlertEvent[] } = await res.json();
      setEvents(data.events);

      if (!primed.current) {
        for (const e of data.events) notified.current.add(e.id);
        primed.current = true;
        return;
      }

      const fresh = data.events.filter((e) => !notified.current.has(e.id));
      for (const e of fresh) notified.current.add(e.id);
      notify(fresh);
    } catch {
      // 轮询失败静默处理：服务可能正在重启，下一轮会自愈
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    // 首次拉取推迟到本次渲染提交之后，避免同步 setState 引发级联渲染
    const first = setTimeout(() => void refresh(ac.signal), 0);
    const t = setInterval(() => void refresh(ac.signal), pollMs);
    return () => {
      // abort 同时避免了组件卸载后仍在 setState
      ac.abort();
      clearTimeout(first);
      clearInterval(t);
    };
  }, [refresh, pollMs]);

  return { events, refresh: () => refresh() };
}

function notify(events: AlertEvent[]): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  for (const e of events) {
    new Notification(`Crypto Radar · ${e.symbol.replace(/USDT$/, '')}`, {
      body: e.message,
      // tag 用 ruleId，同一规则的重复通知会替换而不是堆叠
      tag: e.ruleId,
    });
  }
}
