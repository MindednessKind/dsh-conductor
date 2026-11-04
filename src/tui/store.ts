/** Reconnecting external store for terminal surfaces; no task ownership lives here. */
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { ConductorClient } from '../conductor/client.ts'
import type { ConductorAction, ConductorSnapshot } from '../conductor/protocol.ts'

export interface TuiConnectionState { snapshot?: ConductorSnapshot; error?: string; connected: boolean }
/** Reconnects from the discovery file so a restarted daemon can rotate its port and token. */
export class ConductorTuiStore {
  private state: TuiConnectionState = { connected: false }
  private readonly listeners = new Set<() => void>()
  private readonly controller = new AbortController()
  private client?: ConductorClient
  constructor(readonly stateDir: string) {}
  getSnapshot = (): TuiConnectionState => this.state
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private update(state: TuiConnectionState): void { this.state = state; for (const listener of this.listeners) listener() }
  async run(): Promise<void> {
    while (!this.controller.signal.aborted) {
      try {
        this.client = await ConductorClient.connect(this.stateDir)
        await this.client.watch(snapshot => this.update({ connected: true, snapshot }), this.controller.signal)
        if (!this.controller.signal.aborted) throw new Error('Daemon connection closed; reconnecting')
      } catch (error) {
        if (this.controller.signal.aborted) return
        this.update({ ...this.state, connected: false, error: error instanceof Error ? error.message : String(error) })
      }
      await delay(1500, undefined, { signal: this.controller.signal }).catch(() => {})
    }
  }
  stop(): void { this.controller.abort() }
  async act(action: ConductorAction): Promise<unknown> {
    const client = await ConductorClient.connect(this.stateDir)
    return client.act(action, this.controller.signal)
  }
  say(text: string): Promise<unknown> { return this.act({ type: 'host.say', requestId: randomUUID(), text }) }
  async refresh(): Promise<ConductorSnapshot> {
    const client = await ConductorClient.connect(this.stateDir)
    const snapshot = await client.state(this.controller.signal)
    this.update({ connected: true, snapshot })
    return snapshot
  }
}
