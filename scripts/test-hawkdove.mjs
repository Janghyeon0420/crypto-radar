/**
 * 鹰鸽判断。
 *
 * 开发中在真实声明上踩到两个 bug，都不会报错、只会安静给出错误倾向：
 *
 *   1. 词典把异议句里的「who preferred to raise the target range」
 *      当成了委员会加息——一份「维持利率」的声明被记上 +25 加息分，
 *      还与异议票重复计分，直接把 2026-01-28 判成了鸽派。
 *   2. 解析异议名单时用 [^.]* 圈定范围，而中间名缩写本身带句点
 *      （「Michelle W. Bowman」），于是每份声明都解析成「无异议」。
 *
 * 两个 case 都在下面钉死了。
 */
import {
  analyzeHawkDove,
  detectAction,
  detectDissent,
  decisionBody,
} from '../src/lib/macro/hawkdove.ts';

let pass = 0;
const failures = [];
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else failures.push(name);
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  if (!ok) console.log(`      实际 ${JSON.stringify(actual)}  期望 ${JSON.stringify(expected)}`);
};

/** 取自 2026-07-29 真实声明的结构 */
const HOLD_WITH_HAWKISH_DISSENT = `
The Federal Open Market Committee approved the following statement for release by a 9 – 3 vote:
The Committee decided to maintain the target range for the federal funds rate at 3-1/2 to 3-3/4 percent.
The Committee is continuing its policy of maintaining ample reserves in the banking system.
Economic activity is expanding at a solid pace. Inflation remains elevated relative to the Committee's 2 percent goal.
Voting against the monetary policy action were Beth M. Hammack, Neel Kashkari, and Lorie K. Logan,
who preferred to raise the target range for the federal funds rate by 1/4 percentage point at this meeting.
`;

const CUT_WITH_DOVISH_DISSENT = `
The Committee decided to lower the target range for the federal funds rate by 1/4 percentage point.
Inflation has eased over the past year. The labor market has softened.
Voting against this action was Michelle W. Bowman, who preferred to lower the target range by 1/2 percentage point.
`;

const HOLD_HAWKISH_DISSENT_NAMES_ONLY = `
The Committee decided to maintain the target range for the federal funds rate.
Inflation remains elevated. The Committee will remain vigilant.
Voting against this action were Stephen I. Miran and Michelle W. Bowman, who preferred to lower the target range.
`;

console.log('=== bug 1：异议句不得污染词典打分 ===');
{
  // 委员会明明是「维持」，异议者才主张加息
  check('动作识别为维持', detectAction(HOLD_WITH_HAWKISH_DISSENT), 'maintain');
  const r = analyzeHawkDove(HOLD_WITH_HAWKISH_DISSENT);
  check(
    '证据里不出现「本次决议：加息」',
    r.evidence.some((e) => e.phrase.includes('加息')),
    false,
  );
  check(
    '异议句里的 raise the target range 不计入词典分',
    r.evidence.some((e) => e.kind === 'lexicon' && /target range/i.test(e.phrase)),
    false,
  );
  check('异议本身被单独计分一次', r.evidence.filter((e) => e.kind === 'dissent').length, 1);
  check('整体判为偏鹰（由异议驱动）', r.stance, 'hawkish');

  // decisionBody 是这道防线本身
  check(
    '决议正文切在 Voting against 之前',
    decisionBody(HOLD_WITH_HAWKISH_DISSENT).includes('Voting against'),
    false,
  );
  check(
    '正文保留了决议句',
    decisionBody(HOLD_WITH_HAWKISH_DISSENT).includes('decided to maintain'),
    true,
  );
}

console.log('\n=== bug 2：中间名缩写不得截断异议名单 ===');
{
  const d = detectDissent(HOLD_HAWKISH_DISSENT_NAMES_ONLY);
  check('无票数表述时仍能识别异议', d !== null, true);
  check('  数出两位异议者（含中间名缩写）', d.against, 2);
  check('  方向为鸽派（主张降息）', d.direction, 'dovish');

  const single = detectDissent(CUT_WITH_DOVISH_DISSENT);
  check('单个异议者用 was 而非 were', single.against, 1);
}

