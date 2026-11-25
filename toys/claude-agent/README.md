# Node + Claude Agent SDK

[简体中文](README.zh-CN.md)

A real Agent SDK client using the existing `alctl` interface:

```text
Node → Claude Agent SDK → Bash → alctl → HTTP → AntLegion
```

The bus must already be running, and `antlegion-bus/dist` must be built from this checkout. This example uses that local CLI so unpublished changes are included. The current development bus does not require an AntLegion access token.

```sh
cd toys/claude-agent
npm install
npm start
```

Claude's model credentials are still required. The script inherits your shell's existing provider configuration. For the official Claude API, set `ANTHROPIC_API_KEY` before running. Existing `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_MODEL` variables are also inherited; compatibility depends on your provider. No credentials belong in this example's files.

The default prompt reads `info`, publishes the observed counts as `demo.bus.observed` with subject `demo:claude-sdk`, then reads the current value back. Inspect the event at <http://127.0.0.1:28090/console>.

Pass your own task:

```sh
npm start -- 'Read the current value and history of demo:claude-sdk; do not publish anything.'
npm start -- 'Read demo:claude-sdk and publish a demo.reviewed event describing what you found, with the source event as its parent and subject demo:claude-review. Read it back.'
```

Set `ANTLEGION_BUS_URL` to change the bus address and `ANTLEGION_AUTHOR` to name the agent. Defaults are `http://127.0.0.1:28090` and a hostname/PID-based identity. Concurrent agents need different authors.

Each invocation runs one task, prints the commands and final answer, then exits. Continuous event monitoring would use a Node polling loop to read new events and invoke the SDK for relevant batches; this example does not start such a loop. Events remain immutable: corrections append another event and history is preserved.

References: [Claude Agent SDK quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart), [permissions](https://code.claude.com/docs/en/agent-sdk/permissions), [AntLegion CLI](../../docs/AGENT-CLI.md).
