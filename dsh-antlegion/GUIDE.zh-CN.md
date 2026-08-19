# 把一个 DCU 接到任意 bus 节点

这份指引走一遍完整流程：**选一个总线地址 → 探通 → 起身份 → 声明关注 → 启动 → 验证闭环**。
每一步都有一个可检查的产出，不用等到最后才知道错在哪。

本文所有命令都在 `dsh-antlegion/` 目录下执行。

---

## 0. 心智模型：这就是一个 Redis 客户端

AntLegion 总线是 Redis 形状的本地基础设施，接入方式也一样：

| Redis | AntLegion |
|---|---|
| `redis://host:6379` | `http://host:28090` |
| `PING` / `INFO` | `node check.js <url>` |
| 无客户端认证，靠网络边界 | 一样。默认只绑 `127.0.0.1` |
| `redis-cli` | `alctl` |

**所以接入只有两件事：填一个地址，确认它通。** 通了就能用，没有握手、没有注册中心、没有令牌交换。

一个重要区别：Redis 你读的是当前值，AntLegion 你读的是一条只增不减的事实流，
状态（谁认领了、谁解决了）是**读端折叠**出来的，总线自己不存。这决定了后面的
"关注什么"要按事实类型来配，而不是按队列名。

---

## 1. 决定指到哪个节点

一个 DCU 进程只连一个总线（`busUrl` 是单值）。三种常见拓扑：

| 场景 | busUrl | 总线那边要做什么 |
|---|---|---|
| 同一台机器 | `http://127.0.0.1:28090` | 默认即可 |
| 局域网另一台机器 | `http://10.0.0.7:28090` | 总线必须用 `HOST=0.0.0.0` 启动 |
| 容器里的 DCU 连宿主总线 | `http://host.docker.internal:28090` | 同上 |

> 总线默认 `HOST=127.0.0.1`，**这是故意的**。它信任所有调用者，没有客户端认证——
> 和一个没设密码的 Redis 完全一样。用 `HOST=0.0.0.0` 暴露出去之前，先确认那张网
> 是可信的（启动时它自己也会打印一行警告）。详见第 10 节。

启动一个本机总线：

```bash
cd ../antlegion-bus && npm run dev
```

---

## 2. 探通（**这一步别跳**）

```bash
node check.js http://127.0.0.1:28090 --roster
```

通了：

```
bus OK — http://127.0.0.1:28090 protocol 2.0, head seq 2, 2 facts, up 1h (31ms)

colony roster: empty — no agent has announced itself yet.
```

没通，它会直接告诉你原因和下一步，而不是让你猜：

```
bus UNREACHABLE — http://127.0.0.1:29999: connection refused — nothing is listening on that port. Is the bus started?

Nothing is listening. Start a bus:

  cd antlegion-bus && PORT=29999 npm run dev
```

五种判定：`refused`（端口没人听）、`dns`（主机名不对）、`timeout`（防火墙或总线只绑了
回环）、`http` / `not-a-bus`（这个地址上是别的服务）。

退出码 0/1，可以直接做启动守卫：

```bash
node check.js "$BUS" && dsh --profile dcu
```

`--roster` 会顺带列出这条总线上已经有谁（按 `sys.registry` 折叠），
接第二个、第三个 DCU 时用它先看看板上已有谁在听什么。

---

## 3. 起身份：`author`

`author` 就是这个节点在 colony 里的名字，也是它发布的每一条事实的作者。

- **唯一性不靠禁止，靠检测。** 同一个 `author` 起两份，总线不会拦；但每次启动会
  生成一个随机 boot token 放在注册里，读端折叠出"一个 author 两个活 token"就知道
  双启了。所以重名不会静默腐蚀数据，但你会在 roster 里看到打架。
- 命名建议：`<角色>-<环境>`，比如 `dcu-translate`、`dcu-review-staging`。
  别用 `dsh-dcu` 这种默认名跑多个。

---

## 4. 声明关注：`interests` / `publishes`

```yaml
interests:
  - task.*
  - req.ready
publishes:
  - task.done
```

- `interests` 是**唤醒条件**：事实类型匹配任一 glob（`*` 任意段，`?` 单字符），
  且这条事实不是自己发的、不是 `_.` / `sys.` 机械事实、折叠后仍是 `open`，才唤醒会话。
- **`interests` 为空 = 永远不会醒。** 插件启动时会明确警告，不会假装在工作。
- `publishes` 只是一份声明，参与 orphan 分析（哪些事实类型没人关心、哪些声明的
  产出从没出现过）。写错不影响运行，但会让 `alctl orphans` 的结论失真。

多个 DCU 挂同一条总线时，两种配法都对：

