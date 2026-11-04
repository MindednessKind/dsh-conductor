/** Lightweight client shared by the CLI, TUI and other front ends. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ConnectionSchema, ConductorError, DISCOVERY_FILE, type ConductorAction, type ConductorSnapshot, type DaemonConnection } from './protocol.ts'
export * from './protocol.ts'

/** A client can detach or be destroyed without sending any cancellation request. */
export class ConductorClient {
  constructor(readonly connection: DaemonConnection) { ConnectionSchema.parse(connection) }
  static async connect(stateDir: string): Promise<ConductorClient> {
    let text: string
    try { text = await readFile(join(stateDir, DISCOVERY_FILE), 'utf8') }
    catch { throw new ConductorError('DAEMON_NOT_FOUND', `No daemon connection in ${stateDir}; start Conductor first`, 503) }
    return new ConductorClient(ConnectionSchema.parse(JSON.parse(text)))
  }
  private async request(path: string, value?: unknown, signal?: AbortSignal): Promise<Response> {
    const response = await fetch(this.connection.url + path, {
      method: value === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${this.connection.token}`, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }), signal: signal ?? AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      const result = await response.json() as { error?: { code: string; message: string } }
      throw new ConductorError(result.error?.code ?? 'HTTP_ERROR', result.error?.message ?? `Daemon HTTP ${response.status}`, response.status)
    }
    return response
  }
  async state(signal?: AbortSignal): Promise<ConductorSnapshot> { return await (await this.request('/v1/state', undefined, signal)).json() as ConductorSnapshot }
  async act(action: ConductorAction, signal?: AbortSignal): Promise<unknown> { return await (await this.request('/v1/actions', action, signal)).json() }
  async stop(): Promise<void> { await (await this.request('/v1/shutdown', {})).json() }
  /** Each subscription begins with a complete snapshot, so reconnect needs no event cursor. */
  async watch(listener: (snapshot: ConductorSnapshot) => void, signal: AbortSignal): Promise<void> {
    const response = await this.request('/v1/events', undefined, signal)
    if (!response.body) throw new Error('Daemon returned no event stream')
    const reader = response.body.getReader(), decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        buffer += decoder.decode(next.value, { stream: true })
        if (buffer.length > 8 * 1024 * 1024) throw new Error('Daemon snapshot exceeds client buffer limit')
        let end: number
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, end); buffer = buffer.slice(end + 2)
          if (!event.startsWith('event: snapshot\n')) continue
          const data = event.split('\n').find(line => line.startsWith('data: '))?.slice(6)
          if (data) listener(JSON.parse(data) as ConductorSnapshot)
        }
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  }
}