console.log('\n=== 票数表述 ===');
{
  const d = detectDissent(HOLD_WITH_HAWKISH_DISSENT);
  check('9 – 3 vote → 3 票反对', d.against, 3);
  check('  总票数 12', d.total, 12);
  check('  方向为鹰派', d.direction, 'hawkish');
}

console.log('\n=== 「主张维持」的方向取决于委员会做了什么 ===');
{
  // 委员会降息、有人主张维持 → 那是鹰派异议
  const hawkDissent = detectDissent(`
    The Committee decided to lower the target range for the federal funds rate.
    Voting against this action was Jane A. Doe, who preferred to maintain the target range.
  `);
  check('降息时主张维持 → 鹰派异议', hawkDissent.direction, 'hawkish');

  // 委员会加息、有人主张维持 → 鸽派异议
  const doveDissent = detectDissent(`
    The Committee decided to raise the target range for the federal funds rate.
    Voting against this action was John B. Roe, who preferred to maintain the target range.
  `);
  check('加息时主张维持 → 鸽派异议', doveDissent.direction, 'dovish');
}

console.log('\n=== 决议动作 ===');
{
  check('加息', detectAction('The Committee decided to raise the target range'), 'raise');
  check('降息', detectAction('The Committee decided to lower the target range'), 'lower');
  check('维持', detectAction('The Committee decided to maintain the target range'), 'maintain');
  // 识别不出时必须返回 null，猜一个会让整个分数建立在错误前提上
  check('无法识别时返回 null', detectAction('The Committee met and discussed the economy.'), null);
}

console.log('\n=== 分数与倾向 ===');
{
  const cut = analyzeHawkDove(CUT_WITH_DOVISH_DISSENT);
  check('降息 + 通胀缓和 + 就业走弱 → 偏鸽', cut.stance, 'dovish');
  check('  分数为负', cut.score < 0, true);
  check('  对加密判为 risk-on', cut.cryptoImpact.direction, 'risk-on');

  const hawk = analyzeHawkDove(HOLD_WITH_HAWKISH_DISSENT);
  check('偏鹰 → 对加密 risk-off', hawk.cryptoImpact.direction, 'risk-off');

  // tanh 压缩：极端输入也不该越界
  const extreme = analyzeHawkDove(
    'raise'.padEnd(10) +
      ' The Committee decided to raise the target range. Inflation has increased. ' +
      'Upside risks to inflation. Sufficiently restrictive. Additional policy firming. ' +
      'Further tightening. Tight labor market. Strongly committed to returning inflation. ' +
      'The Committee will reduce its holdings and remains vigilant. Economy is resilient.',
  );
  check('极端鹰派不越界', extreme.score <= 100 && extreme.score > 80, true);

  const empty = analyzeHawkDove('The Committee met.');
  check('无任何信号 → 中性 0 分', { s: empty.stance, n: empty.score }, { s: 'neutral', n: 0 });
  check('  对加密判为 neutral', empty.cryptoImpact.direction, 'neutral');
}

console.log('\n=== 风险均衡表述削弱倾向而非反转 ===');
{
  const strong = analyzeHawkDove('Inflation remains elevated. Upside risks to inflation.');
  const damped = analyzeHawkDove(
    'Inflation remains elevated. Upside risks to inflation. The risks to the outlook are roughly in balance.',
  );
  check('有均衡表述时分数更低', damped.score < strong.score, true);
  check('  但不会被反转成鸽派', damped.score > 0, true);
}

console.log('\n=== 证据必须可核对 ===');
{
  const r = analyzeHawkDove(HOLD_WITH_HAWKISH_DISSENT);
  check('每条证据都有非零权重或明确的动作说明',
    r.evidence.every((e) => e.weight !== 0 || e.kind === 'action'), true);
  check('证据按权重绝对值降序',
    r.evidence.every((e, i, a) => i === 0 || Math.abs(a[i - 1].weight) >= Math.abs(e.weight)), true);
}

console.log(`\n通过 ${pass} / 失败 ${failures.length}`);
process.exit(failures.length ? 1 : 0);
