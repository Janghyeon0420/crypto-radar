/**
 * 稳健驾驶舱的核心逻辑。
 *
 * 这套逻辑的特点是「错了不会报错，只会让人信一个错的数字」：
 *   - 回撤算反了方向，风险体检看起来照样一切正常；
 *   - 由底线反推出的配置若悄悄超预算，用户会以为自己在底线之内；
 *   - 定投日差一天，提醒就变成了「昨天该投了」。
 * 所以每个公式都用能手算验证的小例子钉死，反推配置则用属性测试扫过全部底线取值。
 */
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BEAR_SHOCK,
  BUDGET_FRACTION,
  annualizedVolatility,
  assetShockReturn,
  beta,
  currentDrawdown,
  dailySigma,
  deriveTargets,
  describeEnvironment,
  maxCryptoShare,
  maxDrawdown,
  percentRank,
  percentile,
  replayPortfolio,
  simpleReturns,
  sleeveLoss,
  stressLoss,
  worstWindowReturn,
} from '../src/lib/steady/risk.ts';
import {
  allocationOf,
  describeDca,
  driftTable,
  isDcaDay,
  nextDcaDate,
  splitContribution,
  valueHoldings,
} from '../src/lib/steady/plan.ts';
import { buildActions } from '../src/lib/steady/actions.ts';
import { PlanSchema, SteadyStateSchema, SteadyUpdateSchema, HoldingSchema } from '../src/lib/steady/schema.ts';
import { checkLocalRequest, hostnameOf } from '../src/lib/steady/guard.ts';

let pass = 0;
const failures = [];
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else failures.push(name);
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  if (!ok) console.log(`      实际 ${JSON.stringify(actual)}  期望 ${JSON.stringify(expected)}`);
};
const near = (name, actual, expected, eps = 1e-9) => {
  const ok = actual != null && Math.abs(actual - expected) <= eps;
  if (ok) pass++;
  else failures.push(name);
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  if (!ok) console.log(`      实际 ${actual}  期望 ${expected}`);
};

console.log('\n=== 回撤：方向与基准都不能错 ===');
{
  const dd = maxDrawdown([100, 120, 60, 90, 30]);
  near('最大回撤是从最高点 120 跌到 30 = -75%', dd.depth, -0.75);
  check('峰值与谷底的下标', [dd.peakIndex, dd.troughIndex], [1, 4]);
  near('一路上涨则回撤为 0', maxDrawdown([1, 2, 3]).depth, 0);
  near('当前回撤：从 200 跌到 150 = -25%', currentDrawdown([100, 200, 150]), -0.25);
  near('lookback 只看最近几个点：[200,150] 的高点仍是 200', currentDrawdown([100, 200, 150], 2), -0.25);
  near('lookback=1 时没有更高的点，回撤为 0', currentDrawdown([100, 200, 150], 1), 0);
  near('最差 2 期窗口：100→80 = -20%', worstWindowReturn([100, 90, 80, 100, 120], 2), -0.2);
  check('样本不够窗口长度时不给数', worstWindowReturn([1, 2], 5), null);
}

console.log('\n=== 收益、波动、beta ===');
{
  const r = simpleReturns([100, 110, 99]);
  near('逐日收益 +10%', r[0], 0.1);
  near('逐日收益 -10%', r[1], -0.1);
  near('常数收益的波动为 0', annualizedVolatility([0.01, 0.01, 0.01, 0.01]), 0);
  // 交替 +1% / -1%：样本标准差 = 0.01*sqrt(n/(n-1))，n=100 时约 0.010050
  const alt = Array.from({ length: 100 }, (_, i) => (i % 2 ? -0.01 : 0.01));
  near('日 σ 约 1%', dailySigma(alt), 0.01 * Math.sqrt(100 / 99), 1e-9);
  near('年化按 365 个周期折算', annualizedVolatility(alt), 0.01 * Math.sqrt(100 / 99) * Math.sqrt(365), 1e-9);

  const mkt = Array.from({ length: 60 }, (_, i) => Math.sin(i) * 0.03);
  near('资产涨跌恰为市场 2 倍 → beta = 2', beta(mkt.map((x) => 2 * x), mkt), 2);
  near('资产恰为市场反向 → beta = -1', beta(mkt.map((x) => -x), mkt), -1);
  check('样本不足 30 个点不给 beta', beta([0.1, 0.2], [0.1, 0.2]), null);
  near('分位数线性插值：[1,2,3,4] 的 50% = 2.5', percentile([4, 1, 3, 2], 0.5), 2.5);
  near('百分位排名：5 个值里不高于 3 的占 60%', percentRank([1, 2, 3, 4, 5], 3), 60);
}

