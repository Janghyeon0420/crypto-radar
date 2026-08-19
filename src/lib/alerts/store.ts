/**
 * 告警规则与触发历史的服务端持久化。
 *
 * 从 localStorage 迁到服务端文件，是因为告警要在**没有浏览器**的情况下工作——
 * 这正是服务端告警的全部意义。规则存在浏览器里，常驻进程就读不到。
 *
 * 沿用 history/store.ts 的写串行化模式：Next.js 路由并发处理，
 * 而告警轮询进程也会并发写入（更新 lastTriggeredAt），
 * 两边同时 read-modify-write 会丢规则。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AlertEvent, AlertRule } from './types';

const DATA_DIR = path.join(process.cwd(), 'data');
const RULES_FILE = path.join(DATA_DIR, 'alert-rules.json');
const EVENTS_FILE = path.join(DATA_DIR, 'alert-events.json');

/** 规则与事件各自串行，互不阻塞 */
let ruleChain: Promise<unknown> = Promise.resolve();
let eventChain: Promise<unknown> = Promise.resolve();

async function readJson<T>(file: string): Promise<T[]> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // 文件不存在或损坏都视为空，不该让看板或轮询进程挂掉
    return [];
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

// ── 规则 ──

export function readRules(): Promise<AlertRule[]> {
  return readJson<AlertRule>(RULES_FILE);
}

export function updateRules(
  updater: (rules: AlertRule[]) => AlertRule[],
): Promise<AlertRule[]> {
  const task = ruleChain.then(async () => {
    const next = updater(await readRules());
    await writeJson(RULES_FILE, next);
    return next;
  });
  ruleChain = task.catch(() => []);
  return task;
}

// ── 触发历史 ──

/** 保留条数。够回看最近发生了什么，又不至于让文件无限膨胀 */
const MAX_EVENTS = 200;

export function readEvents(): Promise<AlertEvent[]> {
  return readJson<AlertEvent>(EVENTS_FILE);
}

export function appendEvents(events: AlertEvent[]): Promise<AlertEvent[]> {
  if (events.length === 0) return readEvents();
  const task = eventChain.then(async () => {
    const all = [...events, ...(await readEvents())].slice(0, MAX_EVENTS);
    await writeJson(EVENTS_FILE, all);
    return all;
  });
  eventChain = task.catch(() => []);
  return task;
}

export function clearEvents(): Promise<AlertEvent[]> {
  const task = eventChain.then(async () => {
    await writeJson(EVENTS_FILE, []);
    return [] as AlertEvent[];
  });
  eventChain = task.catch(() => []);
  return task;
}
