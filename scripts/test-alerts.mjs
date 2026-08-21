/**
 * 告警求值语义。
 *
 * 这些分支的共同点是：**错了不会有任何报错**。
 * 规则该触发而没触发，界面上只是安静地什么都不显示；
 * 不该触发而触发了，也只是多一条通知。两种情况都要靠人回头核对才发现，
 * 而人不会回头核对——所以只能靠测试钉住。
 *
 * engine.ts 全是纯函数，喂快照即可，无需网络也无需起服务。
 */
import { evaluateRules } from '../src/lib/alerts/engine.ts';

let pass = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else failures.push(name);
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  if (!ok) console.log(`      实际 ${JSON.stringify(actual)}  期望 ${JSON.stringify(expected)}`);
}

/** 一份字段齐全的技术面快照，各用例只覆盖自己关心的那几个字段 */
const snapshot = (over = {}) => ({
  interval: '1h',
  price: 100,
  changePercent: 0,
  ma: { ma20: 100, ma50: 100, ma200: 100, ema12: 100, ema26: 100, alignment: 'neutral', aboveMa200: true },
  rsi14: 50,
  rsiState: 'normal',
  macd: { macd: 0, signal: 0, histogram: 0, cross: 'none' },
  bollinger: { upper: 110, middle: 100, lower: 90, bandwidth: 20, percentB: 0.5, squeeze: false },
  kdj: { k: 50, d: 50, j: 50 },
  volatility: { atr14: 1, atrPercent: 1 },
  volume: { current: 100, ratio20: 1, vwap: 100 },
  levels: { supports: [], resistances: [] },
  bias: 'neutral',
  reasons: [],
  ...over,
});

const rule = (over = {}) => ({
  id: 'r1',
  symbol: 'BTCUSDT',
  kind: 'price_above',
  interval: '1h',
  enabled: true,
  once: false,
  createdAt: 0,
  ...over,
});

/** 求值一条规则，返回触发条数 */
const fire = (r, ctx) =>
  evaluateRules([r], {
    symbol: 'BTCUSDT',
    price: 100,
    technical: snapshot(),
    previousTechnical: null,
    ...ctx,
  }).length;

console.log('=== 布林带挤压结束：关心的是「状态转变」，不是「当前状态」===');
// worker 把上一轮快照放在内存里，重启即丢失。这组用例同时钉住
// 「无上一轮快照时保持静默」——否则重启后会把所有未挤压的币全报一遍
{
  const r = rule({ kind: 'bb_squeeze_release' });
  const squeezed = snapshot({ bollinger: { ...snapshot().bollinger, squeeze: true } });
  const released = snapshot();
  check('挤压 → 解除，触发', fire(r, { previousTechnical: squeezed, technical: released }), 1);
  check('挤压 → 仍挤压，不触发', fire(r, { previousTechnical: squeezed, technical: squeezed }), 0);
  check('未挤压 → 未挤压，不触发', fire(r, { previousTechnical: released, technical: released }), 0);
  check('未挤压 → 进入挤压，不触发', fire(r, { previousTechnical: released, technical: squeezed }), 0);
  check('无上一轮快照（worker 刚重启），不触发', fire(r, { previousTechnical: null, technical: released }), 0);
}

console.log('\n=== 冷却期：价格在阈值附近抖动不应刷屏 ===');
{
  const kind = { kind: 'price_above', threshold: 90 }; // 现价 100，本身满足
  check('从未触发过，触发', fire(rule(kind), {}), 1);
  check('1 分钟前刚触发，静默', fire(rule({ ...kind, lastTriggeredAt: Date.now() - 60_000 }), {}), 0);
  check('14 分钟前触发，仍在冷却内', fire(rule({ ...kind, lastTriggeredAt: Date.now() - 14 * 60_000 }), {}), 0);
  check('16 分钟前触发，冷却已过', fire(rule({ ...kind, lastTriggeredAt: Date.now() - 16 * 60_000 }), {}), 1);
}

console.log('\n=== K 线拉取失败时的降级：价格类规则不该被一并拖垮 ===');
// worker 在取不到 K 线时仍会带着 technical=null 求值，这条路径是刻意设计的
{
  check('无技术面，价格规则照常触发',
    fire(rule({ kind: 'price_above', threshold: 90 }), { technical: null }), 1);
  check('无技术面，RSI 规则静默而非误报',
    fire(rule({ kind: 'rsi_above', threshold: 10 }), { technical: null }), 0);
  check('无技术面，放量规则静默',
    fire(rule({ kind: 'volume_spike', threshold: 0.1 }), { technical: null }), 0);
}

console.log('\n=== 边界与过滤 ===');
{
  check('已停用的规则不求值',
    fire(rule({ kind: 'price_above', threshold: 90, enabled: false }), {}), 0);
  check('币种不匹配的规则不求值',
    fire(rule({ symbol: 'ETHUSDT', kind: 'price_above', threshold: 90 }), {}), 0);
  // 阈值用 >= 而非 >：正好等于阈值属于「已经到了」，这是用户的预期
  check('价格正好等于阈值，触发', fire(rule({ kind: 'price_above', threshold: 100 }), {}), 1);
  check('价格差 0.01 未达阈值，不触发', fire(rule({ kind: 'price_above', threshold: 100.01 }), {}), 0);
  check('缺阈值的价格规则不触发（脏数据防线）', fire(rule({ kind: 'price_above' }), {}), 0);
  check('MACD 无交叉，不触发', fire(rule({ kind: 'macd_cross' }), {}), 0);
  check('MACD 金叉，触发',
    fire(rule({ kind: 'macd_cross' }), { technical: snapshot({ macd: { macd: 0, signal: 0, histogram: 1, cross: 'golden' } }) }), 1);
}

console.log('\n=== 多条规则同轮求值 ===');
{
  const events = evaluateRules(
    [
      rule({ id: 'a', kind: 'price_above', threshold: 90 }),
      rule({ id: 'b', kind: 'rsi_above', threshold: 40 }),
      rule({ id: 'c', kind: 'price_below', threshold: 90 }), // 不满足
    ],
    { symbol: 'BTCUSDT', price: 100, technical: snapshot(), previousTechnical: null },
  );
  check('只有满足条件的两条产生事件', events.map((e) => e.ruleId), ['a', 'b']);
  check('事件带上求值时的价格', events[0]?.price, 100);
  check('消息含实际数值而非模板占位', events[0]?.message.includes('100'), true);
}

console.log(`\n通过 ${pass} / 失败 ${failures.length}`);
process.exit(failures.length ? 1 : 0);
