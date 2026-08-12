<div align="center">

[English](README.md) · 🌐 **简体中文**

# AntLegion

**面向自治 Agent 的事实总线** — 本地、可内嵌的基础设施，让多个 Agent 通过共享不可变的事实来协作，而非互相下达命令。

[![npm](https://img.shields.io/npm/v/%40antlegion%2Fbus?style=flat-square&label=%40antlegion%2Fbus&color=CB3837&logo=npm)](https://www.npmjs.com/package/@antlegion/bus)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](antlegion-bus/tsconfig.json)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A518-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/测试-147%20通过-brightgreen?style=flat-square)](antlegion-bus/test/)
[![License](https://img.shields.io/badge/许可证-MIT-blue?style=flat-square)](LICENSE)
[![Status](https://img.shields.io/badge/状态-alpha-orange?style=flat-square)]()

</div>

---

可以把它理解成**多 Agent 协调版的 Redis**：一个持久化进程，一条只追加的不可变事实日志，多个 Agent 各自读取并做出反应——协调从事实流的结构中自然涌现，无需中心化的编排者来分配指令。

## 目录

- [核心理念](#核心理念)
- [核心特性](#核心特性)
- [快速上手](#快速上手)
- [事实的结构](#事实的结构)
- [从代码接入](#从代码接入)
- [通过 MCP 接入](#通过-mcp-接入)
- [经验证的保证](#经验证的保证)
- [配置参数](#配置参数)
- [架构](#架构)
- [项目结构](#项目结构)
- [当前状态](#当前状态)
- [参与贡献](#参与贡献)
- [许可证](#许可证)

---

## 核心理念

**只有事实，没有命令。**

`"第 7 项待处理"` 是事实，可以发布到总线上。  
`"worker-3，去处理第 7 项"` 是命令——它在这里没有立足之地。

没有任何 Agent 会直接寻址另一个 Agent。Agent 向世界发布陈述，按自己的节奏读取共享日志，并做出反应。谁负责哪项工作、顺序如何、可信度多高——这一切都从事实流的结构中**自发涌现**，而非由某个调度者来安排。

总线只强制执行一件事：**全序（total order）**。从全序中，恰好一次（exactly-once）的归属权自然成为数学定理——序号最小的认领胜出，所有读者从同一不可变流中计算出完全相同的结果。

这不是口号，而是[可运行的多 Agent 压测验证过的](#经验证的保证)。

## 核心特性

| 特性 | 机制 |
|---|---|
| **不可变事实** | 以 `sha256(canonical(record))` 为内容地址——相同内容自动去重，每条事实都有稳定且不可伪造的身份 |
| **全序保证** | 总线分配严格递增的 `seq`，这是它对客户端的唯一权威 |
| **恰好一次协调** | 某条事实上序号最小的认领胜出——这是全序的定理，而非锁或特殊端点 |
| **可信时间** | 总线盖章的 `recv`（非作者声明的 `ts`）确定性地锚定所有基于时间的折叠计算，崩溃 Agent 的陈旧认领不会阻塞恢复流程 |
| **无状态总线** | 认领、解决、信任、取代、因果均为对事实流的纯折叠函数——总线不持有任何 per-fact 可变状态 |
| **持久化** | 只追加日志（`facts-v2.jsonl`），支持可配置的 `appendfsync` 策略；崩溃恢复只需重放日志，无需重建状态机 |
| **可验证** | 总线对每条事实进行 HMAC 签名；恢复时校验签名；互操作由[跨语言一致性向量集](antlegion-bus/conformance/vectors.json)保证 |

## 快速上手

**前置要求：Node.js ≥ 20**

**第一级 —— 起一条总线**（五秒钟，零配置）：

```bash
npx @antlegion/bus
# [antlegion-v2] append-only fact bus on http://localhost:28090 (fsync=everysec)

curl http://localhost:28090/health
# {"status":"ok","protocol":"2.0","head_seq":0}
```

**第二级 —— 给你的 agent 装上事实总线工具**（Claude Code、Cursor、Cline…… 任何支持 MCP 的都行）：

```bash
claude mcp add antlegion -- npx -y -p @antlegion/bus antlegion-mcp
```

两个这样接入的 agent 仅通过事实流即可协作：一个发布 `task.todo` 事实，另一个认领并解决——恰好一次，没有编排器。参见[通过 MCP 接入](#通过-mcp-接入)。

**第三级 —— 常驻自治工作单元**：[`@antlegion/ant`](https://www.npmjs.com/package/@antlegion/ant) —— 装一只工蚁，告诉它监听哪些事实，它就会自己醒来、认领、干活、解决。*（预发布——运行时正从 [`ecu/`](ecu) 打包中）*

**从源码运行**（开发用）：

```bash
git clone https://github.com/YangKGcsdms/antlegion-platform.git
cd antlegion-platform/antlegion-bus
npm install && npm run dev
```

**或使用 Docker**（从仓库根目录构建）：

```bash
docker build -t antlegion .
docker run -p 28090:28090 -e ANTLEGION_BUS_SECRET=your-stable-secret antlegion
```

### 用终端操作（`alctl` — redis-cli 的对应物）

`npm i -g @antlegion/bus` 会安装三个命令：`antlegion`（服务器）、`alctl`、`antlegion-mcp`。每条 `alctl` 命令在 stdout 输出机器可读的 JSON；人类可读的错误走 stderr 并以非零码退出。

```bash
alctl publish task.build '{"target":"todo-app"}' --author alice
# → {"id":"b3f1…","seq":1,"deduped":false}

alctl claim <id> --author bob
# → {"won":false,"winner":"alice"}        （退出码 1——你输掉了认领）

alctl state <id>
# → {"state":"claimed","owner":"alice"}

alctl resolve <id> --author alice   # 只有认领胜者可以 resolve
# → {"state":"resolved","owner":"alice"}
# 非胜者的 resolve 会明确报错并以非零码退出：
#   error: resolve ignored — fact <id> is owned by 'alice' (you are 'bob')

alctl tail            # 打印一次当前流即退出
alctl tail --follow   # 实时追尾：轮询 ?since= 直到 Ctrl-C

alctl info            # 完整 INFO 载荷
# → {"protocol":"2.0","head_seq":1,"facts":3,"fsync":"everysec","sig_failures":0,"secret_stable":true,…}
```

*（不想全局安装的话：`npx -y -p @antlegion/bus alctl <命令>`）*

`--author <名字>` 是全局旗标，对所有会写入事实的命令生效。身份解析顺序：

| 设置 | 用途 |
|---|---|
| `--author <名字>` | 单条命令的身份（优先级最高） |
| `ANTLEGION_AUTHOR` | 整个 shell 会话的 CLI 身份 |
| *（默认）* | `<系统用户名>@<主机名>`——跨 CLI 调用保持稳定，因此 `claim` 之后 `resolve` 开箱即用 |
| `ANTLEGION_BUS_URL` | CLI/SDK 连接总线的地址（默认 `http://localhost:28090`） |

### 或直接使用 HTTP API

```bash
# 写入一条事实
curl -sX POST http://localhost:28090/facts \
  -H 'content-type: application/json' \
  -d '{"type":"task.build","author":"alice","ts":1748300000,"payload":{"target":"todo-app"}}'
# 201 {"seq":1,"id":"b3f1…","sig":"…","deduped":false}

# 从游标读取（类似 git fetch）
curl -s "http://localhost:28090/facts?since=0&type=task.*"
```

这就是完整的线协议：**一个写操作，一个读操作，两个读便捷接口。** 认领、解决、信任等语义全是「关于事实的事实」，由客户端折叠计算得出。

## 事实的结构

唯一的本原——不可变、内容寻址、在单一全序中占据唯一位置：

```jsonc
{
  "seq":    1337,           // 总线分配的全序位置（可信）
  "recv":   1748300000.4,   // 总线盖章的可信接收时间（unix 秒）——所有时间折叠都基于此，而非 ts
  "id":     "b3f1…",        // sha256(canonical(record))——内容地址
  "type":   "build.failed", // 点分类型；保留类型以 "_." 开头
  "author": "claude-code",  // 发布者
  "ts":     1748300000.0,   // 作者声明的时间（仅供参考，可被伪造，不可用于折叠计算）
  "payload": { "…": "…" },  // 任意 JSON
  "refs": {                 // 唯一的关系机制——值永远是事实 id，绝不是 Agent id
    "parent":     "<id>",   // 因果前驱
    "claim_of":   "<id>",   // 对目标事实的独占认领
    "resolves":   "<id>",   // 目标事实已完成处理
    "release_of": "<id>",   // 放弃之前的认领
    "vote":       "<id>",   // 佐证或反驳（配合 payload.verdict）
    "supersedes": "<id>",   // 本事实取代目标事实
    "subject":    "key",    // 用于「最新胜出」取代逻辑的分组键
    "tombstones": "<id>"    // 目标事实被删除/GC（区别于取代）
  },
  "nonce": "k7x9",          // 可选——让内容相同的重复提交成为新事实
  "sig":   "hmac…"          // 总线对 (id|author|type|ts|recv|seq) 的 HMAC-SHA256 签名
}
```

> **`ts` 与 `recv` 的区别**：`ts` 是作者的声明（是内容哈希的一部分，但可被伪造）；`recv` 是总线亲历并签名的。所有基于时间的折叠计算都使用 `recv`，从不使用 `ts`，以确保任意两个读者的结果完全一致。

保留事实类型（折叠层负责解释）：

| 类型 | 含义 |
|---|---|
| `_.claim` | 对 `refs.claim_of` 的独占认领；序号最小者胜出 |
| `_.resolve` | `refs.resolves` 所指事实已处理完毕；仅当前认领胜者发出的才有效 |
| `_.release` | 作者放弃对 `refs.release_of` 的认领 |
| `_.vote` | 佐证或反驳 `refs.vote`（见 `payload.verdict`） |
| `_.tombstone` | `refs.tombstones` 所指事实被删除/GC；与取代（supersedes）语义不同 |

## 从代码接入

折叠客户端 SDK 负责「发布→读回→折叠」的底层工作，让调用侧保持整洁（`npm i @antlegion/bus`）：

```typescript
import { ClientV2, httpTransport } from "@antlegion/bus/client";

const alice = new ClientV2(httpTransport("http://localhost:28090"), "alice");
const bob   = new ClientV2(httpTransport("http://localhost:28090"), "bob");

// 发布一条待处理的工作项
const { id } = await alice.publish("task.build", { target: "todo-app" });

// 两者竞争认领；序号最小者胜出——确定性，无锁
const [ra, rb] = await Promise.all([alice.claim(id), bob.claim(id)]);
const winner = ra.won ? alice : bob;

// 胜者完成处理，可选地发出子事实（构成因果链）
await winner.resolve(id, [{ type: "build.done", payload: { ok: true } }]);

// 任意客户端从同一不可变日志折叠出相同状态
console.log(await alice.state(id)); // { state: "resolved", owner: "alice" }
console.log(await bob.state(id));   // 完全相同——确定性折叠
```

**同行评审（信任折叠）**：

```typescript
await bob.observe(factId, "corroborate");   // 佐证
await carol.observe(factId, "contradict");  // 反驳

const verdict = await alice.trustOf(factId);
// "asserted" | "corroborated" | "consensus" | "contested" | "refuted" | "superseded"
```

**因果链**：

```typescript
const chain = await alice.causation(buildDoneId);
// [{ type: "task.build", … }, { type: "build.done", … }]  （根 → 叶）
```

**取代（最新胜出）**：

```typescript
// 为同一主体发布更新的状态，旧状态自动被取代
await alice.publish("deploy.status", { stage: "testing" },
  { refs: { subject: "deploy-run-42" } });

await alice.publish("deploy.status", { stage: "done" },
  { refs: { subject: "deploy-run-42" } });
// 读者只会看到第二条为当前状态
```

**进程内嵌入模式**（测试或紧耦合集成）：

```typescript
import { BusV2 } from "@antlegion/bus/bus";
import { ClientV2, localTransport } from "@antlegion/bus/client";

const bus = new BusV2({ secret: "my-secret", dataDir: "./data" });
const client = new ClientV2(localTransport(bus), "my-agent");
// 无 HTTP、无网络——同一套 SDK，同一套折叠逻辑
```

## 通过 MCP 接入

任何支持 MCP 的 Agent——Claude Code、Cursor、Cline、Windsurf、Zed、Goose——都可以通过一行命令以 stdio 方式连接到总线，无需定制集成：

```bash
claude mcp add antlegion \
  --env ANTLEGION_BUS_URL=http://localhost:28090 \
  --env ANTLEGION_AGENT_NAME=my-agent \
  -- npx -y -p @antlegion/bus antlegion-mcp
```

或者通过 `.mcp.json`：

```json
{
  "mcpServers": {
    "antlegion": {
      "command": "npx",
      "args": ["-y", "-p", "@antlegion/bus", "antlegion-mcp"],
      "env": {
        "ANTLEGION_BUS_URL": "http://localhost:28090",
        "ANTLEGION_AGENT_NAME": "my-agent"
      }
    }
  }
}
```

`ANTLEGION_AGENT_NAME` 默认是 `<系统用户名>@<主机名>`；启动时会把解析出的身份打印到 stderr。
`ANTLEGION_DATA_DIR` 与 `ANTLEGION_BUS_SECRET`（见[配置参数](#配置参数)）用于配置总线服务端本身。

暴露的 **7 个工具**：`antlegion_publish`、`antlegion_query`、`antlegion_claim`、`antlegion_resolve`、`antlegion_observe`、`antlegion_causation`、`antlegion_state`。

**1 个资源**：`antlegion://facts/recent`——最近 20 条事实的 JSON。

MCP 适配器与 HTTP 客户端使用同一套 `ClientV2` 折叠 SDK——协调语义只实现一次，不会因适配器而重复。

## 经验证的保证

出发点——「Agent 只靠事实协作、无命令」——由 [`antlegion-bus/examples/`](antlegion-bus/examples) 中四个可运行的 swarm 压测验证。每个都启动一个真实服务端、拉起约 20 个自治 Agent，并断言一个可量化的通过门槛：

| Swarm | 证明内容 | 通过门槛 |
|---|---|---|
| [`swarm-v2`](antlegion-bus/examples/swarm-v2.ts) | 50 项任务经 16 个 worker 460 次竞争认领后完成分发——**恰好一次**，零 Agent 间寻址 | `dupes=0  missing=0` |
| [`scenario-resilience`](antlegion-bus/examples/scenario-resilience.ts) | Agent 中途崩溃，**认领超时重派**转移归属权；exactly-once 在故障下不破 | 无卡死项 |
| [`scenario-consensus`](antlegion-bus/examples/scenario-consensus.ts) | 同行评审收敛真相；决策者**只对 consensus 行动**，绝不对被反驳的事实行动 | decider 从不对 refuted 行动 |
| [`scenario-pipeline`](antlegion-bus/examples/scenario-pipeline.ts) | 因果多阶段 `build→test→deploy` + 最新胜出**取代**；所有监控者对唯一最新状态达成一致 | 所有监控者一致 |

```bash
npx tsx examples/swarm-v2.ts
npx tsx examples/scenario-resilience.ts
npx tsx examples/scenario-consensus.ts
npx tsx examples/scenario-pipeline.ts
```

每个示例都会在临时端口上自启自己的总线——无需提前启动任何总线。

### 杀手锏演示

[`demo-killer`](antlegion-bus/examples/demo-killer.ts) 用约 13 秒、三幕结构讲清整个卖点：**(1)** 来自 4 个"框架"的 8 个 agent 进程争抢 400 个任务——重复数为 0,由全序决定,而非锁;**(2)** 一个真实进程在工作途中被 `SIGKILL`,它留下的无主 claim 在可信总线时钟上过期并被幸存者重新赢得——没有编排器收到通知,因为根本不存在编排器;**(3)** 总线本身被杀掉并从日志重启——`head_seq`、流哈希、每个任务的所有者/状态逐字节一致地恢复。

```bash
npx tsx examples/demo-killer.ts
```

搭配 [`demo/`](antlegion-bus/demo) 里的零依赖实时看板——任务网格、agent 卡片、重复计数器在浏览器中实时更新,总线重启时自动做回放校验。详见 [`demo/README.md`](antlegion-bus/demo/README.md)。

## 配置参数

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `28090` | HTTP 监听端口 |
| `ANTLEGION_DATA_DIR` | `.data-v2` | 日志文件目录（内含 `facts-v2.jsonl`） |
| `ANTLEGION_FSYNC` | `everysec` | `always`（最强持久化）· `everysec`（最多丢 1 秒数据）· `no`（由 OS 决定）——对应 Redis 的 `appendfsync` |
| `ANTLEGION_BUS_SECRET` | *（每次启动随机生成）* | HMAC 签名密钥。**生产环境务必设置稳定值**——不设置则每次重启后无法验证之前写入的签名 |
| `ANTLEGION_MAX_DEPTH` | `64` | 因果链最大深度（§5 安全上限；内容寻址从结构上杜绝了环的存在） |

```bash
# 生产环境启动示例
ANTLEGION_BUS_SECRET=a-stable-32-char-secret \
ANTLEGION_DATA_DIR=/var/lib/antlegion \
ANTLEGION_FSYNC=always \
node dist/index.js
```

## 架构

```
 客户端
 ┌──────────────────┐  ┌───────────────┐  ┌────────────────────┐
 │  ClientV2 (SDK)  │  │  alctl CLI    │  │  MCP stdio 适配器  │
 │  client.ts       │  │  cli.ts       │  │  mcp.ts            │
 │  - publish       │  │  - publish    │  │  - antlegion_*     │
 │  - claim/resolve │  │  - claim      │  │    tools (7)       │
 │  - trust/state   │  │  - tail/info  │  │                    │
 └────────┬─────────┘  └──────┬────────┘  └─────────┬──────────┘
          │                   │                      │
          └───────────────────┴──────────────────────┘
                              │ HTTP (POST /facts · GET /facts)
                              ▼
 ┌────────────────────────────────────────────────────────────────┐
 │  server.ts（Hono，轻量线协议层）                               │
 │  POST /facts · GET /facts[?since&type&author&refs.*]           │
 │  GET /facts/:id · GET /facts/head · GET /info                  │
 │  POST /admin/rewrite（BGREWRITEAOF 对应物）                    │
 │                                                                │
 │  ┌──────────────────────────────────────────────────────────┐  │
 │  │  BusV2（无状态可信核心）  bus.ts                         │  │
 │  │  · 分配 seq（严格递增）                                  │  │
 │  │  · 校验 id == sha256(canonical(record))                  │  │
 │  │  · 盖章 recv + 计算 HMAC sig                             │  │
 │  │  · 按 id 去重（幂等追加）                                │  │
 │  │  · 强制因果深度上限（§5）                                │  │
 │  │  · 日志恢复时验证签名（§4）                              │  │
 │  └────────────────────────┬─────────────────────────────────┘  │
 │                           │                                    │
 │  ┌────────────────────────▼─────────────────────────────────┐  │
 │  │  JsonlLog（只追加文件日志）  log.ts                      │  │
 │  │  · 单个追加模式 fd（一次打开，不按写操作开关）           │  │
 │  │  · appendfsync: always | everysec | no                   │  │
 │  │  · 压缩：临时文件 + 原子重命名                           │  │
 │  └──────────────────────────────────────────────────────────┘  │
 └────────────────────────────────────────────────────────────────┘

 读者折叠（fold.ts — 纯函数，在客户端运行，不在服务端）
 ┌──────────────────────────────────────────────────────────────────────────┐
 │  lifecycle(stream, F)       →  open | claimed | resolved | dead          │
 │  claimWinner(stream, F)     →  string | null                             │
 │  trust(stream, F, quorum)   →  asserted | corroborated | consensus | …  │
 │  supersededBy(stream, F)    →  id | null                                 │
 │  causationChain(stream, F)  →  Fact[]（根 → 叶）                        │
 └──────────────────────────────────────────────────────────────────────────┘
```

**关键设计取舍**：语义（meaning）存在于折叠函数中，而非总线里。对同一事实流进行相同折叠的两个客户端，无论何时读取都会得到完全相同的结果——总线只负责定序和保存。

## 项目结构

```
antlegion-platform/
├── README.md               ← 英文文档（每份文档都有 .zh-CN.md 中文版）
├── README.zh-CN.md         ← 你在这里
├── PROTOCOL.md             ← 线协议规范——§3 折叠规则为规范性
├── Dockerfile              ← docker build . && docker run -p 28090:28090 …
├── docs/
│   ├── QUICKSTART.md       ← 逐步指南：服务端 + SDK + CLI + MCP
│   └── EVOLUTION.md        ← v0 → v1 → v2：尝试过什么、为何改变
└── antlegion-bus/
    ├── src/
    │   ├── bus.ts          ← 无状态可信核心
    │   ├── fold.ts         ← 读者折叠（语义层）
    │   ├── client.ts       ← ClientV2 折叠 SDK
    │   ├── server.ts       ← Hono 线协议层
    │   ├── log.ts          ← 只追加日志
    │   ├── mcp.ts          ← MCP stdio 适配器
    │   ├── cli.ts / bin.ts ← alctl CLI
    │   ├── hash.ts         ← sha256 内容地址 + HMAC + verifySig
    │   ├── canonical.ts    ← stableJsonStringify（兼容 Python 浮点格式）
    │   ├── types.ts        ← Fact、FactInput、Refs、RESERVED 类型
    │   └── config.ts       ← 环境变量配置（redis.conf 对应物）
    ├── conformance/
    │   ├── vectors.json    ← §4 互操作契约：7 个哈希 + 24 个折叠向量
    │   ├── generate.ts     ← 从参考实现派生向量
    │   └── verify.py       ← 独立的 Python §4 重新实现（跨语言证明）
    ├── examples/
    │   ├── swarm-v2.ts              ← 21 个 Agent 的恰好一次扇出
    │   ├── scenario-resilience.ts  ← 崩溃 + 重派
    │   ├── scenario-consensus.ts   ← 同行评审信任
    │   └── scenario-pipeline.ts    ← 因果流水线 + 取代
    └── test/               ← 147 个测试（vitest，约 1 秒）
```

## 当前状态

**Alpha** — 核心协议、参考实现和单节点运维故事已完备。尚不建议用于不可信的公网环境。

### 已完成

- [x] 无状态可信核心：分配全序 · 校验内容哈希 · HMAC 签名 · 持久化 · 按区间返回
- [x] 只追加日志，支持 `appendfsync always|everysec|no` + BGREWRITEAOF 风格压缩
- [x] 读者折叠 SDK：`lifecycle`、`trust`、`supersession`、`causation`
- [x] `alctl` CLI — redis-cli 的对应物
- [x] MCP stdio 适配器——一行命令接入任何支持 MCP 的 Agent
- [x] §5 追加时的因果深度上限强制
- [x] §4 日志恢复时的签名校验，`sig_failures` 通过 `/info` 暴露
- [x] 跨语言一致性向量——哈希 + 折叠互操作证明，配套独立 Python 校验器
- [x] 四个多 Agent 验证 swarm（恰好一次 · 韧性 · 共识 · 流水线）
- [x] Docker 镜像 · 进程内约 16 万 append/s 基准测试 · 147 个测试

### 路线图

- [x] 发布 npm 包——[`@antlegion/bus`](https://www.npmjs.com/package/@antlegion/bus)（`npx @antlegion/bus` 一行起总线）
- [ ] [`@antlegion/ant`](https://www.npmjs.com/package/@antlegion/ant)——常驻自治工作单元（`ant init` / `ant start`）；包名已占位，运行时正从 [`ecu/`](ecu) 打包
- [ ] 多语言客户端 SDK——Go、Python、Rust（一致性向量已就绪，可直接对齐）
- [ ] 面向公网的鉴权 + 每作者速率限制
- [ ] 复制 / 高可用（协议设计：单写者 + 故障切换，见 PROTOCOL.md §7）
- [ ] 在 CI 中集成跨语言 Python 校验器

## 参与贡献

欢迎参与贡献。请注意以下几点：

**协议变更会破坏线兼容性。** 任何对事实结构、`id` 计算方式（§4）或 §3 折叠规则的修改，都必须同步体现在三处：`PROTOCOL.md`、`conformance/vectors.json`（用 `npx tsx conformance/generate.ts` 重新生成）以及跨语言校验器。运行 `python3 conformance/verify.py` 确认未出现分歧。

**提交 PR 前请运行：**

```bash
npm test                      # 147 个测试，约 1 秒
npx tsc --noEmit              # 类型检查
python3 conformance/verify.py # 跨语言哈希证明
npx tsx examples/swarm-v2.ts  # 快速跑一下 swarm（可选，但受欢迎）
```

建议先阅读 [`EVOLUTION.md`](docs/EVOLUTION.md)——它记录了设计决策和已被否定的方向，能帮你避免重走弯路。

## 许可证

MIT — 见 [LICENSE](LICENSE)。

---

<div align="center">
  <sub>AntLegion Protocol v2.0 · 设计者：Carter.Yang · 从第一原理推导，2026 年。</sub>
</div>
