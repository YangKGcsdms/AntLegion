#!/usr/bin/env bash
# AntLegion Bus — one-shot local deploy.
#
# 1. Verify prerequisites
# 2. Bring up the bus via docker compose
# 3. Wait for /health
# 4. Build the MCP server
# 5. Generate setup.html with this machine's absolute paths
# 6. Print next steps (and try to auto-open setup.html)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# ── colors ────────────────────────────────────────────────────────────────
BLUE=$'\033[34m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; DIM=$'\033[2m'; RESET=$'\033[0m'
say()  { printf "%s→%s %s\n" "$BLUE" "$RESET" "$*"; }
ok()   { printf "%s✓%s %s\n" "$GREEN" "$RESET" "$*"; }
warn() { printf "%s!%s %s\n" "$YELLOW" "$RESET" "$*"; }
die()  { printf "%s✗%s %s\n" "$RED" "$RESET" "$*" >&2; exit 1; }

BUS_URL="${ANTLEGION_BUS_URL:-http://localhost:28080}"
BUS_HOST_PORT="${BUS_URL#http://}"
BUS_HOST_PORT="${BUS_HOST_PORT#https://}"

# ── 1. Preflight ──────────────────────────────────────────────────────────
say "checking prerequisites"
command -v docker >/dev/null || die "docker not found"
docker compose version >/dev/null 2>&1 \
  || die "docker compose plugin not available (need v2)"
command -v node >/dev/null || die "node not found (need ≥20)"
NODE_MAJOR=$(node --version | sed 's/v\([0-9]*\).*/\1/')
[ "$NODE_MAJOR" -ge 20 ] || die "node ≥20 required (have v$NODE_MAJOR)"
command -v npm >/dev/null || die "npm not found"
ok "docker, node $(node --version), npm $(npm --version)"

# ── 2. .env ───────────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  cp .env.example .env
  warn "created .env from .env.example — change ANTLEGION_BUS_SECRET for production"
fi

# ── 3. Bring up bus ───────────────────────────────────────────────────────
say "starting bus (docker compose up -d)"
docker compose up -d 2>&1 | sed 's/^/  /'

# ── 4. Wait for health ────────────────────────────────────────────────────
say "waiting for bus /health (max 30s)"
for i in $(seq 1 15); do
  if curl -fsS "${BUS_URL}/health" >/dev/null 2>&1; then
    ok "bus is healthy at ${BUS_URL}"
    BUS_READY=1
    break
  fi
  sleep 2
done
[ "${BUS_READY:-0}" -eq 1 ] || die "bus did not become healthy in 30s — try: docker compose logs antlegion-bus"

# ── 5. Build MCP server ───────────────────────────────────────────────────
say "building MCP server (this may take a minute on first run)"
(
  cd antlegion-mcp
  if [ ! -d node_modules ]; then
    npm install --silent
  fi
  npm run build --silent
)
MCP_ABS_PATH="$ROOT/antlegion-mcp/dist/index.js"
[ -f "$MCP_ABS_PATH" ] || die "MCP build did not produce $MCP_ABS_PATH"
ok "MCP server built: $MCP_ABS_PATH"

# Smoke-test the MCP binary boots
if ! ANTLEGION_BUS_URL="$BUS_URL" timeout 2 node "$MCP_ABS_PATH" 2>&1 | grep -q "ready"; then
  warn "MCP server boot smoke did not print 'ready' — likely fine, but check manually if config fails"
fi

# ── 6. Generate setup.html ────────────────────────────────────────────────
say "generating setup.html for this machine"
cat > "$ROOT/setup.html" <<'__HTML_TEMPLATE__'
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AntLegion Bus — 接入指引</title>
<style>
  :root {
    --bg: #0e1117; --fg: #e6edf3; --muted: #8b949e; --accent: #58a6ff;
    --ok: #3fb950; --err: #f85149; --warn: #d29922;
    --card: #161b22; --code: #0d1117; --border: #30363d;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
          "Helvetica Neue", Arial, "Noto Sans SC", sans-serif;
    background: var(--bg); color: var(--fg);
    padding: 40px 24px 80px; max-width: 880px; margin: 0 auto;
  }
  header h1 { font-size: 22px; margin-bottom: 4px; }
  header .sub { color: var(--muted); margin-bottom: 24px; font-size: 13px; }
  h2 { font-size: 16px; font-weight: 600; margin-top: 32px; margin-bottom: 8px;
       color: var(--fg); border-bottom: 1px solid var(--border); padding-bottom: 6px; }

  .status { background: var(--card); border: 1px solid var(--border);
            border-radius: 8px; padding: 12px 16px; margin: 16px 0 24px;
            display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--muted); flex-shrink: 0; }
  .dot.ok { background: var(--ok); box-shadow: 0 0 6px rgba(63,185,80,.6); }
  .dot.err { background: var(--err); }
  .status .right { margin-left: auto; font-size: 12px; }

  .info { background: var(--card); border: 1px solid var(--border);
          border-radius: 8px; padding: 12px 16px; margin: 12px 0; font-size: 13px; }
  .info .row { display: flex; gap: 12px; padding: 4px 0; }
  .info .row .k { color: var(--muted); width: 96px; flex-shrink: 0; }
  .info .row .v { color: var(--fg); font-family: ui-monospace, SF Mono, Menlo, monospace;
                  word-break: break-all; }

  .card { background: var(--card); border: 1px solid var(--border);
          border-radius: 8px; padding: 14px 16px; margin: 12px 0; }
  .card .hd { display: flex; justify-content: space-between; align-items: baseline;
              margin-bottom: 10px; gap: 12px; flex-wrap: wrap; }
  .card .name { font-weight: 600; color: var(--accent); }
  .card .where { font-family: ui-monospace, SF Mono, Menlo, monospace;
                 font-size: 11px; color: var(--muted); }
  pre { background: var(--code); border: 1px solid var(--border); border-radius: 6px;
        padding: 12px 14px; overflow-x: auto;
        font-family: ui-monospace, SF Mono, Menlo, monospace;
        font-size: 12px; line-height: 1.5; color: var(--fg); }
  .tools { margin-top: 8px; display: flex; gap: 8px; }
  button { background: var(--card); border: 1px solid var(--border); color: var(--fg);
           padding: 5px 14px; border-radius: 4px; cursor: pointer; font-size: 12px;
           font-family: inherit; }
  button:hover { border-color: var(--accent); color: var(--accent); }
  button.copied { color: var(--ok); border-color: var(--ok); }
  .hint { color: var(--muted); font-size: 12px; margin-top: 8px; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { font-family: ui-monospace, SF Mono, Menlo, monospace; font-size: 0.9em;
         background: rgba(110,118,129,.18); padding: 1px 6px; border-radius: 3px; }
  ul.links { padding-left: 20px; }
  ul.links li { color: var(--muted); margin: 4px 0; }
</style>
</head>
<body>

<header>
  <h1>AntLegion Bus — 接入指引</h1>
  <p class="sub">把任何 MCP 客户端接到本机 bus 上。下面所有 snippet 的路径都是当前这台机器的绝对路径，可以直接复制粘贴。</p>
</header>

<div class="status">
  <span class="dot" id="dot"></span>
  <span id="msg">检查 bus 状态...</span>
  <span class="right">
    <a id="link-stats" href="" target="_blank">stats</a> ·
    <a id="link-facts" href="" target="_blank">facts</a> ·
    <a id="link-cursor" href="" target="_blank">cursor</a>
  </span>
</div>

<h2>本机参数</h2>
<div class="info">
  <div class="row"><span class="k">Bus URL</span><span class="v" id="cell-bus">__BUS_URL__</span></div>
  <div class="row"><span class="k">MCP 路径</span><span class="v" id="cell-mcp">__MCP_PATH__</span></div>
</div>

<h2>Claude Code</h2>
<div class="card">
  <div class="hd"><span class="name">Claude Code</span><span class="where">~/.claude.json (或项目内 .mcp.json)</span></div>
<pre id="cfg-claude">{
  "mcpServers": {
    "antlegion": {
      "command": "node",
      "args": ["__MCP_PATH__"],
      "env": {
        "ANTLEGION_BUS_URL": "__BUS_URL__",
        "ANTLEGION_AGENT_NAME": "claude-code"
      }
    }
  }
}</pre>
  <div class="tools"><button onclick="copy('cfg-claude', this)">复制</button></div>
  <div class="hint">合并到现有 <code>mcpServers</code> 块。重启 Claude Code 生效。如果开多窗口，给每个窗口设不同 <code>ANTLEGION_AGENT_NAME</code>。</div>
</div>

<h2>Cursor</h2>
<div class="card">
  <div class="hd"><span class="name">Cursor</span><span class="where">Settings → Cursor Settings → MCP</span></div>
<pre id="cfg-cursor">{
  "mcpServers": {
    "antlegion": {
      "command": "node",
      "args": ["__MCP_PATH__"],
      "env": {
        "ANTLEGION_BUS_URL": "__BUS_URL__",
        "ANTLEGION_AGENT_NAME": "cursor"
      }
    }
  }
}</pre>
  <div class="tools"><button onclick="copy('cfg-cursor', this)">复制</button></div>
</div>

<h2>Cline / Continue / Windsurf / Goose / Zed</h2>
<div class="card">
  <div class="hd"><span class="name">其它 MCP 客户端</span><span class="where">各自的 MCP servers 配置位置</span></div>
<pre id="cfg-generic">{
  "mcpServers": {
    "antlegion": {
      "command": "node",
      "args": ["__MCP_PATH__"],
      "env": {
        "ANTLEGION_BUS_URL": "__BUS_URL__"
      }
    }
  }
}</pre>
  <div class="tools"><button onclick="copy('cfg-generic', this)">复制</button></div>
  <div class="hint">这套 JSON 结构是 MCP 通用约定，几乎所有支持 MCP 的客户端都吃。具体配置文件位置见各家文档。</div>
</div>

<h2>Codex CLI</h2>
<div class="card">
  <div class="hd"><span class="name">Codex CLI</span><span class="where">~/.codex/config.toml</span></div>
<pre id="cfg-codex">[mcp_servers.antlegion]
command = "node"
args = ["__MCP_PATH__"]
env = { ANTLEGION_BUS_URL = "__BUS_URL__", ANTLEGION_AGENT_NAME = "codex-cli" }</pre>
  <div class="tools"><button onclick="copy('cfg-codex', this)">复制</button></div>
</div>

<h2>试一下</h2>
<div class="card">
  <p>配好以后随便挑一个客户端，输入：</p>
<pre>在 antlegion bus 上发一条 fact，type=demo.hello，payload={"msg":"first contact"}</pre>
  <p class="hint">客户端会调 <code>antlegion_publish</code>，bus 接收后返回 fact_id。<a id="link-verify" href="" target="_blank">点这里查看 bus 上的 facts</a>。</p>
</div>

<h2>6 个 MCP 工具一览</h2>
<div class="info" style="font-size: 12.5px;">
  <div class="row"><span class="k">publish</span><span>发一条 fact（broadcast 默认 / exclusive 可选）</span></div>
  <div class="row"><span class="k">query</span><span>查 facts。fact_type 支持 glob，since_sequence 自动续接</span></div>
  <div class="row"><span class="k">claim</span><span>独占认领一条 exclusive fact</span></div>
  <div class="row"><span class="k">resolve</span><span>完成 claim，可附带 result_facts</span></div>
  <div class="row"><span class="k">observe</span><span>corroborate / contradict 别人的 fact</span></div>
  <div class="row"><span class="k">causation</span><span>沿因果链回溯到根</span></div>
</div>

<h2>更多</h2>
<ul class="links">
  <li><a href="./README.md">README.md</a> — 项目总览</li>
  <li><a href="./PROTOCOL.md">PROTOCOL.md</a> — bus 协议（fact / 状态机 / REST / 签名）</li>
  <li><a href="./QUICKSTART.md">QUICKSTART.md</a> — 详细步骤</li>
  <li><a href="./antlegion-mcp/README.md">antlegion-mcp/README.md</a> — 6 个 MCP 工具的完整参数</li>
</ul>

<script>
const BUS = document.getElementById('cell-bus').textContent.trim();

document.getElementById('link-stats').href  = BUS + "/stats";
document.getElementById('link-facts').href  = BUS + "/facts";
document.getElementById('link-cursor').href = BUS + "/facts/cursor";
document.getElementById('link-verify').href = BUS + "/facts?fact_type=demo.hello";

async function checkBus() {
  const dot = document.getElementById('dot');
  const msg = document.getElementById('msg');
  try {
    const r = await fetch(BUS + "/health", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    await r.json();
    dot.className = "dot ok";
    msg.textContent = "bus 在线 · " + BUS;
  } catch (e) {
    dot.className = "dot err";
    msg.textContent = "bus 离线 (" + (e.message || e) + ") — 重新跑 ./deploy.sh 或 docker compose up -d";
  }
}
checkBus();
setInterval(checkBus, 5000);

function copy(id, btn) {
  const txt = document.getElementById(id).textContent;
  navigator.clipboard.writeText(txt).then(() => {
    const orig = btn.textContent;
    btn.textContent = "已复制 ✓";
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1500);
  }).catch(() => {
    btn.textContent = "请手动复制";
  });
}
</script>
</body>
</html>
__HTML_TEMPLATE__

# Substitute __MCP_PATH__ and __BUS_URL__ — escape | in case path contains it (unlikely)
SED_PATH=$(printf '%s' "$MCP_ABS_PATH" | sed 's/[\\&|]/\\&/g')
SED_URL=$(printf '%s' "$BUS_URL"       | sed 's/[\\&|]/\\&/g')
sed -i.bak "s|__MCP_PATH__|${SED_PATH}|g; s|__BUS_URL__|${SED_URL}|g" "$ROOT/setup.html"
rm -f "$ROOT/setup.html.bak"
ok "setup.html ready"

# ── 7. Done ───────────────────────────────────────────────────────────────
echo
printf "%s%s\n" "$GREEN" "════════════════════════════════════════════════════"
printf "  AntLegion Bus is up · %s\n" "$BUS_URL"
printf "════════════════════════════════════════════════════%s\n" "$RESET"
echo
echo "Next steps:"
echo
printf "  1. %sOpen the config page%s:\n" "$BLUE" "$RESET"
printf "       file://%s/setup.html\n" "$ROOT"
echo
printf "  2. %sPick your MCP client%s on the page, copy the snippet,\n" "$BLUE" "$RESET"
printf "     paste into its MCP config, restart the client.\n"
echo
printf "  3. %sTry%s: ask your AI client to \"publish a demo.hello fact to antlegion bus\".\n" "$BLUE" "$RESET"
echo
printf "%sUseful%s\n" "$DIM" "$RESET"
printf "  docker compose logs -f antlegion-bus    # tail bus logs\n"
printf "  docker compose down                      # stop\n"
printf "  curl %s/facts | jq                       # peek facts\n" "$BUS_URL"
echo

# Try to auto-open the HTML file
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "file://$ROOT/setup.html" >/dev/null 2>&1 &
elif command -v open >/dev/null 2>&1; then
  open "file://$ROOT/setup.html" >/dev/null 2>&1 &
fi
