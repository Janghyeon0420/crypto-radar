/**
 * AI 研判的容错链路。
 *
 * 起因是线上日志：研判点完报错，原因分散在四处——
 *   1. 模型漏掉 levels.invalidation，整份 30~150 秒的付费响应被丢弃
 *   2. 输出被 max_tokens 截断或空内容，两者以前报成同一句话，重试也原样重来
 *   3. 取行情时一次网络抖动就让整次研判在第一步结束
 *   4. 错误只是 SDK 的 "Connection error."，看不出该做什么
 * 这些都不会让程序崩溃，只会让用户觉得「点了就报错」，所以在这里钉死。
 *
 * provider 的重试流程用本机起的假 /chat/completions 端点验证，不碰真实模型、不花钱。
 */
import http from 'node:http';
import { AnalysisSchema } from '../src/lib/analysis/schema.ts';
import { JsonExtractionError, parseAndValidate } from '../src/lib/analysis/providers/json-repair.ts';
import { createOpenAiCompatibleProvider } from '../src/lib/analysis/providers/openai-compatible.ts';
import { explainMarketError, explainModelError, withRetry } from '../src/lib/analysis/errors.ts';

let pass = 0;
const failures = [];
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else failures.push(name);
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  if (!ok) console.log(`      实际 ${JSON.stringify(actual)}  期望 ${JSON.stringify(expected)}`);
};

const valid = {
  headline: '震荡偏弱',
  direction: 'neutral',
  confidence: 55,
  timeframe: 'short',
  factors: [
    { dimension: 'technical', stance: 'neutral', weight: 0.4, note: 'RSI 50.1' },
    { dimension: 'momentum', stance: 'bearish', weight: 0.3, note: 'MACD 柱收缩' },
    { dimension: 'sentiment', stance: 'neutral', weight: 0.3, note: '恐惧贪婪 48' },
  ],
  levels: { supports: [2400], resistances: [2500], invalidation: 2380 },
  scenarios: [{ name: '区间震荡', probability: 100, trigger: '不破 2400', target: '2400-2500' }],
  risks: ['数据延迟', '消息面突发'],
  dataGaps: [],
};
const without = (levels) => ({ ...valid, levels });

console.log('\n=== invalidation：缺了不该让整份研判作废 ===');
check('完整输出通过', AnalysisSchema.safeParse(valid).success, true);
check(
  '缺 invalidation 通过（线上最常见的校验失败）',
  AnalysisSchema.safeParse(without({ supports: [2400], resistances: [2500] })).success,
  true,
);
check(
  'invalidation 为 null 通过',
  AnalysisSchema.safeParse(without({ supports: [], resistances: [], invalidation: null })).success,
  true,
);
check(
  'invalidation 是字符串仍然拒绝——宽松只限于缺省，不放过错类型',
  AnalysisSchema.safeParse(without({ supports: [], resistances: [], invalidation: '2380' })).success,
  false,
);
check(
  '真正关键的字段缺失仍然拒绝',
  AnalysisSchema.safeParse({ ...valid, headline: undefined }).success,
  false,
);

console.log('\n=== 缺 invalidation 的真实输出能走完解析校验 ===');
{
  const raw = '```json\n' + JSON.stringify(without({ supports: [2400], resistances: [2500] })) + '\n```';
  const r = parseAndValidate(raw, AnalysisSchema);
  check('解析成功', r.headline, '震荡偏弱');
  check('invalidation 为空而非瞎填', r.levels.invalidation == null, true);
}

console.log('\n=== 错误翻译：该做什么，而不是 SDK 原话 ===');
{
  const e = (name, message, extra = {}) => Object.assign(new Error(message), { name, ...extra });
  const t = (label, err, code, retryable) => {
    const r = explainModelError(err);
    check(`${label} → ${code}`, [r.code, r.retryable], [code, retryable]);
    return r;
  };
  t('密钥无效 401', e('AuthenticationError', '401 Unauthorized', { status: 401 }), 'MODEL_AUTH', false);
  t('模型名不对 404', e('NotFoundError', '404', { status: 404 }), 'MODEL_NOT_FOUND', false);
  t('限流 429', e('RateLimitError', '429', { status: 429 }), 'MODEL_RATE_LIMIT', true);
  t('上游 502', e('InternalServerError', '502', { status: 502 }), 'MODEL_UPSTREAM', true);
  t('SDK 超时', e('APIConnectionTimeoutError', 'Request timed out.'), 'MODEL_TIMEOUT', true);
  const net = t('连接失败', e('APIConnectionError', 'Connection error.', { cause: { code: 'ECONNRESET' } }), 'MODEL_NETWORK', true);
  check('网络错误提示里点出 NO_PROXY', net.message.includes('NO_PROXY'), true);
  check('网络错误带上底层错误码', net.message.includes('ECONNRESET'), true);
  t('输出格式', new JsonExtractionError('JSON 不符合 schema：\n  - headline: 缺失', ''), 'MODEL_FORMAT', true);
  t('未配置供应商', e('ProviderNotConfiguredError', '未配置'), 'NO_PROVIDER', false);
  const u = t('未知错误', new Error('boom'), 'UNKNOWN', true);
  check('未知错误保留原文，不吞信息', u.message.includes('boom'), true);
  t('非 Error 的抛出值', 'plain string', 'UNKNOWN', true);

  const m = explainMarketError(new Error('请求 www.okx.com 超时（6 秒）'), 'OKX ', 'HYPEUSDT');
  check('行情错误按实际数据源命名，不再写死 binance.vision', m.message.startsWith('OKX 行情获取失败'), true);
  check('行情错误保留底层原因', m.message.includes('超时（6 秒）'), true);
}

