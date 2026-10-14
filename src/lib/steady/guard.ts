/**
 * 本机访问保护。
 *
 * 为什么需要：这个项目此前存的都是公开行情和研判历史，`next start` 监听全部网卡也无伤大雅
 * （ROADMAP D1 只担心被刷 API 额度）。稳健驾驶舱会存**持仓与投资计划**——这是第一次
 * 存财务数据，而常驻服务会跟着笔记本连咖啡馆、酒店的 Wi-Fi，同网段的任何人
 * 都能 GET 一下读到它。
 *
 * 做法：只接受 Host 为回环地址的请求（挡掉同网段访问，顺带挡 DNS 重绑定），
 * 并拒绝跨站请求（挡「用户访问了恶意网页，它往 localhost 发 POST」这类 CSRF）。
 * 确实需要手机看盘时，设 STEADY_ALLOW_LAN=1 显式放开 Host 检查——
 * 这是「你知道自己在做什么」的开关，所以默认关。
 */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** 从 Host 头里取主机名，去掉端口；兼容 [::1]:3000 这种 IPv6 写法 */
export function hostnameOf(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end >= 0 ? h.slice(0, end + 1) : h;
  }
  return h.split(':')[0];
}

export type GuardResult = { ok: true } | { ok: false; status: 403; reason: string };

export function checkLocalRequest(
  headers: Headers,
  opts: { allowLan?: boolean } = {},
): GuardResult {
  const host = headers.get('host') ?? '';
  const name = hostnameOf(host);

  if (!opts.allowLan && !LOOPBACK.has(name) && !name.endsWith('.localhost')) {
    return {
      ok: false,
      status: 403,
      reason:
        `出于隐私保护，持仓与投资计划只允许从本机访问（当前访问的是 ${name || '未知主机'}）。` +
        '确实需要在手机或其他设备上查看时，可在服务环境里设置 STEADY_ALLOW_LAN=1。',
    };
  }

  const site = headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    return { ok: false, status: 403, reason: '拒绝跨站请求。' };
  }

  const origin = headers.get('origin');
  if (origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      return { ok: false, status: 403, reason: 'Origin 头不合法。' };
    }
    if (originHost.toLowerCase() !== host.trim().toLowerCase()) {
      return { ok: false, status: 403, reason: '拒绝跨站请求。' };
    }
  }

  return { ok: true };
}

export const lanAllowed = (): boolean => process.env.STEADY_ALLOW_LAN === '1';
