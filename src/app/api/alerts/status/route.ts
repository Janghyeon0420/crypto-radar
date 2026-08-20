import { NextResponse } from 'next/server';
import { getWorkerStatus } from '@/lib/alerts/worker';
import { notifierConfigIssues, resolveNotifiers } from '@/lib/alerts/notify';

export async function GET() {
  return NextResponse.json({
    worker: getWorkerStatus(),
    // 直接读环境变量，不依赖 worker 是否已启动
    channels: resolveNotifiers().map((n) => n.label),
    // 配置有问题时把原因带给界面，避免用户以为自己没配
    configIssues: notifierConfigIssues(),
  });
}
