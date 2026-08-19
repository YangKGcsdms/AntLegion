# 从 agent 驱动总线 —— `alctl` CLI

[English](AGENT-CLI.md) · 🌐 **简体中文**

AntLegion 的 agent 通过**唯一接口：`alctl` CLI** 与日志对话。PI/无头 agent
（`claude -p`、`codex exec`、shell 工具、cron 任务）通过 shell 调用 `alctl`；每个子命令
恰好映射到一次 `ClientV2` 折叠调用，因此「X 现在是什么」、因果、信任、恰好一次所有权
都来自同一处（`fold.ts`）—— 绝不按集成各实现一遍。两台机器上各自 shell 调用 `alctl`
的两个 agent，折叠出同一个世界。

> **为什么不用 MCP？** 总线过去随附一个 stdio MCP 适配器。它是包在同一套 SDK 外的
> 第二层表面，有自己的身份环境变量、工具 schema 和传输需要同步维护。CLI 已经暴露了完整的
> 折叠表面，能与管道 / JSON 工具组合，不需要常驻的 stdio 服务，并且任何能 spawn 进程的
> 语言都能用。所以 MCP 适配器被移除，CLI 成为唯一受认可的 agent 接口。（*更早*的 v1 也
> 曾有一个独立的 MCP 包 —— 见 `docs/EVOLUTION.zh-CN.md`；那是与此不同的、更早的一次移除，
> 本次移除的是 v2 的 stdio 适配器。）

## 安装 / 调用

```bash
# 从检出的仓库
node antlegion-bus/dist/bin.js <cmd>          # 需先 `npm run build`
# 或通过已发布的包
npx -p @antlegion/bus alctl <cmd>
```

把它指向一条总线，并给 agent 一个稳定身份：

```bash
export ANTLEGION_BUS_URL=http://localhost:28090   # 默认
export ANTLEGION_AUTHOR=my-agent                   # 或每条命令加 --author
```

## 动词（与被移除的 MCP 工具完全对等）

| MCP 工具（已移除） | `alctl` 命令 |
|---|---|
| `antlegion_publish` | `alctl publish <type> '<json>' [--parent id] [--subject key] [--ref k=v]` —— 写下发生了什么 |
| — | `alctl supersede <id> <type> '<json>'` —— 修订它（subject 寄存器随之移动）；`alctl tombstone <id>` —— 撤回它 |
| `antlegion_query` | `alctl read [--type glob] [--since N] [--limit n]` |
| — | `alctl current <subject>` —— **X 现在是什么**（退出 1 = 一无所知）；`alctl history <subject>` —— 关于 X 曾说过的一切 |
| `antlegion_causation` | `alctl causation <id>` —— 它怎么来的；`alctl descendants <id>` —— 它引发了什么 |
| `antlegion_claim` | `alctl claim <id>`（退出 0 = 赢，1 = 输）—— 恰好一次地拥有一条事实 |
| `antlegion_resolve` | `alctl resolve <id>` |
| `antlegion_observe` | `alctl observe <id> corroborate\|contradict` |
| `antlegion_state` | `alctl state <id>` |
| — | `alctl release <id>`、`alctl trust <id>`、`alctl tail --follow`、`alctl colony`、`alctl info` |

输出在 stdout 是机器可读的 JSON（`read` / `tail` 为 JSONL），人类可读的错误走 stderr，
失败时以非零码退出 —— 于是 agent 解析 stdout、按退出码分支。

## agent 循环，用 CLI 表达

日志上的 agent 做两件事：**沉积自己观察到的**，以及行动之前**折叠世界**。所有权是第三件事，
只在两个 agent 不能对同一条事实动手时才做。

```bash
# 0. 现在什么是真的？（每台机器同一个答案，没有人问过任何人）
alctl current deploy:prod                        # → 当前那条事实，或退出 1 = 一无所知
alctl read --type 'deploy.*' --since "$CURSOR"   # 或从你的游标起 tail 所有新事实

# 1. 沉积你观察到的 —— 命名它所关于的那一块世界
alctl publish obs.metric '{"cpu":91}' --subject host:web-3
alctl supersede "$PREV_ID" obs.metric '{"cpu":40}'          # 修订：寄存器移动，历史保留
alctl publish alarm.raised '{"why":"p99 up"}' --parent "$FACT_ID"   # 说明是什么引起了它

# 2. 解释 / 追溯
alctl causation "$ALARM_ID"        # 它是怎么来的（根 → 事实，带 payload）
alctl descendants "$FACT_ID"       # 它引发了什么

# 3. 只在两个 agent 不能对同一条事实动手时：恰好一次地拥有它
if alctl claim "$FACT_ID" >/dev/null; then
  alctl resolve "$FACT_ID"
  alctl publish incident.closed '{"result":"ok"}' --parent "$FACT_ID"
else
  echo "别人拥有它了 —— 换下一个"     # 不要对同一个 id 重试
fi

# 为别人的事实投票；读者把票折叠进信任
alctl observe "$OTHER_FACT_ID" corroborate
```

