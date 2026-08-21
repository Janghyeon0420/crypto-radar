'use client';

import { useEffect, useState } from 'react';
import { MicrostructureStream, type Microstructure } from '../ws/microstructure';
import { OkxMicrostructureStream } from '../ws/okx-microstructure';

/**
 * 订阅当前币种的盘口与主动成交。
 *
 * 按 `source` 挑用哪条流：币安的币走 microstructure.ts，
 * OKX 的走 okx-microstructure.ts。两者对外发出同一个 Microstructure，
 * 组件不需要区分。
 *
 * 与 Dashboard / NewsPanel 同一套写法：数据连同它所属的币种一起存，
 * 「是不是上一个币的数据」由比较推导，而不是在 effect 里同步清空 state。
 */
export function useMicrostructure(symbol: string, source?: string): Microstructure | null {
  const [result, setResult] = useState<{ key: string; data: Microstructure } | null>(null);

  useEffect(() => {
    if (!symbol) return;
    // 来源未知时先不连：连错一家的结果是永远收不到数据，
    // 而界面会显示「连接中…」——那比等一下再连更糟
    if (!source) return;

    const stream =
      source === 'okx' ? new OkxMicrostructureStream() : new MicrostructureStream();
    const off = stream.subscribe((data) => setResult({ key: symbol, data }));
    stream.setSymbol(symbol);
    return () => {
      off();
      stream.close();
    };
  }, [symbol, source]);

  return result?.key === symbol ? result.data : null;
}
