<div align="center">

[English](CLAUDE.md) · 🌐 **简体中文**

</div>

# CLAUDE.md

本文件为 Claude Code（claude.ai/code）在本仓库工作时提供指引。

## 这是什么

AntLegion 是**为智能体共享世界状态的事实日志**：跨进程/机器/厂商的智能体把观察写进同一条只追加、全序、不可变、内容寻址的日志，各自折叠出同一个世界——现在是什么（`subject` 寄存器）、因何而起/引出了什么（因果踪迹）、可信与否、归谁所有。奠基公理是**只有事实，没有命令（facts, not commands）**——`refs` 指向的是事实 id 而非 Agent id，所以日志上没有任何东西能被寄给谁。所有权/恰好一次认领是共享一个世界的*推论*（seq 最小的认领胜出），不是目的。它**不是**消息队列、编排器、工作流引擎或多智能体协作框架——「几个 Agent 一起完成一个任务」是工作流领域，只存在于客户端（`ant` 的 dev-chain 是一个例子），绝不进入定位。本地/可内嵌的基础设施（类 Redis），而非公网 SaaS。品牌隐喻：**蚂蚁读地面上的信息素**（stigmergy）——绝不是一支工蚁军队/舰队；避免 舰队/蜂群/spawn 当劳动力 这类措辞。

两个已发布的包，根目录**没有** `package.json`、**没有** npm workspace——各自独立安装、独立测试：

| 目录 | 包名 | 是什么 |
|---|---|---|
| `antlegion-bus/` | `@antlegion/bus` | 总线、折叠 SDK、`alctl` CLI、一致性向量 |
| `ant/` | `@antlegion/ant` | 活在日志**之上**的常驻 Agent（DCU）：镜像 → 折叠 → 行动 的运行时、蚁群守护进程、看板；附带一条 dev-chain 作为工作流客户端示例 |
| `dsh-antlegion/` | `@antlegion/dsh` | 把 DeepSeek Harness 跑成日志上的常驻 Agent（感知 = Node 巡逻流，决策 = LLM 轮次） |
| `antlegion-alias/` | `antlegion` | 20 行别名，让 `npx antlegion` 直接起总线 |

`ant` 依赖的是**已发布**的 `@antlegion/bus`（`^0.4.x`），而不是 `../antlegion-bus`。本地改总线，`ant` 侧看不见——除非发布，或你有意 `npm link`。升级总线版本时必须同步 `ant/package-lock.json`，否则 CI 的 `ant` job 会挂。

`PROTOCOL.md` 是**权威规范**；其 §3 折叠规则是规范性的（意义住在那里，因为总线无状态）。请保持 `PROTOCOL.md` 与 `antlegion-bus/src/` 同步。（早期的 v1——可变状态总线 + 独立 MCP 包——已被移除；见 `docs/EVOLUTION.md` 与 git 历史。）

## 命令

在包目录内运行，绝不在仓库根。

```bash
# ── antlegion-bus/ ──
npm install
npm run dev             # tsx src/index.ts → http://localhost:28090
npm run build && npm run start
npm run bench           # 吞吐 benchmark（redis-benchmark 对应物）
node dist/bin.js <cmd>  # alctl CLI；需先 build 且总线在运行
npx tsx examples/swarm-v2.ts   # 验证 swarm（还有 scenario-{resilience,consensus,pipeline}、demo-killer）

npm test                                    # vitest run
npx vitest run test/fold-lifecycle.test.ts  # 单文件
npx vitest run -t "exactly-once"            # 按名

# 一致性向量（§4 互操作契约）
npx tsx conformance/generate.ts   # 重新生成 vectors.json（仅在有意的协议变更时执行）
python3 conformance/verify.py     # 独立跨语言检查：逐字节复现所有已提交的哈希值

# ── ant/ ──（先 npm install；否则测试报 "Cannot find package '@antlegion/bus/fold'"）
npm test                 # vitest run
npm run chain            # tsx src/main.ts chain —— dev-chain DCU 们，一个工作流客户端示例（需要 :28090 上有总线）
npm run board            # 监督看板 → http://localhost:28091/devchain.html
npm run req -- new "名称" -s slug         # 发布 req.registered 驱动整条链
ANT_WORKER=simulated npx tsx src/main.ts mvp --reqs 25   # 无人值守吞吐跑，不需要 API key
./scripts/up.sh          # 幂等拉起：bus + ingestor + dev-chain DCU + board；./scripts/down.sh 全停
```

无 lint 配置。`npx tsc --noEmit` 做类型检查（两个包都要，CI 就是这么跑的）。CI（`.github/workflows/ci.yml`）三个 job：`bus`（typecheck + vitest + `conformance/verify.py`）、`ant`（typecheck + vitest）、`vectors-guard`。

**改 `conformance/vectors.json` 即破坏线格式。** 只要 PR 碰了它，`vectors-guard` 就会失败，除非该 PR 的某条 commit message 里带字面标记 `[protocol-change]`。仅在有意的协议变更时重新生成，并逐条审查哈希 diff。

