<!-- lang-nav --> 🌐 [English](CLAUDE.md) · **简体中文**

# CLAUDE.md

本文件为 Claude Code(claude.ai/code)在本仓库工作时提供指引。
(权威版本为英文 [`CLAUDE.md`](CLAUDE.md);本文为对照中文版。)

## 这是什么

AntLegion 是面向自治 Agent 的**事实总线**:一个只追加的不可变、内容寻址事实日志,Agent 通过它协作。奠基公理是**只有事实,没有命令(facts, not commands)**——Agent 发布/读取/认领/解决事实,从不互相寻址;协作从事实流中涌现。它**不是**消息队列、编排器或 Agent 运行时,定位为本地/可内嵌的基础设施(类 Redis),而非公网 SaaS。

仓库内有**两代**,都在 `antlegion-bus/` 包内:

- **v2 —— 当前。** 第一性原理重构:唯一本原(全序中的一条事实)、两操作(`append`/`read`);claim/resolve/trust/supersession/causation 都是**读者折叠**,而非服务端状态。位于 **`antlegion-bus/src/v2/`**。规范:**`PROTOCOL.md`**。新工作应针对 v2。
- **v1 —— legacy。** 原始可变状态总线(`antlegion-bus/src/`)+ MCP 适配器(`antlegion-mcp/`)。保留它仅因 MCP 适配器仍是 MCP 客户端零代码接入的唯一路径。规范:`PROTOCOL-v1-historical.md`。

`PROTOCOL.md`(v2)是**权威规范**;其 §3 折叠规则是规范性的(意义住在那里,因为 v2 总线无状态)。请保持 `PROTOCOL.md` 与 `src/v2/` 同步。

## 命令

在 `antlegion-bus/`(或 `antlegion-mcp/`)目录内运行,而非仓库根。

```bash
# v2(当前)—— antlegion-bus/
npm install
npm run dev:v2          # tsx src/v2/index.ts → http://localhost:28090
npm run build && npm run start:v2
npm run bench:v2        # 吞吐 benchmark(redis-benchmark 对应物)
node dist/v2/bin.js <cmd>   # alctl CLI(publish/read/claim/resolve/state/info);需先 build 且总线在运行
npx tsx examples/swarm-v2.ts    # 多 Agent 验证 swarm(还有 scenario-{resilience,consensus,pipeline})

# 测试(共 244:v1 在 test/,v2 在 test/v2/)
npm test                              # vitest run(全部)
npm run test:v2                       # 只跑 v2
npx vitest run test/v2/fold-lifecycle.test.ts   # 单文件
npx vitest run -t "exactly-once"                # 按名

# v1(legacy)—— antlegion-bus/
npm run dev / npm start               # v1 总线 :28080
# antlegion-mcp/:npm run build;把 dist/index.js 接进 MCP 客户端(见 QUICKSTART-v1-mcp.md)

# v1 栈
docker compose up -d                  # 只运行 v1 总线 :28080
```

无 lint 配置。`npx tsc --noEmit` 做类型检查。

## v2 架构(当前)

```
clients → ClientV2(SDK, src/v2/client.ts)─HTTP→ server.ts → BusV2(src/v2/bus.ts)→ JsonlLog(src/v2/log.ts)
          alctl CLI(cli.ts/bin.ts)                                  └ 折叠(fold.ts)在客户端侧运行
```

- **`bus.ts` —— 无状态可信内核。** 分配全序(`seq`)、校验内容哈希 `id`、盖可信接收时间(`recv`)+ HMAC `sig`、持久化、按区间返回。仅有的派生索引(seq 计数、`id→seq` 去重)是日志的纯投影。**无 per-fact 可变状态、无状态机。**
- **`fold.ts` —— 读者折叠(语义)。** `lifecycle`(claimed/resolved/dead/open)、`claimWinner`/`didIWin`、`trust`、`supersededBy`/`isSuperseded`、`causationChain`。对事实流的纯函数。
- **`server.ts`** —— Hono 线面:`POST /facts`、`GET /facts`(since/type/author/refs 过滤)、`/facts/head`、`/facts/:id`、`/info`(INFO)、`POST /admin/rewrite`(BGREWRITEAOF)。
- **`log.ts`** —— 只追加 AOF:`appendfsync` 策略(`always|everysec|no`)、关闭刷盘、压缩时保留完整 `{id,seq,recv,author,refs,sig}` 骨架(只丢 payload)。
- **`client.ts`** —— 基于 transport 的折叠 SDK(`localTransport(bus)` 用于进程内/测试,`httpTransport(url)` 用于真实)。把表面保持得和 MCP 工具一样小,同时吸收「追加→读回→折叠」。

**Fact**(v2):`{seq, recv, id, type, author, ts, payload, refs, nonce?, sig}`。`refs` 是唯一的关系机制(`parent`、`claim_of`、`resolves`、`release_of`、`vote`、`supersedes`、`subject`、`tombstones`),且始终引用**事实 id,绝不引用 Agent id**——这是「没有命令」的结构性原因。

### v2 须知
- **恰好一次是全序的定理**,而非锁:seq 最小的存活 `claim_of:F` 获胜;每个读者算出同一赢家。
- **基于时间的折叠以 `recv`(总线盖,可信)为准,绝不用 `ts`(作者自报,仅供参考)。** 认领超时**以 recv 锚定、确定性**:一个 claim 在后续某事实的 `recv` 越过 `claim.recv + Δ` 时过期;只有末尾无后继的 claim 才回退到墙钟 `now`。这正是崩溃恢复重派能转移 owner、又不会撤销一个真实 resolve 的原因(见 `PROTOCOL.md` §3.1)。
- **按 `id` 幂等**:重发相同内容返回既有事实;要做真正的新动作就换一个 `nonce`。
- 哈希复用 v1 的 `stableJsonStringify`(Python 兼容的浮点渲染)——`src/v2/hash.ts` 从 `../engine/ContentHasher.ts` 导入它。

## v1 架构(legacy)与其坑

v1 是可变状态引擎:`server/app.ts` 把路由接到 `engine/BusEngine.ts`,后者拥有事实注册表、两套状态机(`WorkflowStateMachine` ⊥ `EpistemicStateMachine`)、过滤/仲裁、流控、可靠性(TEC)与 `JSONLStore` 持久化。注意:
- **事件/派发系统在 HTTP 路径里是死的**——`app.ts` 注册空回调,也没有 WebSocket;v1 纯轮询(`GET /facts?since_sequence=N`)。
- **`ContentHasher` 必须与 Python 参考逐字节一致**(`.0` 浮点规则);改它曾弄坏测试。
- **默认 `mode` 因层而异**(`createFact` → `exclusive`;路由/MCP 默认 → `broadcast`);内部状态 `matched`/`processing` 在线面被映射为 `published`/`claimed`。
- MCP 适配器从不注册 ant(用 agent 名作 `source_ant_id`、无 token),并把游标持久化到 `~/.antlegion/`。

两代均为 ESM(`"type":"module"`);包内导入从 `.ts` 源使用显式 `.js` 扩展名。

## 参考文档
- `PROTOCOL.md` —— v2 协议(权威;§3 折叠为规范性)。
- `PROTOCOL-v1-historical.md` —— 归档的 v1 线格式。
- `QUICKSTART.md` —— v2 快速上手(服务端 + SDK + alctl)。`QUICKSTART-v1-mcp.md` —— legacy MCP 走查。
- `EVOLUTION.md` —— 项目为何如此(v0 运行时 → v1 → v2 一元论重构)。
- `README.md` —— 项目概览、定位、仓库地图、已验证保证。
