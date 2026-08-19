'use client';

import { useEffect, useRef } from 'react';
import { useAlerts } from '../stores/alerts';
import { evaluateRules } from '../alerts/engine';
import type { TechnicalSnapshot } from '../indicators/summary';

/**
 * 在每次行情/技术面更新时求值告警规则，并发出桌面通知。
 *
 * 规则求值放在这里而不是各个组件里，是为了保证"一次数据更新只求值一次"——
 * 分散到组件里很容易因为多处渲染而重复触发同一条告警。
 */
export function useAlertEngine(
  symbol: string,
  price: number | undefined,
  technical: TechnicalSnapshot | null,
) {
  const rules = useAlerts((s) => s.rules);
  const recordEvents = useAlerts((s) => s.recordEvents);
  // 保留上一次的技术面，用于识别"状态发生转变"类的规则（如布林带挤压结束）
  const prevTechnicalRef = useRef<TechnicalSnapshot | null>(null);

  useEffect(() => {
    if (!symbol || price == null) return;

    const events = evaluateRules(rules, {
      symbol,
      price,
      technical,
      previousTechnical: prevTechnicalRef.current,
    });
    prevTechnicalRef.current = technical;

    if (events.length === 0) return;
    recordEvents(events);

    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      for (const e of events) {
        new Notification(`Crypto Radar · ${e.symbol.replace(/USDT$/, '')}`, {
          body: e.message,
          // tag 用 ruleId，同一规则的重复通知会替换而不是堆叠
          tag: e.ruleId,
        });
      }
    }
  }, [symbol, price, technical, rules, recordEvents]);
}