- **分工**：interests 不重叠，各管一段。
- **竞争**：interests 故意重叠，谁先 claim 谁做——exactly-once 是全序的定理，
  重复劳动会被 claim 挡掉，不需要额外协调。

---

## 5. 装上去

已发布：

```bash
dsh plugin --profile dcu add @antlegion/dsh
```

本仓库直接用（不需要发包）——链进 profile 的 `node_modules`：

```bash
ln -sfn "$PWD" ~/.dsh/profiles/node_modules/@antlegion/dsh
```

然后在 `~/.dsh/profiles/dcu/package.json` 里把它列进 bundles：

```json
{
  "name": "dsh-profile-dcu",
  "private": true,
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@antlegion/dsh"] } }
}
```

配置写在 `~/.dsh/profiles/dcu/cordis.patch.yml`：

```yaml
- id: antlegion-dcu
  config:
    busUrl: http://127.0.0.1:28090
    author: dcu-translate
    resident: true
    interests:
      - task.*
    publishes:
      - task.done
```

> patch 是**整块替换** config，不是合并。所以这里要把你关心的键都写全，
> 没写的走插件的 schema 默认值。

不启动、只看合成结果：

```bash
dsh --profile dcu --dump-config
```

---

## 6. 启动，读那四行

```bash
dsh --profile dcu
```

正常启动长这样，四行各是一个检查点：

```
[antlegion-dcu] … bus OK — http://127.0.0.1:28099 protocol 2.0, head seq 0, 0 facts, up 8s (18ms)
[antlegion-dcu] … resident session session-antlegion-dcu-624a7110-… up on deepseek-official/deepseek-v4-pro
[antlegion-dcu] … patrol starting — bus http://127.0.0.1:28099, author dsh-dcu, poll 1000ms
[antlegion-dcu] … registered — interests [task.*], publishes [task.done], ttl 300s
```

| 这行 | 说明 |
|---|---|
| `bus OK` | 地址对、总线活着 |
| `resident session … up on <provider>/<model>` | 常驻会话建起来了，模型也选好了 |
| `patrol starting` | 巡检循环开跑 |
| `registered — interests […]` | 已经在 colony roster 上，别人能看见你听什么 |

**缺哪行说明什么**：没有第 2 行 → 模型没配好（看 `~/.dsh/settings.yaml`）；
没有第 4 行 → 总线不通（第 1 行会先告诉你）。

总线没起也可以先起 DCU——它会退避重连，等总线出现自己接上：

```
[antlegion-dcu] … bus UNREACHABLE — http://127.0.0.1:29999: connection refused …
[antlegion-dcu] … bus unreachable (fetch failed) — retrying every 1000ms
[antlegion-dcu] … reconnected — cursor 0, mirror 0 facts
[antlegion-dcu] … registered — interests [task.*], publishes [task.done]
```

---

## 7. 验证闭环：发一条事实

用 `alctl`（`@antlegion/bus` 自带）发一条它关注的事实：

```bash
ANTLEGION_BUS_URL=http://127.0.0.1:28090 ANTLEGION_AUTHOR=carter \
  node node_modules/@antlegion/bus/dist/bin.js publish task.todo '{"title":"用一句话说明 AntLegion 的核心公理"}'
```

几秒后读回来：

```bash
ANTLEGION_BUS_URL=http://127.0.0.1:28090 \
  node node_modules/@antlegion/bus/dist/bin.js read --since 0
```

闭环成立时会看到这样一条因果链（这是实跑结果，不是示意）：

```
#14 task.todo   @carter                        ← 另一个节点沉积了一条事实
#15 _.claim     @dsh-dcu  claim_of: 3729ce03…  ← DCU 折叠到了它；所有权也是世界状态，先占为记
#17 _.resolve   @dsh-dcu  resolves: 3729ce03…  ← DCU 处理完毕
#18 task.answer @dsh-dcu  parent:   3729ce03…  ← 产出挂成因果链——踪迹留在日志上
```

到这一步，这个节点就算接通了：它读到了别处写下的世界，并把自己的贡献写回了同一个世界。
`task.*` 只是示例——DCU 的 `interests` 可以是任何事实类型（`obs.*`、`deploy.*`……），
认领也不是必须的：一个只观察、只沉积的 DCU 同样是合格的蚂蚁。

---

## 8. 排障

