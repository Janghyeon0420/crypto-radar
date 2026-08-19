import { decideCache, DEFAULT_POLICY } from '../src/lib/history/cache.ts';

const mk = (minsAgo, price, atrPct) => ({
  id: 'x', symbol: 'BTCUSDT',
  createdAt: Date.now() - minsAgo * 60_000,
  priceAtAnalysis: price, atrPercentAtAnalysis: atrPct,
  analysis: {}, evaluation: null,
});

const cases = [
  ['无历史记录',              [],                          64000, false],
  ['5分钟前 价格未动',         [mk(5,  64000, 2.0)],        64000, true ],
  ['5分钟前 涨0.5%(阈值1.0%)', [mk(5,  64000, 2.0)],        64320, true ],
  ['5分钟前 涨1.5%(超阈值)',   [mk(5,  64000, 2.0)],        64960, false],
  ['31分钟前 价格未动(超时)',   [mk(31, 64000, 2.0)],        64000, false],
  ['29分钟前 价格未动',        [mk(29, 64000, 2.0)],        64000, true ],
  ['低波动币 ATR0.2% 漂移0.4%', [mk(5,  1.0,   0.2)],        1.004, false],
  ['低波动币 ATR0.2% 漂移0.2%', [mk(5,  1.0,   0.2)],        1.002, true ],
  ['高波动币 ATR20% 漂移2.5%',  [mk(5,  1.0,   20)],         1.025, true ],
  ['高波动币 ATR20% 漂移3.5%',  [mk(5,  1.0,   20)],         1.035, false],
  ['取最新一条(旧的会命中)',    [mk(2, 64000, 2.0), mk(40, 64000, 2.0)], 64000, true],
  ['取最新一条(新的超时)',      [mk(40, 64000, 2.0), mk(2, 50000, 2.0)], 64000, false],
  ['ATR为NaN 退回下限0.3%',    [mk(5,  64000, NaN)],        64100, true ],
  ['ATR为NaN 漂移0.5%超下限',  [mk(5,  64000, NaN)],        64320, false],
];

let pass = 0, fail = 0;
for (const [name, records, price, expect] of cases) {
  const d = decideCache(records, price, DEFAULT_POLICY);
  const ok = d.reuse === expect;
  if (ok) pass++;
  else fail++;
  const th = d.thresholdPercent != null ? `阈值${d.thresholdPercent.toFixed(2)}%` : '';
  const dr = d.driftPercent != null ? `漂移${d.driftPercent.toFixed(2)}%` : '';
  console.log(`${ok ? '  ✓' : '  ✗'} ${name.padEnd(26)} 复用=${String(d.reuse).padEnd(5)} ${dr} ${th}`);
  if (!ok) console.log(`      期望 ${expect}，理由: ${d.reason}`);
}
console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
