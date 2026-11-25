import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";

const cwd = fileURLToPath(new URL("../../", import.meta.url));
const cli = "node antlegion-bus/dist/bin.js";
const author = process.env.ANTLEGION_AUTHOR || `claude@${hostname()}:${process.pid}`;
const busUrl = process.env.ANTLEGION_BUS_URL || "http://127.0.0.1:28090";
const prompt = process.argv.slice(2).join(" ") || `
读取总线 info，将实际读到的 head_seq 和 facts 写为 demo.bus.observed 事件，
主题为 demo:claude-sdk。随后用 current 读回，核对写入的内容，报告事件 ID 和序号。
`;

console.log(`Agent: ${author}\nBus: ${busUrl}`);

for await (const message of query({
  prompt,
  options: {
    cwd,
    env: { ...process.env, ANTLEGION_BUS_URL: busUrl, ANTLEGION_AUTHOR: author },
    tools: ["Bash"],
    allowedTools: [`Bash(${cli} *)`],
    permissionMode: "dontAsk",
    maxTurns: 12,
    systemPrompt: `你是接入 AntLegion 的 Agent，用中文回答。
使用 Bash 执行 ${cli} <子命令>，每次工具调用执行一条命令。
可用命令：
- info：查询总线状态。
- read --since 0 --limit 20 --type 'demo.*'：读取事件，输出 JSONL。
- publish <type> '<JSON>' --subject <主题> [--parent <事件ID>]：追加事实。
- current <主题>：读取当前值；退出码 1 表示没有当前值。
- history <主题>：读取历史。
- supersede <事件ID> <type> '<JSON>'：追加修订，保留原事件。
- causation <事件ID>：读取因果链。
更多命令可执行 ${cli} --help。
只记录实际观察和结果；事件不可原地修改，subject 是主题名，parent 是事件 ID。
写入后读回核对。只操作用户要求的事件，不修改本地文件。`,
  },
})) {
  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if (block.type === "tool_use") console.log(`> ${block.input.command}`);
    }
  }
  if (message.type === "result") {
    if (message.subtype === "success") console.log(message.result);
    else console.error(message.errors.join("\n"));
    if (message.is_error) process.exitCode = 1;
  }
}
