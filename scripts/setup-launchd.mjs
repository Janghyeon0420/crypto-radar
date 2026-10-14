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
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const LABEL = 'com.crypto-radar';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * 常驻服务必须指向主工作区。
 * 在 git worktree 里跑这个脚本时，脚本所在目录是个随时会被删掉的临时目录，
 * 既没有 node_modules 也没有 .next 构建——plist 指到那里，服务要么起不来，
 * 要么哪天 worktree 被清理后静默失效。所以优先取 git 的公共目录（主工作区的 .git）的上一级。
 * 与 make-desktop-app.mjs 的做法一致。
 */
function resolveProject() {
  const fallback = path.resolve(SCRIPT_DIR, '..');
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: SCRIPT_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (commonDir) return path.dirname(commonDir);
  } catch {
    // 不是 git 仓库或 git 不可用，退回脚本所在位置的上一级
  }
  return fallback;
}

const PROJECT = resolveProject();
const IN_WORKTREE = PROJECT !== path.resolve(SCRIPT_DIR, '..');
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

/**
 * 必须直连的域名，自动并入 NO_PROXY。
 *
 * NODE_USE_ENV_PROXY=1 会让**所有**出站请求走代理。可 docs/DATA-SOURCES.md 实测过：
 * 币安镜像与 LLM 中转站是「直连更快更稳」的一类，只有 OKX 需要代理。
 * 实测同一台机器上 data-api.binance.vision 直连稳定在 1 秒内，走本地代理则延迟抖动很大
 * （0.3~10 秒不等，偶发超时）——研判的第一步（拉行情）有超时上限，
 * 抖到上限就报「请求 data-api.binance.vision 超时」，整次研判还没开始就结束了。
 * 以前这里只照搬 shell 里的 NO_PROXY（通常只有 localhost），等于每次安装都把这个坑固化进了 plist。
 */
const DIRECT_HOSTS = ['data-api.binance.vision', 'data-stream.binance.vision'];

/**
 * 本机回环无论如何都不该走代理。以前它们只靠 shell 里恰好带着 NO_PROXY 才存在——
 * 换个没配 NO_PROXY 的终端装一次，plist 里就悄悄少了这几项。
 */
const LOOPBACK = ['localhost', '127.0.0.1', '::1', '.local'];

/**
 * 从 .env.local 里取出 LLM 接口的域名（只读 *_BASE_URL，不碰任何 Key）。
 * 配了 DEEPSEEK_API_KEY 却没写 base url 时用其默认域名。
 */
function llmHosts() {
  let text = '';
  for (const f of ['.env.local', '.env']) {
    try {
      text += '\n' + readFileSync(path.join(PROJECT, f), 'utf8');
    } catch {
      // 没有这个文件，正常
    }
  }
  const hosts = new Set();
  for (const m of text.matchAll(/^\s*(?:OPENAI|ANTHROPIC|DEEPSEEK)_BASE_URL\s*=\s*["']?([^\s"'#]+)/gm)) {
    try {
      hosts.add(new URL(m[1]).hostname);
    } catch {
      // 不是合法 URL，跳过
    }
  }
  if (/^\s*DEEPSEEK_API_KEY\s*=\s*\S+/m.test(text) && !/^\s*DEEPSEEK_BASE_URL\s*=/m.test(text)) {
    hosts.add('api.deepseek.com');
  }
  return [...hosts];
}

/** 合并并去重，保持用户原有条目在前 */
const mergeList = (...lists) => [
  ...new Set(lists.flatMap((l) => (Array.isArray(l) ? l : String(l ?? '').split(',')).map((x) => x.trim()).filter(Boolean))),
];

const hasProxy = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'].some((k) => inheritedProxy[k]);
const directHosts = hasProxy ? mergeList(DIRECT_HOSTS, llmHosts()) : [];
if (hasProxy) {
  const merged = mergeList(inheritedProxy.NO_PROXY, inheritedProxy.no_proxy, LOOPBACK, directHosts).join(',');
  // Node 两种大小写都认，哪个先到用哪个，所以两个都要写成合并后的值
  inheritedProxy.NO_PROXY = merged;
  if (inheritedProxy.no_proxy) inheritedProxy.no_proxy = merged;
}

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isLoaded = () => {
  try {
    execFileSync('launchctl', ['print', `gui/${uid}/${LABEL}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

/**
 * bootout 是异步的：命令返回时旧进程可能还在退出，此时立刻 bootstrap
 * 会报 "Bootstrap failed: 5: Input/output error"，而服务已经被卸掉了——
 * 结果是装一次反而把正在跑的服务停了。所以先等它真正卸载干净。
 */
async function waitUnloaded() {
  for (let i = 0; i < 20 && isLoaded(); i++) await sleep(500);
}

/** 即便等过，偶发的 I/O 错误也再试几次；全失败了要把「服务现在是停着的」说清楚 */
async function bootstrapWithRetry() {
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      execFileSync('launchctl', ['bootstrap', `gui/${uid}`, PLIST], { stdio: 'pipe' });
      return;
    } catch (err) {
      lastErr = err;
      await sleep(1000 * attempt);
    }
  }
  console.error(
    `\n加载失败，服务目前是停止状态。新配置已写入 ${PLIST}，手动加载：\n  ${cmd.load}\n` +
      String(lastErr?.stderr ?? lastErr?.message ?? lastErr),
  );
  process.exit(1);
}

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
  await waitUnloaded();
  await bootstrapWithRetry();
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
  if (IN_WORKTREE) console.log(`检测到在 git worktree 里运行，服务将指向主工作区：${PROJECT}`);
  await install();
} else if (arg === '--uninstall') {
  await uninstall();
} else {
  if (IN_WORKTREE) console.log(`检测到在 git worktree 里运行，服务将指向主工作区：${PROJECT}\n`);
  console.log(`将写入：${PLIST}\n`);
  console.log(plist);
  if (Object.keys(inheritedProxy).length === 0) {
    console.log(
      '⚠️  当前 shell 没有代理变量，生成的配置将直连。\n' +
        '    OKX 衍生品数据需要代理（美联储与币安镜像不需要）。\n' +
        '    需要的话这样生成：HTTPS_PROXY=http://127.0.0.1:7890 node scripts/setup-launchd.mjs --install\n',
    );
  } else {
    console.log(`将固化的代理变量：${Object.keys(inheritedProxy).join(', ')}`);
    console.log(`其中这些域名强制直连（NO_PROXY）：${directHosts.join(', ') || '（无）'}\n`);
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
