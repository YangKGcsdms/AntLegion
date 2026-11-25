<div align="center">

[English](README.md) · 🌐 **简体中文**

# AntLegion

**AntLegion 是为智能体共享世界状态的事实日志。** 跨机器、跨运行时、跨厂商的智能体各自把观察写进同一条全序、只追加的日志，各自根据日志计算发生了什么、现在是什么、因何而起、可信与否。日志位置、规则、参数和计算时间相同，结果才相同。总线不派发命令。本地部署，可内嵌，像 Redis，不是 SaaS。

![npx @antlegion/bus demo——隔离进程、同一个世界、字节级重放](deploy/media/demo.gif)

[![npm](https://img.shields.io/npm/v/%40antlegion%2Fbus?style=flat-square&label=%40antlegion%2Fbus&color=CB3837&logo=npm)](https://www.npmjs.com/package/@antlegion/bus)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](antlegion-bus/tsconfig.json)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-regression%20suite-brightgreen?style=flat-square)](antlegion-bus/test/)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Status](https://img.shields.io/badge/status-alpha-orange?style=flat-square)]()

</div>

---

## 它解决什么

几个互不共享进程的智能体——本机的 Claude Code、CI 里的 Codex、服务器上的常驻 Agent、厂商托管的 Agent——之间唯一的状态通道是人：从一个窗口复制到另一个窗口。同一进程树内有子 Agent、有共享内存；物理隔离的智能体之间没有，只有人肉中继。

AntLegion 提供一条**全序、只追加、内容寻址的事实日志**。每个读者按规则从日志计算状态，下文称为「折叠」。以相同规则和输入重放相同记录，结果才相同；读取进度或参数不同的读者可以得到不同答案。

## 核心思想

**只有事实，没有命令。**

"deploy:prod 现在是 v42"是事实，上日志。
"worker-3 去部署 v42"是指令文本；把它写入日志，不会让总线派发或执行它。

`refs.subject` 是主题名，其余已定义的关系键引用**事实 id**。未知扩展键和符合输入规则的 JSON 内容可以保存。「没有命令」指总线不按接收者寻址派发，也不强制执行，不是说 JSON 无法包含指令。工作流步骤与调度由客户端负责。

总线负责分配**全序**、校验内容并保存日志。关于这个世界你想知道的一切，都是对全序的折叠（`PROTOCOL.md` §3，规范性）：

| 问题 | 折叠 |
|---|---|
| **X 现在是什么** | `subject` 寄存器——seq 最高者胜出；撤回后折叠为「一无所知」，绝不回到旧值 |
| **它是怎么来的 · 它引发了什么** | 因果踪迹——沿 `parent` 向后走到根，或向前走到每一个后代 |
| **它可不可信** | corroborate / contradict 投票，quorum 是读者的策略 |
| **谁拥有它** | seq 最小的存活 `claim_of`——共享认领归属，不保证外部动作恰好执行一次 |

日志位置、规则、参数和计算时间相同，读者结果才相同。信任阈值可以由各读者选择，末尾认领的超时也取决于计算时间。总线提供共享日志，工作流决策由客户端负责。

## 事实

一个本原，不可变、内容寻址、位于单一全序中的唯一位置：

```jsonc
{
  "seq":    1337,           // 总线分配的全序位置（可信）
  "recv":   1748300000.4,   // 总线盖章的可信接收时间——折叠用它，不用 ts
  "id":     "b3f1…",        // sha256(canonical(record))——内容地址
  "type":   "deploy.status",// 点分类型；保留类型以 "_." 开头
  "author": "ci@build-7",   // 谁追加的
  "ts":     1748300000.0,   // 作者自报的时间（仅供参考——可伪造，永远别拿它折叠）
  "payload": { "…": "…" },  // 普通 JSON 对象
  "refs": {                 // 主题名与事实关系
    "subject": "deploy:prod",  // 主题名，不是事实 id
    "parent":  "<id>",         // 事实 id
    "supersedes": "<id>"       //（还有：tombstones · vote · claim_of · resolves · release_of）
  },
  "sig": "hmac…"            // 总线签的 HMAC-SHA256
}
```

**两个操作，这就是全部线面**：`POST /facts` 追加，`GET /facts?since=N` 读取。寄存器、踪迹、信任、所有权都是*关于事实的事实*，由读者折叠——见 [PROTOCOL.md](PROTOCOL.md)。

输入先规范化并复制，再用于哈希和存储。官方 Node 编码是当前基准；已提交向量是回归样例，不代表完整跨语言契约。重试追加必须复用原始输入，包括 `ts` 和 `nonce`；再次调用生成新输入的辅助方法，可能新增事实。见 [PROTOCOL.md §4](PROTOCOL.md#4-identity--integrity)。

使用 Docker 自托管控制台、访问令牌及独立家庭演示，参见[家庭部署说明](deploy/home/README.zh-CN.md)。

## 快速上手

**需要 Node.js ≥ 20。** 最快看一眼，零配置、零 API key、约 15 秒：

```bash
npx @antlegion/bus demo
```

真正的路径是一条总线加一个 shell。启动一次总线，然后让任何 Agent——这台机器上的或另一台上的——沉积与读取：

```bash
npx @antlegion/bus                                                # 1. 一条事实日志在 :28090（HOST=0.0.0.0 即可跨机共享）

# 机器 A
alctl publish deploy.status '{"v":42}' --subject deploy:prod      # 2. 沉积你观察到的

# 机器 B——另一个 Agent、另一种运行时，除了日志没有任何通道
alctl current deploy:prod                                         # 3. prod 现在是什么？→ 那条 v42 事实
alctl causation <id>                                              #    它是怎么来的？
alctl descendants <id>                                            #    它引发了什么？
```

杀掉总线，从日志重启，在任何地方再跑一遍第 3 步：同样的事实、同样的答案，逐字节一致。

想让它一直跑着，就按跑 Redis 的方式跑：一个容器、一个卷、一把稳定的密钥：

```bash
docker run -d --name antlegion -p 28090:28090 \
  -v antlegion-data:/data -e ANTLEGION_BUS_SECRET=change-me \
  ghcr.io/yangkgcsdms/antlegion          # 多架构镜像；:latest 跟着最新的 bus-v* tag 走
```

镜像在容器内绑 `0.0.0.0`——信任边界是 docker 网络，所以端口只发布到你信得过的地方。卷就是全部的持久化：里面只有一条只追加的日志，重启后的容器因此折叠出同一个世界，而不是一个新的。`ANTLEGION_BUS_SECRET` 要给一个固定值并留着：不设的话总线每次启动都新铸一把 HMAC 密钥，重启前写下的签名从此验不过（会在 `/info` 里显示成 `sig_failures`）。想自己构建，在仓库根目录：`docker build -t antlegion .`

→ **守护进程模式、从源码跑、完整环境变量表**：[docs/CONFIGURATION.md](docs/CONFIGURATION.md) · **分步导览**：[docs/QUICKSTART.md](docs/QUICKSTART.md)

## 从代码里用

折叠 SDK 吸收了「追加—读回—折叠」的工作（`npm i @antlegion/bus`）：

```typescript
import { ClientV2, httpTransport } from "@antlegion/bus/client";

// 两个除了总线地址什么都不共享的 Agent
const sensor  = new ClientV2(httpTransport("http://10.0.0.7:28090"), "sensor@node-a");
const watcher = new ClientV2(httpTransport("http://10.0.0.7:28090"), "watcher@node-b");

// A 沉积它看到的，然后修订——一个用普通字符串命名的寄存器
const r1 = await sensor.publish("deploy.status", { v: 41 }, { refs: { subject: "deploy:prod" } });
const r2 = await sensor.supersede(r1.id, "deploy.status", { v: 42 });
await sensor.publish("alarm.raised", { why: "p99 up" }, { refs: { parent: r2.id } });

// B 稍后在另一台机器上，折叠出同一个世界
await watcher.currentOf("deploy:prod");     // → 那条 v42 事实（r1 折叠为 superseded）
await watcher.historyOf("deploy:prod");     // → [r1, r2]——关于 prod 曾说过的一切
await watcher.descendants(r2.id);           // → [alarm.raised]——v42 引发了什么

// 所有权也是世界状态：两个 Agent 都想拥有某件事，
// seq 最小者胜出，两边从同一条流算出同一个赢家
const { id } = await sensor.publish("incident.open", { sev: 1 });
const [a, b] = await Promise.all([sensor.claim(id), watcher.claim(id)]);
console.log(a.won !== b.won, await watcher.state(id)); // true, { state: "claimed", owner: … }
```

→ 信任折叠、因果、撤回、以及进程内嵌入：[docs/QUICKSTART.md](docs/QUICKSTART.md)

## 接上你已经在用的 Agent

任何能跑 shell 命令的 Agent——Claude Code、Cursor、Codex CLI、一个 cron 任务、另一台机器上的常驻守护进程——都通过 **`alctl` CLI**（`redis-cli` 的对应物）接入同一条日志。每条命令输出机器可读的 JSON。

```bash
export ANTLEGION_AUTHOR=my-agent@my-host      # 稳定身份；一个身份 = 一个进程

alctl publish obs.metric '{"cpu":91}' --subject host:web-3     # 写下发生了什么
alctl current host:web-3                                       # 读世界
alctl read --type 'deploy.*' --since "$CURSOR"                  # 或从游标处 tail
alctl claim <id> && alctl resolve <id>                          # 确认认领归属，再记录处理结束
```

→ 完整动词参考、贴给 Agent 的第一条 prompt、`CLAUDE.md` / `.cursorrules` 规则片段、5 分钟双窗口实验：[docs/AGENT-CLI.md](docs/AGENT-CLI.md)

## 把 Agent 托管成常驻单元（DCU 模式）

上面讲的都是有人在驱动的 Agent。另一种姿态是**常驻**：没人驱动它，日志驱动它。它平时闲着，直到一条它声明关注的事实落到日志上——开始处理、认领、执行、把产出关联到原事实。单靠认领归属，无法防止故障或超时后的外部动作重复执行。没有队列，没有调度器，没有人在提示符前面等着。

`@antlegion/dsh` 是为 **DeepSeek Harness** 提供的 AntLegion 插件：运行它，这个 dsh 就作为一个挂载到总线的 DCU 运作——值守在那里，自动响应总线上的事实，并把做完的事作为事实发布回去。感知仍然是纯 Node 代码——轮询、推游标、折叠、筛选——只有「这条事实该怎么办」才花掉一次 LLM 轮次。

### 装插件

先探通节点。地址是这个插件唯一猜不出来的东西，而且填错了会被分类告诉你（`refused` / `dns` / `timeout` / `not-a-bus`），不会挂在那里转圈：

```bash
npx -p @antlegion/dsh antlegion-dcu-check http://10.0.0.7:28090 --roster   # 这是一条总线吗？上面已经有谁？
```

`dsh plugin` 会把参数转发给 profile 目录里的 pnpm，所以装它就一行：

```bash
dsh plugin --profile dcu add @antlegion/dsh
# 从本仓库装：  dsh plugin --profile dcu add link:/path/to/AntLegion/dsh-antlegion
# 直接从 git 装：dsh plugin --profile dcu add "github:YangKGcsdms/AntLegion#path:/dsh-antlegion"
```

然后把这个 bundle 列进 profile，再给它一个地址和它关注的事实类型：

```jsonc
// ~/.dsh/profiles/dcu/package.json —— 一个 dcu profile 就是 dsh-base 加这一个 bundle，没别的
{ "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@antlegion/dsh"] } } }
```

```yaml
# ~/.dsh/profiles/dcu/cordis.patch.yml —— patch 是整块替换 config，不是合并，
# 所以你关心的键要写全；没写的走插件的 schema 默认值
- id: antlegion-dcu
  config:
    busUrl: http://10.0.0.7:28090
    author: dsh-dcu             # 它在群落里的身份——一个身份一个进程
    resident: true              # false 只挂工具，不跑巡检
    interests: ["task.*"]       # 唤醒它的事实类型——空的话它永远不会醒
    publishes: ["task.done"]    # 它向名册声明自己会产出什么
```

`dsh --profile dcu` 启动；`dsh --profile dcu --dump-config` 只看合成结果、不启动。

### 后台托管

它就是一个普通的长期进程——交给你已经在用的进程守护即可。一份 systemd user unit：

```ini
# ~/.config/systemd/user/antlegion-dcu.service
[Unit]
Description=AntLegion resident DCU (DeepSeek Harness)
After=network-online.target

[Service]
ExecStart=/usr/bin/env dsh --profile dcu    # unit 的 PATH 里没有 dsh（nvm、asdf……）就写绝对路径
Environment=DEEPSEEK_API_KEY=…              # 模型凭证也可以放在 ~/.dsh/settings.yaml 里
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now antlegion-dcu
journalctl --user -u antlegion-dcu -f   # 启动四行：bus OK · session up · patrol starting · registered
```

自动重启可以恢复认领归属，但客户端仍需处理外部动作重复执行。持有认领的常驻单元崩溃后，每条认领在总线盖章的 `recv` 之后 Δ 失效，同伴接着做，而且不会撤销一次真的完成了的 `resolve`。注册使用 `refs.subject` 分组中的有效期记录，新声明在读者视图中取代旧声明；两条记录仍然保留在日志中。总线还没起就先起它也没问题：它会退避重连，等节点出现自己接上并重新报到。唯一要当心的和日志上每个 Agent 一样：**一个身份一个进程**——同一个 `author` 起两份就是双启动，这件事由折叠检测出来（`sys.identity.conflict`），而不是由总线禁止。

同样的姿态、换成自带运行时而不是挂在 harness 上，就是 `@antlegion/ant`：`ant start --daemon` 把群落转到后台（pid、日志、工作记忆都在 `./.ant/`），`ant launchd` 打印一份 macOS 开机自启的 plist。

### 在板上确认它活着

```bash
alctl colony
# [{"author":"dsh-dcu","interests":["task.*"],"publishes":["task.done"]}]
```

沉积一条它说过自己关心的事实，然后看它在没人盯着的情况下把闭环走完：

```bash
alctl publish task.todo '{"title":"用一句话说明这次 p99 尖刺"}'   # → {"id":"3729ce03…","seq":14}
alctl state 3729ce03…         # → {"state":"resolved","owner":"dsh-dcu"}
alctl descendants 3729ce03…   # → 它挂在原事实底下的那条 task.answer
```

```
日志上的样子（节选）——全程没有人在提示符前面
#14  task.todo    @carter                         另一个节点沉积下来的事实
#15  _.claim      @dsh-dcu   claim_of: 3729ce03…  它折叠到了，先把所有权占下
#17  _.resolve    @dsh-dcu   resolves: 3729ce03…  处理完毕
#18  task.answer  @dsh-dcu   parent:   3729ce03…  产出挂成因果链——踪迹留在日志上
```

`task.*` 只是个例子，认领也不是必须的：一个只观察、只沉积的常驻单元同样是合格的蚂蚁。

→ 配置键、工具与巡检的分工、以及「liveness 是 TTL 槽位而不是心跳流」：[dsh-antlegion/README.md](dsh-antlegion/README.md) · 从选地址到验证闭环走一遍的中文接入指引：[dsh-antlegion/GUIDE.zh-CN.md](dsh-antlegion/GUIDE.zh-CN.md)

## 这东西真的成立吗？

可运行的场景会启动真实服务器、拉起彼此独立的 Agent、断言一个可度量的通过门槛：

- **共享视图**——6 个传感器节点沉积并修订读数，其中一个中途被杀；8 个冷读者在随机时刻醒来，各自把整个世界（每个 subject 的当前值、历史、踪迹、后代）折叠成一个 sha256。同一 head ⇒ 每个读者同一哈希；杀掉并回放总线 ⇒ 同一哈希；被撤回的寄存器处处折叠为「一无所知」；**流中零个 claim**——这个场景什么都不协调，只共享一个世界。
- **争用下的所有权**——来自 4 个「框架」的 8 个进程争抢 400 条事实，`dupes=0`；一个进程持有认领时被 `SIGKILL`，其所有权确定性地过期；总线从日志重启，逐字节一致地回来。
- 另有 16 个 worker 的扇出/扇入、崩溃重派、共识门控决策、带取代的因果流水线。

```bash
npx tsx examples/scenario-shared-view.ts    # 隔离节点 · 一个世界 · 零 claim
npx tsx examples/demo-killer.ts             # 三幕所有权 demo
```

→ 完整表格、争用下的数字、设计理由：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## 项目结构

三个已发布的包，加上文档、demo 和一个落地页。每个顶层条目都列在这里——不在这张图里的，就不该在仓库里。

```
AntLegion/
├── PROTOCOL.md             ← 线协议规范——§3 折叠规则是规范性的
├── CLAUDE.md               ← 给在本仓库工作的编码 Agent 的定向说明
├── Dockerfile              ← 构建总线镜像；构建上下文是仓库根
│
│   ── 包（已发布到 npm）──
├── antlegion-bus/          ← @antlegion/bus——日志、折叠 SDK、alctl CLI
├── ant/                    ← @antlegion/ant——住在日志上的常驻 Agent（镜像 → 折叠 → 行动）；
│                             附带一条 dev-chain 作为*工作流客户端示例*，不是产品本身
├── antlegion-alias/        ← antlegion——20 行别名，让 `npx antlegion` 启动总线
├── dsh-antlegion/          ← @antlegion/dsh——DSH 的 AntLegion 插件：挂到总线上值守
│
│   ── 其它 ──
├── docs/                   ← QUICKSTART · AGENT-CLI · ARCHITECTURE · CONFIGURATION ·
│                             FACT-MODEL · EVOLUTION · DOCKER-VERIFY · protocol/ · proposals/
├── research/               ← 上文数字引用的第一手测量
├── deploy/                 ← mvp/（docker-compose 运行）· media/ · 校验脚本
├── toys/                   ← 小型可运行用例：hr-colony、pi-duo、pi-agent
├── site/                   ← antlegion.dev 落地页（静态）
└── dcu-workspace/          ← `ant` 默认监视的运行时工作区（仅本地）
```

有两样东西故意**不在**树里：`.data-v2/`（日志本体）和 `.ant/`（常驻 Agent 的 pid、日志、工作记忆）。两者都是运行时状态，在任意层级被 gitignore。

## 当前状态

**Alpha**——官方 Node 实现是当前协议编码基准。已有共享 Bearer 令牌鉴权，但不验证各作者身份，总线仍然信任调用者。当前范围不包含不可信公网部署。

已完成：无状态可信核心 · 带 `appendfsync` 的完整只追加日志 · 读者折叠 SDK（寄存器、踪迹、信任、所有权）· `alctl` CLI · 已提交哈希回归样例及校验这些样例的 Python 脚本 · 共享视图 + 所有权场景 · Docker 镜像 · 吞吐测试 · 自动化测试 · npm 包 · 常驻 Agent（`ant init` / `ant start`、`@antlegion/dsh`）。

当前版本保留完整记录：`compact()`、`rewrite()` 仅保留兼容入口，不执行操作并返回 `0`，也无法恢复旧版本已删除的 payload。完成表示处理结束，撤回表示不再把原陈述当作当前值，取代表示出现新版本。先完成再撤回，生命周期仍为 `resolved`；如果该事实仍是主题的当前陈述，当前值返回 `null`。

`ClientV2.resolve()` 要求调用者持有有效且胜出的认领，先保存产出，再通过 `payload.output_ids` 关联产出并写入完成记录，最后读回确认。多次写入不是事务。底层折叠仍允许在没有存活认领时由任意作者完成，详见 [§3.1](PROTOCOL.md#31-lifecycle-of-a-target-fact-f)。

后续方向：完整的跨语言编码规则及 SDK、面向暴露部署的作者身份校验与限流、复制与高可用。现有回归样例本身不构成跨语言兼容保证。

## 文档

| | |
|---|---|
| [PROTOCOL.md](PROTOCOL.md) | 线协议——权威；§3 折叠规则是规范性的 |
| [docs/QUICKSTART.md](docs/QUICKSTART.md) | 分步：线面、CLI、SDK、持久化与恢复 |
| [docs/AGENT-CLI.md](docs/AGENT-CLI.md) | 从已有 Agent 驱动日志，以及如何让它采用 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 各部分如何拼合、什么被证明了、为什么长这样 |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | 环境变量、运行方式、运维速查、排障 |
| [docs/FACT-MODEL.md](docs/FACT-MODEL.md) | 板上有谁、孤儿事实、上下文充分性闭环 |
| [docs/EVOLUTION.md](docs/EVOLUTION.md) | v0 → v1 → v2：试过什么、为什么变 |
| [ant/README.md](ant/README.md) | 日志上的常驻 Agent；dev-chain 作为工作流客户端示例 |
| [dsh-antlegion/README.md](dsh-antlegion/README.md) | dsh 插件：挂到总线上值守什么、怎么装、配置键（[中文](dsh-antlegion/README.zh-CN.md)） |

每份文档都有 `.zh-CN.md` 伴生版。

## 参与贡献

欢迎贡献。修改事实形状、`id` 计算（§4）或 §3 折叠规则时，须明确评估兼容性，并同步文档与测试。除非有意修改编码，否则保留已提交哈希向量；向量变更要求提交信息声明 `[protocol-change]`。Python 脚本只校验已有样例，不证明完整跨语言兼容。

```bash
npm test                      # 自动化测试
npx tsc --noEmit              # 类型检查
python3 conformance/verify.py # 独立校验已提交回归样例
```

先读 [docs/EVOLUTION.md](docs/EVOLUTION.md)——它能帮你避免重新发明已被放弃的方案。

## 许可证

MIT——见 [LICENSE](LICENSE)。

---

<div align="center">
  <sub>AntLegion Protocol v2.0 · Carter.Yang 设计 · 2026 年从第一性原理推导。</sub>
</div>
