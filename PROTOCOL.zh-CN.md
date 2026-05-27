<div align="center">

[English](PROTOCOL.md) · 🌐 **简体中文**

</div>

# AntLegion 协议 —— v2.0

> 一个本原。一次写。一次读。其余一切皆由其推导。
>
> 由 **Carter.Yang** 设计，2026 年从第一性原理重新推导。

本文关键词 **必须（MUST）**、**不得（MUST NOT）**、**应（SHOULD）**、**可以（MAY）** 遵循
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119)。

---

## 0. 推导过程（v2 为何如此）

### 0.1 唯一本原（一元论）

系统里只存在一种东西：

> **一条 Fact：不可变、内容寻址的陈述，置于单一全序中的一个唯一位置。**

这就是全部本体论。没有独立的「任务」「认领」「投票」「信任级别」「状态」——那些词只是
*事实的模式*；事实是一切。这是一元论的一步，下面每条规则都是它的*推论*，而非附加项。

只有两个操作作用于本原，仅此两个：

- **append(fact) → seq** —— 追加一条事实；总线为它分配全序中的下一个位置。
- **read(since_seq) → fact[]** —— 返回某位置之后的事实，按序。

### 0.2 总线是什么（不是什么）

由本原出发，总线**必须**提供的可信内核又小又固定：

1. **有序** —— 分配严格递增的 `seq`。这个全序是总线*唯一*的权威。
2. **完整性** —— 校验 `id == hash(record)`；不符则拒绝。
3. **持久** —— 追加到一个能跨重启存活的日志。
4. **区间读** —— 按序返回 `seq > since`。

总线**没有 per-fact 可变状态**，没有状态机、没有认领表、没有信任计算、没有派发、没有
仲裁、没有推送。它是一条*可验证、全序、只追加的日志*——能在其上推导出其余一切的最小对象。
（类比：一个签名的 Kafka 单分区，或带序号的 git。）

> **不裁决公理。** 总线为事实排序并保存。它从不裁决它们的*含义*。含义由读者计算（§3）。
> 这正是信任、生命周期、独占性都是读者折叠、而非服务端状态的原因。

### 0.3 其余一切，皆由推导

| v1 概念 | v2 推导 |
|---|---|
| 工作流状态（`published/claimed/resolved/dead`） | 对引用目标的 claim/resolve/tombstone 事实做**折叠** |
| `epistemic_state` + quorum 配置 | 对 `vote` 事实做**折叠**；quorum 是*读者*的策略 |
| 原子 `claim` 端点 + 仲裁 | 追加一条 `claim` 事实；**引用目标的 seq 最小者获胜**——恰好一次是全序的定理 |
| `supersedes` / 自动取代索引 | 事实携带 `supersedes`；读者按 subject 保留 seq 最高者 |
| `causation_chain` + `causation_depth` | 走 `parent` 链；深度是算出来的，不存储 |
| TTL → `dead` 转换 | 读者侧过滤 / 压缩提示；绝非服务端状态变更 |
| 接受过滤 / 派发 | 读者侧查询谓词（服务端**可以**作为纯读优化提供） |
| 事件推送 / WebSocket | 移除；读取推进游标 |
| `semantic_kind`、`schema_version`、`priority`、`confidence`、TEC、reliability | 可选的 payload/ref 提示；可信内核**一概不解释** |

事实的线格式从约 30 个字段缩到一小撮（§1）。两套服务端状态机消失。「智能」逻辑移入
每种语言只写一次的**客户端折叠库**（§3），而非在每个总线实现里重写。

**优雅去了哪。** v1 的 MCP 适配器靠*转发*保持优雅（调 `/claim`，拿 200/409）。v2 下适配器
必须*折叠*（追加一条 claim、读回确认、投影出 state/trust）。客户端表面（如 6 个 MCP 工具）
可以保持一样简单，但这只因为适配器/折叠库现在吸收了这份工作。v2 让**总线**变简单、让
**适配器**略变重；跳过适配器的裸客户端则用「追加 + 折叠」换掉了一次特殊往返。这是把
复杂度**刻意搬到**唯一能写一次、又能被一致性测试覆盖的地方，而非删除它。

---

## 1. 事实（The Fact）

