/** Authenticated loopback control plane, independent of the optional DSH Web server. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { ConnectionSchema, ConductorError, DISCOVERY_FILE, PROTOCOL_VERSION, type ConductorApi, type DaemonConnection } from './protocol.ts'

const MAX_BODY = 256 * 1024
const send = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify(value))
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new ConductorError('CONTENT_TYPE', 'Expected application/json', 415)
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const part = Buffer.from(chunk)
    size += part.length
    if (size > MAX_BODY) throw new ConductorError('BODY_TOO_LARGE', 'Request exceeds 256 KiB', 413)
    chunks.push(part)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new ConductorError('INVALID_JSON', 'Malformed JSON request') }
}
export interface DaemonServerOptions {
  api: ConductorApi
  stateDir: string
  port?: number
  shutdown(): void
}

/** Owns only transport resources; disconnecting a client never stops task execution. */
export class DaemonServer {
  private readonly server = createServer((req, res) => { void this.handle(req, res) })
  private readonly streams = new Set<ServerResponse>()
  private readonly token = randomBytes(32).toString('hex')
  private connection?: DaemonConnection
  private dispose?: () => void
  private refresh?: ReturnType<typeof setTimeout>
  private heartbeat?: ReturnType<typeof setInterval>
  private stopping?: Promise<void>
  constructor(private readonly options: DaemonServerOptions) {
    this.server.requestTimeout = 15_000
    this.server.headersTimeout = 10_000
  }
  async start(): Promise<DaemonConnection> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.options.port ?? 0, '127.0.0.1', () => { this.server.off('error', reject); resolve() })
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('Daemon did not bind a TCP port')
    const connection = this.connection = { version: PROTOCOL_VERSION, instanceId: randomUUID(), pid: process.pid,
      url: `http://127.0.0.1:${address.port}`, token: this.token, startedAt: new Date().toISOString() }
    const temporary = join(this.options.stateDir, `.${DISCOVERY_FILE}.${connection.instanceId}.tmp`)
    try {
      await writeFile(temporary, JSON.stringify(connection, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
      await rename(temporary, join(this.options.stateDir, DISCOVERY_FILE))
    } catch (error) { await rm(temporary, { force: true }); await this.close(); throw error }
    this.dispose = this.options.api.subscribe(() => {
      if (this.refresh) return
      this.refresh = setTimeout(() => {
        this.refresh = undefined
        if (this.streams.size) {
          const update = this.event()
          for (const stream of this.streams) {
            if (stream.writableLength > 1024 * 1024) stream.destroy()
            else stream.write(update)
          }
        }
      }, 150)
      this.refresh.unref()
    })
    this.heartbeat = setInterval(() => { for (const stream of this.streams) stream.write(': heartbeat\n\n') }, 15_000)
    this.heartbeat.unref()
    return connection
  }
  private event(): string { return `event: snapshot\ndata: ${JSON.stringify(this.options.api.snapshot())}\n\n` }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const address = this.server.address()
      const expectedHost = address && typeof address !== 'string' ? `127.0.0.1:${address.port}` : ''
      if (req.headers.host !== expectedHost || req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) {
        throw new ConductorError('FORBIDDEN_ORIGIN', 'Only direct loopback clients are allowed', 403)
      }
      const authorization = req.headers.authorization ?? ''
      const expected = `Bearer ${this.token}`
      if (authorization.length !== expected.length || !timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))) {
        throw new ConductorError('UNAUTHORIZED', 'Daemon authentication required', 401)
      }
      if (this.stopping) throw new ConductorError('SHUTTING_DOWN', 'Daemon is shutting down', 503)
      if (req.method === 'GET' && req.url === '/v1/state') { send(res, 200, this.options.api.snapshot()); return }
      if (req.method === 'GET' && req.url === '/v1/events') {
        if (this.streams.size >= 32) throw new ConductorError('TOO_MANY_CLIENTS', 'Too many event subscribers', 429)
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
        this.streams.add(res)
        res.on('close', () => { this.streams.delete(res) })
        res.write(this.event())
        return
      }
      if (req.method === 'POST' && req.url === '/v1/actions') {
        // The request socket's lifetime intentionally does not become the execution signal.
        send(res, 200, await this.options.api.act(await body(req)))
        return
      }
      if (req.method === 'POST' && req.url === '/v1/shutdown') {
        const value = await body(req)
        z.object({}).strict().parse(value)
        res.once('finish', () => { this.options.shutdown() })
        send(res, 202, { stopping: true })
        return
      }
      throw new ConductorError('NOT_FOUND', 'Unknown API route', 404)
    } catch (error) {
      if (res.headersSent || res.destroyed) { res.destroy(); return }
      if (error instanceof ConductorError) send(res, error.status, { error: { code: error.code, message: error.message } })
      else if (error instanceof z.ZodError) send(res, 400, { error: { code: 'INVALID_REQUEST', message: z.prettifyError(error) } })
      else send(res, 400, { error: { code: 'ACTION_REJECTED', message: error instanceof Error ? error.message : 'Action rejected' } })
    }
  }
  close(): Promise<void> { return this.stopping ??= this.stop() }
  private async stop(): Promise<void> {
    this.dispose?.()
    clearTimeout(this.refresh)
    clearInterval(this.heartbeat)
    for (const stream of this.streams) stream.end()
    this.streams.clear()
    this.server.closeIdleConnections()
    await new Promise<void>((resolve, reject) => {
      this.server.close(error => { if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error); else resolve() })
      this.server.closeAllConnections()
    })
    const path = join(this.options.stateDir, DISCOVERY_FILE)
    const current = await readFile(path, 'utf8').then(text => ConnectionSchema.parse(JSON.parse(text))).catch(() => undefined)
    if (current?.instanceId === this.connection?.instanceId) await rm(path, { force: true })
  }
}
