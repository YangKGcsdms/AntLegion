🌐 [English](CLAUDE.md) · **简体中文**

# CLAUDE.md

本文件为 Claude Code(claude.ai/code)在本仓库工作时提供指引。
(权威版本为英文 [`CLAUDE.md`](CLAUDE.md);本文为对照中文版。)

## 这是什么

AntLegion 是面向自治 Agent 的**事实总线**:一个只追加的不可变、内容寻址事实日志,Agent 通过它协作。奠基公理是**只有事实,没有命令(facts, not commands)**——Agent 发布/读取/认领/解决事实,从不互相寻址;协作从事实流中涌现。它**不是**消息队列、编排器或 Agent 运行时,定位为本地/可内嵌的基础设施(类 Redis),而非公网 SaaS。

**只有一种架构**,在 `antlegion-bus/src/`(扁平)。唯一本原——全序中一个唯一位置的事实;两个操作——`append` / `read`。认领、解决、信任、取代、因果都是**读者折叠**,而非服务端状态。`PROTOCOL.md` 是**权威规范**;其 §3 折叠规则是规范性的(意义住在那里,因为总线无状态)。请保持 `PROTOCOL.md` 与 `src/` 同步。(早期的 v1——可变状态总线 + 独立 MCP 包——已被移除;见 `docs/EVOLUTION.md` 与 git 历史。)

## 命令

在 `antlegion-bus/` 目录内运行,而非仓库根。

```bash
npm install
npm run dev             # tsx src/index.ts → http://localhost:28090
npm run build && npm run start
npm run mcp             # MCP stdio 适配器(需先 build):node dist/mcp.js
npm run bench           # 吞吐 benchmark(redis-benchmark 对应物)
node dist/bin.js <cmd>  # alctl CLI(publish/read/claim/resolve/state/info);需先 build 且总线在运行
npx tsx examples/swarm-v2.ts   # 多 Agent 验证 swarm(还有 scenario-{resilience,consensus,pipeline})

# 测试(74)
npm test                                    # vitest run
npx vitest run test/fold-lifecycle.test.ts  # 单文件
npx vitest run -t "exactly-once"            # 按名
```

无 lint 配置。`npx tsc --noEmit` 做类型检查。

## 架构

```
clients → ClientV2(SDK, src/client.ts)─HTTP→ server.ts → BusV2(src/bus.ts)→ JsonlLog(src/log.ts)
          alctl CLI(cli.ts/bin.ts)                            └ 折叠(fold.ts)在客户端侧运行
          MCP 适配器(mcp.ts,走 stdio)
```

- **`bus.ts` —— 无状态可信内核。** 分配全序(`seq`)、校验内容哈希 `id`、盖可信接收时间(`recv`)+ HMAC `sig`、持久化、按区间返回。仅有的派生索引(seq 计数、`id→seq` 去重)是日志的纯投影。**无 per-fact 可变状态、无状态机。**
- **`fold.ts` —— 读者折叠(语义)。** `lifecycle`、`claimWinner`/`didIWin`、`trust`、`supersededBy`/`isSuperseded`、`causationChain`。对事实流的纯函数。
- **`server.ts`** —— Hono 线面:`POST /facts`、`GET /facts`、`/facts/head`、`/facts/:id`、`/info`(INFO)、`POST /admin/rewrite`(BGREWRITEAOF)。
- **`log.ts`** —— 只追加 AOF:`appendfsync` 策略(`always|everysec|no`)、关闭刷盘、压缩时保留完整 `{id,seq,recv,author,refs,sig}` 骨架(只丢 payload)。
- **`client.ts`** —— 基于 transport 的折叠 SDK(`localTransport(bus)` 进程内/测试,`httpTransport(url)` 真实)。`mcp.ts` 把同一个 client 包成 MCP stdio 服务,折叠逻辑只写一次。
- **`canonical.ts`** —— 自带的 `stableJsonStringify`(Python 兼容浮点渲染,供 `hash.ts`)+ `globMatch`。

**Fact**:`{seq, recv, id, type, author, ts, payload, refs, nonce?, sig}`。`refs` 是唯一的关系机制(`parent`、`claim_of`、`resolves`、`release_of`、`vote`、`supersedes`、`subject`、`tombstones`),且始终引用**事实 id,绝不引用 Agent id**——这是「没有命令」的结构性原因。

### 须知
- **恰好一次是全序的定理**,而非锁:seq 最小的存活 `claim_of:F` 获胜;每个读者算出同一赢家。
- **基于时间的折叠以 `recv`(总线盖,可信)为准,绝不用 `ts`(作者自报,仅供参考)。** 认领超时**以 recv 锚定、确定性**:一个 claim 在后续某事实的 `recv` 越过 `claim.recv + Δ` 时过期;只有末尾无后继的 claim 才回退到墙钟 `now`。这使崩溃恢复重派能转移 owner、又不撤销真实 resolve(`PROTOCOL.md` §3.1)。
- **按 `id` 幂等**:重发相同内容返回既有事实;要做真正的新动作就换一个 `nonce`。
- ESM(`"type":"module"`);包内导入从 `.ts` 源使用显式 `.js` 扩展名。

## 参考文档
- `PROTOCOL.md` —— 协议(权威;§3 折叠为规范性)。`PROTOCOL.zh-CN.md` —— 中文导读。
- `docs/QUICKSTART.md` —— 60 秒快速上手(服务端 + SDK + alctl + MCP)。
- `docs/EVOLUTION.md` —— 项目为何如此(v0 运行时 → v1 → v2 一元论重构,以及 v1 为何被移除)。
- `README.md` —— 概览、定位、仓库地图、已验证保证。每份文档都有 `.zh-CN.md` 中文版。