```jsonc
{
  "seq":     1337,                  // 总线分配的全序位置。追加前不存在。
  "recv":    1748300000.4,          // 总线分配的可信接收时间（unix 秒）。基于时间的折叠必须用此字段。
  "id":      "b3f1…",               // = hash(canonical record)（§4）。内容地址。必须存在。
  "type":    "build.failed",        // 点分类型。必须存在。
  "author":  "claude-code",         // 发布者。必须存在。
  "ts":      1748300000.0,          // unix 秒，作者声明。仅供参考（可被伪造）。必须存在。
  "payload": { "...": "..." },      // 任意 JSON。必须存在（可以为 {}）。
  "refs":    { "...": "..." },      // 到其他事实的链接——唯一的关系机制。可以缺省。
  "nonce":   "k7…",                 // 可选的唯一化 token：让一次合法的重复（如重新认领）得到不同的 id（§4）。可以缺省。
  "sig":     "hmac…"                // 总线对 (id, author, type, ts, recv, seq) 的签名。由总线设置。
}
```

`refs` 是所有关系的居所。已定义的键：

| `refs` 键 | 值 | 含义（由读者折叠解释） |
|---|---|---|
| `parent` | 事实 id | 本事实由该事实因果派生。因果 = 传递性 `parent`。 |
| `claim_of` | 事实 id | 作者主张对目标的独占责任。 |
| `resolves` | 事实 id | 目标已被处理；payload 可以携带结果。 |
| `release_of` | 事实 id | 作者放弃之前的认领。 |
| `vote` | 事实 id | 结合 `payload.verdict ∈ {corroborate, contradict}`。 |
| `supersedes` | 事实 id | 目标被**后继者取代**（本事实）。 |
| `subject` | 字符串 | 无需命名 id 的「最新胜出」取代的分组键。 |
| `tombstones` | 事实 id | `_.tombstone` 将目标标为**已删除 / 已 GC**——区别于 `supersedes`（意为*替换*）。折叠**必须**区分两者。 |

总线**必须**接受未知的 `refs` 键（前向兼容），且**不得**解释它们——只有读者才这样做。
可信内核查看 `refs.parent` *仅*为了强制唯一的结构安全规则（§5，深度/环），此外不作他用。

**`ts` vs `recv`。** `ts` 是作者*声明*的时间；它是内容哈希的一部分，**仅供参考**（一个偏斜
或恶意的时钟可以将其设为任意值）。`recv` 是总线*见证*的，已被签名，**可信**。
每个基于时间的折叠（认领超时 §3.1、TTL）**必须**以 `recv` 为准，绝不用 `ts`——
否则不同读者会得出不同结论，折叠就不再具有确定性。`seq` 和 `recv` 是总线的两个可信戳记：
`seq` 用于排序，`recv` 用于时间。

v1 事实中被移除的一切（state、claimed_by、corroborations[]、effective_priority……）现在都
**可推导**，因此**不得**存储在事实上。`priority`、`confidence`、`ttl`、`semantic_kind` 等——
如果某个用例需要它们——住在 `payload` 里，只有关心它们的读者才予以采纳。

---

## 2. 总线操作（全部线面）

### 2.1 追加（Append）

```
POST /facts
  { type, author, ts, payload, refs?, id? }
→ 201 { seq, id, sig }            // id/sig 回显；id 可以发送为 "" 让总线计算
→ 409 { error: "id mismatch" }    // 完整性校验失败
```

追加是唯一的写操作。总线分配 `seq`、验证/派生 `id`、签名、持久化、返回。
无模式、无 token 门控的认领、无优先级。（鉴权若有，属传输层关切——见 §6。）

### 2.2 读取（Read）

```
GET /facts?since=<seq>&limit=<n>&type=<glob>&author=<id>&refs.<key>=<id>
→ 200 [ fact… ]                   // 按 seq 升序
   header: X-Max-Seq: <返回的最高 seq>
```

`since` 是游标：将上次的 `X-Max-Seq` 传回以只获取新事实。
这是*规范*的访问模式——更接近 `git fetch` 而非队列。
所有查询参数都是**对同一全序流的纯过滤**；它们改变返回哪些事实，绝不改变其含义或顺序。
一个最小合规的总线**可以**忽略除 `since`/`limit` 以外的所有过滤器，仍然保持正确性——
过滤是优化，折叠（§3）才是语义。

```
GET /facts/head → { head_seq }    // 启动一个「只取最新」的新读者
GET /facts/<id> → fact            // 按内容地址获取单条事实
```

这就是完整的总线 API：**一次写，一次读，两个读便捷接口。**

---

## 3. 读者折叠（意义所在）

读者以 `seq` 顺序重放事实，并将其折叠成所需的任意投影。这些折叠规则是**规范性的**——
合规性在这里体现，而非在总线里。以相同方式折叠的两个读者始终达成一致，因为它们消费
同一个全序、不可变的流。

### 3.1 目标事实 F 的生命周期

扫描所有 `refs` 指向 F 的事实：

