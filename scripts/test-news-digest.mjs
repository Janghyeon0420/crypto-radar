/**
 * 资讯汇总的编号映射。
 *
 * 模型给的是「第几条」，界面要的是「哪个链接」，中间这一步是整个功能里
 * 唯一会安静出错的地方：ref 是 1 起算的，稍不留神就整体错位一条，
 * 而错位后的界面看上去完全正常——每条资讯都挂着一个理由，只是理由是隔壁那条的。
 * 这种 bug 不会报错，只会让人信一份错的东西，所以在这里钉死。
 *
 * 一并钉住模型的两种常见越界：编了不存在的编号、同一条标两次。
 * 这两种都不该让面板变空白。
 */
import { resolveMarks } from '../src/lib/analysis/news-digest.ts';

let pass = 0;
const failures = [];
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else failures.push(name);
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  if (!ok) console.log(`      实际 ${JSON.stringify(actual)}  期望 ${JSON.stringify(expected)}`);
};

const news = [
  { title: '一', url: 'https://x/1', source: 'S', publishedAt: 1, category: 'crypto' },
  { title: '二', url: 'https://x/2', source: 'S', publishedAt: 2, category: 'crypto' },
  { title: '三', url: 'https://x/3', source: 'S', publishedAt: 3, category: 'crypto' },
];

const base = {
  summary: '汇总',
  stance: 'hawkish',
  score: 30,
  hawkishSummary: '鹰',
  dovishSummary: '鸽',
  watch: [],
  items: [],
};

const mark = (ref, stance = 'hawkish') => ({ ref, stance, impact: 'low', note: `n${ref}` });

console.log('\n=== ref 是 1 起算：第 1 条对应数组第 0 个 ===');
{
  const d = resolveMarks({ ...base, items: [mark(1), mark(3)] }, news);
  check(
    '编号未错位',
    d.marks.map((m) => m.url),
    ['https://x/1', 'https://x/3'],
  );
  check('标注内容跟着编号走', d.marks[1].note, 'n3');
}

console.log('\n=== 越界编号丢弃，不连累其余标注 ===');
{
  const d = resolveMarks({ ...base, items: [mark(0), mark(2), mark(9), mark(-1)] }, news);
  check(
    '只留下有效的那一条',
    d.marks.map((m) => m.url),
    ['https://x/2'],
  );
}

console.log('\n=== 同一条被标两次时以第一次为准 ===');
{
  const d = resolveMarks({ ...base, items: [mark(2, 'hawkish'), mark(2, 'dovish')] }, news);
  check('不重复出现', d.marks.length, 1);
  check('取第一次的判断', d.marks[0].stance, 'hawkish');
}

console.log('\n=== score 夹到 -100..100 ===');
{
  check('上溢', resolveMarks({ ...base, score: 480 }, news).score, 100);
  check('下溢', resolveMarks({ ...base, score: -999 }, news).score, -100);
  check('小数取整', resolveMarks({ ...base, score: 12.6 }, news).score, 13);
}

console.log('\n=== coveredUrls 反映的是输入的全部资讯，而非被标注的那些 ===');
{
  const d = resolveMarks({ ...base, items: [mark(1)] }, news);
  check('三条都算覆盖', d.coveredUrls.length, 3);
}

console.log(`\n通过 ${pass} / 失败 ${failures.length}`);
if (failures.length) {
  console.error('失败项：' + failures.join('、'));
  process.exit(1);
}