console.log('\n=== 组合回放：每日再平衡到固定权重 ===');
{
  const s = replayPortfolio([0.5, 0.5], [[0.1, -0.1], [0, 0]]);
  near('第 1 天 +5%', s[1], 1.05);
  near('第 2 天再 -5%：1.05 × 0.95', s[2], 0.9975);
  check('起点为 1', s[0], 1);
  const stable = replayPortfolio([1], [[0, 0, 0]]);
  check('全稳定币净值不动', stable, [1, 1, 1, 1]);
}

console.log('\n=== 情景压力：假设，不是预测 ===');
{
  near('BTC 100% 在 -75% 情景下亏 75%', -stressLoss([{ asset: 'BTC', weight: 1, beta: 1 }], BEAR_SHOCK), 0.75);
  near('ETH beta 1.2 → -90%', assetShockReturn(1.2, BEAR_SHOCK), -0.9);
  near('beta 1.5 的币会超过 100%，封底在 -95%', assetShockReturn(1.5, BEAR_SHOCK), -0.95);
  near(
    '25% BTC + 75% 稳定币 → 亏 18.75%',
    -stressLoss([{ asset: 'BTC', weight: 0.25, beta: 1 }, { asset: 'USDT', weight: 0.75, beta: 0 }], BEAR_SHOCK),
    0.1875,
  );
  near(
    '加密部分单独看：稳定币被剔掉后重新归一（80/20 的 BTC/ETH → -78%）',
    sleeveLoss(
      [
        { asset: 'BTC', weight: 0.4, beta: 1 },
        { asset: 'ETH', weight: 0.1, beta: 1.2 },
        { asset: 'USDT', weight: 0.5, beta: 0 },
      ],
      BEAR_SHOCK,
    ),
    -0.78,
  );
  check('全是稳定币时没有加密部分可看', sleeveLoss([{ asset: 'USDT', weight: 1, beta: 0 }], BEAR_SHOCK), null);
  near('底线 20%、加密部分亏 78% → 最多占 25.64%', maxCryptoShare(0.2, -0.78), 0.2 / 0.78);
  near('加密部分亏得比底线还少时，上限封在 100%', maxCryptoShare(0.9, -0.5), 1);
}

