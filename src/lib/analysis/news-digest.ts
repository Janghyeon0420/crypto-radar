/**
 * 资讯 AI 汇总。
 *
 * 解决的问题：原来的资讯面板是一列标题，十几条读完也说不出"现在市场在担心什么"。
 * 标题本身信息密度极低，而人不会真的一条条点开。
 *
 * 这里让模型做三件事，而且只做这三件：
 *   1. 把这批资讯压成一段话——整体在讲什么；
 *   2. 分出鹰派 / 鸽派两侧并对比——哪边的份量更重；
 *   3. **逐条标注每条资讯属于哪一侧**，这样每个结论都能回溯到具体来源。
 *
 * 第 3 点是这个功能能不能用的关键。一段无法核对的 AI 总结没有价值：
 * 用户必须能顺着标签点回原文，自己判断这个归类讲不讲理。
 *
 * 鹰鸽的口径沿用 macro/hawkdove.ts：
 *   鹰 = 流动性收紧 / 风险偏好受压（监管收紧、执法、清算、资金流出、加息预期升温）
 *   鸽 = 流动性宽松 / 风险偏好改善（ETF 流入、监管放宽、机构增持、降息预期升温）
 * 与那边不同的是：那边是词典打分（央行措辞程式化，适合词典），
 * 这边是语义判断（行业资讯措辞千变万化，词典无从下手），所以才动用模型。
 */

import { z } from 'zod';
import { getProvider } from './providers';
import type { NewsItem } from '../datasources/types';

/** 模型直接输出的结构。ref 是输入资讯的编号，落地时再映射回具体链接。 */
const RawDigestSchema = z.object({
  summary: z
    .string()
    .describe('整体汇总：这批资讯合起来在讲什么，100-180 字，写成连贯的一段话而非罗列标题'),

  stance: z
    .enum(['hawkish', 'dovish', 'neutral'])
    .describe('这批资讯整体偏鹰（利空风险资产）/ 偏鸽（利多）/ 中性'),

  score: z
    .number()
    .describe('鹰鸽分，-100 极鸽到 +100 极鹰的整数。两侧势均力敌或都很弱时应接近 0'),

  hawkishSummary: z
    .string()
    .describe('鹰派一侧在说什么，一到两句。没有鹰派信号时写明「本批资讯无明显鹰派信号」'),

  dovishSummary: z
    .string()
    .describe('鸽派一侧在说什么，一到两句。没有鸽派信号时写明「本批资讯无明显鸽派信号」'),

  items: z
    .array(
      z.object({
        ref: z.number().describe('资讯编号，必须是输入列表中出现过的编号'),
        stance: z
          .enum(['hawkish', 'dovish', 'neutral'])
          .describe('该条资讯的倾向。与价格方向无关的纯技术/产品新闻应标 neutral'),
        impact: z
          .enum(['high', 'medium', 'low'])
          .describe('该条资讯对行情的影响量级。high 要克制，一批资讯里通常至多两三条'),
        note: z.string().describe('为什么这么归类，一句话，不超过 30 字，不要复述标题'),
      }),
    )
    .describe('逐条标注。输入的每一条资讯都必须出现且只出现一次'),

  watch: z
    .array(z.string())
    .describe('由这批资讯引出的、接下来值得盯的事，0-3 条。没有则返回空数组'),
});

export type Stance = z.infer<typeof RawDigestSchema>['stance'];
export type Impact = 'high' | 'medium' | 'low';

/** 一条资讯的鹰鸽标注，url 已由服务端从 ref 映射好，前端不需要再对编号 */
export interface DigestMark {
  url: string;
  stance: Stance;
  impact: Impact;
  note: string;
}

export interface NewsDigest {
  summary: string;
  stance: Stance;
  score: number;
  hawkishSummary: string;
  dovishSummary: string;
  watch: string[];
  marks: DigestMark[];
  /** 汇总覆盖了哪些资讯（按输入顺序的 url），用于判断新资讯是否已纳入 */
  coveredUrls: string[];
}

const SYSTEM_PROMPT = `你是一位加密货币市场的资讯编辑，服务于一个个人使用的行情看板。

你的任务是把一批刚抓取到的资讯标题，整理成「一眼能读懂市场在发生什么」的简报，
并按**鹰派 / 鸽派**给每条资讯定性。

鹰鸽的口径（这是本项目统一的定义，不要自行发挥）：
- 鹰派 = 指向流动性收紧或风险偏好受压。典型：监管收紧与执法、诉讼与处罚、
  交易所或项目暴雷、黑客与盗币、大额抛售与资金流出、通胀走高或加息预期升温、
  杠杆爆仓、机构减持。
- 鸽派 = 指向流动性宽松或风险偏好改善。典型：ETF 获批与净流入、监管态度放宽、
  合规牌照落地、机构与企业增持、降息预期升温、重要升级顺利上线、资金净流入。
- 中性 = 与价格方向没有明确关系的技术进展、产品发布、行业科普、人事变动。

必须遵守：
1. 只依据给出的标题与摘要判断。不要引入你记忆中的其它事件，不要编造数字。
2. 标题信息不足以判断倾向时，就标 neutral 并在 note 里说明"标题信息不足"，
   不要为了让结论好看而硬凑一个方向。
3. summary 是**给人读的一段话**，不是标题的罗列。要说清楚这批资讯的主线是什么、
   两侧的力量对比如何。若资讯之间互相矛盾，直接说矛盾在哪。
4. score 要诚实。多数时候一批日常资讯是 -30 到 +30 之间的弱倾向；
   只有出现监管重大变化、ETF 大额流入流出、暴雷这类事件时才给到 60 以上的绝对值。
5. impact 标 high 的必须是真的会让市场重新定价的事。日常项目动态一律 low。
6. note 是给用户核对用的理由，要具体（"SEC 起诉，属执法收紧"），
   不要写"该消息偏空"这种等于没说的话。
7. 输入的每一条资讯都要在 items 里出现一次，不要漏、不要重复、不要发明新编号。

你输出的是资讯梳理，不是投资建议。不要写"建议买入/卖出"。`;

