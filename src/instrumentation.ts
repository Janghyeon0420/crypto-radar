/**
 * Next.js 服务启动钩子。
 *
 * 在这里拉起告警轮询，是为了让「启动看板」和「启动告警」是同一条命令——
 * 单人本地工具，让用户记住要另开一个终端跑 worker 是不合理的负担。
 *
 * 代价是告警随服务进程存活：关掉终端就停。真要 7×24，
 * 得把这个服务本身用 pm2 之类的方式常驻，或部署到服务器。
 */

export async function register() {
  // 只在 Node 运行时启动，Edge Runtime 没有定时器与文件系统
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { startWorker } = await import('./lib/alerts/worker');
  startWorker();
}
