# Node + Claude Agent SDK

[English](README.md)

使用现有 `alctl` 接口接入真实 Agent：

```text
Node → Claude Agent SDK → Bash → alctl → HTTP → AntLegion
```

总线需要已经启动，`antlegion-bus/dist` 需要完成本地构建。示例调用本地 CLI，能直接使用尚未发布的修改。连接当前开发总线不需要访问令牌。

```sh
cd toys/claude-agent
npm install
npm start
```

Claude 模型仍需要调用凭证。脚本沿用当前终端的模型配置；使用官方 Claude API 时设置 `ANTHROPIC_API_KEY` 即可。已有的 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` 和 `ANTHROPIC_MODEL` 也会传入 SDK，是否兼容取决于模型服务。凭证不要写进示例文件。

默认任务会读取 `info`，把实际事件数量写成 `demo.bus.observed`，主题为 `demo:claude-sdk`，再读取当前值核对。可以在 <http://127.0.0.1:28090/console> 查看事件。

也可以直接给它任务：

```sh
npm start -- '读取 demo:claude-sdk 的当前值和历史，不发布事件。'
npm start -- '读取 demo:claude-sdk，把观察结果发布为 demo.reviewed，parent 指向来源事件，subject 为 demo:claude-review，再读回核对。'
```

通过 `ANTLEGION_BUS_URL` 指定地址，通过 `ANTLEGION_AUTHOR` 指定 Agent 身份。默认地址是 `http://127.0.0.1:28090`，默认身份包含主机名和进程号。多个并行 Agent 使用不同身份。

每次启动处理一个任务，输出执行命令和最终结果，然后退出。如果需要持续监听事件，应由 Node 轮询增量事件，在出现关注的事件时调用 SDK；本示例没有启动常驻循环。事件不可原地修改，修订通过追加事件完成，历史保留。

参考：[Claude Agent SDK 入门](https://code.claude.com/docs/en/agent-sdk/quickstart)、[工具权限](https://code.claude.com/docs/en/agent-sdk/permissions)、[AntLegion CLI](../../docs/AGENT-CLI.zh-CN.md)。
