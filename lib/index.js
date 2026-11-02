import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// dsh-audio-rail-macos — host half.
//
// Owns one native Core Audio helper (a process-tap spectrum analyzer), starts
// it only while at least one browser tab is subscribed, and relays its NDJSON
// frames to that tab over Server-Sent Events on the same origin. Nothing here
// knows about the DOM: the browser half decides what a frame means.
//
// Routes (loopback only — the frames are an ambient signal, not a secret, but
// keeping them local also keeps the drag of a public surface at zero):
//   GET /audio-rail/events  SSE: `event: frame` + heartbeat
//   GET /audio-rail/status  JSON snapshot, for one-shot debugging
//
// Native plumbing adapted from dsh-bgm (MIT, © skymecode).

const name = 'dsh-audio-rail-macos'
const inject = ['webServer']

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BINARY = join(PACKAGE_ROOT, 'native', 'bin', 'dsh-audio-rail-tap')

const BAND_COUNT = 12
const EVENTS_PATH = '/audio-rail/events'
const STATUS_PATH = '/audio-rail/status'
const HEARTBEAT_MS = 15_000
// Last subscriber gone: keep the capture running a little, so a reload (⌘R)
// re-attaches to a warm helper instead of re-asking Core Audio for the tap.
const STOP_GRACE_MS = 15_000
const RESTART_BASE_MS = 500
const RESTART_CEILING_MS = 15_000
const MAX_RESTART_ATTEMPTS = 10
const KILL_CEILING_MS = 3_000

function isLoopback(req) {
  const address = req.socket.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

function rejectRemote(res) {
  res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ error: 'forbidden: loopback-only' }))
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  })
  res.end(JSON.stringify(body))
}

function isUnit(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

/** A frame is only usable when every one of its bands is a real 0..1 number. */
function frameOf(value) {
  if (typeof value !== 'object' || value === null) return undefined
  const bands = value.bands
  if (!Array.isArray(bands) || bands.length !== BAND_COUNT) return undefined
  for (const band of bands) if (!isUnit(band)) return undefined
  if (typeof value.capturedAt !== 'number' || !Number.isFinite(value.capturedAt)) return undefined
  return {
    capturedAt: value.capturedAt,
    bands: bands.slice(),
    rms: isUnit(value.rms) ? value.rms : 0,
    onset: isUnit(value.onset) ? value.onset : 0,
  }
}

/**
 * A permission refusal surfaces as a Core Audio fourCC or as `localizedDescription`;
 * the fourCC `!pri`/`!obj` pair is what a denied tap looks like on macOS 14.2+.
 */
function looksDenied(message) {
  return /permission|not permitted|denied|!pri|!obj|授权/i.test(message)
}

function nativeEvent(line) {
  let value
  try {
    value = JSON.parse(line)
  } catch {
    return
  }
  if (typeof value !== 'object' || value === null) return
  switch (value.type) {
    case 'ready':
      if (value.platform !== 'darwin') return
      return {
        type: 'ready',
        sampleRate: typeof value.sampleRate === 'number' ? value.sampleRate : 0,
        channels: typeof value.channels === 'number' ? value.channels : 0,
      }
    case 'frame': {
      const frame = frameOf(value.frame)
      return frame === undefined ? undefined : { type: 'frame', frame }
    }
    case 'permission':
      return {
        type: 'permission',
        granted: value.granted === true,
        reason: typeof value.reason === 'string' ? value.reason : undefined,
      }
    case 'error':
      if (typeof value.message !== 'string') return
      return {
        type: 'error',
        code: typeof value.code === 'string' ? value.code : 'audio-start',
        message: value.message,
      }
    default:
      return
  }
}

/**
 * The single helper, shared by every subscriber. Frames are pushed straight to
 * the listeners; the snapshot exists for `/audio-rail/status` and for the
 * status event a fresh subscriber gets before its first frame.
 */
class AudioRail {
  constructor(ctx) {
    this.ctx = ctx
    this.listeners = new Set()
    this.child = undefined
    this.stopTimer = undefined
    this.restartTimer = undefined
    this.killTimer = undefined
    this.restartAttempt = 0
    this.stopping = false
    this.snapshotValue = { platform: process.platform, status: 'idle', updatedAt: Date.now() }
  }

  snapshot() {
    return this.snapshotValue
  }

  subscribe(listener) {
    this.listeners.add(listener)
    listener({ kind: 'status', status: this.snapshotValue })
    if (this.stopTimer !== undefined) {
      clearTimeout(this.stopTimer)
      this.stopTimer = undefined
    }
    // A reload is the natural retry after the user granted system-audio
    // recording: clear the terminal verdict so ensureStarted() tries again.
    if (this.snapshotValue.status === 'permission-denied') {
      this.snapshotValue = { ...this.snapshotValue, status: 'idle', error: undefined }
    }
    this.ensureStarted()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size > 0 || this.stopTimer !== undefined) return
      this.stopTimer = setTimeout(() => {
        this.stopTimer = undefined
        if (this.listeners.size === 0) this.stop()
      }, STOP_GRACE_MS)
      this.stopTimer.unref?.()
    }
  }

  dispose() {
    this.stopping = true
    for (const timer of [this.stopTimer, this.restartTimer, this.killTimer]) {
      if (timer !== undefined) clearTimeout(timer)
    }
    this.stopTimer = undefined
    this.restartTimer = undefined
    this.killTimer = undefined
    this.listeners.clear()
    this.stop()
  }

  publish(patch) {
    this.snapshotValue = { ...this.snapshotValue, ...patch, updatedAt: Date.now() }
    for (const listener of this.listeners) listener({ kind: 'status', status: this.snapshotValue })
  }

  push(frame) {
    for (const listener of this.listeners) listener({ kind: 'frame', frame })
  }

  ensureStarted() {
    if (this.child !== undefined || this.restartTimer !== undefined || this.stopping) return
    if (this.listeners.size === 0) return
    if (process.platform !== 'darwin') {
      this.publish({ status: 'unsupported', error: `unsupported platform: ${process.platform}` })
      return
    }
    try {
      accessSync(BINARY, constants.X_OK)
    } catch {
      this.publish({ status: 'error', error: `native helper missing or not executable: ${BINARY}` })
      return
    }
    this.publish({ status: 'starting', error: undefined, bands: undefined })

    let child
    try {
      child = spawn(BINARY, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      this.publish({ status: 'error', error: error.message })
      this.scheduleRestart()
      return
    }
    this.child = child

    if (child.stdout !== null) {
      createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
        if (line.trim() === '') return
        const event = nativeEvent(line)
        if (event === undefined) {
          this.ctx.logger.warn(`${name}: malformed helper line: ${line.slice(0, 240)}`)
          return
        }
        this.handle(event)
      })
    }
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      const message = String(chunk).trim()
      if (message !== '') this.ctx.logger.warn(`${name} helper: ${message}`)
    })
    child.on('error', (error) => {
      this.publish({ status: 'error', error: error.message })
    })
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = undefined
      if (this.stopping || this.listeners.size === 0) return
      // A refusal is reported by the helper right before it exits (exit 2).
      // Restarting it would just burn processes until the user grants
      // "System Audio Recording", so keep the verdict and stay down; a fresh
      // subscription (page reload) is the retry.
      if (this.snapshotValue.status === 'permission-denied') return
      this.publish({ status: 'error', error: `native helper exited (${signal ?? code ?? 'unknown'})` })
      this.scheduleRestart()
    })
  }

  scheduleRestart() {
    if (this.restartTimer !== undefined || this.stopping || this.listeners.size === 0) return
    // The verdict can arrive a tick after the exit event; never race it.
    if (this.snapshotValue.status === 'permission-denied') return
    // A helper that keeps dying is not going to heal itself: give up after a
    // few attempts and let the status route tell the user why.
    if (this.restartAttempt >= MAX_RESTART_ATTEMPTS) {
      this.publish({ status: 'error', error: `native helper keeps exiting (gave up after ${MAX_RESTART_ATTEMPTS} restarts)` })
      return
    }
    const delay = Math.min(RESTART_BASE_MS * 2 ** this.restartAttempt, RESTART_CEILING_MS)
    this.restartAttempt += 1
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      this.ensureStarted()
    }, delay)
    this.restartTimer.unref?.()
  }

  handle(event) {
    switch (event.type) {
      case 'ready':
        this.restartAttempt = 0
        this.publish({
          status: 'listening',
          error: undefined,
          sampleRate: event.sampleRate,
          channels: event.channels,
        })
        return
      case 'frame':
        this.push(event.frame)
        // A frame is proof of life; the snapshot only changes when the stream
        // starts so the status route stays cheap.
        if (this.snapshotValue.status !== 'listening') this.publish({ status: 'listening', error: undefined })
        return
      case 'permission':
        this.publish({ status: 'permission-denied', error: event.reason })
        return
      case 'error':
        this.publish({
          status: looksDenied(event.message) ? 'permission-denied' : 'error',
          error: event.message,
        })
        return
    }
  }

  stop() {
    if (this.restartTimer !== undefined) clearTimeout(this.restartTimer)
    if (this.killTimer !== undefined) clearTimeout(this.killTimer)
    this.restartTimer = undefined
    this.killTimer = undefined
    const child = this.child
    this.child = undefined
    // Nobody is left to hear frames, so the snapshot must not keep claiming
    // the capture is live: the exit handler below stays silent in this case.
    if (!this.stopping) this.publish({ status: 'idle', error: undefined, bands: undefined })
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    this.killTimer = setTimeout(() => {
      this.killTimer = undefined
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, KILL_CEILING_MS)
    this.killTimer.unref?.()
  }
}