以 `seq` 顺序对引用 F 的事实做折叠，维护**活跃认领**集合（尚未释放或超时的认领）。
**`resolved` 和 `dead` 是终态**——在其事实出现时决定，永不重访：

```
fold(F):
  active ← []                       # 仍持有 F 的认领，各为 {author, seq, recv}
  for fact in (引用 F 的事实，按 seq 升序):
    if tombstone(F)                       → 返回 dead                       # 终态
    active ← [c ∈ active where fact.recv ≤ c.recv + Δ]   # 确定性超时，以 recv 为锚
    if fact.refs.claim_of   == F          → active.push(fact)
    if fact.refs.release_of == F          → 从 active 中移除 fact.author
    if fact.refs.resolves   == F:
        owner ← active 中 seq 最小的 author（或 null）
        if fact.author == owner or owner == null  → 返回 resolved(owner)    # 终态
  active ← [c ∈ active where now ≤ c.recv + Δ]           # 末尾超时 vs 墙钟
  返回 active ? claimed(active 中 seq 最小的 author) : open
```

**为何以 recv 为锚的超时。** 一个认领超时（崩溃恢复路径）发生在时间已被证明越过
`claim.recv + Δ` 时。只要存在*后续事实*，该证明就是后续事实自身总线盖的 `recv`——
对每个读者都相同，因此折叠**具有确定性**。只有*末尾*的认领（无后继者）才回退到墙钟
`now`，而这只影响「新认领者是否该尝试」这一建议性提示，绝不影响终态决定。

这就是崩溃恢复在两个方向上都正确的原因：
- 在其认领超时*之前*发出的 `resolve` 被采纳并永久终止——超时（崩溃恢复机制）绝不
  撤销真实的完成。
- 已超时的认领被下一个认领的 recv 所超时，使**重派**的 Agent 成为合法 owner，
  它的 `resolve` 也因此被采纳。（「owner = 首个认领者，只有 release 能释放」的朴素规则
  是错的：崩溃认领者陈旧的认领会阻塞恢复 Agent 的 resolve，工作项将被反复重做。）

**独占协调是定理，而非锁。** 若多个 author 追加 `claim_of: F`，**seq 最小**者获胜——
每个读者从同一全序、recv 盖章的流中计算出相同的赢家。无原子端点、无 leader 选举、
无热路径仲裁。认领者通过读回 F 的认领集、确认没有更低 `seq` 的存活 `claim_of: F` 来确认
自己获胜；为使这一操作是 O(F 上的认领数) 而非 O(log)，总线**应**支持
`?refs.claim_of=<id>` 过滤器（§2.2）。基于超时的释放之所以确定性，**恰恰是因为它以
总线盖章的 `recv` 为准**，而非作者的 `ts`；认领作者发出的 `release_of` 则无论 Δ 如何
都立即终止认领。

**`resolve` 由折叠授权**：`resolves: F` 仅从 F 当前认领赢家处被采纳。这阻止了非认领者
将别人的认领工作标记为完成。（对于从未被认领的广播事实，任何 author 均可 resolve，
且 seq 最小的 resolve 胜出。）

### 3.2 事实 F 的信任

对引用 F 的 `vote` 事实做折叠。读者**必须**忽略自投票
（`vote.author == F.author`），且**必须**只计每位 author 的**最新**投票（最高 `seq`），
确保改变主意的投票者不被重复计算：

```
trust(F, quorum):                       // quorum 是读者的选择，默认 2
  C = latest-vote 为 corroborate 的 author 数
  X = latest-vote 为 contradict 的 author 数
  if superseded(F)         → superseded  // 新鲜度压过可信度
  elif |X| ≥ quorum        → refuted
  elif |X| > 0             → contested
  elif |C| ≥ quorum        → consensus
  elif |C| > 0             → corroborated
  else                     → asserted
```

总线不存储这些。不同读者**可以**选择不同的 quorum——总线不裁决真相（§0.2）。信任
**不**自动传播到子孙；关心某条链整体有效性的读者需自行走 `parent` 并逐一检查祖先。

**信任没有全局值，所以绝不要用它来协调。** 由于 quorum 是读者的选择，两个读者对 F 是
`refuted` 还是 `consensus` 可以合法地意见不一。所有参与者必须达成一致的决定——谁来做、
是否推进——**必须**建立在独占认领之上（seq 确定性，§3.1），后者每个读者计算相同。
信任适用于*建议和分诊*，不适用于仲裁。

### 3.3 取代（Supersession）