const CONSTRAINTS = [
  'score 是 -100 到 100 的整数，负数偏鸽、正数偏鹰',
  'items 必须覆盖输入中的每一条资讯，ref 只能取输入里出现过的编号',
  'items 的 note 不超过 30 字，且不要复述标题',
  'watch 无内容时返回空数组 []，不要省略该字段',
  'stance 与 score 的符号要一致：score ≥ 15 为 hawkish，≤ -15 为 dovish，之间为 neutral',
];

export interface NewsDigestInput {
  /** 当前看板选中的币种，用于让模型知道读者关心什么。全市场视角时传 null */
  baseAsset: string | null;
  news: NewsItem[];
}

function buildUserPrompt({ baseAsset, news }: NewsDigestInput): string {
  const scope = baseAsset ? `与 ${baseAsset} 相关的资讯` : '全市场加密资讯';
  const lines = news.map((n, i) => {
    const age = Math.round((Date.now() - n.publishedAt) / 60_000);
    const when = age < 60 ? `${age} 分钟前` : `${Math.round(age / 60)} 小时前`;
    const summary = n.summary?.trim().replace(/\s+/g, ' ').slice(0, 200);
    return [
      `[${i + 1}] ${n.title}`,
      `    来源：${n.source} · ${when}${n.tags?.length ? ` · 标签：${n.tags.slice(0, 4).join('/')}` : ''}`,
      summary ? `    摘要：${summary}` : null,
    ]
      .filter(Boolean)
      .join('\n');
  });

  return `# 待汇总的资讯（${scope}，共 ${news.length} 条）

当前时间：${new Date().toISOString()}
${baseAsset ? `读者当前正在看 ${baseAsset} 的行情，汇总时以「这对 ${baseAsset} 意味着什么」为主线。\n` : ''}
${lines.join('\n')}

请按上面的鹰鸽口径整理这批资讯。`;
}

/**
 * 生成资讯汇总。
 *
 * 单次调用而非逐条打标：逐条调用会把成本乘以条数，而且模型看不到全局，
 * 也就给不出"两侧力量对比"这个真正有用的东西。
 */
export async function runNewsDigest(input: NewsDigestInput): Promise<NewsDigest> {
  const provider = getProvider();
  const started = Date.now();

  const raw = await provider.generate({
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(input),
    schema: RawDigestSchema,
    constraints: CONSTRAINTS,
    // 归类 + 概括不需要深度推理，开了只是更慢更贵
    thinking: false,
    maxTokens: 4000,
  });

  console.log(
    `[news-digest] ${input.baseAsset ?? '全市场'} ${input.news.length} 条 · ` +
      `${provider.label} · ${Date.now() - started}ms`,
  );

  return resolveMarks(raw, input.news);
}

/**
 * 把模型给的编号映射回真实链接。
 *
 * 越界编号直接丢弃而不是报错：模型偶尔多编一个 ref 是小事，
 * 为此让整个面板变空白才是大事。同一条被标两次时以第一次为准。
 */
export function resolveMarks(
  raw: z.infer<typeof RawDigestSchema>,
  news: NewsItem[],
): NewsDigest {
  const seen = new Set<string>();
  const marks: DigestMark[] = [];

  for (const item of raw.items) {
    const target = news[Math.round(item.ref) - 1];
    if (!target || seen.has(target.url)) continue;
    seen.add(target.url);
    marks.push({
      url: target.url,
      stance: item.stance,
      impact: item.impact,
      note: item.note,
    });
  }

  const dropped = raw.items.length - marks.length;
  if (dropped > 0) {
    console.warn(`[news-digest] ${dropped} 条标注的编号无效或重复，已丢弃`);
  }

  return {
    summary: raw.summary,
    // score 的可信区间不比它的符号更宽，先夹到合法范围再给 UI 画条
    score: Math.max(-100, Math.min(100, Math.round(raw.score))),
    stance: raw.stance,
    hawkishSummary: raw.hawkishSummary,
    dovishSummary: raw.dovishSummary,
    watch: raw.watch,
    marks,
    coveredUrls: news.map((n) => n.url),
  };
}