console.log('\n=== 由底线反推配置：绝不能悄悄超预算（属性测试，扫过 5%~80%）===');
{
  const sleeve = [
    { asset: 'BTC', weight: 0.8, beta: 1 },
    { asset: 'ETH', weight: 0.2, beta: 1.2 },
  ];
  check('底线 15% → BTC 12 / ETH 3 / USDT 85', deriveTargets(15), [
    { asset: 'BTC', weightPct: 12 },
    { asset: 'ETH', weightPct: 3 },
    { asset: 'USDT', weightPct: 85 },
  ]);
  check('底线 25%（留 20% 安全垫）→ BTC 20 / ETH 5 / USDT 75', deriveTargets(25), [
    { asset: 'BTC', weightPct: 20 },
    { asset: 'ETH', weightPct: 5 },
    { asset: 'USDT', weightPct: 75 },
  ]);
  check('安全垫是底线的 80%', BUDGET_FRACTION, 0.8);

  let sumBad = 0;
  let overBudget = 0;
  let nonMonotonic = 0;
  let prevCrypto = -1;
  for (let m = 5; m <= 80; m++) {
    const t = deriveTargets(m);
    const total = t.reduce((s, x) => s + x.weightPct, 0);
    if (total !== 100) sumBad++;
    const items = t.map((x) => ({
      asset: x.asset,
      weight: x.weightPct / 100,
      beta: x.asset === 'BTC' ? 1 : x.asset === 'ETH' ? 1.2 : 0,
    }));
    // 熊市基准下的亏损必须落在「底线 × 安全垫」之内（取整后 BTC/ETH 比例略有偏差，容忍 0.5 个百分点）
    if (-stressLoss(items, BEAR_SHOCK) * 100 > m * BUDGET_FRACTION + 0.5) overBudget++;
    const crypto = 100 - (t.find((x) => x.asset === 'USDT')?.weightPct ?? 0);
    if (crypto < prevCrypto) nonMonotonic++;
    prevCrypto = crypto;
  }
  check('76 个底线取值下，权重之和都是 100', sumBad, 0);
  check('76 个底线取值下，熊市基准亏损都在「底线 × 80%」之内（+0.5pp 取整容忍）', overBudget, 0);
  check('底线放宽时，加密占比单调不减', nonMonotonic, 0);
  void sleeve;
}

console.log('\n=== 估值与配置偏离 ===');
{
  const priced = valueHoldings(
    [
      { asset: 'BTC', quantity: 0.01, avgCost: 50000 },
      { asset: 'USDT', quantity: 500 },
      { asset: 'XYZ', quantity: 10 },
    ],
    { BTC: 80000 },
  );
  check('稳定币按 1 计', priced[1].value, 500);
  check('没有行情的币：价格与市值都是 null', [priced[2].price, priced[2].value], [null, null]);
  near('BTC 相对成本盈亏 +60%', priced[0].pnlPct, 60);
  check('稳定币没有盈亏概念', priced[1].pnlPct, null);

  const a = allocationOf(priced);
  near('总值 = 800 + 500', a.total, 1300);
  check('查不到行情的币要列出来', a.unpriced, ['XYZ']);
  near('稳定币占比', a.stablePct, (500 / 1300) * 100);
  near('加密占比 = 100 - 稳定币', a.cryptoPct, 100 - (500 / 1300) * 100);

  const rows = [
    { asset: 'BTC', value: 620, weightPct: 62 },
    { asset: 'USDT', value: 300, weightPct: 30 },
    { asset: 'DOGE', value: 80, weightPct: 8 },
  ];
  const d = driftTable(rows, [{ asset: 'BTC', weightPct: 50 }, { asset: 'USDT', weightPct: 50 }], 5);
  check('BTC 高 12pp → over', d.find((x) => x.asset === 'BTC').status, 'over');
  check('USDT 低 20pp → under', d.find((x) => x.asset === 'USDT').status, 'under');
  check('不在目标里却占了 8% 的币 → untargeted', d.find((x) => x.asset === 'DOGE').status, 'untargeted');
  const small = driftTable([{ asset: 'BTC', value: 52, weightPct: 52 }, { asset: 'USDT', value: 48, weightPct: 48 }], [{ asset: 'BTC', weightPct: 50 }, { asset: 'USDT', weightPct: 50 }], 5);
  check('在容忍带内（±2pp < 5pp）一律 ok，不为小偏离折腾', small.map((x) => x.status), ['ok', 'ok']);
}