console.log('\n=== withRetry：抖动一次不该让整次研判结束 ===');
{
  let n = 0;
  const flaky = async () => {
    if (++n < 2) throw new Error('抖动');
    return 'ok';
  };
  check('第二次成功即返回', await withRetry(flaky, { baseDelayMs: 1 }), 'ok');
  check('只调用了两次', n, 2);

  let m = 0;
  const dead = async () => {
    m++;
    throw new Error(`第${m}次失败`);
  };
  const err = await withRetry(dead, { attempts: 2, baseDelayMs: 1 }).catch((e) => e);
  check('次数用尽后抛出最后一次的错误', err.message, '第2次失败');
  check('不会无限重试', m, 2);
}

console.log('\n=== provider 重试：截断 ≠ 空内容，截断时要给更多空间 ===');
{
  // 假端点：按预设脚本依次返回，同时记录每次请求带的 max_tokens 与提示
  const script = [];
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      seen.push({ max_tokens: parsed.max_tokens, prompt: parsed.messages.at(-1).content });
      const next = script.shift();
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          created: 0,
          model: 'fake',
          choices: [{ index: 0, finish_reason: next.finish, message: { role: 'assistant', content: next.content } }],
          usage: { prompt_tokens: 10, completion_tokens: next.tokens ?? 5, total_tokens: 15 },
        }),
      );
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const provider = createOpenAiCompatibleProvider({
    apiKey: 'test',
    baseURL: `http://127.0.0.1:${port}/v1`,
    model: 'fake-model',
    label: '测试',
    viaRelay: true,
  });
  const run = async (steps) => {
    script.length = 0;
    seen.length = 0;
    script.push(...steps);
    const retries = [];
    const result = await provider
      .generate({
        system: 's',
        user: 'u',
        schema: AnalysisSchema,
        onRetry: (i) => retries.push(i),
      })
      .catch((e) => e);
    return { result, retries };
  };

  const ok = JSON.stringify(valid);
  const truncated = ok.slice(0, 60);

  {
    const { result, retries } = await run([{ finish: 'length', content: truncated, tokens: 8000 }, { finish: 'stop', content: ok }]);
    check('截断后重试成功', result.headline, '震荡偏弱');
    check('通知了一次重试，且是第 2 次', retries.map((r) => r.attempt), [2]);
    check('重试原因点明是截断', retries[0].reason.includes('截断'), true);
    check('重试时 max_tokens 翻倍', seen.map((s) => s.max_tokens), [8000, 16000]);
    check('重试提示要求精简', seen[1].prompt.includes('精简'), true);
  }
  {
    const { result, retries } = await run([{ finish: 'stop', content: '' }, { finish: 'stop', content: ok }]);
    check('空内容后重试成功', result.headline, '震荡偏弱');
    check('空内容不是截断，max_tokens 不变', seen.map((s) => s.max_tokens), [8000, 8000]);
    check('原因里带上 finish_reason 便于排查', retries[0].reason.includes('finish_reason=stop'), true);
  }
  {
    const { result } = await run([
      { finish: 'stop', content: '' },
      { finish: 'stop', content: '' },
    ]);
    check('两次都失败时抛出格式错误', result instanceof JsonExtractionError, true);
    check('只尝试两次，不无限烧钱', seen.length, 2);
  }
  {
    const noInv = JSON.stringify(without({ supports: [2400], resistances: [2500] }));
    const { result, retries } = await run([{ finish: 'stop', content: noInv }]);
    check('缺 invalidation 一次通过，不再触发重试', [result.headline, retries.length], ['震荡偏弱', 0]);
    check('只发了一次请求（省下一整轮推理）', seen.length, 1);
  }

  server.close();
}

console.log(`\n通过 ${pass} / 失败 ${failures.length}`);
if (failures.length) {
  console.error('失败项：' + failures.join('、'));
  process.exit(1);
}
