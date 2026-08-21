/**
 * 鹰鸽判断。
 *
 * 输入美联储官方原文，输出 -100（极鸽）到 +100（极鹰）的分数，
 * 以及**每一分是怎么来的**——命中了哪句话、加减多少。
 * 不透明的情绪分在这里没有价值：用户需要能自己判断这个分数讲不讲理。
 *
 * 为什么用词典而不是让 LLM 打分：
 *   - 央行措辞高度程式化、逐词斟酌，正是词典方法最有效的场景
 *   - 确定性、免费、即时；同一份文本永远得到同一个分数，因而可回测
 *   - LLM 的解读留在研判环节，那里它能结合行情一起看
 *
 * ⚠️ 这个分数**尚未经过回测验证**。`npm run backtest:hawkdove` 会用历史声明
 * 与 FRED 的实际利率路径检验它。在跑过之前，请把它当作
 * 「对官方措辞的结构化摘要」，而不是「对下次议息的预测」。
 */

export type Stance = 'hawkish' | 'dovish' | 'neutral';

export interface HawkDoveEvidence {
  phrase: string;
  weight: number;
  kind: 'lexicon' | 'dissent' | 'action';
  note?: string;
}

export interface HawkDoveResult {
  /** -100 极鸽 ~ +100 极鹰 */
  score: number;
  stance: Stance;
  /** 逐条证据，按绝对权重排序 */
  evidence: HawkDoveEvidence[];
  /** 本次利率动作（从原文识别），识别不出为 null */
  action: 'raise' | 'lower' | 'maintain' | null;
  dissent: { against: number; total: number; direction: Stance } | null;
  cryptoImpact: { direction: 'risk-on' | 'risk-off' | 'neutral'; note: string };
}

/**
 * 鹰派短语。权重反映措辞强度而非出现频率——
 * 「decided to raise the target range」是决议本身，比一句「remains elevated」重得多。
 */
const HAWKISH: [RegExp, number, string?][] = [
  [/\badditional (?:policy )?firming\b/i, 18, '预告继续收紧'],
  [/\bfurther tightening\b/i, 18],
  [/\bsufficiently restrictive\b/i, 12],
  [/\brestrictive\b/i, 8],
  [/\binflation (?:remains|is) elevated\b/i, 10],
  [/\binflation has (?:increased|risen|picked up)\b/i, 12],
  [/\bupside risks to inflation\b/i, 12],
  [/\bstrongly committed to returning inflation\b/i, 10],
  [/\btight labor market\b/i, 8],
  [/\b(?:reduce|reducing) its (?:securities )?holdings\b/i, 8, '缩表'],
  [/\bremains? vigilant\b/i, 6],
  [/\bexpanding at a solid pace\b/i, 5, '经济偏强，降息必要性下降'],
  [/\bresilient\b/i, 4],
];

const DOVISH: [RegExp, number, string?][] = [
  [/\baccommodat(?:ive|ion)\b/i, 15],
  [/\binflation has (?:eased|moderated|declined)\b/i, 12],
  [/\bprogress toward\b/i, 8],
  [/\bdownside risks to (?:employment|the labor market)\b/i, 14],
  [/\blabor market has (?:softened|cooled|weakened)\b/i, 12],
  [/\bjob gains have slowed\b/i, 10],
  [/\bunemployment rate has (?:risen|increased|moved up)\b/i, 10],
  [/\beconomic activity has slowed\b/i, 10],
  [/\bpatient\b/i, 6],
  [/\bample reserves\b/i, 3, '维持充裕准备金，倾向不收紧'],
];

/** 明确的中性表述，用于削弱倾向——「风险大致均衡」是典型的不表态 */
const BALANCING: [RegExp, number][] = [
  [/\brisks?\s.{0,30}roughly (?:in )?balance/i, 8],
  [/\bwell positioned\b/i, 4],
];

/**
 * 识别本次决议动作。
 * 识别不出时返回 null——猜一个会让整个分数建立在错误前提上。
 */
