/**
 * 研判链路的错误处理。
 *
 * 以前所有失败都被压成一句「研判失败：<原始 message>」，而原始 message 往往是
 * SDK 的 "Connection error."、"Request timed out." 这种看不出该怎么办的话。
 * 用户点完按钮等了半分钟，只拿到一行红字，既不知道是网络、密钥还是模型的问题，
 * 也不知道重试有没有用。这里把常见失败翻译成「发生了什么 + 该做什么」。
 *
 * 按 name / status 鸭子类型判断而不是 instanceof：OpenAI 与 Anthropic 两家 SDK
 * 的错误类各是各的，这里不想为了判断类型把两个 SDK 都拉进来。
 */

export interface ExplainedError {
  message: string;
  /** 给界面的稳定标识，文案可以改，这个不变 */
  code: string;
  /** 重试有没有可能成功。鉴权、模型名写错这类重试一百次也一样 */
  retryable: boolean;
}

interface ErrorLike {
  name?: string;
  message?: string;
  status?: number;
  cause?: { code?: string; message?: string } | null;
}

const asErrorLike = (err: unknown): ErrorLike =>
  err && typeof err === 'object' ? (err as ErrorLike) : { message: String(err) };

/** 模型调用阶段的失败 */
export function explainModelError(err: unknown): ExplainedError {
  const e = asErrorLike(err);
  const raw = e.message ?? '未知错误';
  const status = typeof e.status === 'number' ? e.status : undefined;

  if (e.name === 'ProviderNotConfiguredError') {
    return { message: raw, code: 'NO_PROVIDER', retryable: false };
  }

  if (e.name === 'JsonExtractionError') {
    return {
      message:
        `研判失败：模型连续两次输出都不符合要求（${firstLine(raw)}）。` +
        '通常再点一次就能过；反复出现请换更强的模型。',
      code: 'MODEL_FORMAT',
      retryable: true,
    };
  }

  if (status === 401 || status === 403) {
    return {
      message: `研判失败：模型接口拒绝了请求（HTTP ${status}）。API Key 无效、过期或被中转站停用，请检查 .env.local。`,
      code: 'MODEL_AUTH',
      retryable: false,
    };
  }
  if (status === 404) {
    return {
      message:
        '研判失败：模型接口返回 404。多半是 OPENAI_MODEL 名称中转站不支持，' +
        '或 OPENAI_BASE_URL 少了 /v1。可用 GET {BASE_URL}/models 查询可用模型。',
      code: 'MODEL_NOT_FOUND',
      retryable: false,
    };
  }
  if (status === 429) {
    return {
      message: '研判失败：模型接口限流或额度不足（HTTP 429）。稍等片刻再试，或检查中转站余额。',
      code: 'MODEL_RATE_LIMIT',
      retryable: true,
    };
  }
  if (status !== undefined && status >= 500) {
    return {
      message: `研判失败：模型上游服务异常（HTTP ${status}），属于中转站或模型方的临时故障，稍后重试。`,
      code: 'MODEL_UPSTREAM',
      retryable: true,
    };
  }

  if (e.name === 'APIConnectionTimeoutError' || /timed? ?out/i.test(raw)) {
    return {
      message:
        '研判失败：模型长时间没有返回而超时。推理型模型偶尔会思考很久，直接重试通常可以；' +
        '总是超时请换更快的模型（如 deepseek-v4-flash）。',
      code: 'MODEL_TIMEOUT',
      retryable: true,
    };
  }

  const causeCode = e.cause?.code;
  if (
    e.name === 'APIConnectionError' ||
    causeCode ||
    /connection error|fetch failed|ECONN|ENOTFOUND|socket|TLS/i.test(raw)
  ) {
    return {
      message:
        `研判失败：连不上模型接口${causeCode ? `（${causeCode}）` : ''}。` +
        '如果配置了代理，中转站域名需要加进 NO_PROXY 走直连（见 docs/DATA-SOURCES.md「NO_PROXY」一节）。',
      code: 'MODEL_NETWORK',
      retryable: true,
    };
  }

  return { message: `研判失败：${raw}`, code: 'UNKNOWN', retryable: true };
}

/**
 * 取数阶段的失败。
 *
 * @param source 数据来自哪里（「币安镜像」「OKX」）。以前文案写死 binance.vision，
 *   而 HYPE 这类币实际走 OKX，报错却指向币安，查起来是反方向。
 */
export function explainMarketError(err: unknown, source: string, symbol: string): ExplainedError {
  const cause = err instanceof Error ? err.message : String(err);
  return {
    message:
      `${source}行情获取失败（已自动重试）：${cause}。` +
      '这通常是网络或代理抖动，稍后再点一次即可；' +
      `也可能 ${symbol} 不是该交易所的有效交易对。长期如此请检查 NO_PROXY 配置（docs/DATA-SOURCES.md）。`,
    code: 'MARKET_DATA',
    retryable: true,
  };
}

const firstLine = (s: string) => s.split('\n')[0].slice(0, 120);

/**
 * 重试一次有抖动的取数。
 *
 * 研判最贵的是后面那次 30~150 秒的模型调用，不该死在前面取行情时的一次抖动上。
 * 次数刻意很少：底层 fetchJson 可能自带重试，这里叠得太多，
 * 网络真断了的时候用户要干等一分多钟才能看到报错。
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  { attempts = 2, baseDelayMs = 600 }: { attempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts) await new Promise((r) => setTimeout(r, baseDelayMs * i));
    }
  }
  throw lastErr;
}