console.log('\n=== 用新资金补低配（不卖出）===');
{
  const t = [{ asset: 'BTC', weightPct: 50 }, { asset: 'USDT', weightPct: 50 }];
  check(
    'BTC 已超配时，新钱全部给 USDT',
    splitContribution(500, [{ asset: 'BTC', value: 800, weightPct: 80 }, { asset: 'USDT', value: 200, weightPct: 20 }], t),
    [{ asset: 'USDT', amount: 500 }],
  );
  const even = splitContribution(100, [{ asset: 'BTC', value: 500, weightPct: 50 }, { asset: 'USDT', value: 500, weightPct: 50 }], t);
  check('已在目标上时按目标比例分', even.map((x) => Math.round(x.amount)), [50, 50]);
  const three = splitContribution(
    100,
    [{ asset: 'BTC', value: 500, weightPct: 50 }, { asset: 'USDT', value: 500, weightPct: 50 }],
    [{ asset: 'BTC', weightPct: 50 }, { asset: 'ETH', weightPct: 25 }, { asset: 'USDT', weightPct: 25 }],
  );
  near('分配总额恰为投入额', three.reduce((s, x) => s + x.amount, 0), 100, 1e-9);
  check('USDT 已超配，不分钱', three.some((x) => x.asset === 'USDT'), false);
  check('金额为 0 时不分配', splitContribution(0, [], t), []);
}

console.log('\n=== 定投日程：差一天就是「昨天该投了」===');
{
  const wed = new Date(2026, 9, 14, 10, 0); // 2026-10-14 周三（本机时区）
  check('前置：这一天确实是周三', wed.getDay(), 3);
  const ymd = (d) => d && [d.getFullYear(), d.getMonth() + 1, d.getDate()];
  check('每周三（day=3）：今天就是', ymd(nextDcaDate(wed, { amount: 100, frequency: 'weekly', day: 3 })), [2026, 10, 14]);
  check('每周一（day=1）：下周一 10/19', ymd(nextDcaDate(wed, { amount: 100, frequency: 'weekly', day: 1 })), [2026, 10, 19]);
  check('每周日（day=7）：10/18，JS 的周日是 0，这里 7 要换算', ymd(nextDcaDate(wed, { amount: 100, frequency: 'weekly', day: 7 })), [2026, 10, 18]);
  check('每月 20 日：本月 10/20', ymd(nextDcaDate(wed, { amount: 100, frequency: 'monthly', day: 20 })), [2026, 10, 20]);
  check('每月 10 日：本月已过，下月 11/10', ymd(nextDcaDate(wed, { amount: 100, frequency: 'monthly', day: 10 })), [2026, 11, 10]);
  check('每月 14 日：今天就是', ymd(nextDcaDate(wed, { amount: 100, frequency: 'monthly', day: 14 })), [2026, 10, 14]);
  check('跨年：12 月 20 日之后的「每月 10 日」落在明年 1 月', ymd(nextDcaDate(new Date(2026, 11, 20), { amount: 1, frequency: 'monthly', day: 10 })), [2027, 1, 10]);
  check('金额 0 视为未启用', nextDcaDate(wed, { amount: 0, frequency: 'weekly', day: 3 }), null);
  check('isDcaDay：每周三 → 是', isDcaDay(wed, { amount: 100, frequency: 'weekly', day: 3 }), true);
  check('isDcaDay：每周四 → 否', isDcaDay(wed, { amount: 100, frequency: 'weekly', day: 4 }), false);
  check('描述文案', describeDca({ amount: 1500, frequency: 'weekly', day: 1 }), '每周一投入 1,500 USDT');
}

