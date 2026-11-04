/** Real HTTP and streaming contracts for the detached Conductor control plane. */
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { request } from 'node:http'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DaemonServer } from '../src/conductor/server.ts'
import { ConductorClient } from '../src/conductor/client.ts'
import { ConductorService } from '../src/conductor/service.ts'
import { ConductorTuiStore } from '../src/tui/store.ts'
import { executeConductorCommand } from '../src/tui/commands.ts'
import { Store } from '../src/app/store.ts'
import { TaskEngine } from '../src/tasks/engine.ts'
import { WorkerRegistry } from '../src/tasks/workers.ts'
import type { Runtime } from '../src/app/runtime.ts'
import type { ConductorApi, ConductorSnapshot } from '../src/conductor/protocol.ts'

const cleanups: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const snapshot = (): ConductorSnapshot => ({ version: 1, host: { sessionId: 'host-test', status: 'idle', conversation: [] }, workers: [], graphs: [], health: {} })
async function serverFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'conductor-http-'))
  cleanups.push(() => rm(directory, { force: true, recursive: true }))
  let state = snapshot()
  const listeners = new Set<() => void>(), shutdown = vi.fn()
  const api: ConductorApi = { snapshot: () => state, act: vi.fn(async value => value),
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } }
  const server = new DaemonServer({ api, stateDir: directory, shutdown })
  const connection = await server.start()
  cleanups.push(() => server.close())
  const client = await ConductorClient.connect(directory)
  return { server, connection, directory, client, api, shutdown, update: (next: ConductorSnapshot) => { state = next; for (const listener of listeners) listener() } }
}

it('requires authentication on reads, mutations and streams and rejects browser origins and a forged Host', async () => {
  const { connection, client } = await serverFixture()
  for (const path of ['/v1/state', '/v1/events', '/v1/actions', '/v1/shutdown']) {
    const response = await fetch(connection.url + path, { method: path.includes('state') || path.includes('events') ? 'GET' : 'POST' })
    expect(response.status).toBe(401)
    expect(await response.text()).not.toContain(connection.token)
  }
  for (const headers of [{ Origin: 'https://example.com' }, { Host: 'evil.test' }, { 'Sec-Fetch-Site': 'same-origin' }] as Record<string, string>[]) {
    // fetch implementations may replace forbidden headers, so exercise the wire contract directly.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(connection.url + '/v1/state', { headers: { ...headers, Authorization: `Bearer ${connection.token}` } }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode))
      })
      req.on('error', reject); req.end()
    })
    expect(status).toBe(403)
  }
  expect((await client.state()).host.sessionId).toBe('host-test')
})

it('sends an initial snapshot, releases disconnected subscriptions, and keeps the server available for reconnection', async () => {
  const { client, update, api } = await serverFixture()
  const seen: ConductorSnapshot[] = [], abort = new AbortController()
  const watch = client.watch(value => { seen.push(value) }, abort.signal).catch(() => {})
  await vi.waitFor(() => expect(seen).toHaveLength(1))
  update({ ...snapshot(), host: { ...snapshot().host, status: 'running' } })
  await vi.waitFor(() => expect(seen.at(-1)?.host.status).toBe('running'))
  abort.abort(); await watch
  expect((await client.state()).host.status).toBe('running')
  expect(api.act).not.toHaveBeenCalled()
  const reconnect = new AbortController(), again: ConductorSnapshot[] = []
  const watching = client.watch(value => { again.push(value) }, reconnect.signal).catch(() => {})
  await vi.waitFor(() => expect(again[0]?.host.status).toBe('running'))
  reconnect.abort(); await watching
})

