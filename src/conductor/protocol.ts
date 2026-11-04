/** Versioned, transport-independent Conductor client contract. */
import { z } from 'zod'
import type { TaskGraph } from '../tasks/model.ts'
import { TaskPlanSchema, TaskSpecSchema, TaskUpdateSchema } from '../tasks/model.ts'
import type { WorkerProfile } from '../tasks/workers.ts'
import type { Health } from '../sources/host.ts'

export const PROTOCOL_VERSION = 1 as const
export const DISCOVERY_FILE = 'conductor-daemon.json'
const id = z.string().min(1).max(200)
const revision = z.number().int().nonnegative()
export const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('host.say'), requestId: id, text: z.string().trim().min(1).max(20_000), mode: z.enum(['queue', 'steer']).default('steer') }).strict(),
  z.object({ type: z.literal('task.submit'), requestId: id, plan: TaskPlanSchema }).strict(),
  z.object({ type: z.literal('task.add'), graphId: id, expectedRevision: revision, task: TaskSpecSchema }).strict(),
  z.object({ type: z.literal('task.update'), graphId: id, taskId: id, expectedRevision: revision, changes: TaskUpdateSchema }).strict(),
  z.object({ type: z.literal('task.instruct'), graphId: id, taskId: id, expectedRevision: revision, text: z.string().trim().min(1).max(8000) }).strict(),
  z.object({ type: z.literal('task.cancel'), graphId: id, taskId: id.optional(), expectedRevision: revision }).strict(),
  z.object({ type: z.literal('task.retry'), graphId: id, taskId: id, expectedRevision: revision }).strict(),
])
export type ConductorAction = z.input<typeof ActionSchema>
export interface ConversationEntry { id: string; role: 'user' | 'assistant'; text: string }
export interface ConductorSnapshot {
  version: typeof PROTOCOL_VERSION
  host: { sessionId: string; status: string; conversation: ConversationEntry[] }
  workers: WorkerProfile[]
  graphs: TaskGraph[]
  health: Readonly<Record<string, Health>>
}
export interface ConductorApi {
  snapshot(): ConductorSnapshot
  act(value: unknown): Promise<unknown>
  subscribe(listener: () => void): () => void
}
export const ConnectionSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  instanceId: z.string().uuid(),
  pid: z.number().int().positive(),
  url: z.string().regex(/^http:\/\/127\.0\.0\.1:\d+$/),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  startedAt: z.string(),
}).strict()
export type DaemonConnection = z.infer<typeof ConnectionSchema>

/** An API failure whose code remains stable across transports. */
export class ConductorError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message) }
}
