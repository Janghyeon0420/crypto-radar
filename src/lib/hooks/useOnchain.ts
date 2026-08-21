'use client';

import { useEffect, useState } from 'react';
import type { OnchainSnapshot } from '../datasources/onchain';

/**
 * 链上快照。与 useMacro 同一套模块级共享缓存的写法——
 * 数据是日频/十分钟频，没必要每次挂载都重新请求。
 */
const TTL_MS = 10 * 60_000;

let cached: { at: number; data: OnchainSnapshot } | null = null;
let inflight: Promise<OnchainSnapshot> | null = null;

function load(): Promise<OnchainSnapshot> {
  if (cached && Date.now() - cached.at < TTL_MS) return Promise.resolve(cached.data);
  if (inflight) return inflight;

  inflight = fetch('/api/onchain')
    .then((r) => r.json())
    .then((data: OnchainSnapshot) => {
      cached = { at: Date.now(), data };
      return data;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function useOnchain(): OnchainSnapshot | null {
  const [data, setData] = useState<OnchainSnapshot | null>(cached?.data ?? null);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        // 拉不到就不显示这一块，其余内容不受影响
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return data;
}
