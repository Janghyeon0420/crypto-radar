#!/usr/bin/env node
/**
 * 生成 macOS launchd 配置，让看板与告警轮询常驻。
 *
 * 为什么用 launchd 而不是 pm2：这台机器上 launchd 本来就在跑，
 * 不必为一个单人工具再装一个全局进程管理器。pm2 的配置也一并提供了
 * （ecosystem.config.cjs），那份是给 Linux VPS 用的。
 *
 * 用法：
 *   node scripts/setup-launchd.mjs              打印将要写入的内容与命令，不改动任何东西
 *   node scripts/setup-launchd.mjs --install    写入 ~/Library/LaunchAgents 并加载
 *   node scripts/setup-launchd.mjs --uninstall  卸载并删除
 *
 * 注意：API Key 不进这个文件。Next 会自行读取 .env.local，
 * 密钥留在那里即可——plist 是纯文本且会被 Spotlight 索引，不该放凭据。
 * 但代理变量必须进来：NODE_USE_ENV_PROXY 是 Node 启动时读的，
 * 写在 .env.local 里对它无效。
 */

import { writeFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const LABEL = 'com.crypto-radar';
const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const NEXT_BIN = path.join(PROJECT, 'node_modules', 'next', 'dist', 'bin', 'next');
const PORT = process.env.PORT ?? '3000';

/**
 * 代理变量从当前 shell 继承。
 * launchd 不读你的 .zshrc——它启动的进程环境几乎是空的，
 * 所以必须在生成 plist 的这一刻把值固化进去。
 */
const PROXY_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy'];
const inheritedProxy = Object.fromEntries(
  PROXY_KEYS.filter((k) => process.env[k]).map((k) => [k, process.env[k]]),
);

const env = {
  NODE_ENV: 'production',
  // Node 默认不读 HTTP(S)_PROXY，这个开关必须在进程环境里
  NODE_USE_ENV_PROXY: '1',
  PORT,
  ...inheritedProxy,
};

const escape = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${escape(process.execPath)}</string>
    <string>${escape(NEXT_BIN)}</string>
    <string>start</string>
  </array>

  <!-- data/ 与 .env.local 都按 cwd 解析，这一项写错会静默地读不到规则 -->
  <key>WorkingDirectory</key>
  <string>${escape(PROJECT)}</string>

  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env)
  .map(([k, v]) => `    <key>${escape(k)}</key>\n    <string>${escape(v)}</string>`)
  .join('\n')}
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <!-- 崩溃后自动拉起。想临时停掉用 launchctl bootout，别 kill -->
  <key>KeepAlive</key>
  <true/>

  <!-- 崩溃循环时别把 CPU 打满 -->
  <key>ThrottleInterval</key>
  <integer>30</integer>

  <key>StandardOutPath</key>
  <string>${escape(path.join(PROJECT, 'logs', 'server.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escape(path.join(PROJECT, 'logs', 'server.error.log'))}</string>
</dict>
</plist>
`;

const uid = process.getuid();
const cmd = {
  load: `launchctl bootstrap gui/${uid} ${PLIST}`,
  unload: `launchctl bootout gui/${uid}/${LABEL}`,
  status: `launchctl print gui/${uid}/${LABEL} | head -20`,
};

async function install() {
  if (!existsSync(NEXT_BIN)) {
    console.error(`找不到 ${NEXT_BIN}，先跑 npm install`);
    process.exit(1);
  }
  if (!existsSync(path.join(PROJECT, '.next', 'BUILD_ID'))) {
    console.error('还没有生产构建。先跑 npm run build，否则服务起来就会退出');
    process.exit(1);
  }

  await mkdir(path.join(PROJECT, 'logs'), { recursive: true });
  await mkdir(path.dirname(PLIST), { recursive: true });
  // 已加载时先卸载，否则 bootstrap 会因为重复 Label 失败
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'ignore' });
  } catch {
    // 本来就没加载，正常
  }
  await writeFile(PLIST, plist);
  execFileSync('launchctl', ['bootstrap', `gui/${uid}`, PLIST], { stdio: 'inherit' });
  console.log(`已加载 ${LABEL}\n看板：http://localhost:${PORT}\n日志：logs/server.log`);
  console.log(`停止：${cmd.unload}`);
}

async function uninstall() {
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'inherit' });
  } catch {
    console.log('（本来就没加载）');
  }
  await unlink(PLIST).catch(() => {});
  console.log(`已卸载并删除 ${PLIST}`);
}

const arg = process.argv[2];
if (arg === '--install') {
  await install();
} else if (arg === '--uninstall') {
  await uninstall();
} else {
  console.log(`将写入：${PLIST}\n`);
  console.log(plist);
  if (Object.keys(inheritedProxy).length === 0) {
    console.log(
      '⚠️  当前 shell 没有代理变量，生成的配置将直连。\n' +
        '    OKX 衍生品数据需要代理（美联储与币安镜像不需要）。\n' +
        '    需要的话这样生成：HTTPS_PROXY=http://127.0.0.1:7890 node scripts/setup-launchd.mjs --install\n',
    );
  } else {
    console.log(`将固化的代理变量：${Object.keys(inheritedProxy).join(', ')}\n`);
  }
  if (process.execPath.includes('/.nvm/')) {
    console.log(
      '⚠️  node 路径来自 nvm，含具体版本号：\n' +
        `    ${process.execPath}\n` +
        '    升级 node 后这个路径会失效，launchd 找不到二进制会每 30 秒重试一次且不报错——\n' +
        '    表现为「看板打不开、告警没了」而看不出原因。升级后重跑一次本脚本即可。\n',
    );
  }
  console.log(`安装：node scripts/setup-launchd.mjs --install`);
  console.log(`状态：${cmd.status}`);
  console.log(`停止：${cmd.unload}`);
}
