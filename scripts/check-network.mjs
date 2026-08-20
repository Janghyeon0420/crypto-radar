#!/usr/bin/env node
/**
 * 网络节点体检。
 *
 * 用途：切换到不同 VPN 节点后各跑一次，用实测数据决定哪个域名该走哪个节点，
 * 而不是靠"美国节点应该连不上币安"这类推测。
 *
 * 用法：
 *   node scripts/check-network.mjs
 *   node scripts/check-network.mjs --label "银河云-日本"    # 给本次结果打标签
 *   node scripts/check-network.mjs --json > jp.json        # 存档以便对比
 *
 * 注意：本脚本用 Node 原生 fetch，不读取 HTTP_PROXY 环境变量，
 * 因此测的是**系统级 VPN/TUN 的真实出口**，而不是某个终端代理变量。
 * 这正是我们想测的东西。
 */

const TARGETS = [
  // —— 本项目实际依赖的源 ——
  { id: 'binance-vision-rest', label: '币安公开镜像 REST', url: 'https://data-api.binance.vision/api/v3/ping', critical: true },
  { id: 'binance-vision-kline', label: '币安公开镜像 K线', url: 'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=1', critical: true },
  { id: 'okx', label: 'OKX 公开接口', url: 'https://www.okx.com/api/v5/public/time', critical: true },
  { id: 'fng', label: '恐惧贪婪指数', url: 'https://api.alternative.me/fng/?limit=1', critical: true },
  { id: 'cointelegraph', label: 'Cointelegraph RSS', url: 'https://cointelegraph.com/rss', critical: true },
  { id: 'fed-rss', label: '美联储 RSS（宏观）', url: 'https://www.federalreserve.gov/feeds/press_monetary.xml', critical: true },
  { id: 'fed-calendar', label: '美联储议息日历', url: 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm', critical: true },
  { id: 'nyfed-effr', label: '纽约联储 EFFR 利率', url: 'https://markets.newyorkfed.org/api/rates/unsecured/effr/last/1.json', critical: true },
  { id: 'anthropic', label: 'Anthropic API（AI 研判）', url: 'https://api.anthropic.com/v1/models', critical: false, expectAuthError: true },

  // —— 决定"这个节点算不算非美国"的关键探针 ——
  { id: 'binance-main', label: '币安主站 REST（地区探针）', url: 'https://api.binance.com/api/v3/ping', critical: false },
  { id: 'binance-fapi', label: '币安合约 fapi（地区探针）', url: 'https://fapi.binance.com/fapi/v1/ping', critical: false },
  { id: 'binance-web', label: '币安网页版（能否交易）', url: 'https://www.binance.com/en', critical: false },
  { id: 'bybit', label: 'Bybit（地区探针）', url: 'https://api.bybit.com/v5/market/time', critical: false },
];

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const labelIdx = args.indexOf('--label');
const label = labelIdx >= 0 ? args[labelIdx + 1] : null;
const TIMEOUT = 12_000;

async function probe(target) {
  const started = Date.now();
  try {
    const res = await fetch(target.url, {
      signal: AbortSignal.timeout(TIMEOUT),
      headers: { 'user-agent': 'crypto-radar-netcheck/1.0' },
      redirect: 'manual',
    });
    return {
      ...target,
      status: res.status,
      // 401/403 对 Anthropic 是预期的（没带 key），说明网络本身是通的
      ok: res.status < 400 || (target.expectAuthError && res.status === 401),
      ms: Date.now() - started,
      note: res.status === 451 ? '地理封锁' : undefined,
    };
  } catch (err) {
    return {
      ...target,
      status: null,
      ok: false,
      ms: Date.now() - started,
      note: err.name === 'TimeoutError' ? '超时' : (err.cause?.code ?? err.name),
    };
  }
}

/** 出口 IP 与归属地，用来确认"我现在到底在哪个节点上" */
async function whereAmI() {
  for (const url of ['https://ipinfo.io/json', 'https://ifconfig.co/json']) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const d = await res.json();
      return {
        ip: d.ip,
        country: d.country ?? d.country_iso ?? null,
        region: d.region ?? d.region_name ?? null,
        city: d.city ?? null,
        org: d.org ?? d.asn_org ?? null,
      };
    } catch {
      // 换下一个源
    }
  }
  return null;
}

const [where, results] = await Promise.all([
  whereAmI(),
  Promise.all(TARGETS.map(probe)),
]);

if (asJson) {
  console.log(JSON.stringify({ label, checkedAt: new Date().toISOString(), where, results }, null, 2));
  process.exit(0);
}

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m';

console.log(`\n${label ? `节点：${label}\n` : ''}出口：${
  where ? `${where.ip}  ${where.country ?? '?'} ${where.region ?? ''} ${where.city ?? ''}  ${D}${where.org ?? ''}${X}` : '未能获取'
}`);
console.log(`时间：${new Date().toLocaleString('zh-CN')}\n`);

const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].reduce((a, c) => a + (c.charCodeAt(0) > 127 ? 2 : 1), 0)));

for (const r of results) {
  const mark = r.ok ? `${G}✓${X}` : `${R}✗${X}`;
  const status = r.status ?? '—';
  const note = r.note ? ` ${Y}${r.note}${X}` : '';
  console.log(`  ${mark} ${pad(r.label, 30)} ${D}${String(status).padStart(3)}  ${String(r.ms).padStart(5)}ms${X}${note}`);
}

// —— 结论 ——
const byId = Object.fromEntries(results.map((r) => [r.id, r]));
const criticalFails = results.filter((r) => r.critical && !r.ok);
const binanceMainOk = byId['binance-main'].ok;
const fapiOk = byId['binance-fapi'].ok;

console.log(`\n${'─'.repeat(58)}`);

if (criticalFails.length === 0) {
  console.log(`${G}✓ 本看板所需的全部数据源在该节点均可用${X}`);
} else {
  console.log(`${R}✗ 该节点下有 ${criticalFails.length} 个必需数据源不可用：${X}`);
  criticalFails.forEach((f) => console.log(`    · ${f.label}${f.note ? `（${f.note}）` : ''}`));
}

console.log(
  binanceMainOk
    ? `${G}✓ 币安主站可达${X} —— 这是一个${G}非美国${X}节点，可直接用于币安交易${fapiOk ? '，合约数据亦可直取' : ''}`
    : `${Y}○ 币安主站不可达${X} —— 这是一个${Y}受限（美国）${X}节点。看板不受影响（走 binance.vision 镜像），但无法在此节点交易`,
);
console.log(`${'─'.repeat(58)}\n`);
