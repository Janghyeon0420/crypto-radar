/**
 * 群机器人签名与载荷的交叉验证。
 *
 * 签名写错是**静默失败**（HTTP 200 但消息不出现），线上极难发现，
 * 所以这里固定时间戳，用一份**按官方文档独立写出来的**签名实现去比对
 * webhook-bot.ts 的输出——而不是直接调用它自己的函数自证。
 *
 * 三家的差异正是最容易写反的地方，逐条钉死：
 *              企业微信      钉钉                飞书
 *   加签        无          有                  有
 *   时间戳      —          毫秒                秒
 *   HMAC key   —          secret              `timestamp\nsecret`
 *   HMAC data  —          `timestamp\nsecret`  空字符串
 *   签名位置    —          URL 查询参数         请求体字段
 */
import { createHmac } from 'node:crypto';
import { detectVendor } from '../src/lib/alerts/notify/webhook-bot.ts';

// 固定时间与密钥，保证可复现
const FIXED_MS = 1750000000000;
const realNow = Date.now;
Date.now = () => FIXED_MS;

const captured = [];
globalThis.fetch = async (url, init) => {
  captured.push({ url, body: JSON.parse(init.body) });
  return { ok: true, json: async () => ({ errcode: 0, code: 0 }) };
};

const { createWebhookBot } = await import('../src/lib/alerts/notify/webhook-bot.ts');

const SECRET = 'SECtest1234567890abcdefghijklmn';

let pass = 0;
const failures = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else failures.push({ name, actual, expected });
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  if (!ok) {
    console.log(`      实际 ${JSON.stringify(actual)}`);
    console.log(`      期望 ${JSON.stringify(expected)}`);
  }
}

/** 发一条消息并返回捕获到的请求 */
async function sendVia(cfg, text) {
  captured.length = 0;
  await createWebhookBot(cfg).send(text);
  return captured[0];
}

// ── 按官方文档独立实现的签名，用于比对 ──
const dingtalkSign = (secret, ms) =>
  createHmac('sha256', secret).update(`${ms}\n${secret}`).digest('base64');
const feishuSign = (secret, seconds) =>
  createHmac('sha256', `${seconds}\n${secret}`).update('').digest('base64');

console.log('=== 厂商识别 ===');
for (const [url, want] of Object.entries({
  'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc': 'wecom',
  'https://oapi.dingtalk.com/robot/send?access_token=abc': 'dingtalk',
  'https://open.feishu.cn/open-apis/bot/v2/hook/abc': 'feishu',
  'https://open.larksuite.com/open-apis/bot/v2/hook/abc': 'feishu',
  'https://example.com/hook': null,
  'not-a-url': null,
})) {
  check(url.slice(0, 52), detectVendor(url), want);
}

console.log('\n=== 企业微信：无加签 ===');
{
  const url = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc';
  const req = await sendVia({ url, vendor: 'wecom' }, '测试消息');
  check('URL 原样不变（无签名参数）', req.url, url);
  check('载荷', req.body, { msgtype: 'text', text: { content: '测试消息' } });
}

console.log('\n=== 钉钉：毫秒时间戳，secret 作 key，签名进 URL ===');
{
  const req = await sendVia(
    { url: 'https://oapi.dingtalk.com/robot/send?access_token=abc', vendor: 'dingtalk', secret: SECRET },
    '测试消息',
  );
  const u = new URL(req.url);
  check('timestamp 为毫秒', u.searchParams.get('timestamp'), String(FIXED_MS));
  check('sign 与独立实现一致', u.searchParams.get('sign'), dingtalkSign(SECRET, FIXED_MS));
  // base64 里的 + / = 不转义会导致钉钉校验失败，这是最隐蔽的一种写错方式
  check(
    'sign 已 URL 编码',
    u.search.includes(encodeURIComponent(dingtalkSign(SECRET, FIXED_MS))),
    true,
  );
  check('原有查询参数未被冲掉', u.searchParams.get('access_token'), 'abc');
  check('签名不进请求体', req.body, { msgtype: 'text', text: { content: '测试消息' } });
}

console.log('\n=== 飞书：秒级时间戳，`ts\\nsecret` 作 key，签名进请求体 ===');
{
  const req = await sendVia(
    { url: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc', vendor: 'feishu', secret: SECRET },
    '测试消息',
  );
  const seconds = Math.floor(FIXED_MS / 1000);
  check('URL 不带签名参数', req.url, 'https://open.feishu.cn/open-apis/bot/v2/hook/abc');
  check('timestamp 为秒且是字符串', req.body.timestamp, String(seconds));
  check('sign 与独立实现一致', req.body.sign, feishuSign(SECRET, seconds));
  check('消息字段名为 msg_type / content.text', [req.body.msg_type, req.body.content], [
    'text',
    { text: '测试消息' },
  ]);
}

console.log('\n=== 不配 secret 时不应出现任何签名 ===');
{
  const ding = await sendVia(
    { url: 'https://oapi.dingtalk.com/robot/send?access_token=abc', vendor: 'dingtalk' },
    'x',
  );
  check('钉钉 URL 无 sign', ding.url.includes('sign='), false);
  const feishu = await sendVia(
    { url: 'https://open.feishu.cn/open-apis/bot/v2/hook/abc', vendor: 'feishu' },
    'x',
  );
  check('飞书载荷无 sign', 'sign' in feishu.body, false);
}

console.log('\n=== 关键词模式：必须加在消息开头 ===');
{
  const req = await sendVia(
    { url: 'https://oapi.dingtalk.com/robot/send?access_token=abc', vendor: 'dingtalk', keyword: '告警' },
    'BTC 突破 70000',
  );
  check('content 以关键词开头', req.body.text.content, '告警 BTC 突破 70000');
}

Date.now = realNow;
console.log(`\n通过 ${pass} / 失败 ${failures.length}`);
process.exit(failures.length ? 1 : 0);
