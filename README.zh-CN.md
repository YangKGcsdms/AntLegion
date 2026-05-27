🌐 [English](README.md) · **简体中文**

# AntLegion

> 面向自治 Agent 的**事实总线(fact bus)**——本地、可内嵌的基础设施,让众多 Agent
> 通过共享**事实(fact)**协作,而非互相下达**命令(command)**。可以把它理解为
> 多 Agent 协作的「Redis 形态原语」:装上、运行、把你的 Agent 指过来即可。

---

## 这是什么

一个小型服务端,把**不可变、内容寻址的事实**存进单一全序、只追加的日志。Agent
*发布(publish)*事实、按自己的节奏*读取(read)*、可选地*认领(claim)*独占事实并
*解决(resolve)*、还能对彼此的事实*佐证(corroborate)/ 反驳(contradict)*。协作不是
被编排出来的——它从事实流及其因果链中**自发涌现**。

奠基公理:**只有事实,没有命令(facts, not commands)。** `"第 7 项待处理"` 是事实;
`"worker-3,去处理第 7 项"` 是命令,不允许出现在总线上。没有任何 Agent 寻址另一个
Agent,它们只对世界做陈述、并对陈述做出反应。(这不是口号,而是被验证过的——见
[已验证的保证](#已验证的保证)。)

## 它的定位

| 它**是** | 它**不是** |
|---|---|
| 跑在 Agent 旁边的本地/可内嵌设施(类 Redis) | 公网 SaaS |
| 持久、有序、只追加的**事实日志** + 读者侧折叠 | 消息队列 / RPC 总线 |
| 编排式协作:Agent 借共享事实自我协调 | 给 Agent 排序的编排器 |
| 单机、单写(高可用=故障切换,非多主) | 多主分布式数据库 |

血统:CAN 总线(内容寻址广播 + 本地过滤)、事件溯源(日志是唯一真相)、
git(内容哈希 + 游标 `fetch`)、科学方法(可被同行评议、可被反驳的事实)。

## 架构(唯一)

一个本原、一条总线。事实是单一全序中不可变、内容寻址的陈述;总线只负责赋序、校验内容
哈希、盖可信时间、签名、持久化、按区间返回。认领、解决、信任、取代、因果都是对事实流的
**读者折叠**([`PROTOCOL.md`](PROTOCOL.md) §3)——总线不持有 per-fact 状态。「智能」集中
在一处:客户端 SDK / `alctl` CLI / MCP 适配器,均在
[`antlegion-bus/src/`](antlegion-bus/src)。从这里开始:[`QUICKSTART.md`](docs/QUICKSTART.md)。

> 早期的 **v1**(可变状态总线 + 独立 MCP 包)在本设计取代它后已被移除,保留在 git 历史里。
> 见 [`EVOLUTION.md`](docs/EVOLUTION.md)。

## 快速上手(60 秒)

```bash
cd antlegion-bus
npm install
npm run dev          # http://localhost:28090   (或:npm run build && npm run start)
```

用 `alctl`(redis-cli 对应物)在终端操作,或在代码里:

```ts
import { ClientV2, httpTransport } from "antlegion-bus/client";

const alice = new ClientV2(httpTransport("http://localhost:28090"), "alice");
const bob   = new ClientV2(httpTransport("http://localhost:28090"), "bob");

const { id } = await alice.publish("task.build", { target: "todo-app" });
const [ra, rb] = await Promise.all([alice.claim(id), bob.claim(id)]); // 恰好一个赢
const winner = ra.won ? alice : bob;
await winner.resolve(id, [{ type: "build.done", payload: { ok: true } }]);
await bob.state(id);    // → { state: "resolved", owner: <winner> }  (从日志折叠得到)
```

完整版(含持久化与 CLI):[`QUICKSTART.md`](docs/QUICKSTART.md)。

## 已验证的保证

「Agent 只靠事实协作、无命令」这一出发点,由 [`antlegion-bus/examples/`](antlegion-bus/examples)
里**可运行的 swarm** 压测(每个都起一个服务端、拉起约 20 个自治 Agent,并断言一个客观判据):

| Swarm | 证明 |
|---|---|
| `swarm-v2` | 50 项 fan-out/in,16 个 worker 间**恰好一次**,零 Agent 间消息 |
| `scenario-resilience` | 崩溃的 Agent 经**认领超时重派**被救回——exactly-once 在故障下不破 |
| `scenario-consensus` | 同行评议收敛真相;decider **只对 consensus 行动**,绝不对被反驳的事实行动 |
| `scenario-pipeline` | 因果多阶段(`build→test→deploy`)+ latest-wins **取代**;所有 monitor 对唯一新鲜状态达成一致 |

```bash
npx tsx examples/swarm-v2.ts          # 以及 scenario-{resilience,consensus,pipeline}.ts
```

## 仓库地图

```
.
├── README.md          ← 你在这里   (每份文档都有 .zh-CN.md 中文版)
├── PROTOCOL.md        ← 线协议(§3 折叠规则为规范性)
├── Dockerfile         ← 像跑 redis 一样跑总线(从仓库根构建)
├── CLAUDE.md          ← 给 Claude Code 在本仓工作的指引
├── docs/
│   ├── QUICKSTART.md  ← 60 秒快速上手(服务端 + SDK + alctl + MCP)
│   └── EVOLUTION.md   ← 项目为何如此(v0 → v1 → v2)
└── antlegion-bus/
    ├── src/           ← 内核(bus.ts)、服务端、折叠 SDK(client.ts)、alctl CLI、MCP 适配器(mcp.ts)、AOF(log.ts)、bench
    ├── conformance/   ← vectors.json(§4 互操作契约)+ generate.ts + 一个 Python 校验器
    ├── examples/      ← 多 Agent 验证 swarm
    └── test/          ← 单元测试(136 个)
```

## 状态

**Alpha。** 已完成:无状态内核、HTTP 线面、折叠 SDK、`alctl` CLI、**MCP 适配器**
(`npm run mcp`)、带 `appendfsync` 策略 + 压缩的只追加持久化、`INFO`、**§5 因果深度上限强制**、
恢复时**签名校验**、**跨语言一致性向量**(`conformance/vectors.json` + 一个逐字节复现全部哈希的
独立 Python 校验器)、benchmark(进程内约 16 万 append/s)、Docker 镜像,以及 136 个通过的单测
+ 4 个多 Agent 验证 swarm。尚未具备:多语言客户端 SDK、集群/复制,以及已发布的包或预编译二进制
(目前需从源码构建)。

## 许可

MIT,见 [LICENSE](LICENSE)。
