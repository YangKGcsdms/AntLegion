<div align="center">

[English](README.md) · 🌐 **简体中文**

# AntLegion

**几个 AI 智能体跑在同一个项目上，就会互相重做工作、丢失彼此的上下文、各走各路。** AntLegion 在事实层面解决它：一条只追加的**事实总线**，自治工作单元把发生的事贴上去、恰好一次地认领工作、让工作流自己涌现——没有编排器，没有谁指挥谁。本地、可内嵌的基础设施（像 Redis，不是 SaaS）。

![npx @antlegion/bus demo——恰好一次竞速、崩溃接管、字节级重放](deploy/media/demo.gif)

它不锁文件、不串行化你的智能体——冲突在**分工层**就被消灭了，两个单元根本不会碰同一个任务。你已有的 Claude Code / Cursor 会话也能作为工作单元接入同一条总线（通过 [`alctl` CLI](#用-alctl-cli-接入-agent)）。

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
- [用 `alctl` CLI 接入 Agent](#用-alctl-cli-接入-agent)
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

这不是口号，而是[可运行的多 Agent 压测验证过的](#经验证的保证)，并且[在真实竞争下测量过](research/s2-experiments-2026-08.md)。

## 为什么存在

每一套多智能体系统都会遭遇三种事故,它们同根同源——没有一份共享的、有序的"已发生"记录：

1. **重复劳动。** 两个 agent 领了同一个任务，因为谁也看不见对方的意图。在这里，"领任务"本身就是一条事实（`_.claim`），全序让恰好一次成为定理——实测 **4 倍副本竞争下 100 个认领单元、双执行 0 次**（[实验记录](research/s2-experiments-2026-08.md)）。
2. **上下文丢失。** A 学到的东西传不到 B，或者传过去时已经是过期的散文。在这里，每个观察都是不可变、内容寻址的事实，任何单元按自己的节奏折叠。
3. **靠散文维系的工作流。** "先方案、再开发、后测试"写在提示词里，直到有人跳过一步。在这里，流水线是因果结构（`refs.parent`），证据形状由裁决者强制——注入实验中，"全绿但没写没测什么"的伪造报告被 **8/8 拦截、0 误杀**。

这些失效模式在文献中早有记录——MAST 多智能体失效分类（[arXiv:2503.13657](https://arxiv.org/abs/2503.13657)）把智能体间失调与验证缺失列为主要失效类。但上面的数字是我们自己的：第一手、每个都能用一条命令复现。

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

### 它是什么——不是什么

不是消息队列（没有东西被消费掉）、不是编排器（没有人分派工作）、不是工作流引擎（流水线从流里折叠出来，从不被存储）。与今天其他的协作方式相比：

| | 共享文件/草稿板 | SQLite 信箱 | 托管协调 SaaS | 平台内置共享状态（Agent Teams 类） | **AntLegion** |
|---|---|---|---|---|---|
| 全序 | ✗ | 按表、隐式 | 不透明 | 不透明 | ✓ 核心本原 |
| 恰好一次认领 | ✗（靠锁和运气） | ✗（行锁） | 厂商定义 | 厂商定义 | ✓ 全序的定理 |
| 因果/审计 | ✗ | ✗ | 部分 | 部分 | ✓ `refs` + 签名日志 |
| 本地可内嵌 | ✓ | ✓ | ✗ | ✗ | ✓ 一个进程一个文件 |
| 跨 harness | ✓（勉强） | ✓ | 绑框架 | 绑单一厂商 | ✓ HTTP + CLI + SDK，任何 agent |
| 协议开放 | — | — | ✗ | ✗ | ✓ [PROTOCOL.md](PROTOCOL.md) + 一致性向量 |

### 三个机制，一套协作模型

**持久化让 agent 共享现实，认领让 agent 分得清工，因果让工作流自己涌现。** 系统里的一切都是这三者之一，从同一条有序日志读出——持久化是只追加日志（[§1](PROTOCOL.md)），认领是最小 seq 定理（[§3.1](PROTOCOL.md)），因果是 `refs.parent` 链（[§3.4](PROTOCOL.md)）。

## 快速上手

**前置要求：Node.js ≥ 20**

**最快的一眼**——三幕 demo（恰好一次竞速 → 崩溃接管 → 字节级重放），零配置零 key，约 15 秒：

```bash
npx @antlegion/bus demo
```

主线是两个包、四条命令：起一条总线，放一支 DCU 舰队上去，喂一条需求，看着它自治跑完。

**1. 起一条总线**（五秒钟，零配置）：

```bash
npx @antlegion/bus
# [antlegion-v2] append-only fact bus on http://localhost:28090 (fsync=everysec)
# [antlegion-v2] dashboard → http://127.0.0.1:28090/dashboard
```

**2. 起 DCU 舰队**（[`@antlegion/ant`](https://www.npmjs.com/package/@antlegion/ant)——dev-chain 六单元：4 个阶段 DCU + 裁决者 + 看门狗）：

```bash
npx @antlegion/ant chain
```

**3. 喂一条需求，看链条自治运转**：

```bash
npx @antlegion/ant req new "试点需求" -s pilot
npx @antlegion/ant board      # 监督看板 → http://localhost:28091/devchain.html
```

约 2 秒内 `dcu-plan` 认领需求（恰好一次，最小 seq 胜出）、产出 `plan.ready`、裁决者校验证据形状、链条停在 H1 人工门——在看板上批准后，dev → unittest → e2e 自己跑到 ✔ CHAIN DONE。没有编排器，没有单元互相寻址，全部协调都是对事实流的读者折叠。

详见 [`ant/`](ant)（DCU 运行时、dev-chain、证据裁决、看板）。此外，任何能执行 shell 命令的 agent（Claude Code、Cursor……）都可以通过 [`alctl` CLI](#用-alctl-cli-接入-agent) 驱动总线做 publish/claim/resolve。

**或者全部装进容器，一条命令**——1 个总线 + 3 个 pi-agent 容器（Ubuntu 24.04），100 个 LLM act 循环，结束打记分板：

```bash
cd deploy/mvp
DEEPSEEK_API_KEY=sk-… docker compose up --build --exit-code-from mvp
```

详见 [`deploy/mvp/`](deploy/mvp)——act 经 pi-ai 走 DeepSeek 推理；`ANT_WORKER=simulated` 可在无 API key 时运行。

**从源码运行**（开发用）：

```bash
git clone https://github.com/YangKGcsdms/antlegion-platform.git
cd antlegion-platform/antlegion-bus
npm install && npm run dev
```

### 或者用 Docker 跑

```bash
docker run -d --name antlegion -p 28090:28090 \
  -v antlegion-data:/data -e ANTLEGION_BUS_SECRET=change-me \
  ghcr.io/yangkgcsdms/antlegion
```

一个进程、一个卷——`/data` 里只有日志文件，别无他物。镜像在容器内绑定 `0.0.0.0`（docker 网络就是信任边界）；端口只发布到你信任调用方的地方。

### 或者作为守护进程跑（redis-server 式）

```bash
npm i -g @antlegion/bus
antlegion start     # 后台常驻;pidfile 和日志与数据文件放在一起
antlegion status    # pid · /health · 文件位置
antlegion stop      # SIGTERM——退出前日志落盘
```

**或自己构建镜像**（从仓库根目录构建）：

```bash
docker build -t antlegion .
docker run -p 28090:28090 -e ANTLEGION_BUS_SECRET=your-stable-secret antlegion
```

### 用终端操作（`alctl` — redis-cli 的对应物）

`npm i -g @antlegion/bus` 会安装两个命令：`antlegion`（服务器）和 `alctl`。每条 `alctl` 命令在 stdout 输出机器可读的 JSON；人类可读的错误走 stderr 并以非零码退出。

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

## 用 `alctl` CLI 接入 Agent

无头 / PI agent——Claude Code、Cursor、Codex CLI、shell 工具、cron 任务——通过 shell 调用 **`alctl` CLI** 驱动总线。一个接口，每个动词恰好映射到一次折叠调用。完整指南见 [`docs/AGENT-CLI.md`](docs/AGENT-CLI.zh-CN.md)。

```bash
export ANTLEGION_BUS_URL=http://localhost:28090   # 默认
export ANTLEGION_AUTHOR=my-agent                   # 稳定的 agent 身份

# 读取新事实、恰好一次认领、用子事实解决
alctl read --type 'task.*' --since "$CURSOR"
alctl claim <id> && alctl resolve <id>
alctl publish task.done '{"result":"ok"}' --parent <id>
```

*（不想全局安装的话，给每条命令加前缀 `npx -y -p @antlegion/bus`。）*

`ANTLEGION_DATA_DIR` 与 `ANTLEGION_BUS_SECRET`（见[配置参数](#配置参数)）用于配置总线服务端本身。CLI 驱动的是与 HTTP 客户端相同的 `ClientV2` 折叠 SDK——协调语义只实现一次，不会因接口而重复。

### 给 agent 的第一条 prompt

采用发生在提示词里，不在安装里。给能执行 shell 命令的 agent 贴这段作为第一条消息：

> 查看 antlegion 事实总线上有没有开放的 `task.todo` 事实（`alctl read --type task.todo`）。有未认领的就先 `alctl claim <id>` 再干活；只有认领退出码为 0 才继续。做完后用简短的结果 `alctl resolve <id>`。如果没有开放任务，就 `alctl publish task.todo '{…}'` 把你接下来打算做的事发布出去，让其他 agent 看得见。

### 贴进 CLAUDE.md / .cursorrules 的协作规则

```markdown
## 多智能体协作（AntLegion）
- 动手前先 `alctl read` 查总线；某任务的 task.todo 已被认领就换别的活。
- 干活前先认领（`alctl claim <id>`）；只有退出码为 0 才继续。输掉认领是常态——换下一个。
- 完成后 `alctl resolve <id>` 并附上产出。绝不只用散文宣布完工。
- 把重要观察发布成事实（`alctl publish`），让其他 agent 能够反应——别囤上下文。
```

### 双窗口实验（5 分钟）

开两个 PATH 上有 `alctl` 的 agent shell，都指向同一条总线，然后在**窗口 A**：

> 发布一条 task.todo 事实——`alctl publish task.todo '{"title": "写一首关于全序的俳句"}'`——然后认领它（`alctl claim <id>`）并开始工作。

紧接着在**窗口 B**：

> 找到总线上最新的 task.todo（`alctl read --type task.todo`）并认领它。

窗口 B 会输：`alctl claim` 以非零码退出并报出 A 是胜者，B 转头去干别的而不是重复劳动。这就是零锁的恰好一次——由哪条认领先落进全序决定，两个读者算出同一个结果。

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
| `HOST` | `127.0.0.1` | 监听地址——总线信任它的调用方（与 Redis 同款安全模型）；只在信任边界内设 `0.0.0.0` |
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

### 运维小抄

- **数据在哪？** 一个只追加文件：`$ANTLEGION_DATA_DIR/facts-v2.jsonl`（默认 `.data-v2/`）。备份=复制它。
- **想清零：** 停总线、删数据目录。别处没有任何状态。
- **Ctrl-C 是安全的：** 关闭时日志落盘；恢复时重放并校验每条签名。
- **务必设置稳定的 `ANTLEGION_BUS_SECRET`：** 不设的话每次启动都换新 HMAC 密钥——重启后先前写入的 `sig` 无法再验证（在 `/info` 里表现为 `sig_failures`）。

### 安全模型

与 Redis 同款信任边界：总线**信任它的调用方**。默认只绑 `127.0.0.1`；只有在你控制的边界内（docker 网络、VPC）才设 `HOST=0.0.0.0`。目前没有鉴权（[路线图](#路线图)）——不要暴露到不可信网络。

### 疑难排查

| 症状 | 原因 / 处理 |
|---|---|
| `error: port 28090 already in use` | 已有总线在跑——直接复用，或 `PORT=28091 npx @antlegion/bus` |
| `/info` 里 `sig_failures > 0` | 总线用了不同（或缺失）的 `ANTLEGION_BUS_SECRET` 重启——设一个稳定值 |
| alctl/SDK 报 `cannot reach bus` | 那个 URL 上没有总线——`npx @antlegion/bus`，或把 `ANTLEGION_BUS_URL` 指对 |
| `resolve ignored — fact is owned by 'X'` | 你输掉了认领；这正是系统在工作。查状态、换活干 |
| 两个单元做了同一个任务 | 是不是两个进程共用同一个身份？一个身份 = 一个进程（[为什么](research/s2-experiments-2026-08.md)） |

## 架构

```
 客户端
 ┌──────────────────┐  ┌───────────────┐
 │  ClientV2 (SDK)  │  │  alctl CLI    │
 │  client.ts       │  │  cli.ts       │
 │  - publish       │  │  - publish    │
 │  - claim/resolve │  │  - claim      │
 │  - trust/state   │  │  - tail/info  │
 └────────┬─────────┘  └──────┬────────┘
          │                   │
          └─────────┬─────────┘
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

三个已发布的包，外加文档、演示和一个落地页。**顶层每一项都在这张图里**——没出现在图上的东西，就不该待在仓库里。

```
AntLegion/
├── README.md               ← 英文文档（每份文档都有 .zh-CN.md 中文版）
├── README.zh-CN.md         ← 你在这里
├── PROTOCOL.md             ← 线协议规范——§3 折叠规则为规范性
├── CLAUDE.md               ← 给在本仓库工作的编码 agent 的指引
├── Dockerfile              ← 构建总线镜像；build context 是仓库根
│
│   ── 已发布到 npm 的包 ──
├── antlegion-bus/          ← @antlegion/bus——总线、SDK、alctl CLI（内部结构见下）
├── ant/                    ← @antlegion/ant——DCU 运行时 + dev-chain 舰队 + 看板
├── antlegion-alias/        ← antlegion——20 行别名，让 `npx antlegion` 起总线
│
│   ── 其余 ──
├── docs/                   ← 指南（QUICKSTART · AGENT-CLI · FACT-MODEL · EVOLUTION ·
│                             DOCKER-VERIFY）+ proposals/（待评审的设计方案）
├── research/               ← 上文各项数字的第一方实测记录
├── deploy/                 ← mvp/（docker-compose 舰队跑分）· media/（演示 gif+tape）·
│                             verify-cli-eventflow.mjs（端到端 CLI 验证）
├── toys/                   ← 可直接跑的小用例：hr-colony、pi-duo、pi-agent
├── site/                   ← antlegion.dev 落地页（静态，尚未上线）
└── dcu-workspace/          ← `ant` 默认监视的运行时工作区；
                              需求目录仅存本地，只有 README 进版本库
```

参考实现内部：

```
antlegion-bus/
├── src/
│   ├── bus.ts          ← 无状态可信核心
│   ├── fold.ts         ← 读者折叠（语义层）
│   ├── client.ts       ← ClientV2 折叠 SDK
│   ├── server.ts       ← Hono 线协议层
│   ├── log.ts          ← 只追加日志
│   ├── cli.ts / bin.ts ← alctl CLI
│   ├── daemon.ts       ← antlegion start|stop|status（redis-server 风格）
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
├── console/ · demo/    ← 服务端在 /console 与 /dashboard 提供的只读页面
└── test/               ← 147 个测试（vitest，约 1 秒）
```

有两样东西**故意**不在树里：`.data-v2/`（总线日志，跑在哪就生成在哪）和 `.ant/`（蚁群的 pid、日志与工作记忆）。两者都是运行时状态，已在任意层级被 gitignore。

## 当前状态

**Alpha** — 核心协议、参考实现和单节点运维故事已完备。尚不建议用于不可信的公网环境。

### 已完成

- [x] 无状态可信核心：分配全序 · 校验内容哈希 · HMAC 签名 · 持久化 · 按区间返回
- [x] 只追加日志，支持 `appendfsync always|everysec|no` + BGREWRITEAOF 风格压缩
- [x] 读者折叠 SDK：`lifecycle`、`trust`、`supersession`、`causation`
- [x] `alctl` CLI — redis-cli 的对应物
- [x] agent 经 `alctl` 从 shell 驱动总线——全折叠动词对等，无需按集成写适配器（`docs/AGENT-CLI.md`）
- [x] §5 追加时的因果深度上限强制
- [x] §4 日志恢复时的签名校验，`sig_failures` 通过 `/info` 暴露
- [x] 跨语言一致性向量——哈希 + 折叠互操作证明，配套独立 Python 校验器
- [x] 四个多 Agent 验证 swarm（恰好一次 · 韧性 · 共识 · 流水线）
- [x] Docker 镜像 · 进程内约 16 万 append/s 基准测试 · 147 个测试

### 路线图

**近期——任何人五分钟能上手的 MVP**
- [x] npm 包：[`@antlegion/bus`](https://www.npmjs.com/package/@antlegion/bus) · [`@antlegion/ant`](https://www.npmjs.com/package/@antlegion/ant)
- [x] LLM 驱动的 worker（pi-ai → DeepSeek 或任何 OpenAI 兼容端点）——协调保持确定性，LLM 只产内容
- [x] `ant init` / `ant start`——问答引导 + 常驻蚁群
- [x] `npx @antlegion/bus demo`——三幕 killer demo，零配置零 key
- [x] CI（测试 + 类型检查 + 跨语言一致性校验 + 破线护栏）
- [ ] README 顶部 demo GIF · GitHub Releases

**中期——被测量的协调层**
- [ ] 多语言客户端 SDK——Go、Python、Rust（[一致性向量](antlegion-bus/conformance/vectors.json)就是测试标靶）
- [ ] 评估基准：重复劳动率、认领竞争结果、接管时延、拦截率——[S2 实验系列](research/s2-experiments-2026-08.md)是它的种子
- [ ] 只读运维看板（fold.ts 跑在浏览器里——读者折叠模型本身就是可观测性）
- [ ] 面向暴露部署的鉴权 + 每作者速率限制

**远期——智能体舰队的默认协调层**
- [ ] 复制 / 高可用（单写者 + 故障切换，PROTOCOL.md §7）
- [ ] DCU 生态：角色模板（`ant init --template dev-chain` 及更多），任何 harness 的 agent 都是同一条总线上的一等单元——多智能体协调的 "Redis"

### 它从哪来

这是第二个系统。第一个——[claw_fact_bus](https://github.com/YangKGcsdms/claw_fact_bus)（2026-03，Python）——让总线当仲裁者、按兴趣推送事实，死于本设计所治愈的那些病：服务端状态、隐式命令、协调规则住在运行时里。重写删掉了一切能删的，只留下删不掉的——全序——并把所有语义搬进读者折叠。完整故事见 [EVOLUTION.md](docs/EVOLUTION.md)；先造出会失败的版本，正是这个版本长成这样的原因。

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
