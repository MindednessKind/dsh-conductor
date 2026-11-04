/** Stable host-side facade over the existing scheduler and Session lifecycle. */
import { Service, type Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Runtime } from '../app/runtime.ts'
import { record } from '../kv.ts'
import { ActionSchema, ConductorError, PROTOCOL_VERSION, type ConductorApi, type ConductorSnapshot, type ConversationEntry } from './protocol.ts'

declare module '@deepseek-ai/cordis' { interface Context { conductor: ConductorService } }

/** The sole public task service; clients never obtain database or Agent handles. */
export class ConductorService extends Service implements ConductorApi {
  private readonly listeners = new Set<() => void>()
  private readonly transcript = new Map<number, ConversationEntry>()
  private readonly pendingInputs = new Map<string, Promise<void>>()
  private loaded?: Promise<void>
  constructor(ctx: Context, private readonly runtime: Runtime) {
    super(ctx, 'conductor')
    ctx.on('session/event', (session, event) => { if (session.id === runtime.masterId) { this.consume(event); this.changed() } })
    ctx.on('agent/status', ({ agent }) => { if (agent.id === runtime.masterId) this.changed() })
  }
  get stateDir(): string { return this.runtime.machine.stateDir }
  get ready(): Promise<void> {
    return this.loaded ??= this.runtime.ready.then(async () => {
      await this.ctx.sessionPersistence.flush()
      await using handle = await this.ctx.sessionPersistence.open(this.runtime.masterId as never, 'read')
      for (let offset = 0; ; ) {
        const { events } = await handle.read(offset, 512)
        if (!events.length) break
        for (const event of events) this.consume(event)
        offset += events.length
      }
    }).catch(error => { this.loaded = undefined; throw error })
  }
  private consume(event: SessionEvent): void {
    if (event.surfaceOp !== 'append' || !['user/message', 'assistant/message'].includes(event.type)) return
    const agent = this.ctx.agents.get(this.runtime.masterId as never)
    const message = agent?.session.deriveEventMessage(event)
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) return
    if (message.role === 'user' && message.source.kind !== 'user'
      && !(message.source.kind === 'dsh-conductor' && this.runtime.store.get(record<boolean>(`conductor-input-message:${message.id}`)))) return
    const text = message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    if (text) this.transcript.set(event.seq, { id: String(event.seq), role: message.role, text: text.slice(-20_000) })
    if (this.transcript.size > 100) this.transcript.delete(Math.min(...this.transcript.keys()))
  }
  changed(): void { for (const listener of this.listeners) listener() }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  snapshot(): ConductorSnapshot {
    const agent = this.ctx.agents.get(this.runtime.masterId as never)
    const conversation = [...this.transcript.entries()].sort(([a], [b]) => a - b).map(([, entry]) => entry)
    return { version: PROTOCOL_VERSION,
      host: { sessionId: this.runtime.masterId, status: agent?.status ?? 'starting', conversation: conversation.slice(-100) },
      workers: this.runtime.workers?.list() ?? [], graphs: this.runtime.taskRunner?.list() ?? [], health: this.runtime.health }
  }
  async act(value: unknown): Promise<unknown> {
    const action = ActionSchema.parse(value)
    await this.ready
    this.runtime.lifetime.throwIfAborted()
    if (action.type === 'host.say') {
      const key = record<string>(`conductor-input:${action.requestId}`)
      const fingerprint = createHash('sha256').update(JSON.stringify([action.text, action.mode])).digest('hex')
      const previous = this.runtime.store.get(key)
      if (previous && previous !== fingerprint) throw new ConductorError('REQUEST_CONFLICT', 'Request ID was already used for another Host instruction', 409)
      this.runtime.store.set(key, fingerprint)
      this.runtime.store.set(record<boolean>(`conductor-input-message:${this.runtime.sessions.promptedId(`conductor-user:${action.requestId}`)}`), true)
      let pending = this.pendingInputs.get(action.requestId)
      if (!pending) {
        pending = this.runtime.sessions.prompt(this.runtime.masterId, `conductor-user:${action.requestId}`, action.text, action.mode)
        this.pendingInputs.set(action.requestId, pending)
      }
      try { await pending } finally { if (this.pendingInputs.get(action.requestId) === pending) this.pendingInputs.delete(action.requestId) }
      this.changed()
      return { accepted: true, requestId: action.requestId, sessionId: this.runtime.masterId }
    }
    const runner = this.runtime.taskRunner
    if (!runner) throw new ConductorError('WORKERS_NOT_CONFIGURED', 'Create workers.json in the daemon state directory', 503)
    if (action.type === 'task.submit') {
      const requestKey = record<{ fingerprint: string; graphId: string }>(`conductor-submit:${action.requestId}`)
      const fingerprint = createHash('sha256').update(JSON.stringify(action.plan)).digest('hex')
      const previous = this.runtime.store.get(requestKey)
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new ConductorError('REQUEST_CONFLICT', 'Request ID was already used for another task plan', 409)
        return { graph: runner.get(previous.graphId), scheduled: [] }
      }
      // Graph creation and its idempotency record commit together; asynchronous launch runs after commit.
      const result = this.runtime.store.atomic(() => {
        const submitted = runner.submit(action.plan)
        this.runtime.store.set(requestKey, { fingerprint, graphId: submitted.graph.id })
        return submitted
      })
      this.changed()
      return result
    }
    const graph = runner.get(action.graphId)
    if (!graph) throw new ConductorError('NOT_FOUND', `Task graph not found: ${action.graphId}`, 404)
    if (graph.revision !== action.expectedRevision) throw new ConductorError('REVISION_CONFLICT', `Task graph revision changed to ${graph.revision}; refresh before editing`, 409)
    let result: unknown
    switch (action.type) {
      case 'task.add': result = runner.addTask(action.graphId, action.task, action.expectedRevision); break
      case 'task.update': result = runner.updateTask(action.graphId, action.taskId, action.changes, action.expectedRevision); break
      case 'task.instruct': result = await runner.instruct(action.graphId, action.taskId, action.text, action.expectedRevision); break
      case 'task.cancel': result = action.taskId ? runner.cancelTask(action.graphId, action.taskId, action.expectedRevision) : runner.cancel(action.graphId); break
      case 'task.retry': result = runner.retry(action.graphId, action.taskId); break
    }
    this.changed()
    return result
  }
}
