#!/usr/bin/env node
/**
 * check.js — point this at a bus before you point a DCU at it.
 *
 *   node check.js                          # the default loopback bus
 *   node check.js http://10.0.0.7:28090    # some other node
 *   node check.js http://10.0.0.7:28090 --roster
 *
 * Exit 0 when the node answers as a bus, 1 when it does not — so it drops
 * straight into a shell guard:
 *
 *   node check.js "$BUS" && dsh --profile dcu
 */

import { probeBus, renderProbe } from './preflight.js'

const args = process.argv.slice(2)
const wantRoster = args.includes('--roster')
const busUrl = args.find((arg) => !arg.startsWith('--'))
  ?? process.env.ANTLEGION_BUS_URL
  ?? 'http://127.0.0.1:28090'

const verdict = await probeBus(busUrl, { timeoutMs: 5000 })
console.log(renderProbe(verdict))

if (!verdict.ok) {
  console.log('')
  console.log(hint(verdict.kind, verdict.url))
  process.exit(1)
}

if (verdict.secretStable === false) {
  console.log('note: this bus has no stable ANTLEGION_BUS_SECRET — it mints a fresh HMAC key each boot, so signatures written before a restart stop verifying.')
}

if (wantRoster) {
  const facts = await fetch(`${verdict.url}/facts?type=sys.registry&since=0`).then((r) => r.json())
  const latest = new Map()
  for (const fact of facts) {
    const previous = latest.get(fact.author)
    if (previous === undefined || fact.seq > previous.seq) latest.set(fact.author, fact)
  }
  console.log('')
  console.log(latest.size === 0 ? 'colony roster: empty — no agent has announced itself yet.' : 'colony roster:')
  for (const fact of [...latest.values()].sort((a, b) => a.author.localeCompare(b.author))) {
    const interests = (fact.payload?.interests ?? []).join(', ') || '—'
    const publishes = (fact.payload?.publishes ?? []).join(', ') || '—'
    console.log(`  ${fact.author}  wakes on [${interests}]  emits [${publishes}]`)
  }
}

/** What to actually do about a failed probe. */
function hint(kind, url) {
  const port = safePort(url)
  switch (kind) {
    case 'refused':
      return [
        'Nothing is listening. Start a bus:',
        '',
        `  cd antlegion-bus && PORT=${port} npm run dev`,
        '',
        'or point at one that is already running (ANTLEGION_BUS_URL, or the plugin\'s `busUrl`).',
      ].join('\n')
    case 'dns':
      return 'Check the hostname. Inside Docker, the host bus is usually host.docker.internal, not localhost.'
    case 'timeout':
      return [
        'The address resolves but nothing answers in time. Usually one of:',
        '  - the bus is bound to loopback on a different machine (it defaults to HOST=127.0.0.1)',
        '  - a firewall is dropping the connection',
        '',
        'To serve a bus beyond loopback, start it with HOST=0.0.0.0 — and keep that inside a trusted network:',
        'the bus has no client auth, exactly like an unprotected Redis.',
      ].join('\n')
    case 'http':
    case 'not-a-bus':
      return 'Something answers here, but it is not an AntLegion bus. Check the port — the bus default is 28090.'
    default:
      return 'Check `busUrl`. It should look like http://host:28090 — scheme included, no path.'
  }
}

function safePort(url) {
  try {
    return new URL(url).port || '28090'
  } catch {
    return '28090'
  }
}
