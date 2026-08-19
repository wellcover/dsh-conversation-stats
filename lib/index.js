/**
 * dsh-conversation-stats — HOST half.
 *
 * Cordis plugin for a DeepSeek Harness web profile. Scans the durable session
 * logs under `$DSH_HOME/sessions` (each conversation's `session.jsonl.zstd`)
 * and folds per-conversation statistics: turns, steps, LLM/tool wall times,
 * first-token/decode figures, and token usage (input / output / cache read /
 * cache write), plus per-model and per-tool breakdowns.
 *
 * Storage format (observed, matches dsh-session-persistence-jsonl): the log is
 * a CONCATENATION of independent zstd frames; frame 0 holds the session header
 * line, later frames hold batches of newline-delimited JSON session events
 * (event shape: { type, seq, time, data }). Node's zstdDecompressSync only
 * decodes the first frame of a concatenated stream, so frames are split on the
 * zstd magic bytes and decoded individually.
 *
 * Routes (same-origin, query-string parameter style like dsh-ssh):
 *   GET /conversation-stats/api            → session summaries (cached, TTL)
 *   GET /conversation-stats/api?refresh=1  → force rescan
 *   GET /conversation-stats/api/detail?id=…→ one session's call/tool detail
 *
 * No live event subscription: history and current sessions are read from the
 * logs on demand, so stats survive restarts and cover every conversation.
 */
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import zlib from 'node:zlib'

/** List cache TTL (ms). */
const CACHE_TTL_MS = 30000
/** Cap on sessions in one response (safety). */
const MAX_SESSIONS = 500
/** Sessions log filename. */
const LOG_FILE = 'session.jsonl.zstd'

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}
function optNum(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Split a concatenated zstd stream into individual frames (by magic bytes). */
function splitFrames(buf) {
  const frames = []
  let i = 0
  const n = buf.length
  while (i < n - 3) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) {
      let j = i + 4
      while (j < n - 3 && !(buf[j] === ZSTD_MAGIC[0] && buf[j + 1] === ZSTD_MAGIC[1] && buf[j + 2] === ZSTD_MAGIC[2] && buf[j + 3] === ZSTD_MAGIC[3])) j++
      frames.push(buf.subarray(i, j))
      i = j
    } else i++
  }
  return frames
}

/** Read and decode every event of one session log. */
async function readSessionEvents(file) {
  const buf = await readFile(file)
  const events = []
  for (const frame of splitFrames(buf)) {
    let text
    try { text = zlib.zstdDecompressSync(frame).toString('utf8') } catch (e) { continue }
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (t === '') continue
      try { events.push(JSON.parse(t)) } catch (e) { /* tolerate partial/torn lines */ }
    }
  }
  return events
}

/**
 * True when an event line carries a token-bearing stream delta (first-token
 * anchor). The JSONL stores individual `assistant/chunk` events (block-start /
 * deltas) plus packed chunk runs (`text-chunks`, `reasoning-chunks`,
 * `tool-call-chunks` with seq0/time0 fields). block-start lines are not
 * token deltas, so they are ignored here.
 */
function isTokenDelta(ev) {
  if (ev.type === 'text-chunks' || ev.type === 'reasoning-chunks' || ev.type === 'tool-call-chunks') return true
  if (ev.type !== 'assistant/chunk') return false
  const chunk = ev.data && ev.data.chunk
  if (!chunk || typeof chunk !== 'object') return false
  const type = chunk.type || ''
  return type.endsWith('-delta') || typeof chunk.text === 'string' || typeof chunk.delta === 'string'
}

/** Event timestamp, tolerant of packed `time0` fields. */
function evTime(ev, fallback) {
  const t = typeof ev.time === 'number' ? ev.time : typeof ev.time0 === 'number' ? ev.time0 : null
  return t === null ? fallback : t
}

/**
 * Fold one session's events into a statistics object.
 * @param events - decoded session events (including the `session` header).
 * @param detail - also collect per-call and per-tool detail arrays.
 */
