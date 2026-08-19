/**
 * preflight.js — "can I reach this bus?", answered once, in one line.
 *
 * The bus is Redis-shaped: an address, no client auth, and a liveness probe.
 * This is the `PING` + `INFO` of that story. It exists so that pointing a DCU
 * at a node is a decision you can VERIFY before you start burning model turns,
 * and so a wrong address fails with the actual reason (refused? DNS? not a
 * bus?) instead of a silent retry loop.
 *
 * No harness imports: runnable from the plugin, from a test, or from `check.js`
 * on a bare Node install.
 */

/** How long a probe waits before calling the node unreachable. */
const DEFAULT_TIMEOUT_MS = 3000

/**
 * Probe one bus node.
 * @param busUrl - the bus base URL, with or without a trailing slash.
 * @param options.timeoutMs - per-request budget (default 3000).
 * @returns a verdict: `{ ok, url, protocol, headSeq, facts, uptimeSeconds,
 *   fsync, secretStable, latencyMs }` on success, or `{ ok: false, url, kind,
 *   detail }` where `kind` is one of `refused` | `dns` | `timeout` |
 *   `http` | `not-a-bus` | `unknown`.
 */
export async function probeBus(busUrl, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const base = String(busUrl ?? '').replace(/\/$/, '')
  if (base === '') return { ok: false, url: busUrl, kind: 'unknown', detail: 'busUrl is empty' }

  let url
  try {
    url = new URL(`${base}/info`)
  } catch {
    return { ok: false, url: base, kind: 'unknown', detail: 'busUrl is not a valid URL' }
  }

  const started = Date.now()
  let response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    return { ok: false, url: base, ...classify(error, timeoutMs) }
  }
  const latencyMs = Date.now() - started

  if (!response.ok) {
    return {
      ok: false,
      url: base,
      kind: 'http',
      detail: `${url.pathname} → HTTP ${response.status}. Something answers at this address, but it is not serving the bus API.`,
    }
  }

  let info
  try {
    info = await response.json()
  } catch {
    return { ok: false, url: base, kind: 'not-a-bus', detail: 'the response was not JSON — is this address another service?' }
  }
  if (typeof info?.protocol !== 'string' || typeof info?.head_seq !== 'number') {
    return { ok: false, url: base, kind: 'not-a-bus', detail: 'JSON without `protocol`/`head_seq` — this is not an AntLegion bus.' }
  }

  return {
    ok: true,
    url: base,
    protocol: info.protocol,
    headSeq: info.head_seq,
    facts: info.facts,
    uptimeSeconds: info.uptime_seconds,
    fsync: info.fsync,
    secretStable: info.secret_stable,
    latencyMs,
  }
}

/** Turn a fetch rejection into an actionable kind + sentence. */
function classify(error, timeoutMs) {
  const cause = error?.cause ?? error
  const code = cause?.code ?? ''
  if (error?.name === 'TimeoutError' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return { kind: 'timeout', detail: `no answer within ${timeoutMs}ms — wrong host, or a firewall is dropping the connection.` }
  }
  if (code === 'ECONNREFUSED') {
    return { kind: 'refused', detail: 'connection refused — nothing is listening on that port. Is the bus started?' }
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { kind: 'dns', detail: 'host not found — check the hostname.' }
  }
  return { kind: 'unknown', detail: error instanceof Error ? error.message : String(error) }
}

/** One human line for a verdict — the same sentence in logs and in the CLI. */
export function renderProbe(verdict) {
  if (verdict.ok) {
    const age = verdict.uptimeSeconds >= 0 ? `, up ${formatDuration(verdict.uptimeSeconds)}` : ''
    return `bus OK — ${verdict.url} protocol ${verdict.protocol}, head seq ${verdict.headSeq}, ${verdict.facts} facts${age} (${verdict.latencyMs}ms)`
  }
  return `bus UNREACHABLE — ${verdict.url}: ${verdict.detail}`
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}