对共享 `refs.subject`（或由 `refs.supersedes` 链接）的事实，读者保留 **seq 最高**者为当前，
其余投影为 `superseded`。最新胜出因此是一种*读者策略*：积累多源观察的读者只需不应用它。
（v1 的自动 supersede 脚枪已消失——没有服务端索引静默地替换事实。）

### 3.4 因果（Causation）

`chain(F)` = 传递性地追随 `refs.parent` 到根。深度 = 链长。
由于事实不可变，只能通过显式 `tombstone`（§5.2）被移除，一条链绝不会静默地失去祖先——
读者遇到已被 tombstone 的祖先时，看到的是 tombstone，而非空白。

---

## 4. 身份与完整性

`id` 是内容地址：`id = sha256(canonical(record))`，其中 canonical record 是
`{type, author, ts, payload, refs, nonce}` 的 JSON 对象（仅当 `nonce` 存在时包含），
键递归排序，浮点数渲染含尾随 `.0`（兼容 Python `json.dumps`）。`seq`、`recv`、`sig`
及 `id` 本身被排除——它们是总线赋值，不是内容。

内容寻址免费提供去重，但有一个尖锐的边缘，协议以**唯一**一种方式显式解决：
**追加对 `id` 幂等。** 总线维护 `id → seq` 索引（从日志恢复时重建——纯投影，非权威状态）；
追加一个已存在的 `id` 返回现有的 `{seq, recv, sig}`，**不**写入第二份。「重发是安全的」
因此是默认行为。推论：*合法的重复*——在 release 后重新认领 F——否则会坍缩回原始，
所以想要真正**新**的动作的客户端**必须**让内容不同，通常是设置新的 `nonce`（§1）。
关系事实（`_.claim`、`_.resolve`、`_.vote`）**应**始终携带 `nonce`。
这与内容寻址存储（如 git）的模型完全一致：相同内容是同一个对象；改变内容才得到新对象。

总线对每条接受的事实签名：`sig = hmac_sha256(secret, "id|author|type|ts|recv|seq")`。
验证者重新计算该 HMAC 并与 `sig` 做常时比较；由于密钥是对称的，**只有持密钥者才能
验证**——总线在恢复时（`sig` 不符意味着日志被篡改或用了不同 secret 写入），或共享
secret 的只读副本可以。未经认证的 HTTP 读者无法验证 `sig`；对它而言，内容地址 `id`
是完整性检查，`seq`/`recv` 则通过信任总线来获得。
运营者**必须**设置稳定的 `ANTLEGION_BUS_SECRET`，以便签名跨重启仍可验证。一个**规范的
跨语言一致性向量集**随协议一起交付；任何实现（TS、Python、Go……）**必须**逐字节复现其
哈希值。这个向量集——而非散文——才是互操作契约。

---

## 5. 总线强制的唯一安全规则

刻意保持最小：恰好足以防止只追加日志被武器化为无限增长或出现环。其余一切是读者的关切。

1. **完整性** —— 拒绝 `id` ≠ `hash(record)`（§4）。
2. **因果深度** —— 拒绝因果深度（通过走 `parent` 计算）超过配置上限（默认 64）。
   **`refs.parent` 的环在内容寻址下从结构上不可构造**——闭合 A→B→A 的环需要在对 A
   进行哈希之前就知道 A 的 `id`（即 sha256 原像），因此只有深度是可强制的，且深度遍历
   永远终止。
3. **接入速率** —— 总线**可以**施加 per-author token bucket 与全局速率上限来约束日志
   增长。拒绝是「未写入的事实」，绝非状态变更。

### 5.2 删除即事实

总线从不修改或静默丢弃已存储的事实。移除本身是一条追加的 `tombstone` 事实
（`type: "_.tombstone"`，`refs.tombstones` → 目标）。删除使用专属的 ref 键，绝不复用
`supersedes`：supersede 意为*后继者取代了它*；tombstone 意为*它消失了*。折叠（生命周期
§3.1、信任 §3.2）**必须**区分两者——已 GC 的事实是 `dead`，而非 `superseded`。
压缩（§7）**可以**物理丢弃事实的 *payload*，但**必须**保留其完整骨架——
`{id, seq, recv, author, refs, sig}`——因为每个折叠都依赖它：因果遍历需要 `refs.parent`；
认领赢家需要 `seq` + `author` + `refs.claim_of`；信任需要 `author` + `refs.vote`。
丢弃 `refs` 或 `author` 会摧毁折叠所基于的关系。保留骨架是 v2 在压缩后仍能保持
因果和协调持久性的方式。

---

## 6. 鉴权（传输层，可选）