## 架构

```
ant 常驻 DCU（ant/src/runtime.ts）    ─┐
alctl CLI（bus src/cli.ts, bin.ts） ─┼─HTTP→ server.ts → BusV2（bus.ts）→ JsonlLog（log.ts）
你的代码 → ClientV2（client.ts）    ─┘                      └ 折叠（fold.ts）在客户端侧运行
```

### `antlegion-bus/src/`（扁平）

- **`bus.ts` —— 无状态可信内核。** 分配全序（`seq`）、校验内容哈希 `id`、盖可信接收时间（`recv`）+ HMAC `sig`、持久化、按区间返回。仅有的派生索引（seq 计数、`id→seq` 去重）是日志的纯投影。**无 per-fact 可变状态，无状态机。**
- **`fold.ts` —— 读者折叠（语义）。** `lifecycle`（claimed/resolved/dead/open）、`claimWinner`/`didIWin`、`trust`、`supersededBy`/`isSuperseded`、`causationChain`，以及 §3.5–§3.6 的可选约定：`colony`/`SYS_REGISTRY`（板上有谁）、`orphanReport`（没人关心的事实类型）、`contextGaps`（`context.requested`/`context.provided`）。对事实流的纯函数。
- **`server.ts`** —— Hono 线面：`POST /facts`、`GET /facts`（since/type/author/refs；返回 `X-Max-Seq` 用于游标推进）、`/facts/head`、`/facts/:id`、`/info`（INFO）、`POST /admin/rewrite`（BGREWRITEAOF）、`/health`，以及静态 `/dashboard`、`/console`。
- **`log.ts`** —— 只追加 AOF：`appendfsync` 策略（`always|everysec|no`）、关闭刷盘、压缩时保留完整 `{id,seq,recv,author,refs,sig}` 骨架（只丢 payload）。
- **`client.ts`** —— 基于 transport 的折叠 SDK（`localTransport(bus)` 进程内/测试，`httpTransport(url)` 真实 HTTP）。`cli.ts` 驱动同一个 client，折叠逻辑只写一次。
- **`daemon.ts`** —— `antlegion start|stop|status`，redis-server 风格；pidfile + 日志放在日志文件旁边。
- **`canonical.ts`** —— 自带的 `stableJsonStringify`（Python 兼容浮点渲染，供 `hash.ts`）+ `globMatch`。

**Fact**：`{seq, recv, id, type, author, ts, payload, refs, nonce?, sig}`。`refs` 是唯一的关系机制（`parent`、`claim_of`、`resolves`、`release_of`、`vote`、`supersedes`、`subject`、`tombstones`），且始终引用**事实 id，绝不引用 Agent id**——这是「没有命令」的结构性原因。

### `ant/src/` —— DCU（Domain Control Unit，域控单元）

DCU 是总线之上一个极薄的确定性监督循环，名字取自汽车 CAN 总线上的控制单元：只听自己关心的，条件成立就动。这里没有任何协议扩展——每个 DCU 都只是普通的总线客户端。

```
poll(游标) → 重建共享折叠 → 判定触发谓词 → act → 推进游标
```

- **`runtime.ts`** —— 循环原语（`runDCU`/`DCUSpec`/`DCUContext`）。维护镜像流、每批重折叠；总线从空日志重启（`head < cursor`）时重置镜像并重跑 `init`。发 `sys.heartbeat`，携带本进程的一次性启动 token。全部常驻 DCU 共用一套进程级 SIGINT/SIGTERM 分发，而不是每个 DCU 各注册一套。
- **`folds/`** —— `devchain.ts`（阶段注册表 + 证据规则 + 链折叠）、`chain.ts`（需求看板）、`watchdog.ts`（饥饿/升级检测，纯函数）、`identity.ts`（同一 author 下两个存活 token ⇒ `sys.identity.conflict`）。
- **`dcus/`** —— dev-chain 六单元（`devchain-dcus.ts` = 4 个阶段 DCU + 裁决者；`watchdog-dcu.ts`）、只读工作区镜像 `ingestor-req.ts`、`scheduler-dcu.ts`（cron 节拍**以事实形式发布**）、`worker-spawn.ts`（唤醒真实 headless agent 干活）、`workers-llm.ts`（pi-ai → DeepSeek）、`gate-approver.ts`。
- **`main.ts`** —— `ant` CLI，其中的 `HELP` 字符串才是当前命令清单（`chain`/`ingestor`/`board`/`req new`/`mvp`/`init`/`start [--daemon]`/`stop`/`status`/`logs`/`launchd`）；`ant/README.md` 早于常驻功能，仍写着 `init`/`start`「0.2 落地」。
- **`daemon.ts`** —— 蚁群常驻：分离式 `ant start`，pid/日志/prompt/`memory/` 都在 `./.ant/` 下；macOS 开机自启的 launchd plist。
- **配置**是蚁群根目录的 `./ant.config.json`（`config.ts`）：`busUrl`、`watchRoots`、`worker`（`llm|simulated|spawn`）、`identity`（蚁群名 + origin/payload 认领范围）、`spawn`、`schedules`、`heartbeatSec`。环境变量优先于文件：`ANTLEGION_BUS_URL`、`ANT_WORKER`、`ANT_LLM_MODEL`、`ANT_LLM_BASE_URL`、`ANT_AUTO_GATE`、`ANT_CLAIM_DELTA`、`BOARD_PORT`、`DEEPSEEK_API_KEY`。