console.log('\n=== 今日行动：默认什么都不做，且每条都有理由 ===');
{
  const plan = {
    profile: 'balanced',
    maxLossPct: 25,
    targets: [{ asset: 'BTC', weightPct: 50 }, { asset: 'USDT', weightPct: 50 }],
    rebalanceBandPct: 5,
    dca: { amount: 200, frequency: 'weekly', day: 3 },
    ifLimitHit: '暂停加仓，但继续定投',
  };
  const wed = new Date(2026, 9, 14, 10, 0);
  const quiet = {
    now: new Date(2026, 9, 15, 10, 0), // 周四，非定投日
    plan,
    hasHoldings: true,
    total: 1000,
    alloc: [{ asset: 'BTC', value: 500, weightPct: 50 }, { asset: 'USDT', value: 500, weightPct: 50 }],
    drift: [],
    tail: { lossPct: 20, lossValue: 200, shockPct: -75 },
    budget: { maxCryptoSharePct: 60, currentCryptoSharePct: 50 },
    currentDrawdownPct: -5,
    btc24hChangePct: 0.8,
    btcDailySigmaPct: 2,
  };
  const calm = buildActions(quiet);
  check('一切正常 → 只有一条「今天没有需要做的事」', [calm.length, calm[0].id, calm[0].level], [1, 'all-clear', 'ok']);
  check('每条行动都带 why', calm.every((a) => a.why.length > 10), true);

  check('没有计划 → 引导写计划', buildActions({ ...quiet, plan: null })[0].id, 'no-plan');
  check('有计划没持仓 → 引导录入', buildActions({ ...quiet, hasHoldings: false })[0].id, 'no-holdings');

  const over = buildActions({ ...quiet, tail: { lossPct: 31.5, lossValue: 315, shockPct: -75 } });
  check('熊市亏损超底线 → alert，且排在最前', [over[0].id, over[0].level], ['tail-over', 'alert']);
  const near80 = buildActions({ ...quiet, tail: { lossPct: 21, lossValue: 210, shockPct: -75 } });
  check('超过底线的 80%（20%）→ warn', near80[0].id, 'tail-near');

  const lim = buildActions({ ...quiet, currentDrawdownPct: -26 });
  check('回撤触及底线 → alert，并引出用户事先写好的预案', [lim[0].id, lim[0].detail.includes('暂停加仓，但继续定投')], ['drawdown-limit', true]);
  const limNoPlan = buildActions({ ...quiet, plan: { ...plan, ifLimitHit: '' }, currentDrawdownPct: -26 });
  check('没写预案时提醒现在去写', limNoPlan[0].detail.includes('还没有写下'), true);

  const drift = buildActions({
    ...quiet,
    drift: [{ asset: 'BTC', actualPct: 62, targetPct: 50, driftPp: 12, status: 'over' }],
  });
  check('配置偏离 → warn，提示先用新钱补低配', [drift[0].id, drift[0].detail.includes('不用卖出')], ['rebalance', true]);

  const due = buildActions({ ...quiet, now: wed });
  check('定投日出现提醒', due.some((a) => a.id === 'dca-due'), true);
  check('定投日有事可做 → 不再说「今天没事」', due.some((a) => a.id === 'all-clear'), false);

  const wild = buildActions({ ...quiet, btc24hChangePct: -9, btcDailySigmaPct: 2 });
  check('波动超过 3σ → 冷静提醒', wild.some((a) => a.id === 'wild-day'), true);
  const mild = buildActions({ ...quiet, btc24hChangePct: 5, btcDailySigmaPct: 2 });
  check('2.5σ 不算异常，不打扰', mild.some((a) => a.id === 'wild-day'), false);

  const sorted = buildActions({
    ...quiet,
    now: wed,
    tail: { lossPct: 31.5, lossValue: 315, shockPct: -75 },
    drift: [{ asset: 'BTC', actualPct: 62, targetPct: 50, driftPp: 12, status: 'over' }],
  }).map((a) => a.level);
  check('严重程度排序：alert → warn → info', sorted, ['alert', 'warn', 'info']);
}

console.log('\n=== 市场环境描述 ===');
{
  const flat = Array.from({ length: 300 }, () => 100);
  const env = describeEnvironment(flat);
  near('价格不动时距高点回撤 0', env.drawdownFromHighPct, 0);
  near('价格不动时距 200 日均线 0', env.distFromSma200Pct, 0);
  check('样本太少时不描述', describeEnvironment([1, 2, 3]), null);
  const down = Array.from({ length: 300 }, (_, i) => 200 - i * 0.2); // 200 → 140.2
  const e2 = describeEnvironment(down);
  check('下跌序列：距高点回撤为负', e2.drawdownFromHighPct < 0, true);
  check('下跌序列：在 200 日均线下方', e2.distFromSma200Pct < 0, true);
}

