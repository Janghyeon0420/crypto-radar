import { NextResponse } from 'next/server';
import { BINANCE_REST } from '@/lib/datasources/binance-vision';
import { isAnalysisAvailable } from '@/lib/analysis/claude';
import type { SourceHealth } from '@/lib/datasources/types';

/**
 * 数据源健康检查。
 *
 * 这个接口在本项目里不是可有可无的运维摆设——由于用户网络环境受地区限制，
 * "某个源今天还能不能用"是真实会变的状态，前端需要明确显示出来，
 * 而不是让用户对着空白图表猜是哪里坏了。
 */
const PROBES = [
  { id: 'binance-vision', label: '币安公开行情（现货）', url: `${BINANCE_REST}/api/v3/ping` },
  { id: 'okx', label: 'OKX（衍生品）', url: 'https://www.okx.com/api/v5/public/time' },
  { id: 'fng', label: '恐惧贪婪指数', url: 'https://api.alternative.me/fng/?limit=1' },
  { id: 'cointelegraph', label: 'Cointelegraph 资讯', url: 'https://cointelegraph.com/rss' },
  // 故意保留一个受限探针：让看板直观显示"主站确实被封，镜像确实可用"
  { id: 'binance-main', label: '币安主站（预期受限）', url: 'https://api.binance.com/api/v3/ping' },
];

export async function GET() {
  const results = await Promise.all(
    PROBES.map(async ({ id, label, url }): Promise<SourceHealth> => {
      const started = Date.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
        clearTimeout(timer);
        return {
          id,
          label,
          ok: res.ok,
          latencyMs: Date.now() - started,
          error: res.ok ? undefined : `HTTP ${res.status}`,
          checkedAt: Date.now(),
        };
      } catch (err) {
        return {
          id,
          label,
          ok: false,
          latencyMs: Date.now() - started,
          error: err instanceof Error ? err.message : String(err),
          checkedAt: Date.now(),
        };
      }
    }),
  );

  return NextResponse.json({ sources: results, llmConfigured: isAnalysisAvailable() });
}