export function detectAction(text: string): HawkDoveResult['action'] {
  if (/decided to (?:raise|increase) the target range/i.test(text)) return 'raise';
  if (/decided to (?:lower|reduce) the target range/i.test(text)) return 'lower';
  if (/decided to maintain the target range/i.test(text)) return 'maintain';
  return null;
}

/**
 * 解析投票分歧。
 *
 * 这是整套判断里信息量最高的一项，也是纯词频统计必然漏掉的：
 * 一份措辞温和的声明，若有三位委员投票主张加息，
 * 其实际鹰派程度远高于字面。
 */
export function detectDissent(text: string): HawkDoveResult['dissent'] {
  let against = 0;
  let total = 0;

  // 写法一（近年）：「by a 9 – 3 vote」直接给出票数
  const vote = /by an? (\d+)\s*[–—-]\s*(\d+) vote/i.exec(text);
  if (vote) {
    against = Number(vote[2]);
    total = Number(vote[1]) + against;
  } else {
    // 写法二（更常见）：不给票数，只列名字——
    // 「Voting against this action was Michelle W. Bowman, who preferred…」
    // 实测中这种写法占多数，只认写法一会把绝大部分异议漏掉
    // 不能用 [^.]* 去圈定名单：中间名缩写本身带句点（「Michelle W. Bowman」），
    // 那样会在名字中间截断，于是每次都解析成「无异议」而毫无报错。
    // 以「who preferred」作为终止符，它是这句话的固定结构。
    const seg =
      /Voting against[\s\S]{0,200}?\b(?:was|were)\b([\s\S]{0,300}?),?\s*who\s+preferred/i.exec(
        text,
      );
    if (seg) {
      const names = seg[1].match(/[A-Z][a-zA-Z'’-]+(?:\s+[A-Z]\.)?\s+[A-Z][a-zA-Z'’-]+/g) ?? [];
      against = names.length;
      // 委员会通常 12 人，没有票数时按此估算，仅用于展示
      total = against ? 12 : 0;
    }
  }

  if (against === 0) return null;

  // 异议者想要什么，比有几个人异议更重要
  const wantsHigher = /preferred to (?:raise|increase)/i.test(text);
  const wantsLower = /preferred to (?:lower|reduce)/i.test(text);
  const wantsHold = /preferred to maintain/i.test(text);

  let direction: Stance = 'neutral';
  if (wantsHigher) direction = 'hawkish';
  else if (wantsLower) direction = 'dovish';
  else if (wantsHold) {
    // 「主张维持」的方向取决于委员会实际做了什么：
    // 委员会降息而有人主张维持 → 那是鹰派异议
    const action = detectAction(text);
    direction = action === 'lower' ? 'hawkish' : action === 'raise' ? 'dovish' : 'neutral';
  }

  return { against, total, direction };
}

/**
 * 切出「决议正文」，剔除异议段落。
 *
 * 必须切，而且这是实测中真的踩到的坑：异议句里写着
 * 「who preferred to raise the target range」，词典会把它当成委员会加息，
 * 于是一份「维持利率」的声明被记上加息的分，还与异议票重复计分。
 * 异议的方向由 detectDissent 单独处理，正文扫描不该再看到它。
 */
export function decisionBody(text: string): string {
  const cut = text.search(/Voting (?:against|for) the monetary policy action/i);
  return cut > 0 ? text.slice(0, cut) : text;
}

