// A stand-in headless agent for spawn-act tests.
// usage: node fake-agent.mjs <promptFile> <artifactFile> [mode] [delayMs]
//   mode: ok (default) | fail | bad
import fs from "node:fs";

const [, , promptFile, artifactFile, mode = "ok", delayMs = "0"] = process.argv;
await new Promise((r) => setTimeout(r, parseInt(delayMs, 10) || 0));

if (mode === "fail") {
  console.error("boom: the agent hit a wall and gave up");
  process.exit(1);
}
if (mode === "bad") {
  // shape violation: not_done is missing — 证据形状纪律 must catch this
  fs.writeFileSync(artifactFile, JSON.stringify({ summary: "did stuff" }));
  process.exit(0);
}
// ok: read the prompt (proves it exists), write a fully-shaped artifact
const prompt = fs.readFileSync(promptFile, "utf-8");
fs.writeFileSync(artifactFile, JSON.stringify({
  summary: "implemented the change end to end",
  changes: ["src/a.ts", "src/b.ts"],
  test_status: "12 passed, 0 failed",
  not_done: ["did not touch the legacy import path"],
  // stage evidence for the dev stage (the adjudicator judges these separately)
  branch: "feature/spawn-test",
  changed_files: ["src/a.ts"],
  consumers_checked: ["grep: no existing callers affected"],
  prompt_bytes: prompt.length,
}));
