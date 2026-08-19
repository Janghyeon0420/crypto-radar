'use client';

import { useEffect, useState } from 'react';
import type { SourceHealth } from '@/lib/datasources/types';

/**
 * 数据源状态条。
 *
 * 在受地区限制的网络下，"哪个源今天通不通"是会变的，必须显式暴露给用户，
 * 否则图表空白时无从判断是网络问题、上游故障还是代码 bug。
 * 其中「币安主站」是故意保留的对照探针，预期为红色。
 */
interface EgressInfo {
  ip: string;
  country: string | null;
  city: string | null;
  viaProxy: boolean;
}

interface ProviderInfo {
  configured: boolean;
  id: string | null;
  label: string | null;
  model: string | null;
  viaRelay: boolean;
  needsProxy: boolean;
}

interface HealthResponse {
  sources: SourceHealth[];
  llm: ProviderInfo;
  egress: EgressInfo | null;
  proxyConfigured: boolean;
  proxyEnabled: boolean;
}

export function SourceHealthBar() {
  const [sources, setSources] = useState<SourceHealth[]>([]);
  const [llm, setLlm] = useState<ProviderInfo | null>(null);
  const [egress, setEgress] = useState<EgressInfo | null>(null);
  const [proxyReady, setProxyReady] = useState<boolean | null>(null);

  useEffect(() => {
    const load = () =>
      fetch('/api/health')
        .then((r) => r.json())
        .then((d: HealthResponse) => {
          setSources(d.sources);
          setLlm(d.llm);
          setEgress(d.egress);
          setProxyReady(d.proxyConfigured && d.proxyEnabled);
        })
        .catch(() => setSources([]));
    load();
    const timer = setInterval(load, 120_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
      {/* 服务端出口。中国大陆直连意味着 OKX / Anthropic 会被拦，必须让用户第一眼看到 */}
      {egress && (
        <span
          className="flex items-center gap-1.5"
          title={`服务端出口 ${egress.ip}${egress.viaProxy ? '（经代理）' : '（直连，未走代理）'}`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              egress.country === 'CN' && !egress.viaProxy ? 'bg-amber-500' : 'bg-sky-500'
            }`}
          />
          出口 {egress.country ?? '?'}
          {egress.city ? ` · ${egress.city}` : ''}
          {!egress.viaProxy && proxyReady === false && (
            <span className="text-amber-500/80">未走代理</span>
          )}
        </span>
      )}
      {sources.map((s) => {
        // 主站探针失败是预期结果，不该显示成告警红
        const expectedFail = s.id === 'binance-main';
        const color = s.ok
          ? 'bg-emerald-500'
          : expectedFail
            ? 'bg-zinc-600'
            : 'bg-rose-500';
        return (
          <span key={s.id} className="flex items-center gap-1.5" title={s.error ?? `${s.latencyMs}ms`}>
            <span className={`h-1.5 w-1.5 rounded-full ${color}`} />
            {s.label}
            {expectedFail && !s.ok && <span className="text-zinc-700">已封锁·符合预期</span>}
          </span>
        );
      })}
      {llm && !llm.configured && (
        <span className="flex items-center gap-1.5 text-amber-500/70">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
          未配置 LLM 供应商
        </span>
      )}
      {llm?.configured && (
        <span
          className="flex items-center gap-1.5"
          title={
            llm.needsProxy
              ? `${llm.label} · 该供应商在中国大陆需经代理访问`
              : `${llm.label} · 国内直连可达`
          }
        >
          <span className="h-1.5 w-1.5 rounded-full bg-violet-500" />
          {llm.label}
          {llm.needsProxy && !egress?.viaProxy && (
            <span className="text-amber-500/80">需代理</span>
          )}
        </span>
      )}
    </div>
  );
}
