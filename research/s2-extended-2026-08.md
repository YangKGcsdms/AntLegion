# S2 扩展实验轮：M5 / M6 / M8 的可复现测量（2026-08）

`research/s2-experiments-2026-08.md` 留下的三笔欠账在这里补齐：实验二（崩溃接管）
只有单次触发、实验三（伪造拦截）只有单轮注入、时钟偏移轮（宪章 M5 的隔离场景子项）
完全没做。指标口径见 `.cowork/11-隔离协作评估指标.md`（M5 跨界恰好一次·时钟偏移
容忍；M6 断连恢复时延分布；M8 seeded-error 拦截）；被测协议属性是
`PROTOCOL.md` §3.1 的 recv 锚定认领过期。所有数字各自一条命令复现（无 API key、
无 docker，总线在 29xxx 端口段自起自灭，数据目录在 tmp、成功后自动清理）：

```bash
cd ant
npx tsx experiments/exp2-repeat.ts       # M6：10 次 kill→过期→接管→完成，≈5 分钟
npx tsx experiments/exp5-clock-skew.ts   # M5：三臂时钟偏移对照，≈15 秒
npx tsx experiments/exp8-repeat.ts       # M8：5 轮伪造注入，≈10 秒
```

结果 JSON 落在 `ant/experiments/results/s2ext-{exp2,exp5,exp8}-latest.json`。

## M6 重复轮：崩溃接管时延分布（exp2-repeat）

**假设**：实验二的单次触发不是运气——kill→过期→接管→完成的时延由
Δ、轮询周期、副本负载三个参数预算，重复 N 次应得到窄分布，且双执行恒 0。

**装置**：每次迭代全新总线（29200+i）+ 三个独立 OS 进程：support（plan/unittest/
e2e DCU + adjudicator + gate-approver）、dev-a（`dcu-dev@devchain`）、dev-b
（`dcu-dev-r1@devchain`，独立身份副本）。喂 1 条需求；谁先赢下 `plan.ready` 的
认领（最小 seq），谁的**整个进程组**在工作中途被 SIGKILL（dev 工时 4s，
`ANT_CLAIM_DELTA=6` > 工时；harness 盯流开枪，认领后 ≈0.2s 击发）。之后 harness
只旁观：认领在总线时钟 `claim.recv + Δ` 过期 → 幸存副本折叠出 `open` → 重新
认领 → 完成全链。时延全部取自总线盖章的 `recv`（kill 时刻是 harness 墙钟，
同一台机器，可比）。

**结果**（2026-08-13，macOS，Node 22，simulated act，N=10，单位 s）：

| 区间 | min | p50 | p95 | max |
|---|---|---|---|---|
| 过期 → 接管认领（M6 主口径） | **0.02** | **0.03** | **1.00** | **1.00** |
| kill → 接管认领 | 5.92 | 5.96 | 6.91 | 6.91 |
| kill → 幸存者 resolve | 9.93 | 9.98 | 10.92 | 10.92 |
| kill → 全链 4 阶段 done | 18.54 | 20.05 | 21.19 | 21.19 |
| 认领 → kill（装置口径，非被测） | 0.04 | 0.08 | 0.11 | 0.11 |

| 核对项 | 结果 |
|---|---|
| 双执行（同 (req,stage) >1 个产物） | **0 / 10 次迭代** |
| 被杀身份分布 | 6× `dcu-dev`、4× `dcu-dev-r1`（谁先赢谁挨枪） |

**结论**：接管时延无隐藏项，逐项可预算——kill→接管 p50 5.96s ≈ (Δ=6s − kill 前
已耗的 ~0.08s 认领时间) + 幸存者轮询相位（实测过期→接管 0.02~1.00s，正是 1s
轮询周期的相位分布）；kill→resolve p50 9.98s = 接管 + 4s 工时。10 次崩溃零双执行
——victim 全部死在 resolve 之前，认领过期后所有权干净转移。实验二单次触发的机制
解释成立，且这次是分布不是轶事。

## M5 时钟偏移轮：折叠只看 recv，作者时钟无关（exp5-clock-skew）