console.log('\n=== 数据契约 ===');
{
  const base = {
    profile: 'balanced',
    maxLossPct: 25,
    targets: [{ asset: 'btc', weightPct: 60 }, { asset: 'USDT', weightPct: 40 }],
    rebalanceBandPct: 5,
    dca: { amount: 100, frequency: 'weekly', day: 3 },
    ifLimitHit: '',
  };
  const ok = PlanSchema.safeParse(base);
  check('合法计划通过', ok.success, true);
  check('币种代码自动规整为大写', ok.data.targets[0].asset, 'BTC');
  check('权重之和不是 100 → 拒绝', PlanSchema.safeParse({ ...base, targets: [{ asset: 'BTC', weightPct: 60 }, { asset: 'USDT', weightPct: 39 }] }).success, false);
  check('权重之和 99.8（滑块取整）→ 容忍', PlanSchema.safeParse({ ...base, targets: [{ asset: 'BTC', weightPct: 59.9 }, { asset: 'USDT', weightPct: 39.9 }] }).success, true);
  check('重复币种 → 拒绝', PlanSchema.safeParse({ ...base, targets: [{ asset: 'BTC', weightPct: 50 }, { asset: 'BTC', weightPct: 50 }] }).success, false);
  check('底线 4% 过低 → 拒绝', PlanSchema.safeParse({ ...base, maxLossPct: 4 }).success, false);
  check('底线 81% 与稳健矛盾 → 拒绝', PlanSchema.safeParse({ ...base, maxLossPct: 81 }).success, false);
  check('每周定投 day=8 非法 → 拒绝', PlanSchema.safeParse({ ...base, dca: { amount: 1, frequency: 'weekly', day: 8 } }).success, false);
  check('每月定投 day=29 非法 → 拒绝（并非每个月都有）', PlanSchema.safeParse({ ...base, dca: { amount: 1, frequency: 'monthly', day: 29 } }).success, false);
  check('持仓数量为负 → 拒绝', HoldingSchema.safeParse({ asset: 'BTC', quantity: -1 }).success, false);
  check('持仓币种带非法字符 → 拒绝', HoldingSchema.safeParse({ asset: 'BTC/USDT', quantity: 1 }).success, false);
  check('更新请求不能是空的', SteadyUpdateSchema.safeParse({}).success, false);
  check('只更新持仓是允许的', SteadyUpdateSchema.safeParse({ holdings: [] }).success, true);
  check('持仓里重复的币种 → 拒绝', SteadyUpdateSchema.safeParse({ holdings: [{ asset: 'BTC', quantity: 1 }, { asset: 'BTC', quantity: 2 }] }).success, false);
  check('完整状态可解析', SteadyStateSchema.safeParse({ version: 1, plan: null, holdings: [], updatedAt: 0 }).success, true);
}

