/**
 * Next.js 服务启动钩子。
 *
 * 在这里拉起告警轮询，是为了让「启动看板」和「启动告警」是同一条命令——
 * 单人本地工具，让用户记住要另开一个终端跑 worker 是不合理的负担。
 *
 * 代价是告警随服务进程存活：关掉终端就停。
 * 常驻方案见 docs/DEPLOY.md（macOS 用 launchd，VPS 用 pm2）。
 */

export async function register() {
  // 只在 Node 运行时启动，Edge Runtime 没有定时器与文件系统
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { startWorker } = await import('./lib/alerts/worker');
  startWorker();

  void warmMacroCache();
}

/**
 * 预热宏观快照。
 *
 * 冷缓存时它要拉十几个上游（FRED 六个序列、净流动性三个、发布日历、
 * FOMC 日历、声明原文、RSS、Finlight）。实测通常 2-3 秒，但曾出现过
 * 一次 30 秒以上——而这个数据支撑着图表下方常驻的利率与议息倒计时，
 * 落在用户面前就是半分钟的「—」。
 *
 * 服务常驻之后这件事有了简单解法：启动时自己先拉一遍。
 * 反正数据要拉，早拉晚拉都是拉，不如让等待发生在没有人看的时候。
 *
 * 失败不做任何处理：这只是预热，真正的请求会自己重试，
 * 而启动阶段的网络抖动不该让服务起不来。
 */
async function warmMacroCache(): Promise<void> {
  try {
    const started = Date.now();
    const { fetchMacroSnapshot } = await import('./lib/datasources/macro');
    await fetchMacroSnapshot();
    console.log(`[macro] 启动预热完成，耗时 ${Date.now() - started}ms`);
  } catch (err) {
    console.warn('[macro] 启动预热失败（不影响服务，首次请求会自行拉取）：', err);
  }
}
