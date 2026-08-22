#!/usr/bin/env node
/**
 * 在桌面生成一个双击即用的 macOS App：起服务 + 开看板。
 *
 * 为什么不是一个 .command 脚本：双击 .command 会弹出一个终端窗口并一直留着，
 * 关掉它心里没底、不关又占地方。这里生成的是正经 .app bundle
 * （LSUIElement，不进 Dock、不留窗口），行为就是「双击 → 浏览器出看板」。
 *
 * 它做的事按顺序：
 *   1. 看 http://localhost:PORT 是否已经在服务 —— 常驻服务在跑时这是唯一路径，秒开
 *   2. 没在服务就先把等待页开出来（冷启动那十几秒必须有东西可看），再叫 launchd 拉起
 *   3. 等待页轮询到服务起来，自己跳转到看板
 *
 * 服务本身仍然是 scripts/setup-launchd.mjs 装的那个 com.crypto-radar，
 * 这个 App 只是它的开关和入口，不复制一份启动逻辑——两处起服务必然会漂移。
 *
 * 用法：
 *   node scripts/make-desktop-app.mjs            生成到 ~/Desktop
 *   node scripts/make-desktop-app.mjs --open     生成完顺手启动一次
 *   node scripts/make-desktop-app.mjs --out DIR  换个位置放
 */

import { mkdir, writeFile, rm, chmod, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { renderIcon } from './desktop-app-icon.mjs';

const APP_NAME = 'Crypto Radar';
const BUNDLE_ID = 'com.crypto-radar.launcher';
const LABEL = 'com.crypto-radar';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * 项目路径。注意这个脚本可能是在 git worktree 里跑的，而常驻服务跑的是主工作区——
 * 生成的 App 必须指向主工作区，否则指到一个随时会被删掉的临时目录上。
 */
function resolveProject() {
  const flag = process.argv.indexOf('--project');
  if (flag !== -1 && process.argv[flag + 1]) return path.resolve(process.argv[flag + 1]);
  try {
    const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: SCRIPT_DIR,
      encoding: 'utf8',
    }).trim();
    if (commonDir) return path.dirname(commonDir);
  } catch {
    // 不是 git 仓库或 git 不可用，退回脚本所在位置的上一级
  }
  return path.resolve(SCRIPT_DIR, '..');
}

const PROJECT = resolveProject();
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