console.log('\n=== 本机访问保护：持仓是第一份财务数据 ===');
{
  const h = (o) => new Headers(o);
  check('localhost:3000 通过', checkLocalRequest(h({ host: 'localhost:3000' })).ok, true);
  check('127.0.0.1 通过', checkLocalRequest(h({ host: '127.0.0.1:3000' })).ok, true);
  check('IPv6 回环 [::1]:3000 通过', checkLocalRequest(h({ host: '[::1]:3000' })).ok, true);
  check('局域网 IP 被拒（同 Wi-Fi 的人读不到持仓）', checkLocalRequest(h({ host: '192.168.1.8:3000' })).ok, false);
  check('域名被拒（挡 DNS 重绑定）', checkLocalRequest(h({ host: 'evil.example.com' })).ok, false);
  check('显式 STEADY_ALLOW_LAN 放开 Host 检查', checkLocalRequest(h({ host: '192.168.1.8:3000' }), { allowLan: true }).ok, true);
  check('*.localhost 视为本机', checkLocalRequest(h({ host: 'radar.localhost:3000' })).ok, true);
  check('同源 Origin 通过', checkLocalRequest(h({ host: 'localhost:3000', origin: 'http://localhost:3000' })).ok, true);
  check('跨站 Origin 被拒（挡恶意网页往 localhost 发请求）', checkLocalRequest(h({ host: 'localhost:3000', origin: 'https://evil.example.com' })).ok, false);
  check('Sec-Fetch-Site: cross-site 被拒', checkLocalRequest(h({ host: 'localhost:3000', 'sec-fetch-site': 'cross-site' })).ok, false);
  check('Sec-Fetch-Site: same-origin 通过', checkLocalRequest(h({ host: 'localhost:3000', 'sec-fetch-site': 'same-origin' })).ok, true);
  check('allowLan 也不放过跨站请求', checkLocalRequest(h({ host: '192.168.1.8:3000', origin: 'https://evil.example.com' }), { allowLan: true }).ok, false);
  check('主机名解析：带端口', hostnameOf('Localhost:3000'), 'localhost');
  check('主机名解析：IPv6', hostnameOf('[::1]:3000'), '[::1]');
}

console.log('\n=== 存储：原子写、损坏不覆盖、并发不丢 ===');
{
  const dir = await mkdtemp(path.join(tmpdir(), 'steady-test-'));
  process.chdir(dir);
  const store = await import('../src/lib/steady/store.ts');
  const dataDir = path.join(dir, 'data');

  check('文件不存在 → 空状态', (await store.readState()).plan, null);

  const plan = {
    profile: 'balanced', maxLossPct: 25,
    targets: [{ asset: 'BTC', weightPct: 30 }, { asset: 'USDT', weightPct: 70 }],
    rebalanceBandPct: 5, dca: { amount: 100, frequency: 'monthly', day: 1 }, ifLimitHit: '先别动',
  };
  await store.updateState({ plan });
  check('保存后读回一致', (await store.readState()).plan.ifLimitHit, '先别动');
  await store.updateState({ holdings: [{ asset: 'BTC', quantity: 0.5 }] });
  const s2 = await store.readState();
  check('只更新持仓时，计划不被覆盖', [s2.plan.maxLossPct, s2.holdings.length], [25, 1]);
  check('没有遗留的 .tmp 文件（rename 是原子的）', (await readdir(dataDir)).filter((f) => f.endsWith('.tmp')), []);

  await Promise.all(
    Array.from({ length: 20 }, (_, i) => store.updateState({ holdings: [{ asset: 'BTC', quantity: i + 1 }] })),
  );
  const s3 = await store.readState();
  check('20 个并发写之后文件仍然合法', s3.holdings.length, 1);

  await writeFile(path.join(dataDir, 'steady.json'), '{ 这不是 JSON', 'utf8');
  const s4 = await store.readState();
  check('损坏的文件 → 当空状态处理', s4.plan, null);
  const names = await readdir(dataDir);
  check('损坏文件被改名留档，而不是被覆盖', names.some((f) => f.startsWith('steady.corrupt-')), true);
  const keep = names.find((f) => f.startsWith('steady.corrupt-'));
  check('留档的内容原样保留', (await readFile(path.join(dataDir, keep), 'utf8')).includes('这不是 JSON'), true);

  await writeFile(path.join(dataDir, 'steady.json'), JSON.stringify({ version: 1, plan: { maxLossPct: 3 }, holdings: [], updatedAt: 1 }), 'utf8');
  check('格式合法但内容不符 Zod 也算损坏，同样留档', (await store.readState()).plan, null);
}

console.log(`\n通过 ${pass} / 失败 ${failures.length}`);
if (failures.length) {
  console.error('失败项：' + failures.join('、'));
  process.exit(1);
}
