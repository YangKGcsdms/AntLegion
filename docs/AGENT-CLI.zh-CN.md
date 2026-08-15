# 从 agent 驱动总线 —— `alctl` CLI

[English](AGENT-CLI.md) · 🌐 **简体中文**

AntLegion 的 agent 通过**唯一接口：`alctl` CLI** 与总线对话。PI/无头 agent
（`claude -p`、`codex exec`、shell 工具、cron 任务）通过 shell 调用 `alctl`；每个子命令
恰好映射到一次 `ClientV2` 折叠调用，因此恰好一次认领、信任、因果都来自同一处
（`fold.ts`）—— 绝不按集成各实现一遍。

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
| `antlegion_publish` | `alctl publish <type> '<json>' [--parent id] [--subject key] [--ref k=v]` |
| `antlegion_query` | `alctl read [--type glob] [--since N] [--limit n]` |
| `antlegion_claim` | `alctl claim <id>`（退出 0 = 赢，1 = 输） |
| `antlegion_resolve` | `alctl resolve <id>` |
| `antlegion_observe` | `alctl observe <id> corroborate\|contradict` |
| `antlegion_causation` | `alctl causation <id>` |
| `antlegion_state` | `alctl state <id>` |
| — | `alctl release <id>`、`alctl trust <id>`、`alctl tail --follow`、`alctl info` |

输出在 stdout 是机器可读的 JSON（`read` / `tail` 为 JSONL），人类可读的错误走 stderr，
失败时以非零码退出 —— 于是 agent 解析 stdout、按退出码分支。

## agent 循环，用 CLI 表达

```bash
# 1. 从你的游标读取新事实，做出反应
alctl read --type 'task.*' --since "$CURSOR"

# 2. 恰好一次认领一个工作单元（只有一个 agent 会赢）
if alctl claim "$FACT_ID" >/dev/null; then
  # 3. 干活，然后用一条子事实解决（因果通过 --parent）
  alctl resolve "$FACT_ID"
  alctl publish task.done '{"result":"ok"}' --parent "$FACT_ID"
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

> 去 antlegion 事实总线上查有没有开放的 `task.todo` 事实（`alctl read --type task.todo`）。如果有一条还没被认领，先 `alctl claim <id>` 再开始干；只有认领以 0 退出才继续。做完后用 `alctl resolve <id>` 附上简短结果。如果没有开放任务，就 `alctl publish task.todo '{…}'` 描述你接下来打算做的事，好让别的 Agent 看见。

### 给 CLAUDE.md / .cursorrules 的规则片段

```markdown
## 多 Agent 协作（AntLegion）
- 开始任何任务前：先 `alctl read` 事实总线；如果对应的 `task.todo` 已存在且已被认领，换一件事做。
- 干活前先认领（`alctl claim <id>`）；只有退出码为 0 才继续。抢不到是常态——换一件事。
- 做完后用 `alctl resolve <id>` 交代你产出了什么。绝不要只在散文里宣布完成。
- 把重要观察作为事实发布（`alctl publish`），让其他 Agent 能够反应——不要囤积上下文。
```

### 双窗口实验（5 分钟）

开两个 PATH 上有 `alctl` 的 Agent 终端，都指向同一条总线。在**窗口 A**：

> 发布一条 task.todo 事实——`alctl publish task.todo '{"title": "写一首关于全序的俳句"}'`——然后认领它（`alctl claim <id>`）并开始工作。

紧接着在**窗口 B**：

> 找到总线上最新的 task.todo（`alctl read --type task.todo`）并认领它。

窗口 B 会输：`alctl claim` 以非零码退出并报告 A 是赢家，于是 B 转去做别的，而不是重复劳动。这就是零锁的恰好一次——由哪条认领先落进全序决定，两个读者算出完全相同的结果。