/** 端口以已安装的 plist 为准——那才是服务实际监听的值，猜 3000 会猜错 */
function resolvePort() {
  if (process.env.PORT) return process.env.PORT;
  try {
    return execFileSync(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :EnvironmentVariables:PORT', PLIST],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    return '3000';
  }
}

const PORT = resolvePort();
const URL = `http://localhost:${PORT}`;

const outFlag = process.argv.indexOf('--out');
const OUT_DIR = outFlag !== -1 && process.argv[outFlag + 1]
  ? path.resolve(process.argv[outFlag + 1])
  : path.join(os.homedir(), 'Desktop');
const APP = path.join(OUT_DIR, `${APP_NAME}.app`);

const fill = (tpl, vars) =>
  tpl.replace(/%%(\w+)%%/g, (_, k) => {
    if (!(k in vars)) throw new Error(`模板里的 %%${k}%% 没有对应的值`);
    return vars[k];
  });

// ── Contents/MacOS/launcher ──
const LAUNCHER = String.raw`#!/bin/bash
# 由 scripts/make-desktop-app.mjs 生成。要改行为请改生成器并重跑，
# 直接改这里下次生成就没了。
set -u

URL="%%URL%%"
LABEL="%%LABEL%%"
PLIST="%%PLIST%%"
PROJECT="%%PROJECT%%"
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
ME="$(id -u)"

# Finder 启动的进程 PATH 很干净，一律写绝对路径
ready() { /usr/bin/curl -fsS -m 5 -o /dev/null "$URL/"; }

# 快路径：常驻服务本来就在跑，直接开页面
if ready; then
  exec /usr/bin/open "$URL"
fi

# 没装常驻服务就没得启动。这里只提示，不偷偷 npm install——
# 装依赖和构建是几分钟的事，得让人看着终端跑
if [ ! -f "$PLIST" ]; then
  CHOICE=$(/usr/bin/osascript <<'APPLESCRIPT'
tell application "System Events"
  activate
  set r to display dialog "还没安装常驻服务（com.crypto-radar），没有可启动的后台进程。

要在终端里装一次吗？装完以后开机自启，这个 App 每次都是秒开。" buttons {"取消", "打开终端安装"} default button 2 with title "Crypto Radar"
  return button returned of r
end tell
APPLESCRIPT
)
  if [ "$CHOICE" = "打开终端安装" ]; then
    /usr/bin/osascript \
      -e 'tell application "Terminal" to activate' \
      -e "tell application \"Terminal\" to do script \"cd '$PROJECT' && npm install && npm run build && node scripts/setup-launchd.mjs --install\""
  fi
  exit 0
fi

# 冷启动要十几秒。先把等待页开出来，否则双击完全没反应，
# 人会以为坏了然后连点五次
/usr/bin/open "file://$RES/starting.html"

if /bin/launchctl print "gui/$ME/$LABEL" >/dev/null 2>&1; then
  # 已加载却不响应：多半崩在 ThrottleInterval 的重试里，-k 强制重来一遍
  /bin/launchctl kickstart -k "gui/$ME/$LABEL" >/dev/null 2>&1
else
  /bin/launchctl bootstrap "gui/$ME" "$PLIST" >/dev/null 2>&1
fi

# 剩下的交给等待页轮询，这里不阻塞，App 直接退出
exit 0
`;

// ── Contents/Resources/starting.html ──
const STARTING = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>正在启动 Crypto Radar</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; height: 100vh; display: grid; place-content: center; justify-items: center;
    gap: 20px; background: #080c11; color: #e2e8f0;
    font: 15px/1.7 -apple-system, "PingFang SC", system-ui, sans-serif;
  }
  .ring { width: 46px; height: 46px; border-radius: 50%;
    border: 3px solid rgba(34, 211, 238, .18); border-top-color: #22d3ee;
    animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  h1 { font-size: 16px; font-weight: 600; margin: 0; letter-spacing: .02em; }
  p { margin: 0; color: #7b8794; font-size: 13px; text-align: center; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #a8b3bf; }
  a { color: #34d399; }
  .fail { display: none; }
  body.failed .ring, body.failed .live { display: none; }
  body.failed .fail { display: block; }
</style>
</head>
<body>
  <div class="ring"></div>
  <h1 class="live">正在启动 Crypto Radar…</h1>
  <p class="live">第一次冷启动约十几秒，起来后会自动跳转<br><span id="waited"></span></p>
  <div class="fail">
    <h1>服务没能起来</h1>
    <p>等了 90 秒还是没有响应。看一眼日志：<br>
      <code>tail -50 %%PROJECT%%/logs/server.error.log</code><br><br>
      也可能是 <code>npm run build</code> 还没跑过，或者 node 版本换了导致
      launchd 里固化的路径失效——那种情况重跑一次
      <code>node scripts/setup-launchd.mjs --install</code> 即可。<br><br>
      <a href="%%URL%%">手动试一次 %%URL%%</a>
    </p>
  </div>
<script>
  // file:// 页面 fetch 不了 http://localhost（跨源被拦），
  // 但 <img> 加载不受同源限制——拿 favicon 当探针就够判断「服务起来了没」
  var url = %%URL_JSON%%;
  var start = Date.now();
  var waited = document.getElementById('waited');

  function probe() {
    var elapsed = Math.round((Date.now() - start) / 1000);
    waited.textContent = '已等待 ' + elapsed + ' 秒';
    if (elapsed > 90) { document.body.className = 'failed'; return; }

    var img = new Image();
    img.onload = function () { location.replace(url); };
    img.onerror = function () { setTimeout(probe, 900); };
    img.src = url + '/favicon.ico?probe=' + Date.now();
  }
  probe();
</script>
</body>
</html>
`;

const INFO_PLIST = String.raw`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>%%APP_NAME%%</string>
  <key>CFBundleDisplayName</key><string>%%APP_NAME%%</string>
  <key>CFBundleIdentifier</key><string>%%BUNDLE_ID%%</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>%%VERSION%%</string>
  <key>CFBundleVersion</key><string>%%VERSION%%</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <!-- 不进 Dock、不抢焦点：它只是个开关，活不过一秒 -->
  <key>LSUIElement</key><true/>
</dict>
</plist>
`;

async function buildIcns(resourcesDir) {
  const png = renderIcon();
  const iconset = path.join(resourcesDir, 'AppIcon.iconset');
  await mkdir(iconset, { recursive: true });
  const src = path.join(iconset, 'source.png');
  await writeFile(src, png);

  // macOS 要求的全套尺寸，缺 @2x 会在 Retina 上糊
  const sizes = [
    [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
  ];
  for (const [px, name] of sizes) {
    execFileSync('sips', ['-z', String(px), String(px), src, '--out', path.join(iconset, name)], {
      stdio: 'ignore',
    });
  }
  await rm(src);
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(resourcesDir, 'AppIcon.icns')]);
  await rm(iconset, { recursive: true });
}

/** 覆盖前先确认目标确实是本脚本生成过的 App，别把同名的别的东西删了 */
async function assertSafeToReplace() {
  if (!existsSync(APP)) return;
  const info = path.join(APP, 'Contents', 'Info.plist');
  const owned = existsSync(info) && (await readFile(info, 'utf8')).includes(BUNDLE_ID);
  if (!owned) {
    console.error(`${APP} 已存在，但不是本脚本生成的。先手动挪走再重试。`);
    process.exit(1);
  }
  await rm(APP, { recursive: true });
}

const pkg = JSON.parse(await readFile(path.join(PROJECT, 'package.json'), 'utf8'));
const vars = {
  APP_NAME,
  BUNDLE_ID,
  LABEL,
  PLIST,
  PROJECT,
  URL,
  URL_JSON: JSON.stringify(URL),
  VERSION: pkg.version ?? '0.1.0',
};

await assertSafeToReplace();

const macos = path.join(APP, 'Contents', 'MacOS');
const resources = path.join(APP, 'Contents', 'Resources');
await mkdir(macos, { recursive: true });
await mkdir(resources, { recursive: true });

await writeFile(path.join(APP, 'Contents', 'Info.plist'), fill(INFO_PLIST, vars));
await writeFile(path.join(APP, 'Contents', 'PkgInfo'), 'APPL????');
await writeFile(path.join(macos, 'launcher'), fill(LAUNCHER, vars));
await chmod(path.join(macos, 'launcher'), 0o755);
await writeFile(path.join(resources, 'starting.html'), fill(STARTING, vars));
await buildIcns(resources);

// Finder 会缓存图标，改完 bundle 不 touch 一下可能还显示旧的（或空白）
execFileSync('touch', [APP]);

console.log(`已生成 ${APP}`);
console.log(`  项目：${PROJECT}`);
console.log(`  看板：${URL}`);
console.log(`  服务：${existsSync(PLIST) ? PLIST : '未安装（App 会提示装）'}`);

if (process.argv.includes('--open')) {
  execFileSync('open', [APP]);
  console.log('已启动一次');
}
