/**
 * 企业微信 / 钉钉 / 飞书 群机器人。
 *
 * 三家都是「一条 webhook URL 即可推送」，无需注册第三方服务、无需装新 app，
 * 且实测国内直连延迟最低（270-320ms）。
 *
 * 但三家的差异比看起来大，尤其是加签算法——写反了是**静默失败**
 * （请求返回成功但消息不出现），所以这里把差异写得很直白：
 *
 *              企业微信      钉钉                飞书
 *   加签        无          有                  有
 *   时间戳      —          毫秒                秒
 *   HMAC key   —          secret              `timestamp\nsecret`
 *   HMAC data  —          `timestamp\nsecret`  空字符串
 *   签名位置    —          URL 查询参数         请求体字段
 *   成功判定    errcode=0   errcode=0           code=0
 */

import { createHmac } from 'node:crypto';
import type { Notifier, SendResult } from './types';

export type BotVendor = 'wecom' | 'dingtalk' | 'feishu';

export interface WebhookBotConfig {
  url: string;
  vendor: BotVendor;
  /** 加签模式的密钥。钉钉以 SEC 开头，飞书是一串随机字符 */
  secret?: string;
  /** 关键词模式下必须出现在消息里的词，会自动加到消息开头 */
  keyword?: string;
}

const VENDOR_LABELS: Record<BotVendor, string> = {
  wecom: '企业微信群机器人',
  dingtalk: '钉钉群机器人',
  feishu: '飞书群机器人',
};

/** 从 webhook 域名识别厂商，省得用户还要手动指定 */
export function detectVendor(url: string): BotVendor | null {
  try {
    const host = new URL(url).hostname;
    if (host.includes('qyapi.weixin.qq.com')) return 'wecom';
    if (host.includes('dingtalk.com')) return 'dingtalk';
    if (host.includes('feishu.cn') || host.includes('larksuite.com')) return 'feishu';
    return null;
  } catch {
    return null;
  }
}

const VENDORS: BotVendor[] = ['wecom', 'dingtalk', 'feishu'];

/**
 * 配置读取的结果。
 *
 * 刻意区分「没配置」与「配了但不对」：后者必须让用户看到原因。
 * 若只返回 null，界面会显示「未配置通知通道」，用户明明填了 URL
 * 却被告知没配置，只能去翻服务端日志才知道是域名没被识别。
 */
export type WebhookBotResolution =
  | { status: 'absent' }
  | { status: 'ok'; config: WebhookBotConfig }
  | { status: 'invalid'; reason: string };

export function webhookBotFromEnv(): WebhookBotResolution {
  const url = process.env.ALERT_WEBHOOK_URL?.trim();
  if (!url) return { status: 'absent' };

  // 允许显式指定厂商：自建网关、企业内网代理或本地测试时，
  // 域名不是官方域名，但协议格式仍然一致
  const override = process.env.ALERT_WEBHOOK_VENDOR?.trim().toLowerCase();
  let vendor: BotVendor | null = null;

  if (override) {
    if (!(VENDORS as string[]).includes(override)) {
      return {
        status: 'invalid',
        reason: `ALERT_WEBHOOK_VENDOR 只能是 wecom / dingtalk / feishu，当前为 "${override}"`,
      };
    }
    vendor = override as BotVendor;
  } else {
    vendor = detectVendor(url);
  }

  if (!vendor) {
    return {
      status: 'invalid',
      reason:
        `无法从 URL 域名识别厂商（支持 qyapi.weixin.qq.com / oapi.dingtalk.com / open.feishu.cn）。` +
        `若使用自建网关，请用 ALERT_WEBHOOK_VENDOR 显式指定`,
    };
  }

  return {
    status: 'ok',
    config: {
      url,
      vendor,
      secret: process.env.ALERT_WEBHOOK_SECRET?.trim() || undefined,
      keyword: process.env.ALERT_WEBHOOK_KEYWORD?.trim() || undefined,
    },
  };
}

export function createWebhookBot(cfg: WebhookBotConfig): Notifier {
  return {
    id: `webhook-${cfg.vendor}`,
    label: VENDOR_LABELS[cfg.vendor],
    send: (text) => send(cfg, text),
  };
}

async function send(cfg: WebhookBotConfig, rawText: string): Promise<SendResult> {
  // 关键词安全模式要求消息中必须包含指定词，否则钉钉/飞书会拒收
  const text = cfg.keyword ? `${cfg.keyword} ${rawText}` : rawText;

  try {
    const { url, body } = buildRequest(cfg, text);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };

    const data = await res.json();
    return interpret(cfg.vendor, data);
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function buildRequest(
  cfg: WebhookBotConfig,
  text: string,
): { url: string; body: Record<string, unknown> } {
  switch (cfg.vendor) {
    case 'wecom':
      // 企业微信没有加签机制，安全性靠 URL 中的 key 本身
      return { url: cfg.url, body: { msgtype: 'text', text: { content: text } } };

    case 'dingtalk': {
      let url = cfg.url;
      if (cfg.secret) {
        const timestamp = Date.now(); // 毫秒
        const sign = createHmac('sha256', cfg.secret)
          .update(`${timestamp}\n${cfg.secret}`)
          .digest('base64');
        // 签名走查询参数，且必须 URL 编码——base64 里的 + / = 不转义会签名校验失败
        const sep = url.includes('?') ? '&' : '?';
        url = `${url}${sep}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`;
      }
      return { url, body: { msgtype: 'text', text: { content: text } } };
    }

    case 'feishu': {
      const body: Record<string, unknown> = {
        msg_type: 'text',
        content: { text },
      };
      if (cfg.secret) {
        const timestamp = Math.floor(Date.now() / 1000); // 秒，与钉钉不同
        // 飞书是把 `timestamp\nsecret` 当作 HMAC 的密钥，对空内容签名，
        // 与钉钉的「用 secret 对 `timestamp\nsecret` 签名」正好相反
        const sign = createHmac('sha256', `${timestamp}\n${cfg.secret}`)
          .update('')
          .digest('base64');
        body.timestamp = String(timestamp);
        body.sign = sign;
      }
      return { url: cfg.url, body };
    }
  }
}

/** 三家的成功判定字段不同，且都可能在 HTTP 200 的响应里报错 */
function interpret(vendor: BotVendor, data: Record<string, unknown>): SendResult {
  if (vendor === 'feishu') {
    return data.code === 0
      ? { ok: true, detail: 'sent' }
      : { ok: false, detail: String(data.msg ?? `code=${data.code}`) };
  }
  return data.errcode === 0
    ? { ok: true, detail: 'sent' }
    : { ok: false, detail: String(data.errmsg ?? `errcode=${data.errcode}`) };
}