function registerRoutes(ctx, rail) {
  const disposeStatus = ctx.webServer.register({
    kind: 'exact',
    path: STATUS_PATH,
    handler(req, res) {
      if (!isLoopback(req)) return rejectRemote(res)
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      sendJson(res, 200, rail.snapshot())
    },
  })

  const disposeEvents = ctx.webServer.register({
    kind: 'exact',
    path: EVENTS_PATH,
    handler(req, res) {
      if (!isLoopback(req)) return rejectRemote(res)
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'access-control-allow-origin': '*',
      })
      res.write(': connected\n\n')

      let closed = false
      let unsubscribe = () => {}
      const heartbeat = setInterval(() => {
        if (!closed && !res.writableEnded) res.write(': heartbeat\n\n')
      }, HEARTBEAT_MS)

      unsubscribe = rail.subscribe((event) => {
        if (closed || res.writableEnded) return
        if (event.kind === 'frame') {
          res.write(`event: frame\ndata: ${JSON.stringify(event.frame)}\n\n`)
          return
        }
        res.write(`event: status\ndata: ${JSON.stringify(event.status)}\n\n`)
      })

      const close = () => {
        if (closed) return
        closed = true
        clearInterval(heartbeat)
        unsubscribe()
      }
      req.once('close', close)
      res.once('close', close)
    },
  })

  return () => {
    disposeEvents()
    disposeStatus()
  }
}

/** DSH/Cordis plugin entry point: one lazily-started helper behind two routes. */
function apply(ctx) {
  const rail = new AudioRail(ctx)
  ctx.effect(() => {
    const disposeRoutes = registerRoutes(ctx, rail)
    return () => {
      disposeRoutes()
      rail.dispose()
    }
  }, 'dsh-audio-rail-macos: host')
}

export { apply, inject, name }
