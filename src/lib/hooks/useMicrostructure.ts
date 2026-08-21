'use client';

import { useEffect, useState } from 'react';
import { MicrostructureStream, type Microstructure } from '../ws/microstructure';

/**
 * 订阅当前币种的盘口与主动成交。
 *
 * 与 Dashboard / NewsPanel 同一套写法：数据连同它所属的币种一起存，
 * 「是不是上一个币的数据」由比较推导，而不是在 effect 里同步清空 state——
 * 那会触发级联渲染，也会在切换币种时闪一下空白。
 */
export function useMicrostructure(symbol: string): Microstructure | null {
  const [result, setResult] = useState<{ key: string; data: Microstructure } | null>(null);

  useEffect(() => {
    if (!symbol) return;
    const stream = new MicrostructureStream();
    const off = stream.subscribe((data) => setResult({ key: symbol, data }));
    stream.setSymbol(symbol);
    return () => {
      off();
      stream.close();
    };
  }, [symbol]);

  return result?.key === symbol ? result.data : null;
}