export function analyzeHawkDove(fullText: string): HawkDoveResult {
  const evidence: HawkDoveEvidence[] = [];
  let raw = 0;
  const text = decisionBody(fullText);

  for (const [re, weight, note] of HAWKISH) {
    if (re.test(text)) {
      raw += weight;
      evidence.push({ phrase: describe(re), weight, kind: 'lexicon', note });
    }
  }
  for (const [re, weight, note] of DOVISH) {
    if (re.test(text)) {
      raw -= weight;
      evidence.push({ phrase: describe(re), weight: -weight, kind: 'lexicon', note });
    }
  }
  for (const [re, weight] of BALANCING) {
    if (re.test(text)) {
      // 向 0 靠拢而不是简单加减：中性表述削弱的是倾向的强度
      const damp = raw > 0 ? -Math.min(weight, raw) : Math.min(weight, -raw);
      raw += damp;
      if (damp !== 0) {
        evidence.push({
          phrase: describe(re),
          weight: damp,
          kind: 'lexicon',
          note: '风险均衡表述，削弱倾向',
        });
      }
    }
  }

  const action = detectAction(fullText);
  if (action === 'raise') {
    raw += 20;
    evidence.push({ phrase: '本次决议：加息', weight: 20, kind: 'action' });
  } else if (action === 'lower') {
    raw -= 20;
    evidence.push({ phrase: '本次决议：降息', weight: -20, kind: 'action' });
  } else if (action === 'maintain') {
    // 维持不加减分，但要出现在证据里——否则用户看不出「动作」这一项被考虑过
    evidence.push({ phrase: '本次决议：维持利率不变', weight: 0, kind: 'action' });
  }

  const dissent = detectDissent(fullText);
  if (dissent && dissent.direction !== 'neutral') {
    // 每票 6 分、封顶 24：历史上超过 4 票异议极为罕见，
    // 不封顶会让个别极端情形主导整个分数
    const magnitude = Math.min(dissent.against * 6, 24);
    const signed = dissent.direction === 'hawkish' ? magnitude : -magnitude;
    raw += signed;
    evidence.push({
      phrase: `${dissent.against} 票反对，主张${dissent.direction === 'hawkish' ? '更紧' : '更松'}`,
      weight: signed,
      kind: 'dissent',
      note: `${dissent.total - dissent.against}–${dissent.against} 通过`,
    });
  }

  // 用 tanh 压缩而不是硬截断：硬截断会把「很鹰」和「极鹰」显示成同一个 100
  const score = Math.round(Math.tanh(raw / 45) * 100);
  const stance: Stance = score >= 15 ? 'hawkish' : score <= -15 ? 'dovish' : 'neutral';

  return {
    score,
    stance,
    evidence: evidence.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)),
    action,
    dissent,
    cryptoImpact: mapToCrypto(stance, score),
  };
}

/**
 * 鹰鸽 → 加密的传导。
 *
 * 路径清楚：收紧 → 无风险收益率上升、流动性减少 → 风险资产估值承压，
 * 而加密处在风险资产里久期最长、波动最大的一端，通常放大这个方向。
 *
 * 但**方向清楚不等于可预测**：传导有时滞、幅度不定，市场还常常提前定价。
 * 所以这里只给方向与理由，不给概率——给概率就是在假装知道自己不知道的事。
 */
function mapToCrypto(stance: Stance, score: number): HawkDoveResult['cryptoImpact'] {
  if (stance === 'hawkish') {
    return {
      direction: 'risk-off',
      note:
        `措辞偏鹰（${score}）意味着流动性倾向收紧，对加密这类长久期风险资产通常构成压力。` +
        '但市场可能已提前定价：若价格未跌反涨，说明原有预期比这份措辞更鹰。',
    };
  }
  if (stance === 'dovish') {
    return {
      direction: 'risk-on',
      note:
        `措辞偏鸽（${score}）意味着流动性倾向宽松，历来对加密有利。` +
        '但要区分是"预防式降息"还是"衰退式降息"——后者往往先跌后涨。',
    };
  }
  return {
    direction: 'neutral',
    note: '措辞未显示明确倾向，方向性含义有限，接下来更多取决于市场原有预期与后续数据。',
  };
}

/**
 * 把正则还原成人能读的短语。
 * 证据要能被用户对着原文核对，露出 `(remains|is)` 这种正则痕迹会妨碍这件事，
 * 所以多分支一律取第一个写法。
 */
function describe(re: RegExp): string {
  return re.source
    .replace(/\\b/g, '')
    .replace(/\(\?:([^)]*)\)/g, (_, alt) => String(alt).split('|')[0])
    .replace(/\(([^)]*)\)/g, (_, alt) => String(alt).split('|')[0])
    .replace(/\.\{0,\d+\}/g, ' … ')
    .replace(/\\s/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
