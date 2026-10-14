import { z } from 'zod';
import { INTERVALS } from '../datasources/types';

export const forecastRequest = z.object({
  symbol: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,24}(USDT|USDC)$/, '请输入 USDT / USDC 交易对'),
  interval: z.enum(INTERVALS),
}).strict();

export function sameOrigin(req: Request): boolean {
  if (req.headers.get('sec-fetch-site') === 'cross-site') return false;
  const origin = req.headers.get('origin');
  if (!origin) return true;
  try {
    const incoming = new URL(origin);
    const requestUrl = new URL(req.url);
    // Next 生产路由会用内部 hostname 重建 req.url；Host 才是浏览器实际访问的域名。
    return incoming.host === (req.headers.get('host') ?? requestUrl.host)
      && incoming.protocol === requestUrl.protocol;
  } catch {
    return false;
  }
}