it('completes accepted work after its request disconnects; shutdown is a separate authenticated operation', async () => {
  const { client, api, shutdown, connection } = await serverFixture()
  let finish!: () => void
  const completed = vi.fn()
  api.act = vi.fn(async () => { await new Promise<void>(resolve => { finish = resolve }); completed(); return { accepted: true } })
  const controller = new AbortController()
  const acting = client.act({ type: 'host.say', requestId: 'input-1', text: 'continue working' }, controller.signal).catch(() => {})
  await vi.waitFor(() => expect(api.act).toHaveBeenCalledOnce())
  controller.abort(); await acting
  finish()
  await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce())
  expect(shutdown).not.toHaveBeenCalled()
  expect((await client.state()).version).toBe(1)
  const malformed = await fetch(connection.url + '/v1/actions', { method: 'POST', headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' }, body: '{bad' })
  expect(malformed.status).toBe(400)
  await malformed.text()
  await client.stop()
  await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce())
})

it('rotates discovery on restart and reconnects the terminal store without killing background work', async () => {
  const { server, directory, api, update } = await serverFixture()
  const store = new ConductorTuiStore(directory)
  const running = store.run()
  cleanups.push(async () => { store.stop(); await running })
  await vi.waitFor(() => expect(store.getSnapshot().connected).toBe(true))
  const first = JSON.parse(await readFile(join(directory, 'conductor-daemon.json'), 'utf8')) as { instanceId: string }
  await server.close()
  update({ ...snapshot(), host: { ...snapshot().host, status: 'restarted' } })
  const second = new DaemonServer({ api, stateDir: directory, shutdown: vi.fn() })
  const connection = await second.start()
  cleanups.push(() => second.close())
  expect(connection.instanceId).not.toBe(first.instanceId)
  await vi.waitFor(() => expect(store.getSnapshot().snapshot?.host.status).toBe('restarted'), { timeout: 5000 })
  expect(await executeConductorCommand(store, 'status')).toContain('host-test')
  store.stop(); await running
  expect((await (await ConductorClient.connect(directory)).state()).host.sessionId).toBe('host-test')
})

it('enforces graph revisions, validates input, and deduplicates persisted task submissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'conductor-service-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const database = new Store(join(directory, 'test.sqlite'))
  cleanups.push(() => database.close())
  const workers = WorkerRegistry.parse({ version: 1, profiles: [{ id: 'reviewer', name: 'Reviewer', maxInstances: 1 }] })
  const graphs = new Map()
  const engine = new TaskEngine({ workers, repository: { get: id => graphs.get(id), list: () => [...graphs.values()], save: graph => { graphs.set(graph.id, graph) }, atomic: operation => operation() } })
  const ctx = new Context()
  const runner = { submit: vi.fn((value: unknown) => ({ graph: engine.create(value), scheduled: [] })), list: () => engine.list(), get: (id: string) => engine.get(id), cancelTask: (id: string, task: string, revision: number) => engine.cancelTask(id, task, revision) }
  const hostSession = { id: 'host', deriveEventMessage: (event: { data: unknown }) => event.data }
  ctx.reflect.provide('agents', new Map([['host', { session: hostSession, status: 'idle' }]]))
  ctx.reflect.provide('sessionPersistence', { flush: async () => {}, open: async () => ({ read: async () => ({ events: [] }), [Symbol.asyncDispose]: async () => {} }) })
  const service = new ConductorService(ctx, { ready: Promise.resolve(), masterId: 'host', lifetime: new AbortController().signal,
    sessions: { prompt: vi.fn(async () => {}), promptedId: (id: string) => id },
    taskRunner: runner, store: database, workers, health: {}, machine: { stateDir: directory } } as unknown as Runtime)
  const plan = { objective: 'Review', tasks: [{ id: 'read', title: 'Read', description: 'Read inputs', worker: 'reviewer' }] }
  const submitted = await service.act({ type: 'task.submit', requestId: 'one', plan }) as { graph: { id: string; revision: number } }
  expect(await service.act({ type: 'task.submit', requestId: 'one', plan })).toMatchObject({ graph: { id: submitted.graph.id } })
  expect(runner.submit).toHaveBeenCalledOnce()
  await expect(service.act({ type: 'task.submit', requestId: 'one', plan: { ...plan, objective: 'Different' } })).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' })
  await expect(service.act({ type: 'task.cancel', graphId: submitted.graph.id, taskId: 'read', expectedRevision: 999 })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  await expect(service.act({ type: 'host.say', requestId: 'x', text: '' })).rejects.toThrow()
  await service.act({ type: 'host.say', requestId: 'input', text: 'Review this' })
  await expect(service.act({ type: 'host.say', requestId: 'input', text: 'Change it' })).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' })
  const emit = (seq: number, role: 'user' | 'assistant', id: string, kind: string, text: string) => ctx.emit('session/event', hostSession as never,
    { seq, surfaceOp: 'append', type: `${role}/message`, data: { id, role, source: { kind }, content: [{ type: 'text', text }] } } as never)
  emit(1, 'user', 'context', 'runtime-context', 'Internal context')
  emit(2, 'user', 'conductor-user:input', 'dsh-conductor', 'Review this')
  emit(3, 'assistant', 'reply', 'model', 'Reviewed')
  expect(service.snapshot().host.conversation.map(entry => entry.text)).toEqual(['Review this', 'Reviewed'])
  await service.act({ type: 'task.cancel', graphId: submitted.graph.id, taskId: 'read', expectedRevision: submitted.graph.revision })
  expect(engine.get(submitted.graph.id)?.tasks[0]?.status).toBe('cancelled')
})
