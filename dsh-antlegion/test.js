/**
 * Smoke tests for the protocol v3.0 behaviours this DCU depends on.
 *
 *   node --test
 *
 * Uses node:test and a real bus spawned from the installed @antlegion/bus bin —
 * no test framework, no extra dependency. The liveness case in particular has
 * to run against a real log: it is about what compaction is allowed to reclaim,
 * which is a property of the bus, not of this file.
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

import { renderProbe, probeBus, SPEAKS_PROTOCOL } from './preflight.js'
import { createPatrol } from './patrol.js'
import { ClientV2, httpTransport } from '@antlegion/bus/client'
import { colony } from '@antlegion/bus/fold'

const require = createRequire(import.meta.url)
const busEntry = require.resolve('@antlegion/bus/package.json').replace(/package\.json$/, 'dist/index.js')

const PORT = 28197
const BUS = `http://127.0.0.1:${PORT}`
let child
let dataDir

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'dsh-v3-'))
  child = spawn(process.execPath, [busEntry], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', ANTLEGION_DATA_DIR: dataDir, ANTLEGION_BUS_SECRET: 'test' },
    stdio: 'ignore',
  })
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BUS}/health`)
      if (res.ok) return
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('bus did not start')
})

after(() => {
  child?.kill()
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

test('preflight reports the bus protocol and the log Δ', async () => {
  const verdict = await probeBus(BUS)
  assert.equal(verdict.ok, true)
  assert.equal(verdict.protocol, SPEAKS_PROTOCOL)
  assert.equal(verdict.protocolMismatch, false)
  assert.equal(typeof verdict.claimTimeout, 'number')
  assert.match(renderProbe(verdict), /protocol 3\.0/)
  assert.match(renderProbe(verdict), /Δ \d+s/)
})

test('preflight flags a bus that speaks another protocol', () => {
  // Reachable, appendable, and every fold would be wrong — so this is a loud
  // warning rather than an unreachable verdict.
  const stale = {
    ok: true, url: BUS, protocol: '2.0', protocolMismatch: true, speaks: SPEAKS_PROTOCOL,
    claimTimeout: null, headSeq: 3, facts: 3, uptimeSeconds: 1, latencyMs: 2,
  }
  const rendered = renderProbe(stale)
  assert.match(rendered, /PROTOCOL MISMATCH/)
  assert.match(rendered, /every fold will be wrong/)
})

test('a liveness refresh retracts the registration it replaced, so compaction can reclaim it', async () => {
  const author = 'dsh-test@node'
  const client = new ClientV2(httpTransport(BUS), author)

  // livenessTtlSec 2 ⇒ refresh at 1s. One register + one refresh is all we need.
  const patrol = createPatrol({
    client, busUrl: BUS, author,
    interests: ['never.matches.*'], publishes: [],
    pollMs: 100, livenessTtlSec: 2, log: () => {},
  })
  patrol.start()
  await new Promise((r) => setTimeout(r, 2500))
  await patrol.stop()

  const reader = new ClientV2(httpTransport(BUS), 'auditor@test')
  await reader.sync()
  const all = await reader.query({ since: 0, limit: 10000 })

  // NOT a register fold: `sys.` is a reserved namespace, so §8.1 rule 6 keeps
  // these out of `history(S)`/`current(S)` entirely. §8.5's own rule — latest
  // per author — is what makes the roster correct.
  const registrations = all
    .filter((f) => f.type === 'sys.registry' && f.author === author)
    .sort((a, b) => a.seq - b.seq)
  assert.ok(registrations.length >= 2, `expected a register + a refresh, got ${registrations.length}`)

  const head = registrations[registrations.length - 1]

  // Every registration below the newest is retracted — by its own author, which
  // is what §10.1's gate requires and what §11.2 needs before it may drop a payload.
  const tombstones = all.filter((f) => f.type === '_.tombstone')
  for (const older of registrations.slice(0, -1)) {
    const t = tombstones.find((f) => f.refs.tombstones === older.id)
    assert.ok(t, `registration ${older.id.slice(0, 12)} was left un-retracted — it can never be reclaimed`)
    assert.equal(t.author, older.author, 'a stranger tombstone would not retract it (§10.1)')
  }

  // Retracting the older ones is housekeeping, not leaving: the roster still
  // lists this author, reading its newest registration (§8.5).
  const roster = colony(all).filter((r) => r.author === author)
  assert.equal(roster.length, 1, 'housekeeping retractions must not evict the author from the roster')
  assert.equal(roster[0].fact.id, head.id)

  // And the bus agrees: rewrite() strips exactly those payloads.
  const res = await fetch(`${BUS}/admin/rewrite`, { method: 'POST' })
  const { stripped } = await res.json()
  assert.ok(stripped >= registrations.length - 1,
    `expected at least ${registrations.length - 1} payloads reclaimed, got ${stripped}`)

  // The newest survives with its payload — the roster still reads.
  const after = await reader.query({ since: 0, limit: 10000 })
  const rosterAfter = colony(after).filter((r) => r.author === author)
  assert.equal(rosterAfter.length, 1)
  assert.equal(rosterAfter[0].fact.id, head.id)
  assert.equal(rosterAfter[0].fact.payload.runtime, 'deepseek-harness')
  assert.deepEqual(rosterAfter[0].interests, ['never.matches.*'])
})

test('retracting the LATEST registration is how a DCU leaves the roster (§8.5)', async () => {
  const author = 'dsh-leaver@node'
  const client = new ClientV2(httpTransport(BUS), author)
  const reg = await client.publish('sys.registry', { interests: ['z.*'], publishes: [] })
  await client.sync()
  assert.equal(colony(await client.query({ since: 0, limit: 10000 })).some((r) => r.author === author), true)

  await client.tombstone(reg.id)
  assert.equal(colony(await client.query({ since: 0, limit: 10000 })).some((r) => r.author === author), false)
})
