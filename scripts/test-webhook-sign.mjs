/**
 * 群机器人签名与载荷的交叉验证。
 *
 * 签名写错是静默失败（HTTP 200 但消息不出现），线上很难发现，
 * 所以这里固定时间戳，把请求实际内容打出来，与按官方文档独立实现的
 * Python 参考实现逐字节比对。
 */
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

console.log('=== 厂商识别 ===');
const urls = {
  'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc': 'wecom',
  'https://oapi.dingtalk.com/robot/send?access_token=abc': 'dingtalk',
  'https://open.feishu.cn/open-apis/bot/v2/hook/abc': 'feishu',
  'https://open.larksuite.com/open-apis/bot/v2/hook/abc': 'feishu',
  'https://example.com/hook': null,
  'not-a-url': null,
};
let ok = 0, bad = 0;
for (const [u, want] of Object.entries(urls)) {
  const got = detectVendor(u);
  const pass = got === want;
  if (pass) ok++;
  else bad++;
  console.log(`  ${pass ? '✓' : '✗'} ${u.slice(0, 52).padEnd(54)} -> ${got}`);
}

console.log('\n=== 请求内容（供 Python 参考实现比对）===');
for (const [vendor, url] of [
  ['wecom', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc'],
  ['dingtalk', 'https://oapi.dingtalk.com/robot/send?access_token=abc'],
  ['feishu', 'https://open.feishu.cn/open-apis/bot/v2/hook/abc'],
]) {
  captured.length = 0;
  const bot = createWebhookBot({ url, vendor, secret: vendor === 'wecom' ? undefined : SECRET });
  await bot.send('测试消息');
  const c = captured[0];
  console.log(`\n[${vendor}]`);
  console.log(`  URL : ${c.url}`);
  console.log(`  BODY: ${JSON.stringify(c.body)}`);
}

console.log('\n=== 关键词模式：应加在消息开头 ===');
captured.length = 0;
const kw = createWebhookBot({
  url: 'https://oapi.dingtalk.com/robot/send?access_token=abc',
  vendor: 'dingtalk',
  keyword: '告警',
});
await kw.send('BTC 突破 70000');
console.log(`  content = ${JSON.stringify(captured[0].body.text.content)}`);

Date.now = realNow;
console.log(`\n厂商识别 通过 ${ok} / 失败 ${bad}`);
