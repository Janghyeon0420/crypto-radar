/**
 * 链上数据的日期回看。
 *
 * 这是一个典型的「错了不会报错」的地方：按数组下标往回数 N 个点，
 * 在上游缺日时会把「7 天变化」算成 9 天或 5 天的变化，
 * 显示出来的百分比悄悄失真，而没有任何异常可查。
 */
import { changeOverDays } from '../src/lib/datasources/onchain.ts';

let pass = 0;
const failures = [];
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else failures.push(name);
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  if (!ok) console.log(`      实际 ${JSON.stringify(actual)}  期望 ${JSON.stringify(expected)}`);
};

/** 从 base 日期起连续 n 天，值等于 start + i */
const series = (start, n, from = '2026-08-01') =>
  Array.from({ length: n }, (_, i) => ({
    date: new Date(Date.parse(from) + i * 86400_000).toISOString().slice(0, 10),
    billions: start + i,
  }));

console.log('=== 连续数据 ===');
{
  const pts = series(100, 31); // 100 → 130，共 31 天
  // 最后一天 130，7 天前是 123
  check('7 天变化', changeOverDays(pts, 7)?.toFixed(4), (((130 - 123) / 123) * 100).toFixed(4));
  check('30 天变化', changeOverDays(pts, 30)?.toFixed(4), (((130 - 100) / 100) * 100).toFixed(4));
}

console.log('\n=== 缺日：必须按天数回看，不能数下标 ===');
{
  // 造一段中间缺 3 天的序列
  const pts = [
    { date: '2026-08-01', billions: 100 },
    { date: '2026-08-02', billions: 101 },
    // 03/04/05 缺失
    { date: '2026-08-06', billions: 106 },
    { date: '2026-08-07', billions: 107 },
    { date: '2026-08-08', billions: 108 },
  ];
  // 最后一天 08-08，往回 7 天是 08-01（值 100）
  // 若错误地往回数 7 个下标，只有 5 个点，会取到最早的 100 —— 这次碰巧一样，
  // 所以再用一个能区分的例子
  check('缺日时按日期取到 08-01', changeOverDays(pts, 7)?.toFixed(4), (((108 - 100) / 100) * 100).toFixed(4));

  const pts2 = [
    { date: '2026-08-01', billions: 100 },
    { date: '2026-08-06', billions: 106 },
    { date: '2026-08-07', billions: 107 },
    { date: '2026-08-08', billions: 108 },
  ];
  // 往回 2 天 = 08-06（值 106）。若数下标往回 2 个会取到 08-01（值 100），差异明显
  check('往回 2 天取 08-06 而不是往回 2 个点', changeOverDays(pts2, 2)?.toFixed(2), (((108 - 106) / 106) * 100).toFixed(2));
}

console.log('\n=== 目标日无数据时取不晚于它的最近一天 ===');
{
  const pts = [
    { date: '2026-08-01', billions: 100 },
    { date: '2026-08-05', billions: 105 },
    { date: '2026-08-10', billions: 110 },
  ];
  // 往回 7 天 = 08-03，无数据 → 取 08-01
  check('回落到更早的一天', changeOverDays(pts, 7)?.toFixed(2), (((110 - 100) / 100) * 100).toFixed(2));
}

console.log('\n=== 历史不够长时不硬算 ===');
{
  const pts = series(100, 3);
  // 只有 3 天数据却要 30 天变化——拿最早那天硬算会得出一个
  // 看着像 30 天其实是 2 天的数字
  check('历史不足 → null', changeOverDays(pts, 30), null);
  check('单点序列 → null', changeOverDays([{ date: '2026-08-01', billions: 100 }], 7), null);
  check('空序列 → null', changeOverDays([], 7), null);
}

console.log('\n=== 异常值 ===');
{
  const pts = [
    { date: '2026-08-01', billions: 0 },
    { date: '2026-08-08', billions: 100 },
  ];
  check('基准为 0 时不产生 Infinity', changeOverDays(pts, 7), null);

  const down = [
    { date: '2026-08-01', billions: 200 },
    { date: '2026-08-08', billions: 150 },
  ];
  check('下降为负值', changeOverDays(down, 7)?.toFixed(2), '-25.00');
}

console.log(`\n通过 ${pass} / 失败 ${failures.length}`);
process.exit(failures.length ? 1 : 0);
