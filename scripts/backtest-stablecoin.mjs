#!/usr/bin/env node
/**
 * 稳定币供应变化的回测。
 *
 * 「稳定币增发 = 买盘燃料」这个说法在加密圈流传很广，听起来也合理。
 * 但这个项目已经三次证明：听起来合理的指标，实测常常毫无信息量。
 * 所以接进界面之前先量。
 *
 * 跑法：npm run backtest:stablecoin
 *
 * 方法：DefiLlama 的日度稳定币总量（2017 至今）对齐 BTC 日线，
 * 看「过去 N 天供应变化」与「未来 M 天 BTC 涨跌」的关系。
 * 与其它回测一样，命中率要减去基线才叫信息量。
 */
import { fetchCandles } from '../src/lib/datasources/binance-vision.ts';

const pad = (s, n) => String(s).padEnd(n);
const pct = (v) => `${v.toFixed(1)}%`;

console.log('拉取稳定币历史与 BTC 日线…\n');

const raw = await fetch('https://stablecoins.llama.fi/stablecoincharts/all').then((r) => r.json());
const supply = new Map();
for (const p of raw) {
  const v = p.totalCirculatingUSD?.peggedUSD;
  if (v > 0) supply.set(new Date(Number(p.date) * 1000).toISOString().slice(0, 10), v / 1e9);
}

const candles = await fetchCandles('BTCUSDT', '1d', 1000);
console.log(`  稳定币 ${supply.size} 天 · BTC 日线 ${candles.length} 根\n`);

/** 供应量按日期回看 N 天的变化率 % */
const supplyChange = (dateStr, days) => {
  const before = new Date(Date.parse(dateStr) - days * 86400_000).toISOString().slice(0, 10);
  const a = supply.get(dateStr);
  // 上游偶有缺日，往前找最近的一天
  let b = supply.get(before);
  for (let i = 1; i <= 5 && b == null; i++) {
    b = supply.get(new Date(Date.parse(before) - i * 86400_000).toISOString().slice(0, 10));
  }
  return a != null && b != null && b > 0 ? ((a - b) / b) * 100 : null;
};

const LOOKBACKS = [7, 30];
const HORIZONS = [7, 14, 30];

console.log('═'.repeat(74));
console.log('供应变化 → 未来 BTC 涨跌');
console.log('═'.repeat(74));
console.log(`  ${pad('回看', 8)}${pad('前瞻', 8)}${pad('样本', 8)}${pad('分组', 14)}${pad('平均涨跌', 12)}${pad('上涨占比', 10)}`);

let anyEdge = false;

for (const back of LOOKBACKS) {
  for (const fwd of HORIZONS) {
    const rows = [];
    for (let i = 0; i < candles.length - fwd; i++) {
      const d = new Date(candles[i].time).toISOString().slice(0, 10);
      const chg = supplyChange(d, back);
      if (chg == null) continue;
      const ret = ((candles[i + fwd].close - candles[i].close) / candles[i].close) * 100;
      rows.push({ chg, ret });
    }
    if (rows.length < 100) continue;

    // 按供应变化分三档：明显增发 / 中间 / 明显收缩
    const sorted = [...rows].sort((a, b) => a.chg - b.chg);
    const third = Math.floor(sorted.length / 3);
    const groups = [
      ['供应收缩(低1/3)', sorted.slice(0, third)],
      ['中间1/3', sorted.slice(third, third * 2)],
      ['供应扩张(高1/3)', sorted.slice(third * 2)],
    ];

    const stats = groups.map(([name, g]) => ({
      name,
      n: g.length,
      avg: g.reduce((a, r) => a + r.ret, 0) / g.length,
      up: (g.filter((r) => r.ret > 0).length / g.length) * 100,
    }));

    const spread = stats[2].avg - stats[0].avg;
    if (Math.abs(spread) > 3) anyEdge = true;

    for (const [i, st] of stats.entries()) {
      console.log(
        `  ${pad(i === 0 ? back + '天' : '', 8)}${pad(i === 0 ? fwd + '天' : '', 8)}` +
          `${pad(i === 0 ? rows.length : '', 8)}${pad(st.name, 14)}` +
          `${pad((st.avg >= 0 ? '+' : '') + st.avg.toFixed(2) + '%', 12)}${pad(pct(st.up), 10)}`,
      );
    }
    console.log(
      `  ${pad('', 30)}扩张组减收缩组：${spread >= 0 ? '+' : ''}${spread.toFixed(2)}pt` +
        (Math.abs(spread) > 3 ? '  ← 差异明显' : ''),
    );
    console.log('  ' + '─'.repeat(70));
  }
}

console.log('\n' + '═'.repeat(74));
const btcUp = (candles.filter((c, i) => i > 0 && c.close > candles[i - 1].close).length / candles.length) * 100;
console.log(`样本期内 BTC 日线上涨天数占比 ${pct(btcUp)}——这是所有「上涨占比」的基线。`);
console.log(
  `样本仅 ${candles.length} 天（约 2.7 年）且高度重叠：相邻观测共享绝大部分区间，\n` +
    `有效独立样本约 ${Math.round(candles.length / 30)} 个。几个百分点的差异说明不了什么。`,
);
console.log(
  anyEdge
    ? '\n有分组差异超过 3pt——但请先读上面那两条再决定要不要相信。'
    : '\n所有组合的分组差异都不超过 3pt：供应变化与后续涨跌没有可用的关系。',
);
console.log('═'.repeat(74));
