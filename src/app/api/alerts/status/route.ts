import { NextResponse } from 'next/server';
import { getWorkerStatus } from '@/lib/alerts/worker';
import { telegramConfigFromEnv } from '@/lib/alerts/notify/telegram';

export async function GET() {
  return NextResponse.json({
    worker: getWorkerStatus(),
    telegramConfigured: telegramConfigFromEnv() !== null,
  });
}
