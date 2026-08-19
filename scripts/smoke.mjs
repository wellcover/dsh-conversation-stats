// Smoke test for dsh-conversation-stats host half: stub Cordis ctx, apply(),
// then exercise the list + detail routes against the REAL session logs.
// Run: node scripts/smoke.mjs
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const plugin = await import(pathToFileURL(join(here, '..', 'lib', 'index.js')).href)

const routes = {}
const fakeCtx = {
  get(name) {
    if (name === 'fs') {
      return {
        async resolve(p) { return p },
        async writeText() {},
      }
    }
    if (name === 'webServer') {
      return {
        register(entry) {
          routes[entry.path] = entry.handler
        },
      }
    }
    return undefined
  },
}

console.log('inject:', JSON.stringify(plugin.default.inject))
plugin.default.apply(fakeCtx)
console.log('routes:', Object.keys(routes))

function fakeRes() {
  const chunks = []
  return {
    writeHead(status, headers) { this._status = status; this._headers = headers },
    end(payload) { chunks.push(String(payload)) },
    get body() { return chunks.join('') },
    get status() { return this._status },
  }
}

async function hit(path, query) {
  const res = fakeRes()
  await routes[path]({ url: path + (query ? '?' + query : '') }, res)
  let parsed = null
  try { parsed = JSON.parse(res.body) } catch (e) { parsed = { parseError: String(e) } }
  return { status: res.status, parsed }
}

// ── list ──
const list = await hit('/conversation-stats/api')
if (!list.parsed.ok) {
  console.log('LIST FAIL:', list.parsed.error)
  process.exit(1)
}
console.log('LIST OK. sessions:', list.parsed.sessions.length, '| scannedAt:', new Date(list.parsed.scannedAt).toLocaleString())
for (const s of list.parsed.sessions.slice(0, 5)) {
  const total = (s.outputTokens || 0) + (s.inputTokens || 0) + (s.cacheReadTokens || 0) + (s.cacheWriteTokens || 0)
  console.log(`  ${s.id.slice(0, 22)}… turns=${s.turns} steps=${s.steps} calls=${s.calls} in=${s.inputTokens} out=${s.outputTokens} cache=${s.cacheReadTokens} total=${total} last=${new Date(s.lastTime).toLocaleString()} title="${(s.title || '').slice(0, 24)}"`)
}
if (list.parsed.sessions.length === 0) {
  console.log('WARN: no sessions found')
  process.exit(0)
}

// ── detail (first session) ──
const first = list.parsed.sessions[0]
const detail = await hit('/conversation-stats/api/detail', 'id=' + encodeURIComponent(first.id))
if (!detail.parsed.ok) {
  console.log('DETAIL FAIL:', detail.parsed.error)
  process.exit(1)
}
const d = detail.parsed.session
console.log('DETAIL OK. callsDetail:', (d.callsDetail || []).length, '| toolsDetail:', (d.toolsDetail || []).length)
if (d.callsDetail && d.callsDetail.length > 0) {
  const c = d.callsDetail[0]
  console.log('  first call:', JSON.stringify({ time: new Date(c.time).toLocaleString(), model: c.model, provider: c.provider, stopReason: c.stopReason, input: c.inputTokens, output: c.outputTokens, cache: c.cacheRead, tools: c.tools }))
}
if (d.toolsDetail && d.toolsDetail.length > 0) {
  console.log('  tools:', JSON.stringify(d.toolsDetail.slice(0, 5)))
}
console.log('SMOKE OK')