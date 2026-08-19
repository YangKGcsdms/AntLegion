[English](ARCHITECTURE.md) · 🌐 **简体中文**

# 架构——各部分如何拼合，以及什么已被证明

[README](../README.zh-CN.md) 陈述思想；[PROTOCOL.md](../PROTOCOL.zh-CN.md) 是规范。本页位于两者之间：实现长什么样、为何长成这样，以及支撑它的证据。

## 关键属性

| 属性 | 如何做到 |
|---|---|
| **不可变事实** | 以 `sha256(canonical(record))` 内容寻址——相同内容自动去重；每条事实都有稳定、不可伪造的身份 |
| **全序** | 总线分配严格递增的 `seq`；这是它对客户端唯一的权威 |
| **共享寄存器** | `refs.subject` 命名世界的一块；关于它 `seq` 最高的事实就是它在每个读者处的当前值（`current`/`history`）；tombstone 把它撤回为「一无所知」，绝不回到旧值 |
| **因果踪迹** | 沿 `refs.parent` 向后走是「它怎么来的」，向前走是「它引发了什么」——内容哈希，事后不可伪造 |
| **恰好一次所有权** | 任一事实上 `seq` 最小的认领胜出——所有权也是世界状态；这是全序的定理，不是锁，也不是专用接口 |
| **可信时间** | 由总线盖的 `recv`（而非作者自报的 `ts`）确定性地锚定所有时间折叠；崩溃 Agent 的陈旧认领无法阻塞恢复 |
| **无状态总线** | 寄存器、踪迹、信任、所有权都是对流的纯折叠函数——总线不持有任何 per-fact 可变状态；两个隔离的读者永远折叠出同一个世界 |
| **持久** | 只追加日志（`facts-v2.jsonl`）+ 可配置 `appendfsync`；崩溃恢复重放日志——没有状态机需要重建 |
| **可验证** | 每条事实由总线 HMAC 签名，恢复时验证；互操作由[跨语言一致性向量集](../antlegion-bus/conformance/vectors.json)保证 |

## 它是什么——以及不是什么

不是消息队列（没有东西被消费），不是编排器（没有谁分派工作），不是工作流引擎（流水线是从流里折叠出来的，从不被存储）。与当下协调 Agent 的其他做法相比：

| | 共享文件 / 便笺 | SQLite 信箱 | 托管协作 SaaS | 平台内建共享状态（Agent-Teams 类） | **AntLegion** |
|---|---|---|---|---|---|
| 全序 | ✗ | 分表、隐式 | 不透明 | 不透明 | ✓ 核心本原 |
| 恰好一次认领 | ✗（靠锁、靠祈祷） | ✗（行锁） | 厂商定义 | 厂商定义 | ✓ 全序的定理 |
| 因果 / 审计 | ✗ | ✗ | 部分 | 部分 | ✓ `refs` + 签名日志 |
| 本地可内嵌 | ✓ | ✓ | ✗ | ✗ | ✓ 一个进程、一个文件 |
| 跨 harness | ✓（勉强） | ✓ | 绑定某个 Agent 框架 | 单一厂商 | ✓ HTTP + CLI + SDK，任意 Agent |
| 开放协议 | — | — | ✗ | ✗ | ✓ [PROTOCOL.md](../PROTOCOL.zh-CN.md) + 一致性向量 |

### 三个机制，一个协作模型

**持久化让 Agent 共享现实。认领让它们分工。因果让工作流涌现。** 系统里其余的一切都是这三者之一，都读自同一条有序日志——持久化是只追加日志（[§1](../PROTOCOL.zh-CN.md)），认领是最小 seq 定理（[§3.1](../PROTOCOL.zh-CN.md)），因果是 `refs.parent` 链（[§3.4](../PROTOCOL.zh-CN.md)）。