**证据形状才是重点**（做完了 ≠ 验证过了）：resolve 不是一句声明，而是提交证据。裁决者按生产者在 `sys.registry` 里登记的形状校验每份产物的 payload，发 `evidence.accepted`/`evidence.rejected`；被否的产物会让该阶段停住。下游阶段只折叠裁决结论，绝不直接折叠原始产物。

### 须知

- **恰好一次是全序的定理**，而非锁：seq 最小的存活 `claim_of:F` 获胜；每个读者算出同一赢家。
- **基于时间的折叠以 `recv`（总线盖，可信）为准，绝不用 `ts`（作者自报，仅供参考）。** 认领超时**以 recv 锚定、确定性**：一个 claim 在后续某事实的 `recv` 越过 `claim.recv + Δ` 时过期；只有末尾无后继的 claim 才回退到墙钟 `now`。这使崩溃恢复重派能转移 owner、又不撤销真实 resolve（`PROTOCOL.md` §3.1）。
- **按 `id` 幂等**：重发相同内容返回既有事实；要做真正的新动作就换一个 `nonce`。多个子系统是有意吃这个性质的——`sys.registry` 用 `ts:0` + 固定 nonce 发布，重启再注册自动去重；调度器每次触发用 `sched:{colony}:{name}:{slot}`，重启永不重复触发；`req new` 与 ingestor 回填对同一目录规划出逐字节相同的事实。
- **长时间的 act 靠重叠再认领续期，绝不 release**（`worker-spawn.ts`）：每 Δ/3 用新 nonce 再认领同一输入；旧 claim 在 `recv+Δ` 过期后，同一 author 的新 claim 就成了最小的存活 seq。所有权无缝延续，零竞态、零协议改动；子进程死了续期即停，claim 自然失效。
- **总线无法禁止两个进程共用一个 author——但折叠能看见。** `detectIdentityConflicts` 折叠心跳：同一 author 下两个存活 token 就是重复启动（检测代替禁止）。一个身份 = 一个进程。
- **服务端配置由环境变量驱动**（`antlegion-bus/src/config.ts`，redis.conf 对应物）：`PORT`（28090）、`HOST`（127.0.0.1）、`ANTLEGION_DATA_DIR`（`.data-v2`）、`ANTLEGION_FSYNC`（`always|everysec|no`，默认 `everysec`）、`ANTLEGION_BUS_SECRET`、`ANTLEGION_MAX_DEPTH`（64）。设置**稳定**的 `ANTLEGION_BUS_SECRET`——未设置时总线每次启动都会生成新的 HMAC 密钥，重启前写入的 `sig` 就无法再被验证。
- ESM（`"type":"module"`）；包内导入从 `.ts` 源使用显式 `.js` 扩展名。
- **规范安全规则已强制，而非只是文档（§4/§5）。** `append` 拒绝因果深度超过 `maxDepth` 的追加；parent *环*无需检查——内容寻址让它们从结构上不可构造。总线在密钥稳定时对恢复的每条事实验证 `sig`，并通过 INFO 暴露 `sig_failures`（`hash.ts:verifySig`，常时比较；HMAC 是对称的，所以只有总线/共享密钥的副本能验证，HTTP 客户端不能）。
- spawn 出来的 agent 子进程只拿到**白名单环境变量**；`ANTLEGION_BUS_SECRET` 与 `LARK_*` 即便写进 `spawn.envPass` 也一律不传。
- 文档按约定双语：**每个 `X.md` 都有 `X.zh-CN.md` 伴生文件**——要改就两边一起改，否则都别改。

## 参考文档

- `PROTOCOL.md` —— 协议（权威；§3 折叠为规范性）。`PROTOCOL.zh-CN.md` —— 完整中文版。
- `docs/QUICKSTART.md` · `docs/AGENT-CLI.md`（agent 如何通过 `alctl` 驱动总线）· `docs/FACT-MODEL.md` · `docs/EVOLUTION.md`（v0 运行时 → v1 → v2 一元论重构，以及 v1 为何被移除）· `docs/DOCKER-VERIFY.md` · `docs/proposals/`（待评审的设计方案）。
- `README.md` —— 概览、定位、仓库地图、已验证保证。`ant/README.md` —— DCU 模型、dev-chain 表格、监督看板。
- `research/` —— README 引用的第一方实测数据（竞争下的重复执行、伪造证据拦截）。`deploy/mvp/`、`toys/` —— 容器化的多 Agent 跑法。