**假设**（PROTOCOL.md §3.1 的字面属性）：`ts` 是作者自报的咨询字段，所有时间性
折叠（认领过期、胜者判定、生命周期）只锚在总线盖章的 `recv` 上——一台节点时钟
拨快/拨慢 5 分钟，折叠结果应与时钟正常的对照轮**逐字节一致**。

**装置**：三条独立总线（29240~29242）重放同一份确定性编排，唯一差异是
`worker-skew@exp5` 身份的 `ts` 偏移（control 0 / fast +300s / slow −300s）。
三个工作单元覆盖三类时间性判定（Δ=2s）：U1 竞争胜者（skew 先认领、honest 后
认领）；U2 过期边界（在 `claim.recv+1.0s` 与 `+2.5s` 两个确定性评估点折叠）；
U3 崩溃接管（skew 认领 → 真实等 3s → honest 认领，其 recv 即过期证明 → skew
僵尸 resolve → honest resolve）。每臂把全部折叠结果投影成 canonical JSON 后
sha256 对比。

**结果**（2026-08-13）——三臂对照表，每格为 `折叠输出`：

| 折叠探针 | control | fast(+300s) | slow(−300s) | 一致 |
|---|---|---|---|---|
| U1 竞争胜者（两认领在场时） | worker-skew | worker-skew | worker-skew | ✓ |
| U1 终态生命周期 | resolved/worker-skew | resolved/worker-skew | resolved/worker-skew | ✓ |
| U2 生命周期 @claim+1.0s（Δ=2） | claimed/worker-skew | claimed/worker-skew | claimed/worker-skew | ✓ |
| U2 生命周期 @claim+2.5s（Δ=2） | open | open | open | ✓ |
| U3 过期后胜者（接管时点） | worker-honest | worker-honest | worker-honest | ✓ |
| U3 终态（僵尸 resolve 被忽略?） | resolved/worker-honest | resolved/worker-honest | resolved/worker-honest | ✓ |

| 核对项 | 结果 |
|---|---|
| 三臂折叠投影 sha256 | `8e8e8a7d…d61e` 三臂全同 → **逐字节一致 ✓** |
| 偏移真实存在（skew 身份 mean(ts−recv)） | control 0.00s / fast **+300.00s** / slow **−300.00s** |
| skew 身份事实 id 与对照臂不同 | 是（内容寻址——输入确实不同，只是折叠语义相同） |

**结论**：作者时钟拨到 5 分钟外，六个时间性判定一个都没动——包括最刁的一条：
拿着"未来时间戳"的僵尸 resolve 在认领过期后依然被折叠忽略，所有权判给接管者。
"跨隔离节点不需要时钟同步"在这里不是工程妥协而是协议属性：`ts` 根本不在
折叠的输入里。

## M8 重复轮：伪造报告拦截率稳定性（exp8-repeat）

**假设**：实验三的 8/8 单轮拦截可跨轮稳定复现——裁决者是确定性形状校验，
本轮验证的是**管线**在多轮注入下的稳定性（跨轮无 dedup 串扰、无乱序漏裁、
无误杀漂移），不是校验函数本身会不会变卦。

**装置**：一条总线（29260）+ 进程内原装 `dcu-adjudicator@devchain`（跨轮同一
实例）。探针集与 exp3 逐字对齐（8 种形状残缺 + 4 种形状完整对照），重复 5 轮，
每轮换 `nonce` 与带轮次的 `reqSlug`（内容寻址下 id 全新；脚本断言无一被 dedup）。

**结果**（2026-08-13）：

| 轮 | 拦截 | 漏网 | 误杀 | 未裁决 |
|---|---|---|---|---|
| r1 | 8/8 | 0 | 0/4 | 0 |
| r2 | 8/8 | 0 | 0/4 | 0 |
| r3 | 8/8 | 0 | 0/4 | 0 |
| r4 | 8/8 | 0 | 0/4 | 0 |
| r5 | 8/8 | 0 | 0/4 | 0 |
| **合计** | **40/40 = 100%** | **0** | **0/20 = 0%** | **0** |

