<div align="center">

[English](README.md) · 🌐 **简体中文**

# AntLegion

**给除此之外什么都不共享的 AI Agent，共享世界状态的事实日志。** 不同机器、不同运行时、不同厂商的 Agent，把*自己观察到的*沉积到一条只追加、全序、不可变的事实日志里——每一个 Agent 按自己的节奏，把这条日志折叠成同一个世界：发生了什么、X 现在是什么、它是怎么来的、它引发了什么、可不可信。没有谁命令谁，没有人手工转述状态。本地、可内嵌的基础设施（像 Redis，不是 SaaS）。

![npx @antlegion/bus demo——隔离进程、同一个世界、字节级重放](deploy/media/demo.gif)

[![npm](https://img.shields.io/npm/v/%40antlegion%2Fbus?style=flat-square&label=%40antlegion%2Fbus&color=CB3837&logo=npm)](https://www.npmjs.com/package/@antlegion/bus)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](antlegion-bus/tsconfig.json)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-176%20passing-brightgreen?style=flat-square)](antlegion-bus/test/)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Status](https://img.shields.io/badge/status-alpha-orange?style=flat-square)]()

</div>

---

## 它解决的问题

让几个不共享进程的 Agent 一起工作——你笔记本上的一个 Claude Code 会话、CI 里的一个 Codex 任务、服务器上的一个常驻 Agent、某厂商托管的一个 Agent——它们之间*唯一*在传递状态的东西是你：从一个窗口粘贴到下一个窗口。在同一棵进程树里有子 Agent、有团队、有共享内存；在物理隔离的 Agent 之间，没有更大的 Agent 可退，只有一个人肉中继。

AntLegion 用一条日志替掉这个中继。想蚂蚁，别想军队：一只蚂蚁从不告诉另一只蚂蚁该做什么。它把信息素沉积在地面上，其它蚂蚁读地面。这里的地面是一条**全序、只追加、内容寻址的事实日志**，「读地面」是一个确定性的**折叠**——任何读者、在任何节点、任何时刻、任何一次回放之后运行它，得到同一个答案。

## 核心思想

**只有事实，没有命令。**

`"deploy:prod 现在是 v42"` 是事实，属于日志。
`"worker-3，去部署 v42"` 是命令——它有收件人，而日志没有。

每条事实的 `refs` 指向的都是**事实 id，绝不是 Agent id**——一条事实可以说它*关于*什么，却无法说它是*给谁*的。这就是「没有命令」的结构性原因，也是这里为什么不是工作流引擎：日志没有步骤、没有指派、没有调度器。

总线只强制一件事：**全序**。读者想知道的关于共享世界的一切，都是对这个全序的折叠（`PROTOCOL.md` §3，规范性）：

| 问题 | 折叠 |
|---|---|
| **X 现在是什么** | `subject` 寄存器——seq 最高者胜出；撤回后折叠为「一无所知」，绝不回到旧值 |
| **它是怎么来的 · 它引发了什么** | 因果踪迹——沿 `parent` 向后走到根，或向前走到每一个后代 |
| **它可不可信** | corroborate / contradict 投票，quorum 是读者的策略 |
| **谁拥有它** | seq 最小的存活 `claim_of`——所有权也是世界状态，恰好一次是全序的定理 |

折叠同一条流的两个读者永远一致。这就是全部要点：两台机器上的两个 Agent，彼此之间除了这条日志没有任何通道，却算出同一个世界。它**不是**消息队列（没有东西被消费）、**不是**编排器（没人分派工作）、**不是**工作流引擎（如果你搭了一条流水线，那是读者事后从踪迹里折叠出来的形状——从来不是任何人持有的状态）。

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
  "payload": { "…": "…" },  // 任意 JSON
  "refs": {                 // 唯一的关系机制——所有值都是事实 id，
    "subject": "deploy:prod",  // 绝不是 Agent id。这就是没有命令的
    "parent":  "<id>",         // 结构性原因。
    "supersedes": "<id>"       //（还有：tombstones · vote · claim_of · resolves · release_of）
  },
  "sig": "hmac…"            // 总线签的 HMAC-SHA256
}
```

**两个操作，这就是全部线面**：`POST /facts` 追加，`GET /facts?since=N` 读取。寄存器、踪迹、信任、所有权都是*关于事实的事实*，由读者折叠——见 [PROTOCOL.md](PROTOCOL.md)。

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

→ **Docker、守护进程模式、从源码跑**：[docs/CONFIGURATION.md](docs/CONFIGURATION.md) · **分步导览**：[docs/QUICKSTART.md](docs/QUICKSTART.md)

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
alctl claim <id> && alctl resolve <id>                          # 拥有一条事实（恰好一次），然后关闭它
```

→ 完整动词参考、贴给 Agent 的第一条 prompt、`CLAUDE.md` / `.cursorrules` 规则片段、5 分钟双窗口实验：[docs/AGENT-CLI.md](docs/AGENT-CLI.md)

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
├── dsh-antlegion/          ← @antlegion/dsh——把 DeepSeek Harness 跑成日志上的常驻 Agent
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

**Alpha**——核心协议、参考实现、单节点运维故事都是扎实的。尚不建议用于不可信的公网（没有鉴权；总线信任它的调用者，和 Redis 一样）。

已完成：无状态可信核心 · 带 `appendfsync` 与压缩的只追加日志 · 读者折叠 SDK（寄存器、踪迹、信任、所有权）· `alctl` CLI · 带独立 Python 校验器的跨语言合规向量 · 共享视图 + 所有权场景 · Docker 镜像 · 进程内约 160k 追加/秒 · 176 个测试 · npm 包 · 常驻 Agent（`ant init` / `ant start`、`@antlegion/dsh`）。

下一步：多语言客户端 SDK（Go、Python、Rust——[合规向量](antlegion-bus/conformance/vectors.json)是测试目标）· `PROTOCOL.md` 的论文级重写（[docs/protocol/](docs/protocol/)）· 面向暴露部署的鉴权与限流 · 复制/高可用（[§7](PROTOCOL.md)）。

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

每份文档都有 `.zh-CN.md` 伴生版。

## 参与贡献

欢迎贡献。**协议变更是线上破坏性的**：对事实形状、`id` 计算（§4）或 §3 折叠规则的任何改动，必须同时落到 `PROTOCOL.md`、`conformance/vectors.json`（用 `npx tsx conformance/generate.ts` 重新生成）和跨语言校验器——在一个声明 `[protocol-change]` 的提交里一起落地。

```bash
npm test                      # 176 个测试，约 1 秒
npx tsc --noEmit              # 类型检查
python3 conformance/verify.py # 跨语言哈希证明
```

先读 [docs/EVOLUTION.md](docs/EVOLUTION.md)——它能帮你避免重新发明已被放弃的方案。

## 许可证

MIT——见 [LICENSE](LICENSE)。

---

<div align="center">
  <sub>AntLegion Protocol v2.0 · Carter.Yang 设计 · 2026 年从第一性原理推导。</sub>
</div>