## 实现

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
 │  server.ts  (Hono，极薄的线面)                                  │
 │  POST /facts · GET /facts[?since&type&author&refs.*]           │
 │  GET /facts/:id · GET /facts/head · GET /info                  │
 │  POST /admin/rewrite  (BGREWRITEAOF 对应物)                     │
 │                                                                │
 │  ┌──────────────────────────────────────────────────────────┐  │
 │  │  BusV2  (无状态可信内核)   bus.ts                        │  │
 │  │  · 分配 seq（严格递增）                                  │  │
 │  │  · 校验 id == sha256(canonical(record))                 │  │
 │  │  · 盖 recv + 计算 HMAC sig                               │  │
 │  │  · 按 id 去重（幂等追加）                                │  │
 │  │  · 强制因果深度上限  (§5)                                │  │
 │  │  · 恢复时验证 sig     (§4)                               │  │
 │  └────────────────────────┬─────────────────────────────────┘  │
 │                           │                                    │
 │  ┌────────────────────────▼─────────────────────────────────┐  │
 │  │  JsonlLog  (只追加文件日志)   log.ts                      │  │
 │  │  · 单个追加模式 fd（只开一次，而非每次写都开）            │  │
 │  │  · appendfsync: always | everysec | no                  │  │
 │  │  · 压缩：临时文件 + 原子重命名                            │  │
 │  └──────────────────────────────────────────────────────────┘  │
 └────────────────────────────────────────────────────────────────┘

 读者折叠  (fold.ts —— 纯函数，跑在客户端，不在服务端)
 ┌──────────────────────────────────────────────────────────────────────────┐
 │  lifecycle(stream, F)       →  open | claimed | resolved | dead          │
 │  claimWinner(stream, F)     →  string | null                             │
 │  trust(stream, F, quorum)   →  asserted | corroborated | consensus | …  │
 │  supersededBy(stream, F)    →  id | null                                 │
 │  causationChain(stream, F)  →  Fact[]   (root → leaf)                   │
 └──────────────────────────────────────────────────────────────────────────┘
```

**关键设计选择**：意义住在折叠里，不在总线里。两个客户端折叠同一条流永远得到相同结果，无论它们何时读——总线只负责排序与保存。

## 已验证的保证

奠基前提由 [`antlegion-bus/examples/`](../antlegion-bus/examples) 中四个可直接运行的 swarm 检验。每个都拉起一个真实服务端、生成约 20 个自治 Agent，并断言一条具体、可测量的通过门槛：

| Swarm | 证明了什么 | 通过门槛 |
|---|---|---|
| [`swarm-v2`](../antlegion-bus/examples/swarm-v2.ts) | 16 个 worker 上 50 项扇出/扇入、460 次竞争认领——**恰好一次**，零 Agent 间寻址 | `dupes=0  missing=0` |
| [`scenario-resilience`](../antlegion-bus/examples/scenario-resilience.ts) | Agent 干活途中崩溃；**认领超时重派**转移所有权；恰好一次依然成立 | 无卡住的项 |
| [`scenario-consensus`](../antlegion-bus/examples/scenario-consensus.ts) | 同行评审收敛；决策者**只在共识下**行动，绝不基于被驳倒的事实 | 决策者从不基于被驳倒的事实行动 |
| [`scenario-pipeline`](../antlegion-bus/examples/scenario-pipeline.ts) | 因果 `build→test→deploy` + 最新胜出的**取代**；所有监视者对唯一的新鲜状态达成一致 | 所有监视者一致 |

```bash
npx tsx examples/swarm-v2.ts
npx tsx examples/scenario-resilience.ts
npx tsx examples/scenario-consensus.ts
npx tsx examples/scenario-pipeline.ts
```

每个示例都会在临时端口上自启一条总线——事先不需要有总线在跑。

### killer demo

[`demo-killer`](../antlegion-bus/examples/demo-killer.ts) 把整套主张压缩进约 13 秒，分三幕：**(1)** 来自 4 个「框架」的 8 个 Agent 进程争抢 400 个任务——重复：0，由全序判定，而非靠锁；**(2)** 一个真实进程在干活途中被 `SIGKILL`，它遗留的认领按可信的总线时钟过期并被幸存者重新赢得——没有任何编排器被通知，因为根本不存在；**(3)** 总线本身被杀掉再从日志重启——`head_seq`、流哈希、每个任务的 owner/state 全部字节级一致地回来。

```bash
npx tsx examples/demo-killer.ts
```

搭配 [`demo/`](../antlegion-bus/demo) 里零依赖的实时仪表板食用——任务网格、每个 Agent 的卡片、实时更新的重复计数，总线重启时自动做重放验证。见 [`demo/README.md`](../antlegion-bus/demo/README.md)。

### 竞争下的实测

上面的 swarm 是通过/失败门槛。要看数字——副本 worker 下的重复劳动率、伪造证据拦截率——见 [`research/s2-experiments-2026-08.md`](../research/s2-experiments-2026-08.md)：**100 个认领单元、4 倍副本 worker 竞争下 0 次双执行**，伪造的「全绿」报告被 **8/8 拦截、0 误杀**。

## 它从哪来

这是第二个系统。第一个——[claw_fact_bus](https://github.com/YangKGcsdms/claw_fact_bus)（2026-03，Python）——把总线做成了一个向感兴趣的 Agent 推送事实的仲裁者，并且恰恰死于本设计所治的那些病：服务端状态、隐式命令、协作规则住在运行时里。重写删掉了一切可删的，只留下不可删的——全序——并把所有意义移进读者折叠。[EVOLUTION.zh-CN.md](EVOLUTION.zh-CN.md) 讲了完整故事；先造出那个失败版本，正是这一版长成这样的原因。
