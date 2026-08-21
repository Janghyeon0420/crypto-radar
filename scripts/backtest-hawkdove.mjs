#!/usr/bin/env node
/**
 * 鹰鸽词典的回测。
 *
 * 规则引擎那次的教训是：一个看着很合理的评分，实测可能毫无信息量。
 * 鹰鸽分同样要先量再信——而它恰好可以量：
 * 历史 FOMC 声明是公开的，之后的实际利率路径 FRED 上也有。
 *
 * 跑法：npm run backtest:hawkdove
 *
 * 检验的问题：**这次声明的鹰鸽分，能不能预示下次会议的动作？**
 * 这是这个分数唯一有意义的用法——如果只能事后描述已发生的决议，
 * 那它就只是把声明换了种说法，没有增加任何信息。
 */
import { fetchFedDocument, statementUrlFor } from '../src/lib/datasources/fed-text.ts';
import { parseFomcCalendar } from '../src/lib/datasources/macro.ts';
import { analyzeHawkDove } from '../src/lib/macro/hawkdove.ts';
import { fetchObservations } from '../src/lib/datasources/fred.ts';

const pad = (s, n) => String(s).padEnd(n);
const pct = (v) => `${v.toFixed(1)}%`;

console.log('取历史会期 → 抓声明原文 → 打分 → 对照 FRED 实际利率\n');

const calHtml = await fetch('https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', {
  headers: { 'user-agent': 'crypto-radar/0.1' },
}).then((r) => r.text());

const now = Date.now();
// 日历只回溯一年，这里放宽到尽可能久：parseFomcCalendar 自带一年过滤，
// 所以直接传一个很早的 now 让它把历史会议都留下来
const meetings = parseFomcCalendar(calHtml, 0)
  .filter((m) => m.decisionAt < now)
  .sort((a, b) => a.decisionAt - b.decisionAt);

console.log(`日历上共 ${meetings.length} 场已开完的会议\n`);

const dff = await fetchObservations('DFF', 4000);
const rateAt = (ts) => {
  const day = new Date(ts).toISOString().slice(0, 10);
  // DFF 倒序，取「不晚于该日」的第一个值
  return dff.find((p) => p.date <= day)?.value ?? null;
};

const rows = [];
for (const m of meetings) {
  const url = statementUrlFor(new Date(m.decisionAt));
  let text;
  try {
    text = await fetchFedDocument(url);
  } catch {
    continue;
  }
  // 抓到的若不是声明（404 页/改版），正文里不会有决议句式，跳过而不是硬打分
  if (!/target range for the federal funds rate/i.test(text)) continue;

  const r = analyzeHawkDove(text);
  rows.push({ date: new Date(m.decisionAt).toISOString().slice(0, 10), ts: m.decisionAt, ...r });
}

console.log(`成功解析 ${rows.length} 份声明\n`);
if (rows.length < 8) {
  console.error('样本太少，无法判断。可能是页面结构变了，先检查 fed-text.ts 的提取逻辑。');
  process.exit(1);
}

// 每份声明配上「到下次会议为止的实际利率变化」
for (let i = 0; i < rows.length - 1; i++) {
  const a = rateAt(rows[i].ts);
  const b = rateAt(rows[i + 1].ts);
  rows[i].nextChange = a !== null && b !== null ? Number((b - a).toFixed(4)) : null;
}
// 最后一场会议没有「下一场」，nextChange 是 undefined；
// 只用 !== null 过滤会把它漏进来，在 toFixed 时炸掉
const usable = rows.filter((r) => typeof r.nextChange === 'number');

console.log('═'.repeat(78));
console.log('逐次声明');
console.log('═'.repeat(78));
console.log(`  ${pad('会议日期', 12)}${pad('分数', 8)}${pad('倾向', 10)}${pad('异议', 8)}下次会议前的实际利率变化`);
for (const r of usable) {
  const arrow = r.nextChange > 0.05 ? '↑ 加息' : r.nextChange < -0.05 ? '↓ 降息' : '— 未动';
  console.log(
    `  ${pad(r.date, 12)}${pad((r.score > 0 ? '+' : '') + r.score, 8)}${pad(r.stance, 10)}` +
      `${pad(r.dissent ? `${r.dissent.against}票` : '-', 8)}${arrow}  (${r.nextChange > 0 ? '+' : ''}${r.nextChange.toFixed(2)}pt)`,
  );
}

// ── 按倾向分组，看鹰鸽分是否与后续动作相关 ──
console.log('\n' + '═'.repeat(78));
console.log('鹰鸽分能否预示下次动作');
console.log('═'.repeat(78));

const groups = ['hawkish', 'neutral', 'dovish'];
console.log(`  ${pad('本次倾向', 12)}${pad('次数', 8)}${pad('后续加息', 10)}${pad('后续未动', 10)}${pad('后续降息', 10)}平均变化`);
for (const g of groups) {
  const sub = usable.filter((r) => r.stance === g);
  if (sub.length === 0) continue;
  const up = sub.filter((r) => r.nextChange > 0.05).length;
  const flat = sub.filter((r) => Math.abs(r.nextChange) <= 0.05).length;
  const down = sub.filter((r) => r.nextChange < -0.05).length;
  const avg = sub.reduce((a, r) => a + r.nextChange, 0) / sub.length;
  console.log(
    `  ${pad(g, 12)}${pad(sub.length, 8)}${pad(pct((up / sub.length) * 100), 10)}` +
      `${pad(pct((flat / sub.length) * 100), 10)}${pad(pct((down / sub.length) * 100), 10)}` +
      `${avg > 0 ? '+' : ''}${avg.toFixed(3)}pt`,
  );
}

const hawk = usable.filter((r) => r.stance === 'hawkish');
const dove = usable.filter((r) => r.stance === 'dovish');
const avgOf = (a) => (a.length ? a.reduce((s, r) => s + r.nextChange, 0) / a.length : null);

console.log('\n' + '─'.repeat(78));
if (hawk.length >= 3 && dove.length >= 3) {
  const gap = avgOf(hawk) - avgOf(dove);
  console.log(
    `鹰派声明之后平均 ${avgOf(hawk).toFixed(3)}pt，鸽派之后平均 ${avgOf(dove).toFixed(3)}pt，` +
      `相差 ${gap.toFixed(3)}pt。`,
  );
  console.log(
    gap > 0.05
      ? '方向符合预期：鹰派措辞之后确实更倾向收紧。'
      : '方向不成立或差异极小——这个分数目前只能描述措辞，不能预示动作。',
  );
} else {
  console.log(
    `样本不足以判断：鹰派 ${hawk.length} 次、鸽派 ${dove.length} 次，各需至少 3 次。\n` +
      '在跑出有效结论之前，界面上应把鹰鸽分标注为「措辞摘要」而非「政策预测」。',
  );
}
console.log(
  `\n注意：FOMC 一年只开 8 次，样本天生稀少（当前 ${usable.length} 次），\n` +
    '且政策周期本身有很强的自相关——加息周期里连续多次加息，\n' +
    '这会让任何"鹰派→加息"的关联都显得比实际更强。',
);
console.log('─'.repeat(78));
