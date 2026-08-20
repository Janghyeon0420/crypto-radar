/**
 * FOMC 日历解析的实测校验。
 *
 * 这是项目里唯一一处 HTML 抓取，页面结构一变解析就会静默返回空数组——
 * 而"下次议息"显示为空，用户多半只会以为最近没有会议，不会怀疑是解析坏了。
 * 所以这里直接拉真实页面跑一遍，把解析结果打出来供肉眼核对。
 *
 * 跑法：npx tsx scripts/test-fomc-parse.mjs
 */
import { parseFomcCalendar } from '../src/lib/datasources/macro.ts';

const html = await fetch('https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', {
  headers: { 'user-agent': 'crypto-radar/0.1' },
}).then((r) => r.text());

const now = Date.now();
const meetings = parseFomcCalendar(html, now);

console.log(`解析出 ${meetings.length} 场会议（已过滤掉一年前的）\n`);

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
};

check('解析到会议', meetings.length > 0, `${meetings.length} 场`);
check(
  '每场都有合法时间戳',
  meetings.every((m) => Number.isFinite(m.decisionAt)),
);
check(
  '时间戳单调递增（排序后与原顺序一致性无关，仅检查无重复）',
  new Set(meetings.map((m) => m.decisionAt)).size === meetings.length,
);
check(
  '存在带点阵图的会议（一年 4 次，日历上以 * 标注）',
  meetings.some((m) => m.hasProjections),
  `${meetings.filter((m) => m.hasProjections).length} 场`,
);

const upcoming = meetings.filter((m) => m.decisionAt > now).sort((a, b) => a.decisionAt - b.decisionAt);
check('存在未来会议', upcoming.length > 0, `${upcoming.length} 场`);

console.log('\n最近三场已开完的：');
for (const m of meetings.filter((m) => m.decisionAt <= now).slice(-3)) {
  console.log(`  ${m.label}${m.hasProjections ? ' *' : ''} → ${new Date(m.decisionAt).toISOString()}`);
}
console.log('\n接下来三场：');
for (const m of upcoming.slice(0, 3)) {
  const days = ((m.decisionAt - now) / 86400_000).toFixed(1);
  console.log(`  ${m.label}${m.hasProjections ? ' *' : ''} → ${new Date(m.decisionAt).toISOString()}（${days} 天后）`);
}

process.exit(failed === 0 ? 0 : 1);
