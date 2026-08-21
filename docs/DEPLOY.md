# 常驻部署

告警在服务端求值，**只要服务在跑就持续监控**——但反过来说，
服务不跑就什么都没有。用 `npm run dev` 起的服务随终端存活，
关掉终端、合上电脑、重启系统，告警就停了，而且不会有任何提示。

这份文档解决的就是这件事。

---

## 先明确一件事：这台 Mac 能不能算 7×24

不能，除非你处理睡眠。

**Mac 一旦休眠，进程就冻结**——定时器不走、网络请求不发。
合盖之后告警不是"延迟"，是彻底停摆，醒来后也不会补跑错过的那些轮次。

三个选择，诚实排序：

| 方案 | 真实可用性 | 代价 |
|---|---|---|
| Mac + launchd + 不让它睡 | 电脑开着就行，合盖即停 | 免费，但只能覆盖你开机的时间 |
| Mac + launchd + `caffeinate` | 插电时不休眠 | 费电、机器一直转 |
| Linux VPS + pm2 | 真正 7×24 | 每月几美元，且需要能连上币安镜像的机房 |

盯盘提醒这个用途，第一种通常够用——你不在电脑前的时候，
本来也不会去看告警。**但别把它当成"我一定不会错过"**，
这个预期落空一次就足以造成实际损失。

想在插电时不休眠：

```bash
caffeinate -s -w $(pgrep -f "next start" | head -1)
```

---

## macOS：launchd（推荐，无需装任何东西）

```bash
npm run build
node scripts/setup-launchd.mjs            # 先看要写什么，不改动任何东西
node scripts/setup-launchd.mjs --install  # 确认无误后再装
```

装好后开机登录即自动启动，崩溃自动拉起。

```bash
launchctl print gui/$(id -u)/com.crypto-radar | head -20   # 状态
tail -f logs/server.log                                    # 日志
node scripts/setup-launchd.mjs --uninstall                 # 卸载
```

**代理变量必须在生成配置时就带上**，因为 launchd 不读你的 `.zshrc`：

```bash
HTTPS_PROXY=http://127.0.0.1:7890 node scripts/setup-launchd.mjs --install
```

脚本会把当前 shell 里的代理变量固化进 plist，并在你没带时给出警告。
没有代理的话 OKX 衍生品数据会拿不到（币安镜像与美联储数据不需要代理）。

**API Key 不进 plist**。Next 会自行读取 `.env.local`，密钥留在那里——
plist 是纯文本、会被 Spotlight 索引，不该放凭据。

### 一个会静默失效的坑：nvm

如果你的 node 来自 nvm，plist 里记的是带版本号的绝对路径
（`~/.nvm/versions/node/v24.15.0/bin/node`）。
**升级 node 之后这个路径就没了**，launchd 找不到二进制会每 30 秒重试一次，
不报错、不提示，表现只是"看板打不开了、告警没了"。

升级 node 后重跑一次 `node scripts/setup-launchd.mjs --install` 即可。

---

## Linux VPS：pm2

配置在 `ecosystem.config.cjs`。

```bash
npm ci && npm run build
HTTPS_PROXY=... pm2 start ecosystem.config.cjs
pm2 save && pm2 startup     # save 会把当前环境变量固化进 dump，重启后仍在
```

**必须单实例 fork 模式**（配置里已经写死）。cluster 模式或 `instances > 1`
会让每个实例各起一套告警轮询，同一条规则被求值多次、通知发多遍。
这个项目当初把求值从浏览器移到服务端就是为了消灭"两个地方同时求值"，
别在部署这一步退回去。

VPS 选址要先跑一次体检，别假设：

```bash
npm run netcheck:proxy
```

---

## 单实例锁

服务常驻之后有个很容易踩的坑：常驻服务在 3000 跑着，你又敲了 `npm run dev`。
**Next 发现端口被占用会自动改用 3001，而不是报错**——
于是两个进程对着同一份 `data/` 各跑一套轮询，通知发两遍。

所以 worker 启动时会取一把锁（`data/alerts.lock`），拿不到就不求值，
并在界面上说明是谁占着：

> 另一个进程（pid 34886）正在轮询同一份 data/，本进程不重复求值。

这不影响你开发——第二个实例的看板、图表、研判全都正常，只是不重复发告警。

锁按心跳判定，**持有者消失后会自动失效**（默认轮询间隔的 3 倍、至少 90 秒）。
`kill -9` 不给进程清理的机会，所以宁可让锁能自愈：
死锁导致"告警彻底不工作却看不出原因"，比偶尔重复一次通知更糟。

---

## 更新代码之后

```bash
git pull
npm ci
npm run build
launchctl kickstart -k gui/$(id -u)/com.crypto-radar    # macOS
# pm2 restart crypto-radar                              # VPS
```

**必须重新 build**。`next start` 跑的是 `.next/` 里的产物，
不重新构建的话代码改了也不会生效——而这件事同样没有任何提示。

---

## 确认它真的在工作

```bash
curl -s localhost:3000/api/alerts/status | python3 -m json.tool
```

`running: true`、`lastRuleCount` 与你建的规则数一致、`totalRuns` 在增长，
才算真的在监控。看板顶部的状态条也会显示同样的信息。

配了群机器人的话，发一条测试消息确认链路通：

```bash
curl -s -X POST localhost:3000/api/alerts/test
```
