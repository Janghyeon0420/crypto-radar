'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AlertEvent, AlertRule } from '../alerts/types';

interface AlertState {
  rules: AlertRule[];
  /** 触发历史，只留最近 50 条 */
  events: AlertEvent[];
  addRule: (rule: Omit<AlertRule, 'id' | 'createdAt' | 'enabled'>) => void;
  removeRule: (id: string) => void;
  toggleRule: (id: string) => void;
  recordEvents: (events: AlertEvent[]) => void;
  clearEvents: () => void;
}

export const useAlerts = create<AlertState>()(
  persist(
    (set) => ({
      rules: [],
      events: [],

      addRule: (rule) =>
        set((state) => ({
          rules: [
            ...state.rules,
            {
              ...rule,
              id: crypto.randomUUID(),
              enabled: true,
              createdAt: Date.now(),
            },
          ],
        })),

      removeRule: (id) =>
        set((state) => ({ rules: state.rules.filter((r) => r.id !== id) })),

      toggleRule: (id) =>
        set((state) => ({
          rules: state.rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)),
        })),

      recordEvents: (events) =>
        set((state) => ({
          events: [...events, ...state.events].slice(0, 50),
          // 记下触发时间用于冷却；once 规则触发后直接关闭
          rules: state.rules.map((r) => {
            const hit = events.find((e) => e.ruleId === r.id);
            if (!hit) return r;
            return { ...r, lastTriggeredAt: hit.triggeredAt, enabled: r.once ? false : r.enabled };
          }),
        })),

      clearEvents: () => set({ events: [] }),
    }),
    { name: 'crypto-radar-alerts' },
  ),
);
