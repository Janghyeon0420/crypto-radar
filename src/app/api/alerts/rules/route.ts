import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { readRules, updateRules } from '@/lib/alerts/store';
import { NEEDS_THRESHOLD, type AlertKind, type AlertRule } from '@/lib/alerts/types';
import { INTERVALS } from '@/lib/datasources/types';

const KINDS: AlertKind[] = [
  'price_above',
  'price_below',
  'rsi_above',
  'rsi_below',
  'macd_cross',
  'bb_squeeze_release',
  'volume_spike',
];

export async function GET() {
  return NextResponse.json({ rules: await readRules() });
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: '请求体必须是 JSON' }, { status: 400 });
  }

  // 批量导入：用于把浏览器 localStorage 里的旧规则一次性迁到服务端
  if (Array.isArray(body.rules)) {
    const incoming = body.rules as AlertRule[];
    const rules = await updateRules((existing) => {
      // 按 币种+类型+阈值+周期 去重，避免重复点击迁移按钮造成大量重复规则
      const seen = new Set(existing.map(signature));
      const fresh = incoming
        .filter((r) => !seen.has(signature(r)))
        .map((r) => ({ ...r, id: r.id || randomUUID(), createdAt: r.createdAt || Date.now() }));
      return [...existing, ...fresh];
    });
    return NextResponse.json({ rules, imported: rules.length });
  }

  const symbol = String(body.symbol ?? '').toUpperCase();
  const kind = body.kind as AlertKind;
  const interval = String(body.interval ?? '');
  const threshold = body.threshold == null ? undefined : Number(body.threshold);

  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) {
    return NextResponse.json({ error: 'symbol 格式非法' }, { status: 400 });
  }
  if (!KINDS.includes(kind)) {
    return NextResponse.json({ error: `不支持的告警类型：${kind}` }, { status: 400 });
  }
  if (!(INTERVALS as string[]).includes(interval)) {
    return NextResponse.json({ error: `不支持的周期：${interval}` }, { status: 400 });
  }
  if (NEEDS_THRESHOLD.includes(kind) && (threshold == null || !Number.isFinite(threshold))) {
    return NextResponse.json({ error: '该告警类型必须提供有效阈值' }, { status: 400 });
  }

  const rule: AlertRule = {
    id: randomUUID(),
    symbol,
    kind,
    interval,
    threshold,
    enabled: true,
    once: body.once === true,
    createdAt: Date.now(),
  };

  const rules = await updateRules((existing) => [...existing, rule]);
  return NextResponse.json({ rule, rules }, { status: 201 });
}

export async function PATCH(req: Request) {
  let body: { id?: string; enabled?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: '请求体必须是 JSON' }, { status: 400 });
  }
  if (!body.id) return NextResponse.json({ error: '缺少 id' }, { status: 400 });

  const rules = await updateRules((existing) =>
    existing.map((r) =>
      r.id === body.id ? { ...r, enabled: body.enabled ?? !r.enabled } : r,
    ),
  );
  return NextResponse.json({ rules });
}

export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: '缺少 id 参数' }, { status: 400 });
  const rules = await updateRules((existing) => existing.filter((r) => r.id !== id));
  return NextResponse.json({ rules });
}

/** 用于去重的规则指纹 */
function signature(r: AlertRule): string {
  return `${r.symbol}|${r.kind}|${r.interval}|${r.threshold ?? ''}`;
}
