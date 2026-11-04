import { z } from 'zod'
import { isAbsolute } from 'node:path'

export type TaskStatus = 'pending' | 'ready' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled'
export type TaskGraphStatus = 'active' | 'blocked' | 'completed' | 'failed' | 'cancelled'

export const TaskSpecSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional(),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(20_000),
  worker: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  dependsOn: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)).default([]),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(1000)).max(30).default([]),
  workspace: z.string().trim().min(1).optional().describe('Absolute working directory for the Worker. Set this field when the task uses an existing project, sample or project-local Skill; mentioning a path only in the description does not select it. Must be within the profile workspaceRoot. Omit to create a fresh task directory.'),
}).strict().superRefine((task, context) => {
  if (task.workspace && !isAbsolute(task.workspace)) context.addIssue({ code: 'custom', path: ['workspace'], message: 'Task workspace must be an absolute path' })
})
export type TaskSpec = z.infer<typeof TaskSpecSchema>

export const TaskPlanSchema = z.object({
  objective: z.string().trim().min(1).max(4000),
  tasks: z.array(TaskSpecSchema).min(1).max(200),
}).strict()
export type TaskPlan = z.infer<typeof TaskPlanSchema>

export const TaskUpdateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().min(1).max(20_000).optional(),
  worker: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).optional(),
  dependsOn: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)).optional(),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(1000)).max(30).optional(),
  workspace: z.string().trim().min(1).optional().describe('Absolute working directory for the next Worker run; must be within its profile workspaceRoot.'),
}).strict().refine(value => Object.keys(value).length > 0, 'At least one task field must change')
  .superRefine((task, context) => {
    if (task.workspace && !isAbsolute(task.workspace)) context.addIssue({ code: 'custom', path: ['workspace'], message: 'Task workspace must be an absolute path' })
  })
export type TaskUpdate = z.infer<typeof TaskUpdateSchema>

export const TaskInstructionSchema = z.object({
  id: z.string().min(1),
  text: z.string().trim().min(1).max(8000),
  at: z.string().datetime(),
  deliveredAt: z.string().datetime().optional(),
}).strict()
export type TaskInstruction = z.infer<typeof TaskInstructionSchema>

export interface WorkerRun {
  id: string
  profile: string
  sessionId: string
  attempt: number
  state: 'running' | 'completed' | 'blocked' | 'failed' | 'cancelled'
  startedAt: string
  endedAt?: string
}

export interface TaskRecord extends TaskSpec {
  id: string
  status: TaskStatus
  attempts: number
  createdAt: string
  updatedAt: string
  run?: WorkerRun
  report?: { state: 'progress' | 'completed' | 'blocked' | 'failed'; summary: string; at: string; artifacts?: string[] }
  blockedBy?: string[]
  instructions?: TaskInstruction[]
}

export interface TaskGraph {
  id: string
  objective: string
  revision: number
  status: TaskGraphStatus
  tasks: TaskRecord[]
  createdAt: string
  updatedAt: string
}

export const TaskReportSchema = z.object({
  state: z.enum(['progress', 'completed', 'blocked', 'failed']),
  summary: z.string().trim().min(1).max(4000),
  artifacts: z.array(z.string().trim().min(1).max(2000)).max(40).optional(),
}).strict()
export type TaskReport = z.infer<typeof TaskReportSchema>
