/**
 * Reproduction for @mswjs/interceptors HTTPParser leak.
 *
 * Uses ClientRequestInterceptor directly (no msw on top) to remove any
 * confounders. Fires N requests against a mocked URL, takes heap
 * snapshots, and reports the number of `HTTPParser` JS objects retained
 * at increasing milestones. The count grows linearly with the number of
 * requests, well past Node's own `_http_common.parsers` FreeList cap
 * (max=1000). This indicates the JS HTTPParser wrappers created by
 * `new HTTPParser()` inside `MockHttpSocket` are not eligible for GC.
 *
 * Run: npm test
 *   (which is `node --expose-gc repro.mjs`)
 */

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { writeHeapSnapshot } from 'node:v8'

import { ClientRequestInterceptor } from '@mswjs/interceptors/ClientRequest'

if (typeof globalThis.gc !== 'function') {
  console.error('Run with --expose-gc, e.g.: npm test')
  process.exit(1)
}

const MILESTONES = [100, 500, 1000, 2000, 5000]
const TARGET = 'http://probe.local/leak'
const CONCURRENCY = 20

const interceptor = new ClientRequestInterceptor()
interceptor.on('request', ({ controller }) => {
  controller.respondWith(
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
})
interceptor.apply()

const agent = new http.Agent({ keepAlive: false })

function makeRequest() {
  return new Promise((resolve, reject) => {
    const req = http.get(TARGET, { agent }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('error', reject)
  })
}

async function fireBatch(count, concurrency) {
  let inflight = 0
  let started = 0
  return new Promise((resolve, reject) => {
    const next = () => {
      if (started >= count && inflight === 0) return resolve()
      while (inflight < concurrency && started < count) {
        started++
        inflight++
        makeRequest()
          .catch(reject)
          .finally(() => {
            inflight--
            next()
          })
      }
    }
    next()
  })
}

async function forceGc() {
  for (let i = 0; i < 6; i++) {
    globalThis.gc()
    await delay(30)
  }
}

function countHTTPParser(snapPath) {
  const json = JSON.parse(fs.readFileSync(snapPath, 'utf8'))
  const meta = json.snapshot.meta
  const F = meta.node_fields.length
  const fT = meta.node_fields.indexOf('type')
  const fN = meta.node_fields.indexOf('name')
  const objIdx = meta.node_types[0].indexOf('object')
  let count = 0
  for (let i = 0; i < json.snapshot.node_count; i++) {
    const b = i * F
    if (json.nodes[b + fT] !== objIdx) continue
    const name = json.strings[json.nodes[b + fN]]
    if (name === 'HTTPParser') count++
  }
  return count
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'interceptors-httpparser-leak-'))
console.log(`Heap snapshots → ${tmp}`)
console.log()

// Baseline (warm-up to settle JIT, then snapshot).
await fireBatch(50, CONCURRENCY)
await forceGc()
const baseSnap = path.join(tmp, 'baseline.heapsnapshot')
writeHeapSnapshot(baseSnap)
const baseCount = countHTTPParser(baseSnap)
console.log(`baseline (after 50 warm-up requests):  HTTPParser=${baseCount}`)
console.log()

// Maintainer asked: "Is there ever a scenario where there are *more* than 100 parsers
// in memory at the same time?" — print the count at several milestones, including
// well past the Node `parsers` FreeList cap (1000), so it's unambiguous.
console.log(
  `Comparison reference: Node's own _http_common.parsers FreeList caps at max=1000.`,
)
console.log()

const results = []
let totalDone = 0
for (const target of MILESTONES) {
  const need = target - totalDone
  await fireBatch(need, CONCURRENCY)
  totalDone = target
  await forceGc()
  const snap = path.join(tmp, `after-${target}.heapsnapshot`)
  writeHeapSnapshot(snap)
  const count = countHTTPParser(snap)
  const delta = count - baseCount
  const perReq = totalDone > 0 ? (delta / totalDone).toFixed(3) : '0.000'
  results.push({ requests: totalDone, count, delta, perReq })
  console.log(
    `after ${String(totalDone).padStart(5)} requests: HTTPParser=${String(count).padStart(6)}  ` +
      `(delta=+${String(delta).padStart(5)}, per-request=${perReq})`,
  )
}

console.log()
console.log('=== summary ===')
const last = results[results.length - 1]
const exceedsHundred = last.count > 100
const exceedsThousand = last.count > 1000
console.log(`HTTPParser count at end (${last.requests} requests): ${last.count}`)
console.log(`  > 100 ?  ${exceedsHundred ? 'YES' : 'no'}`)
console.log(`  > 1000 ? ${exceedsThousand ? 'YES' : 'no'}`)
console.log(`  per-request growth: ~${last.perReq}`)

interceptor.dispose()
agent.destroy()
process.exit(exceedsThousand ? 1 : 0)
