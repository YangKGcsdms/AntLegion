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

## 仓库内的两代

- **v2 —— 当前,推荐。** 一次第一性原理重构:唯一本原(全序中的一条事实)、
  两个操作(`append` / `read`),其余一切——认领、解决、信任、取代、因果——都是
  **读者折叠(reader fold)**。总线退化为无状态可信内核,SDK 与 CLI 承载「智能」。
  代码在 [`antlegion-bus/src/v2/`](antlegion-bus/src/v2)。规范:[`PROTOCOL.md`](PROTOCOL.md)。
  从这里开始:[`QUICKSTART.md`](QUICKSTART.md)。

- **v1 —— legacy。** 原始总线(`antlegion-bus/src/`)加一个 **MCP 适配器**
  ([`antlegion-mcp/`](antlegion-mcp)),让 MCP 客户端(Claude Code、Cursor、Cline……)
  一行配置即可接入。保留它,只因目前它是 MCP 客户端**零代码**接入的唯一路径;v2 的
  MCP 适配器在计划中。规范:[`PROTOCOL-v1-historical.md`](PROTOCOL-v1-historical.md)。
  上手:[`QUICKSTART-v1-mcp.md`](QUICKSTART-v1-mcp.md)。

新项目请用 **v2**。

## 快速上手(v2,60 秒)

```bash
cd antlegion-bus
npm install
npm run dev:v2          # http://localhost:28090   (或:npm run build && npm run start:v2)
```

用 `alctl`(redis-cli 对应物)在终端操作,或在代码里:

```ts
import { ClientV2, httpTransport } from "antlegion-bus/v2/client";

const alice = new ClientV2(httpTransport("http://localhost:28090"), "alice");
const bob   = new ClientV2(httpTransport("http://localhost:28090"), "bob");

const { id } = await alice.publish("task.build", { target: "todo-app" });
const [ra, rb] = await Promise.all([alice.claim(id), bob.claim(id)]); // 恰好一个赢
const winner = ra.won ? alice : bob;
await winner.resolve(id, [{ type: "build.done", payload: { ok: true } }]);
await bob.state(id);    // → { state: "resolved", owner: <winner> }  (从日志折叠得到)
```

完整版(含持久化与 CLI):[`QUICKSTART.md`](QUICKSTART.md)。

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
├── README.md                  ← 你在这里(英文)/ README.zh-CN.md(中文)
├── PROTOCOL.md                ← v2 线协议(当前)
├── PROTOCOL-v1-historical.md  ← v1 协议(归档)
├── QUICKSTART.md              ← v2 快速上手(服务端 + SDK + alctl)
├── QUICKSTART-v1-mcp.md       ← v1 / MCP 快速上手(legacy)
├── EVOLUTION.md               ← 项目为何如此(v0→v1→v2)
├── CLAUDE.md                  ← 给 Claude Code 在本仓工作的指引
├── docker-compose.yml         ← 运行 v1 总线
├── antlegion-bus/
│   ├── src/                   ← v1 总线引擎(legacy)
│   ├── src/v2/                ← v2:内核、服务端、折叠 SDK、alctl CLI、AOF、benchmark
│   ├── examples/              ← 多 Agent 验证 swarm(v2)
│   ├── test/  test/v2/        ← 单元测试(共 244 个)
│   └── Dockerfile-v2          ← 像跑 redis 一样跑 v2 总线
└── antlegion-mcp/             ← v1 MCP 适配器(legacy)
```

## 状态

**Alpha。** v2 已完成:无状态内核、HTTP 线面、折叠 SDK、`alctl` CLI、带
`appendfsync` 策略 + 压缩的只追加持久化、`INFO`、benchmark(进程内约 16 万 append/s)、
Docker 镜像,以及 244 个通过的单测 + 4 个多 Agent 验证 swarm。尚未具备:v2 的 MCP
适配器、多语言客户端 SDK / 跨语言一致性向量、集群/复制,以及已发布的包或预编译二进制
(目前需从源码构建)。

## 许可

MIT,见 [LICENSE](LICENSE)。