function foldSession(events, detail) {
  const out = {
    id: null, cwd: null, createdAt: null, title: null, firstUserText: null,
    turns: 0, steps: 0, calls: 0,
    llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    models: {}, stopReasons: {}, tools: {}, toolFailures: 0,
    startTime: null, lastTime: 0, durationMs: 0,
  }
  const detailCalls = detail ? [] : null
  const detailTools = detail ? {} : null

  let firstSeen = Infinity
  let lastSeen = 0
  let lastTurn = null
  let openStep = null
  const pendingCalls = {}      // callId -> { time, name }
  const toolAgg = {}           // name -> { count, ms, errors }
  const toolMsById = {}        // callId -> name (for pairing)

  for (const ev of events) {
    const t = evTime(ev, 0)
    if (t < firstSeen) firstSeen = t
    if (t > lastSeen) lastSeen = t
    const d = ev.data || {}
    switch (ev.type) {
      case 'session': {
        out.id = ev.id || null
        out.createdAt = typeof ev.createdAt === 'number' ? ev.createdAt : null
        out.cwd = typeof ev.cwd === 'string' ? ev.cwd : null
        break
      }
      case 'session/title': {
        if (d.title) out.title = String(d.title)
        break
      }
      case 'user/message': {
        if (out.firstUserText === null && d.source && d.source.kind === 'user' && Array.isArray(d.content)) {
          const text = d.content
            .map((c) => (c && c.type === 'text' && typeof c.text === 'string' ? c.text : ''))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim()
          if (text) out.firstUserText = text.slice(0, 90)
        }
        break
      }
      case 'step/start': {
        openStep = { turn: d.turn, step: d.step, startTime: t, firstTokenTime: null }
        break
      }
      case 'assistant/chunk':
      case 'text-chunks':
      case 'reasoning-chunks':
      case 'tool-call-chunks': {
        if (!openStep || openStep.turn !== d.turn || openStep.step !== d.step) break
        if (openStep.firstTokenTime !== null) break
        if (isTokenDelta(ev)) openStep.firstTokenTime = t
        break
      }
      case 'assistant/message': {
        out.calls += 1
        const src = (d.message && d.message.source) || {}
        if (src.provider || src.model) {
          const mk = (src.model || '?') + ' @ ' + (src.provider || '?')
          out.models[mk] = (out.models[mk] || 0) + 1
        }
        const stop = src.replayState && src.replayState.stopReason
        if (stop) out.stopReasons[String(stop)] = (out.stopReasons[String(stop)] || 0) + 1
        const usage = d.usage || {}
        const inputTokens = optNum(usage.inputTokens)
        const outputTokens = optNum(usage.outputTokens)
        const cacheRead = optNum(usage.cacheReadTokens)
        const cacheWrite = optNum(usage.cacheWriteTokens)
        out.inputTokens += num(inputTokens)
        out.outputTokens += num(outputTokens)
        out.cacheReadTokens += num(cacheRead)
        out.cacheWriteTokens += num(cacheWrite)

        const toolNames = []
        if (Array.isArray(d.message && d.message.content)) {
          for (const c of d.message.content) {
            if (c && c.type === 'tool-call' && c.name) toolNames.push(String(c.name))
          }
        }
        if (detail && detailCalls) {
          detailCalls.push({
            seq: ev.seq,
            time: t,
            turn: d.turn,
            step: d.step,
            model: src.model || null,
            provider: src.provider || null,
            stopReason: stop || null,
            inputTokens, outputTokens, cacheRead, cacheWrite,
            tools: toolNames,
          })
        }

        if (openStep && openStep.turn === d.turn && openStep.step === d.step) {
          out.llmMs += Math.max(0, t - openStep.startTime)
          if (openStep.firstTokenTime !== null) {
            out.ttftMs += Math.max(0, openStep.firstTokenTime - openStep.startTime)
            out.ttftSteps += 1
            if (outputTokens !== null && outputTokens > 0) {
              out.decodeMs += Math.max(0, t - openStep.firstTokenTime)
              out.decodeTokens += outputTokens
            }
          }
          openStep = null
        }
        break
      }
      case 'tool/call': {
        const name = String(d.name || 'unknown')
        out.tools[name] = (out.tools[name] || 0) + 1
        if (d.callId && typeof d.callId === 'string') pendingCalls[d.callId] = { time: t, name }
        break
      }
      case 'tool/result': {
        const callId = d.message && d.message.source && d.message.source.callId
        if (typeof callId === 'string') {
          const pending = pendingCalls[callId]
          if (pending) {
            out.toolMs += Math.max(0, t - pending.time)
            if (detailTools && detail) {
              const agg = toolAgg[pending.name] || (toolAgg[pending.name] = { count: 0, ms: 0, errors: 0 })
              agg.count += 1
              agg.ms += Math.max(0, t - pending.time)
            }
            delete pendingCalls[callId]
          }
          // failure detection
          const content = Array.isArray(d.message && d.message.content) ? d.message.content : []
          const isErr = content.some((c) => c && c.type === 'tool-result' && (c.isError === true ||
            (Array.isArray(c.content) && c.content.some((x) => x && (x.type === 'error' || x.isError === true)))))
          if (isErr) {
            out.toolFailures += 1
            if (detailTools && detail && pending) {
              const agg = toolAgg[pending.name]
              if (agg) agg.errors += 1
            }
          }
        }
        break
      }
      case 'step/end': {
        out.steps += 1
        if (lastTurn !== d.turn) {
          out.turns += 1
          lastTurn = d.turn
        }
        openStep = null
        break
      }
      default: break
    }
  }

  out.startTime = firstSeen === Infinity ? null : firstSeen
  out.lastTime = lastSeen || out.createdAt || 0
  out.durationMs = out.startTime !== null ? Math.max(0, out.lastTime - out.startTime) : 0

  if (detail && detailCalls) out.callsDetail = detailCalls
  if (detail && detailTools) {
    out.toolsDetail = Object.entries(toolAgg)
      .map(([name, agg]) => ({ name, count: agg.count, ms: Math.round(agg.ms), errors: agg.errors }))
      .sort((a, b) => b.count - a.count)
  }
  return out
}

