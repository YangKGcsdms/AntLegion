/**
 * agent.mjs — one containerized pi agent on the AntLegion bus.
 *
 * Generic by env: give it a name, a persona, what it LISTENS to and what it
 * PRODUCES. On boot it publishes a sys.registry fact declaring exactly that
 * (registration IS the act of publishing). Then the loop: poll → find open
 * facts of its listen type → claim (lowest seq wins; losing is normal) →
 * think via pi-ai → DeepSeek → resolve with its artifact as a causal child.
 *
 *   BUS_URL           http://host.docker.internal:28090
 *   AGENT_NAME        poet@toy
 *   PERSONA           system prompt for the LLM act
 *   LISTEN_TYPE       poem.request
 *   PRODUCE_TYPE      poem.draft
 *   OUTPUT_HINT       one line telling the LLM what JSON to produce
 *   DEEPSEEK_API_KEY  injected inference credentials (never logged)
 */

import { ClientV2, httpTransport } from "@antlegion/bus/client";
import { complete } from "@mariozechner/pi-ai";

const BUS = (process.env.BUS_URL ?? "http://host.docker.internal:28090").replace(/\/$/, "");
const NAME = process.env.AGENT_NAME ?? "anon@toy";
const PERSONA = process.env.PERSONA ?? "You are a helpful agent.";
const LISTEN = process.env.LISTEN_TYPE ?? "task.todo";
const PRODUCE = process.env.PRODUCE_TYPE ?? "task.done";
const HINT = process.env.OUTPUT_HINT ?? '{"text":"..."}';

const model = {
  id: process.env.ANT_LLM_MODEL ?? "deepseek-v4-flash",
  name: "toy agent act",
  api: "openai-completions",
  provider: "deepseek",
  baseUrl: process.env.ANT_LLM_BASE_URL ?? "https://api.deepseek.com",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 3000,
};

const log = (m) => console.log(`[${NAME}] ${new Date().toISOString()} ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function think(payload) {
  const msg = await complete(model, {
    systemPrompt: PERSONA,
    messages: [{
      role: "user",
      content: `输入事实 payload：${JSON.stringify(payload)}\n\n只输出一个 JSON 对象，形如 ${HINT}，不要任何其他文字。`,
      timestamp: Date.now(),
    }],
  }, { apiKey: process.env.DEEPSEEK_API_KEY });
  const text = msg.content.filter((c) => c.type === "text").map((c) => c.text).join("");
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a === -1 || b <= a) throw new Error(`no JSON in completion: ${text.slice(0, 80)}`);
  return JSON.parse(text.slice(a, b + 1));
}

async function main() {
  if (!process.env.DEEPSEEK_API_KEY) { console.error("DEEPSEEK_API_KEY is required"); process.exit(1); }
  const t = httpTransport(BUS);
  const client = new ClientV2(t, NAME, { claimTimeout: 120 });

  // Declare interests on the board — deterministic content, so restarts dedup.
  const reg = await t.append({
    type: "sys.registry", author: NAME, ts: 0,
    nonce: `registry:toy:${NAME}:v1`,
    payload: { domain: "toy", agent: NAME, listens: [LISTEN], produces: [PRODUCE], engine: model.id },
  });
  log(`registered on the board (seq ${reg.seq}${reg.deduped ? ", deduped" : ""}) — listens ${LISTEN} → produces ${PRODUCE}`);

  let cursor = 0;
  const seen = new Map(); // id -> fact, my listen type only
  for (;;) {
    try {
      for (;;) {
        const page = await client.query({ since: cursor, limit: 500 });
        if (page.length === 0) break;
        for (const f of page) {
          if (f.seq > cursor) cursor = f.seq;
          if (f.type === LISTEN) seen.set(f.id, f);
        }
        if (page.length < 500) break;
      }
      for (const [id, f] of seen) {
        const st = await client.state(id);
        if (st.state !== "open") { if (st.state === "resolved" || st.state === "dead") seen.delete(id); continue; }
        const c = await client.claim(id);
        if (!c.won) { log(`lost the race for #${f.seq} to ${c.winner} — moving on`); continue; }
        log(`claimed #${f.seq} (${LISTEN}) — thinking…`);
        try {
          const out = await think(f.payload);
          await client.resolve(id, [{ type: PRODUCE, payload: out, refs: f.refs?.subject ? { subject: f.refs.subject } : {} }]);
          log(`resolved #${f.seq} → ${PRODUCE}: ${JSON.stringify(out).slice(0, 120)}`);
          seen.delete(id);
        } catch (err) {
          log(`act failed on #${f.seq} (${err.message}) — releasing so someone else can try`);
          try { await client.release(id); } catch { /* claim will expire anyway */ }
        }
      }
    } catch (err) {
      log(`bus unreachable (${err.message}) — retrying`);
    }
    await sleep(1500);
  }
}

main();
