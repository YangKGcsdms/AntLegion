<div align="center">

[English](README.md) · 🌐 **简体中文**

# AntLegion

**让几个 AI Agent 在同一个项目上干活，它们会重复彼此的工作、丢失彼此的上下文、各自漂移。** AntLegion 在事实层面解决这件事：一条只追加的**事实总线**，自治工作单元在上面发布发生了什么、以恰好一次认领工作，让工作流自行涌现——没有编排器，没有谁命令谁。本地、可内嵌的基础设施（像 Redis，不是 SaaS）。

![npx @antlegion/bus demo——恰好一次竞速、崩溃接管、字节级重放](deploy/media/demo.gif)

[![npm](https://img.shields.io/npm/v/%40antlegion%2Fbus?style=flat-square&label=%40antlegion%2Fbus&color=CB3837&logo=npm)](https://www.npmjs.com/package/@antlegion/bus)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](antlegion-bus/tsconfig.json)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-147%20passing-brightgreen?style=flat-square)](antlegion-bus/test/)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Status](https://img.shields.io/badge/status-alpha-orange?style=flat-square)]()

</div>

---

## 核心思想

**只有事实，没有命令。**

`「第 7 项需要处理」`是事实，属于总线。
`「worker-3，去处理第 7 项」`是命令——这里没有它的位置。

没有 Agent 会寻址另一个 Agent。Agent 发布对世界的观察，按自己的节奏读取共享日志，然后反应。谁做什么、以什么顺序、以多大把握——全都从事实流的结构中涌现。

总线只强制一件事：**全序**。由全序出发，恰好一次分配是一条数学定理：**序号最小的认领获胜**，每个读者从同一条不可变流中算出同一个赢家。不需要锁，不需要租约，不需要协调者。

这一个选择，正好治了多 Agent 共事时必犯的三种病：

- **重复劳动**——领活这个动作**本身就是一条事实**（`_.claim`），两个 Agent 不可能都认为自己拥有它。实测：**100 个认领单元、4 倍副本 worker 竞争下，0 次双执行**。
- **上下文丢失**——每条观察都是不可变、内容寻址的事实，任何单元都能按自己的节奏折叠，而不是永远传不到 B 的散文。
- **靠散文维系的工作流**——流水线是因果结构（`refs.parent`），证据形状由裁决者强制；伪造的「全绿」报告被 **8/8 拦截，0 误杀**。

它**不是**消息队列（没有东西被消费）、**不是**编排器（没有谁分派工作）、**不是**工作流引擎（流水线是从流里折叠出来的，从不被存储）。它也不锁文件、不串行化你的 Agent——冲突在分工层就被消除了，两个单元根本不会碰到同一个任务。

## 事实

唯一的本原：不可变、内容寻址、位于单一全序中的唯一位置：

```jsonc
{
  "seq":    1337,           // 总线分配的全序位置（可信）
  "recv":   1748300000.4,   // 总线盖的可信接收时间——折叠用它，不用 ts
  "id":     "b3f1…",        // sha256(canonical(record))——内容地址
  "type":   "build.failed", // 点号命名法；保留类型以 "_." 开头
  "author": "claude-code",  // 谁追加的
  "ts":     1748300000.0,   // 作者自报时间（仅供参考——可伪造，绝不用它折叠）
  "payload": { "…": "…" },  // 任意 JSON
  "refs": {                 // 唯一的关系机制——所有值都是事实 id，
    "parent":   "<id>",     // 绝不是 agent id。这就是「没有命令」
    "claim_of": "<id>",     // 的结构性原因。
    "resolves": "<id>"      // （另有：release_of · vote · supersedes · subject · tombstones）
  },
  "sig": "hmac…"            // 由总线签发的 HMAC-SHA256
}
```

**两个操作，这就是全部线面**：`POST /facts` 追加，`GET /facts?since=N` 读取。认领、解决、信任、取代、因果都是*关于事实的事实*，由读者折叠——见 [PROTOCOL.zh-CN.md](PROTOCOL.zh-CN.md)（§3 折叠规则为规范性）。

## 快速上手

**需要 Node.js ≥ 20。** 最快的一瞥——三幕演示（恰好一次竞速 → 崩溃接管 → 字节级重放），零配置、零 API key、约 15 秒：

```bash
npx @antlegion/bus demo
```

真正的路径是两个包、四条命令：起一条总线，在上面放一队工作单元，喂给它一个任务，看它自己跑。

```bash
npx @antlegion/bus                              # 1. :28090 上的事实总线
npx @antlegion/ant chain                        # 2. dev-chain 舰队（6 个工作单元）
npx @antlegion/ant req new "试点" -s pilot       # 3. 喂一条需求进去
npx @antlegion/ant board                        # 4. → http://localhost:28091/devchain.html
```

约 2 秒内 `dcu-plan` 认领这条需求（恰好一次，最小 seq 胜出），产出 `plan.ready`，裁决者检查它的证据形状，链条停在人工闸门——在看板上批准，dev → unittest → e2e 就会自己跑到 ✔ CHAIN DONE。没有编排器，没有单元寻址另一个单元。

→ **Docker、守护进程、从源码运行**：[docs/CONFIGURATION.zh-CN.md](docs/CONFIGURATION.zh-CN.md) · **逐步导览**：[docs/QUICKSTART.zh-CN.md](docs/QUICKSTART.zh-CN.md)

## 从代码里用

折叠 SDK 替你吸收了「追加 → 读回 → 折叠」这套活（`npm i @antlegion/bus`）：

```typescript
import { ClientV2, httpTransport } from "@antlegion/bus/client";

const alice = new ClientV2(httpTransport("http://localhost:28090"), "alice");
const bob   = new ClientV2(httpTransport("http://localhost:28090"), "bob");

const { id } = await alice.publish("task.build", { target: "todo-app" });

// 两者同时抢认领；最小 seq 胜出——确定性，无锁
const [ra, rb] = await Promise.all([alice.claim(id), bob.claim(id)]);
const winner = ra.won ? alice : bob;

// 赢家解决，可顺带产出子事实（因果链）
await winner.resolve(id, [{ type: "build.done", payload: { ok: true } }]);

console.log(await alice.state(id)); // { state: "resolved", owner: "alice" }
console.log(await bob.state(id));   // 完全相同——同一条流，同一个折叠
```

→ 同行评审的信任折叠、因果链、取代、进程内嵌入路径：[docs/QUICKSTART.zh-CN.md](docs/QUICKSTART.zh-CN.md)

## 接上你已经在用的 Agent

任何能执行 shell 命令的 Agent——Claude Code、Cursor、Codex CLI、一个 cron job——都可以通过 **`alctl` CLI**（`redis-cli` 的对应物）加入同一条总线。每条命令都输出机器可读的 JSON；认领失败会以非零码退出。

```bash
export ANTLEGION_AUTHOR=my-agent          # 稳定身份；一个身份 = 一个进程

alctl read --type 'task.*' --since "$CURSOR"   # 读新事实
alctl claim <id> && alctl resolve <id>         # 恰好一次认领，然后解决
alctl publish task.done '{"result":"ok"}' --parent <id>
```

→ 完整动词参考、可直接粘给 Agent 的第一条 prompt、给 `CLAUDE.md` / `.cursorrules` 的规则片段，以及 5 分钟的双窗口实验：[docs/AGENT-CLI.zh-CN.md](docs/AGENT-CLI.zh-CN.md)

## 这东西真的成立吗？

四个可直接运行的 swarm，各自拉起一个真实服务端、生成约 20 个自治 Agent，并断言一条可测量的通过门槛——恰好一次扇出（`dupes=0 missing=0`）、崩溃 + 认领超时重派、只在共识下决策、带取代的因果流水线。另有一个约 13 秒的演示：8 个进程争抢 400 个任务，其中一个在干活途中被 `SIGKILL`，最后连总线本身也被重启，从日志恢复后字节级一致。

```bash
npx tsx examples/demo-killer.ts     # 三幕版本
```

→ 完整表格、竞争下的实测数字，以及设计取舍的来龙去脉：[docs/ARCHITECTURE.zh-CN.md](docs/ARCHITECTURE.zh-CN.md)

## 项目结构

三个已发布的包，外加文档、演示和一个落地页。**顶层每一项都在这张图里**——没出现在图上的东西，就不该待在仓库里。

```
AntLegion/
├── PROTOCOL.md             ← 线协议规范——§3 折叠规则为规范性
├── CLAUDE.md               ← 给在本仓库工作的编码 agent 的指引
├── Dockerfile              ← 构建总线镜像；build context 是仓库根
│
│   ── 已发布到 npm 的包 ──
├── antlegion-bus/          ← @antlegion/bus——总线、折叠 SDK、alctl CLI
├── ant/                    ← @antlegion/ant——工作单元运行时、dev-chain 舰队、看板
├── antlegion-alias/        ← antlegion——20 行别名，让 `npx antlegion` 起总线
│
│   ── 其余 ──
├── docs/                   ← QUICKSTART · AGENT-CLI · ARCHITECTURE · CONFIGURATION ·
│                             FACT-MODEL · EVOLUTION · DOCKER-VERIFY · proposals/
├── research/               ← 上文各项数字的第一方实测记录
├── deploy/                 ← mvp/（docker-compose 舰队跑分）· media/ · 验证脚本
├── toys/                   ← 可直接跑的小用例：hr-colony、pi-duo、pi-agent
├── site/                   ← antlegion.dev 落地页（静态）
└── dcu-workspace/          ← `ant` 默认监视的运行时工作区（仅存本地）
```

有两样东西**故意**不在树里：`.data-v2/`（总线日志）和 `.ant/`（蚁群的 pid、日志与工作记忆）。两者都是运行时状态，已在任意层级被 gitignore。

## 当前状态

**Alpha** —— 核心协议、参考实现和单机运维故事都已扎实。尚不建议暴露在不受信任的公网上（还没有鉴权；总线信任它的调用方，与 Redis 相同）。

已完成：无状态可信内核 · 带 `appendfsync` 与压缩的只追加日志 · 读者折叠 SDK · `alctl` CLI · 带独立 Python 校验器的跨语言一致性向量 · 四个验证 swarm · Docker 镜像 · 进程内约 16 万次追加/秒 · 147 个测试 · npm 包 · LLM 驱动的工作单元 · 常驻蚁群（`ant init` / `ant start`）。

下一步：多语言客户端 SDK（Go、Python、Rust——[一致性向量](antlegion-bus/conformance/vectors.json)就是测试靶子）· 以 [S2 实验](research/s2-experiments-2026-08.md)为种子的协作基准测试 · 面向暴露部署的鉴权与限流 · 复制/高可用（[§7](PROTOCOL.zh-CN.md)）。

## 文档

| | |
|---|---|
| [PROTOCOL.zh-CN.md](PROTOCOL.zh-CN.md) | 线协议——权威；§3 折叠规则为规范性 |
| [docs/QUICKSTART.zh-CN.md](docs/QUICKSTART.zh-CN.md) | 逐步指南：线面、CLI、SDK、持久化与恢复 |
| [docs/AGENT-CLI.zh-CN.md](docs/AGENT-CLI.zh-CN.md) | 从已有 Agent 驱动总线，以及怎么让它真的用起来 |
| [docs/ARCHITECTURE.zh-CN.md](docs/ARCHITECTURE.zh-CN.md) | 各部分如何拼合、什么已被证明、为何长成这样 |
| [docs/CONFIGURATION.zh-CN.md](docs/CONFIGURATION.zh-CN.md) | 环境变量、几种跑法、运维速查、排障 |
| [docs/FACT-MODEL.zh-CN.md](docs/FACT-MODEL.zh-CN.md) | 兴趣声明、孤儿事实与上下文充分性闭环 |
| [docs/EVOLUTION.zh-CN.md](docs/EVOLUTION.zh-CN.md) | v0 → v1 → v2：试过什么、为何改变 |
| [ant/README.md](ant/README.md) | 工作单元模型、dev-chain、证据裁决、看板 |

每份文档都有 `.zh-CN.md` 中文版。

## 参与贡献

欢迎贡献。**协议变更会破坏线格式**：任何对事实形状、`id` 计算（§4）或 §3 折叠规则的改动，必须同时落到 `PROTOCOL.md`、`conformance/vectors.json`（用 `npx tsx conformance/generate.ts` 重新生成）和跨语言校验器——放在同一个提交里，并声明 `[protocol-change]`。

```bash
npm test                      # 147 个测试，约 1 秒
npx tsc --noEmit              # 类型检查
python3 conformance/verify.py # 跨语言哈希证明
```

先读 [docs/EVOLUTION.zh-CN.md](docs/EVOLUTION.zh-CN.md)——它能让你少走一遍已经被否掉的路。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。

---

<div align="center">
  <sub>AntLegion Protocol v2.0 · 由 Carter.Yang 设计 · 从第一性原理推导，2026。</sub>
</div>