export default {
  inject: ['fs', 'webServer'],
  apply(ctx) {
    const diag = { ok: true, steps: [], error: null }
    const push = (s) => { try { diag.steps.push(String(s)) } catch (e) { /* noop */ } }
    const flushDiag = () => {
      try {
        const fs = ctx.get('fs')
        if (fs && typeof fs.resolve === 'function' && typeof fs.writeText === 'function') {
          fs.resolve('conversation-stats-boot.log')
            .then((target) => fs.writeText(target, JSON.stringify({ time: Date.now(), ...diag }, null, 2)))
            .catch(() => { /* boot log best-effort */ })
        }
      } catch (e) { /* noop */ }
    }

    try {
      push('apply-start')

      const msg = (e) => String((e && e.message) || e)

      function sessionsRoot() {
        const home = process.env.DSH_HOME || join(homedir(), '.dsh')
        return join(home, 'sessions')
      }

      async function listSessionLogs() {
        const root = sessionsRoot()
        let workspaces = []
        try {
          workspaces = await readdir(root, { withFileTypes: true })
        } catch (e) {
          throw new Error('无法读取会话目录（' + root + '）：' + msg(e))
        }
        const files = []
        for (const ws of workspaces) {
          if (!ws.isDirectory()) continue
          const wsDir = join(root, ws.name)
          let entries = []
          try { entries = await readdir(wsDir, { withFileTypes: true }) } catch (e) { continue }
          for (const ent of entries) {
            if (!ent.isDirectory()) continue
            const file = join(wsDir, ent.name, LOG_FILE)
            try {
              await stat(file)
              files.push({ path: file, sessionId: ent.name, workspaceKey: ws.name })
            } catch (e) { /* no log (empty session dir) */ }
          }
        }
        return files
      }

      async function scanAll() {
        const files = await listSessionLogs()
        files.sort((a, b) => a.path.localeCompare(b.path))
        const list = []
        let count = 0
        for (const f of files) {
          if (count >= MAX_SESSIONS) break
          let events
          try {
            events = await readSessionEvents(f.path)
          } catch (e) {
            continue
          }
          const s = foldSession(events, false)
          s.workspaceKey = f.workspaceKey
          list.push(summaryView(s))
          count += 1
        }
        list.sort((a, b) => (b.lastTime || 0) - (a.lastTime || 0))
        return list
      }

      function summaryView(s) {
        return {
          id: s.id,
          cwd: s.cwd,
          workspaceKey: s.workspaceKey,
          title: s.title,
          firstUserText: s.firstUserText,
          createdAt: s.createdAt,
          startTime: s.startTime,
          lastTime: s.lastTime,
          durationMs: s.durationMs,
          turns: s.turns,
          steps: s.steps,
          calls: s.calls,
          llmMs: s.llmMs,
          toolMs: s.toolMs,
          ttftMs: s.ttftMs,
          ttftSteps: s.ttftSteps,
          decodeMs: s.decodeMs,
          decodeTokens: s.decodeTokens,
          inputTokens: s.inputTokens,
          outputTokens: s.outputTokens,
          cacheReadTokens: s.cacheReadTokens,
          cacheWriteTokens: s.cacheWriteTokens,
          toolFailures: s.toolFailures,
          models: s.models,
          stopReasons: s.stopReasons,
          tools: s.tools,
        }
      }

      // ── list cache ──
      let cache = { at: 0, data: null }
      async function listSessions(force) {
        const now = Date.now()
        if (!force && cache.data !== null && now - cache.at < CACHE_TTL_MS) return cache.data
        const data = await scanAll()
        cache = { at: Date.now(), data }
        return data
      }

      async function sessionDetail(sessionId) {
        const files = await listSessionLogs()
        const target = files.find((f) => f.sessionId === sessionId)
        if (!target) return { ok: false, error: '未找到会话 ' + sessionId }
        const events = await readSessionEvents(target.path)
        const s = foldSession(events, true)
        s.workspaceKey = target.workspaceKey
        return { ok: true, session: detailView(s) }
      }

      function detailView(s) {
        const base = summaryView(s)
        return {
          ...base,
          callsDetail: s.callsDetail || [],
          toolsDetail: s.toolsDetail || [],
          stopReasons: s.stopReasons,
        }
      }

      /**
       * Permanently delete one conversation's directory.
       *
       * Safety: the target is resolved from `listSessionLogs()` (which walks
       * `$DSH_HOME/sessions` itself) — never from the caller-supplied id used
       * as a raw path — so a malicious `id` like `../..` cannot escape the
       * sessions root. Deleting the whole per-session folder also removes its
       * `session.jsonl.zstd` (and any sibling meta files).
       */
      async function deleteSessionFolder(sessionId) {
        const files = await listSessionLogs()
        const target = files.find((f) => f.sessionId === sessionId && !/[/\\]/.test(sessionId))
        if (!target) return { ok: false, error: '未找到会话 ' + sessionId }
        const folder = dirname(target.path) // <sessions>/<workspace>/<sessionId>
        await rm(folder, { recursive: true, force: true })
        cache = { at: 0, data: null } // invalidate list cache
        return { ok: true, id: sessionId }
      }

      const webServer = ctx.get('webServer')
      push('webServer=' + (webServer ? 'present' : 'undefined'))
      if (webServer && typeof webServer.register === 'function') {
        try {
          const sendJson = (res, obj) => {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
            res.end(JSON.stringify(obj))
          }
          const queryOf = (req) => {
            const url = (req && req.url) || ''
            const q = url.indexOf('?') >= 0 ? url.slice(url.indexOf('?') + 1) : ''
            return new URLSearchParams(q)
          }

          webServer.register({
            kind: 'exact',
            path: '/conversation-stats/api',
            handler: async (req, res) => {
              const query = queryOf(req)
              let payload
              try {
                const force = query.get('refresh') === '1'
                const sessions = await listSessions(force)
                payload = { ok: true, scannedAt: Date.now(), sessions }
              } catch (e) {
                payload = { ok: false, error: msg(e) }
              }
              sendJson(res, payload)
            },
          })
          push('route-registered:list')

          webServer.register({
            kind: 'exact',
            path: '/conversation-stats/api/detail',
            handler: async (req, res) => {
              const query = queryOf(req)
              const id = query.get('id') || ''
              let payload
              try {
                if (!id) payload = { ok: false, error: '缺少会话 id' }
                else payload = await sessionDetail(id)
              } catch (e) {
                payload = { ok: false, error: msg(e) }
              }
              sendJson(res, payload)
            },
          })
          push('route-registered:detail')

          webServer.register({
            kind: 'exact',
            path: '/conversation-stats/api/delete',
            handler: async (req, res) => {
              const query = queryOf(req)
              const id = query.get('id') || ''
              let payload
              try {
                if (!id) payload = { ok: false, error: '缺少会话 id' }
                else payload = await deleteSessionFolder(id)
              } catch (e) {
                payload = { ok: false, error: msg(e) }
              }
              sendJson(res, payload)
            },
          })
          push('route-registered:delete')
        } catch (e) {
          push('route-register-threw: ' + (e && e.stack ? e.stack : msg(e)))
        }
      } else {
        push('route-not-registered (no webServer)')
      }

      push('apply-end')
      diag.ok = true
    } catch (e) {
      diag.ok = false
      diag.error = (e && e.stack) ? e.stack : String(e)
    }
    flushDiag()
  },
}