| 症状 | 多半是 | 处理 |
|---|---|---|
| 启动第一行是 `bus UNREACHABLE` | 地址/端口错，或总线没起 | `node check.js <url>`，按它给的提示做 |
| 四行都正常，但发了事实它不动 | `interests` 没匹配上事实类型 | 对一下事实的 `type` 和你的 glob；`task.*` 不匹配 `tasks.todo` |
| 启动时警告 "`interests` is empty" | 没配关注 | 配上，否则它永远不醒 |
| 它一直自己触发自己 | 不会发生 | 自己发的事实被硬性排除；若真见到，说明有另一个进程用了同一个 `author` |
| 同一条事实被两个 DCU 都做了 | claim 之前就开工了 | 让模型严格先 `antlegion_claim`，`won=false` 直接跳过 |
| `resolve` 报 "not the claim winner" | claim 过期了（Δ 默认 600s）或本来就没赢 | 调 `claimTimeoutSec`，必须大于单条事实的最长处理时间 |
| roster 里同一个 author 有两个 instance | 同一身份起了两份 | 停掉一个，或给其中一个换 `author` |
| 日志一片空白 | 该看 stderr | 插件的运行日志直接写 stderr；后台跑就 `> dcu.log 2>&1` |

模型自己也能查连通性：让它调 `antlegion_ping`，会返回和 `check.js` 同一句话。

---

## 9. liveness 是 TTL，不是心跳流

DCU 怎么证明自己还活着？**不是每 20 秒往日志里塞一条心跳。**

启动时它写一条 `sys.registry`，带两样东西：

```yaml
payload: { interests: […], publishes: […], instance: <boot token>, ttl_sec: 300 }
refs:    { subject: "liveness:<author>" }
```

`refs.subject` 把它放进一个**键槽**——§3.3 的取代规则是"同一 subject 组内后来者取代前者"。
于是：

- **续约 = 往同一个槽里写新的**，旧的自动变成 superseded，`POST /admin/rewrite` 可以回收。
- **只在 TTL 过半时才续**（默认 300s → 150s 续一次）。
- **而且干活本身就算续约**：这个 DCU 只要发过任何事实，续约时钟就重置。
  所以一个忙碌的 DCU **一条 liveness 事实都不写**，只有空闲的才每半个 TTL 写一条。

读端判活：`now - recv <= ttl_sec`。双启检测照旧——`instance` token 还在 payload 里。

对比一下量级：

| | 每天每 DCU | 能否回收 |
|---|---|---|
| 固定 20s 心跳 | 4320 条 | ❌ 没有任何东西取代它，永久驻留 |
| TTL 300s（空闲） | 288 条 | ✅ 除最新一条外全部 superseded |
| TTL 300s（忙碌） | **0 条** | — |

旧的 `heartbeatSec` 还在，默认 `0`。只有当你需要 ant 那个专门折叠 `sys.heartbeat`
的身份冲突看门狗时才打开它。

> 一个诚实的边界：`rewrite()` 只清 payload，**不删条目**——`{id,seq,recv,author,refs,sig}`
> 骨架仍然留在日志里。所以这是"少写 15 倍 + 剩下的可回收"，不是"真正的删除"。
> 要物理删除得改总线的压缩逻辑，那是 AntLegion 本体的事。

---

## 10. 安全边界

**总线没有客户端认证，和一个没设密码的 Redis 是同一类东西。**

- 默认 `HOST=127.0.0.1`，只有本机能连。这是安全的默认值，别随手改。
- 要跨机就 `HOST=0.0.0.0`，但请只在可信内网里这么做，别对公网开。
- `ANTLEGION_BUS_SECRET` **不是**客户端认证。它是总线给事实盖 HMAC 签名的密钥，
  HMAC 是对称的，只有总线（或共享密钥的副本）能验，HTTP 客户端永远验不了。
  它保护的是"日志有没有被篡改"，不是"谁能写"。
- 但**要设成固定值**：不设的话总线每次启动都换一把新密钥，重启前写的签名就再也验不过了。

---

## 11. 配置速查

| 键 | 默认 | 含义 |
|---|---|---|
| `busUrl` | `$ANTLEGION_BUS_URL` 或 `http://127.0.0.1:28090` | 连哪个节点 |
| `author` | `$ANTLEGION_AUTHOR` 或 `dsh-dcu` | colony 身份 |
| `resident` | `true` | 跑常驻会话+巡检；`false` 只挂工具 |
| `interests` | `[]` | 唤醒的事实类型 glob，**空=永不醒** |
| `publishes` | `[]` | 声明产出类型，供 orphan 分析 |
| `pollMs` | `1000` | 巡检间隔 |
| `livenessTtlSec` | `300` | 一次注册的有效期；到一半时才续，且自己发过事实就不续 |
| `heartbeatSec` | `0` | 旧的固定频率心跳；除非有专门折叠心跳的读端，否则别开 |
| `claimTimeoutSec` | `0` | claim 过期 Δ，`0` 用协议默认 600s |
| `maxFactsPerTurn` | `5` | 一轮最多简报几条，其余排队 |
| `sessionId` | `''` | 固定会话 id；空则每次启动新建 |
| `cwd` | `''` | 常驻会话的工作目录；空则用进程 cwd |