**结论**：拦截率/误杀率零方差。60 条注入（40 伪 + 20 对照）全部拿到裁决，
每条拒绝依旧带缺失字段清单，链上可审计。

## 复现与文件清单

```bash
cd ant
npx tsx experiments/exp2-repeat.ts [--n 10] [--delta 6]   # M6
npx tsx experiments/exp5-clock-skew.ts                     # M5
npx tsx experiments/exp8-repeat.ts [--rounds 5]            # M8
```

新增脚本（全部在 `ant/experiments/`，只加不改）：`s2ext-lib.ts`（总线/子进程/
分布统计共用件）、`exp2-repeat.ts` + `exp2-node.ts`（M6 harness + 复用原装 DCU
的节点进程）、`exp5-clock-skew.ts`（M5 三臂）、`exp8-repeat.ts`（M8 重复轮）。

## 没做什么 / 没测什么（如实申报）

- **进程 ≈ 容器，kill ≈ 断连。** "节点崩溃"是本机进程组 SIGKILL，不是 docker
  容器死亡或网络分区；对认领过期语义两者等价（bus 看到的都是"该身份再无后续
  事实"），但没有覆盖"进程活着但网络断了"的半开连接场景。附带一个装置教训：
  tsx CLI 是包一层的 wrapper，SIGKILL 打在 wrapper 上真正的 worker 进程还活着
  ——首个版本因此测出"victim 被杀后照常 resolve"；现版本以进程组（detached +
  `kill(-pid)`）整组击杀。这也算 M6 的一个免费旁证：只要 victim 还有一口气，
  它 4s 后的 resolve 依然有效（认领未过期，协议如常兑现）。
- **本机时钟没有真拨。** M5 轮偏移的是 `ts` 字段（作者自报值 +/− 300s），不是
  节点的系统时钟。对被测属性这是等价的——`ts` 是作者时钟进入事实的唯一通道，
  DCU 代码里没有任何其他读本地钟并写上总线的路径；但"系统钟偏移还会不会通过
  别的侧信道影响行为"（比如日志时间戳、轮询定时器漂移）未测。
- **M6 的幸存者是空闲的。** 每迭代只喂 1 条需求，幸存副本手头无积压，接管时延
  分布测的是"Δ 余量 + 轮询相位"这一下界；实验二单次触发里 +2.63s 的"手头 4s
  工时排队"分量在本轮不出现（那正是它单测过的东西）。忙碌副本下的分布留待
  多需求版。
- **kill 时刻是 harness 墙钟。** 接管/resolve 时刻取总线 `recv`（可信、同机
  可比），kill 时刻只能取 harness 自己的钟；同机误差在 ms 级，对秒级分布无影响。
  `认领→kill ≈ 0.2s` 里含 harness 150ms 轮询——"事件触发开枪"是近似不是瞬时。
- **N=10 / N=5 是小样本。** 分布的 p95 在 N=10 下就是次大值附近（nearest-rank），
  只够说"窄"，不够拟合尾部；零事件（双执行、误杀）在小 N 下只是"未观测到"，
  与实验一/实验三的 0 互为佐证而非独立强证。
- **M8 的稳定性是管线稳定性。** 裁决函数确定性，输入逐轮同构（只换 nonce），
  跨轮零方差是预期结果；本轮排除的是工程性翻车（dedup 串扰、乱序漏裁、长驻
  裁决者状态腐化），不是对"更聪明的伪造者"的鲁棒性——对抗性变异探针集是
  另一项实验。
- **simulated act。** 工时是 sleep 常数，同既往两份报告的申报。
- **改动声明（红线自查）。** `antlegion-bus/src` 零改动；`ant/src`、既有实验
  脚本（`exp3-*`、`m1m3-*`）零改动，本轮全部文件为新增。`ant` 的 `npm test`
  （76/76）与 `npx tsc --noEmit` 通过；实验脚本不在 tsconfig include 里，
  已用同参数单独 `tsc --noEmit` 过一遍。
