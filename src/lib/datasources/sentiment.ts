/**
 * 市场情绪：alternative.me 的加密恐惧贪婪指数。
 * 免费、无需 key、实测在受限网络下可用，每天更新一次。
 */

import { fetchJson } from './http';
import type { SentimentSnapshot } from './types';

interface FngResponse {
  data: { value: string; value_classification: string; timestamp: string }[];
}

export async function fetchFearGreed(): Promise<SentimentSnapshot | null> {
  try {
    const raw = await fetchJson<FngResponse>('https://api.alternative.me/fng/?limit=1', {
      ttlMs: 600_000, // 每天才更新，缓存 10 分钟绰绰有余
    });
    const d = raw.data?.[0];
    if (!d) return null;
    return {
      fearGreed: +d.value,
      classification: d.value_classification,
      updatedAt: +d.timestamp * 1000,
    };
  } catch {
    return null;
  }
}

/** 取最近 N 天的指数序列，用于画情绪趋势线 */
export async function fetchFearGreedHistory(days = 30): Promise<{ t: number; v: number }[]> {
  try {
    const raw = await fetchJson<FngResponse>(`https://api.alternative.me/fng/?limit=${days}`, {
      ttlMs: 600_000,
    });
    return raw.data.map((d) => ({ t: +d.timestamp * 1000, v: +d.value })).reverse();
  } catch {
    return [];
  }
}
