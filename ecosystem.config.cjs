/**
 * pm2 配置。给 Linux VPS 用——本机（macOS）推荐用 launchd：
 *   node scripts/setup-launchd.mjs
 * 两者选其一，别同时上：两个进程对同一份 data/ 求值会重复通知
 * （告警本身有单实例锁会挡住，但那是最后一道防线，不该当常态）。
 *
 * 用法：
 *   npm run build
 *   HTTPS_PROXY=... pm2 start ecosystem.config.cjs
 *   pm2 save && pm2 startup     # 开机自启，save 会把当前环境变量固化进 dump
 */
module.exports = {
  apps: [
    {
      name: 'crypto-radar',
      script: './node_modules/next/dist/bin/next',
      args: 'start',

      /**
       * 必须是单实例 fork 模式。
       *
       * cluster 模式或 instances > 1 会让每个实例各起一套告警轮询，
       * 同一条规则被求值多次、通知发多遍。这个项目当初把求值从浏览器
       * 移到服务端，就是为了消灭「两个地方同时求值」——别在这里退回去。
       */
      instances: 1,
      exec_mode: 'fork',

      env: {
        NODE_ENV: 'production',
        // Node 默认不读 HTTP(S)_PROXY。写在 .env.local 里对它无效，
        // 因为这个开关在进程启动时就被读走了
        NODE_USE_ENV_PROXY: '1',
        PORT: process.env.PORT || 3000,
        // 代理从启动 pm2 时的 shell 继承；pm2 save 会把值写进 dump，重启后仍在
        ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
        ...(process.env.HTTP_PROXY ? { HTTP_PROXY: process.env.HTTP_PROXY } : {}),
        ...(process.env.NO_PROXY ? { NO_PROXY: process.env.NO_PROXY } : {}),
      },

      // API Key 不写在这里，Next 自行读取 .env.local

      out_file: 'logs/server.log',
      error_file: 'logs/server.error.log',
      merge_logs: true,
      time: true,

      // 崩溃自动重启，但别在崩溃循环里空转
      autorestart: true,
      min_uptime: '30s',
      max_restarts: 10,
      restart_delay: 5000,
    },
  ],
};