你赢下却随即崩溃的认领，会在总线时间（Δ，以 recv 锚定）到点后过期，并由一个兄弟 agent
重新赢得 —— 与 SDK 给出的崩溃恢复保证相同，现在从一个 shell 就能触达。

## 声明一个 agent 关心什么

agent 应在启动时，通过发布一条带 `interests`（globs）与 `publishes`（类型）的
`sys.registry` 事实，声明它消费和发出的事实类型。这闭合了「我监听什么」与「我产出什么」
之间的环，并让控制台能标记**孤儿事实**（没有任何人关心的类型）。见 `PROTOCOL.zh-CN.md`
§3.5–§3.6（舰群注册、孤儿与上下文闭环）与 `docs/FACT-MODEL.md`。

```bash
alctl publish sys.registry '{
  "agent": "'"$ANTLEGION_AUTHOR"'",
  "interests": ["task.*", "build.failed"],
  "publishes": ["task.done", "build.report"]
}'
```

## 身份解析

`--author <name>` 是所有会写事实的命令上的全局标志。解析优先级：

| 设置 | 用途 |
|---|---|
| `--author <name>` | 单条命令的身份（压过一切） |
| `ANTLEGION_AUTHOR` | 整个 shell 会话的 CLI 身份 |
| *（默认）* | `<os-username>@<hostname>`——跨多次 CLI 调用保持稳定，所以先 `claim` 后 `resolve` 天然可用 |
| `ANTLEGION_BUS_URL` | CLI/SDK 去哪找总线（默认 `http://localhost:28090`） |

一个身份 = 一个进程。两个进程共用一个 author 是总线唯一无法禁止的失败——但读者折叠**能看见**它（`sys.heartbeat` + 身份冲突检测）。

## 采纳发生在 prompt 里，不在安装里

### 给 Agent 的第一条 prompt

把这段作为第一条消息，粘给一个能执行 shell 命令的 Agent：

> `$ANTLEGION_BUS_URL` 上有一条 AntLegion 日志，其它机器上的其它 Agent 也在读写它。动手之前先读它：`alctl read --type '<你关心的类型>' --since <游标>`，以及对任何当前值对你重要的东西 `alctl current <subject>`。你观察到或产出的、别的 Agent 可能需要的一切，都沉积为事实：`alctl publish <type> '{…}' --subject <它关于什么> [--parent <引起它的那条事实>]`；用 `alctl supersede` 修订。绝不要告诉别的 Agent 该做什么——写下什么是真的，让它自己读。如果一条事实必须恰好由一个 Agent 处理，先 `alctl claim <id>`，退出码为 0 才继续；做完后 `alctl resolve <id>`。

### 给 CLAUDE.md / .cursorrules 的规则片段

```markdown
## 共享世界（AntLegion）
- AntLegion 日志是你和其它机器上的 Agent 之间的共享世界。动手前先读它（`alctl read`、`alctl current <subject>`）；不要假设别的 Agent 知道什么——查日志。
- 把你观察到和产出的沉积为事实（`alctl publish … --subject <它关于什么> --parent <因>`）；用 `alctl supersede` 修订。不要把上下文囤在散文里。
- 只有事实，没有命令：绝不写「Agent X 应该……」。写下什么是真的，别的 Agent 自己折叠。
- 如果一条事实必须恰好由一个 Agent 处理，先 `alctl claim <id>`；只有退出码为 0 才继续。抢不到是常态——换一件事。做完后 `alctl resolve <id>`。
```

### 双窗口实验（5 分钟）

开两个 PATH 上有 `alctl` 的 Agent 终端——最好在两台机器上——都指向同一条日志（总线用 `HOST=0.0.0.0` 起）。在**窗口 A**：

> 沉积你对 prod 的了解——`alctl publish deploy.status '{"v":41}' --subject deploy:prod`——然后修订它：`alctl supersede <id> deploy.status '{"v":42}'`。

然后在从未被告知这一切的**窗口 B**：

> prod 现在在哪个版本？（`alctl current deploy:prod`）它是怎么到那儿的？（`alctl history deploy:prod`、`alctl causation <id>`）

B 答出 v42 和完整历史——什么都没粘贴，没有人给 B 发消息。现在两个窗口同时：

> 认领那条 v42 事实（`alctl claim <id>`）。

一个赢，一个以非零码退出并转去做别的。所有权由哪条认领先落进全序决定，两个读者算出完全相同的结果——和让两个窗口得到同一个「当前值」的是同一个折叠。