v1 将 token 烘焙进 claim/resolve。v2 将 per-operation 鉴权从语义中移除：由于独占性由
`seq` 顺序决定，*谁*认领只是 `author`，鉴权纯粹是「这个 author 是否是他们自称的那个人」。
这是一个**传输层关切**（mTLS、网关、API key header），超出事实模型的范围。
部署**可以**在受信网络上开放运行总线，或置于一个为 `author` 盖章/校验的认证代理后面。
协议不强制要求某种方案，但公网部署**应**认证 `author`，且**不应**在未经认证的情况下
暴露写访问。

---

## 7. 存储与恢复

总线是一个只追加日志（每行一个 JSON 记录，每次追加或每批 fsync）。
恢复：按序读取日志；遇到撕裂的末尾记录时，截断到最后一个可解析的字节偏移，然后继续追加。
**没有需要重建的内存状态机**——日志*就是*状态，`seq` 从最后一条记录恢复。这是 §0.2 的
可靠性红利。

压缩将日志折叠成检查点：对当前投影做快照（可选，派生，绝非权威）并丢弃已取代/已
tombstone 的事实的 *payload*，同时保留完整的 `{id, seq, recv, author, refs, sig}` 骨架
（§5.2）。压缩**必须**使用临时文件 + 原子重命名。

**全序 ⇒ 单一逻辑写入点。** `seq` 是一个全局序列，所有写操作都汇聚到单一逻辑追加点。
高可用因此是*单写者加故障切换*（例如 Raft 复制追加位置），**不是**多主——
无法在不丢失恰好一次保证（§3.1）的情况下合并两个独立的顺序。读操作可以在日志副本上
自由横向扩展。真正需要多地域写入的部署必须按独立总线分片（例如按 `type` 或 `subject`），
各有其自己的顺序；跨分片协调此时是客户端的关切，不是总线的。

总线**可以**提供**物化视图**（`GET /facts/<id>/state`、`/trust`……）作为 §3 折叠的缓存。
此类视图是便捷功能，**必须**与从头折叠的结果逐位相同；它们绝不是第二真相来源。

---

## 8. 默认值

| 参数 | 默认值 | 备注 |
|---|---|---|
| 因果深度上限 | 64 | §5 —— 慷慨；环才是真正的风险，深度不是 |
| 读者 quorum（信任） | 2 | §3.2 —— 读者策略，非服务端配置 |
| 认领超时（基于 recv） | 600 秒 | §3.1 —— 总线盖章的 recv 比此值更老的认领折叠为已释放 |
| Per-author 速率（若启用） | 20 突发 / 5 每秒 | §5 |
| 日志 fsync | 每次追加 | 可换成每批以降低高负载下的延迟 |

注意这些大多是**读者**或**运营者**的旋钮。可信内核几乎没有什么可配置的——这是 §0.2 的
另一个推论。

---

## 9. v1 → v2 映射（供迁移者参考）

| v1 | v2 |
|---|---|
| `POST /facts {mode, priority, ttl, …}` | `POST /facts {type, author, ts, payload, refs}` |
| `POST /facts/:id/claim` | `POST /facts { type:"_.claim", refs:{claim_of:id} }` |
| `POST /facts/:id/resolve {result_facts}` | `POST /facts { type:"_.resolve", refs:{resolves:id} }` + 子事实带 `refs.parent:id` |
| `POST /facts/:id/corroborate` | `POST /facts { type:"_.vote", payload:{verdict:"corroborate"}, refs:{vote:id} }` |
| `GET /facts?state=published` | `GET /facts?since=N` 然后客户端侧折叠 §3.1（或打一个物化视图） |
| fact.`state` / `epistemic_state` | `fold(stream)` §3 |
| ant 连接 / 心跳 / TEC | 移除；`author` 是自由字符串，可靠性若需要则是对结果做读者折叠 |

v1→v2 的 shim 可以以读者身份运行：折叠 v2 流并重新暴露 v1 REST 表面供遗留客户端使用，
无需对可信内核做任何改动。

---

## 10. 血统

| 来源 | v2 取用之处 |
|---|---|
| **事件溯源 / CQRS** | 日志是唯一真相；状态是投影 |
| **Git** | 内容寻址、不可变、只追加；按游标 `fetch` |
| **Lamport / 全序** | 恰好一次的独占性作为顺序的*定理* |
| **CAN 总线** | 内容寻址广播 + 本地（读者）过滤 |
| **科学方法** | 可被挑战的事实（佐证/反驳），无中央仲裁者 |

---

*协议 v2.0 由 Carter.Yang 设计。总线排序并保存；读者裁决含义。把可信内核保持得足够小，
让第二个实现是一个周末的事，并让一致性向量——而非散文——来保证互操作。*
