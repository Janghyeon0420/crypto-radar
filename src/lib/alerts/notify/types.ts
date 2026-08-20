/**
 * 通知通道抽象。
 *
 * 各家的鉴权方式、载荷结构、成功判定都不一样，
 * 上层只关心「把这段文字送出去，成没成」，差异关在各自实现里。
 */

export interface SendResult {
  ok: boolean;
  detail: string;
}

export interface Notifier {
  id: string;
  /** 展示名，用于界面与日志 */
  label: string;
  send(text: string): Promise<SendResult>;
}
