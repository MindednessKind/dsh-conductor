import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'
import { mkdirSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { TaskEngine } from '../tasks/engine.ts'
import { TaskPlanSchema, TaskSpecSchema, TaskUpdateSchema, type TaskGraph, type TaskRecord, type TaskReport, type WorkerRun } from '../tasks/model.ts'
import { workerToolNames, type WorkerProfile, type WorkerRegistry } from '../tasks/workers.ts'
import type { Sessions } from '../app/sessions.ts'
import { TaskReportSchema } from '../tasks/model.ts'
import { killJobs, until } from './background.ts'

export interface TaskWorkerBinding { graph: TaskGraph; task: TaskRecord; run: WorkerRun; profile: WorkerProfile }

export interface TaskRunnerHost {
  context: Context
  engine: TaskEngine
  workers: WorkerRegistry
  sessions: Pick<Sessions, 'ensure' | 'prompt' | 'relay'>
  atomic<T>(operation: () => T): T
  stateDir: string
  lifetime: AbortSignal
  closing(): boolean
}

/** Runs independent task graphs in profile-scoped DSH Sessions and feeds their reports back into the graph scheduler. */
export class TaskRunner {
  private readonly disposers: (() => void)[] = []
  private readonly delivered = new Set<string>()
  private readonly launches = new Set<Promise<void>>()
  private readonly stops = new Set<Promise<void>>()

  constructor(private readonly host: TaskRunnerHost) {
    this.disposers.push(host.context.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle' || host.closing()) return
      const binding = this.worker(agent.id)
      if (!binding || !this.delivered.has(agent.id)) return
      this.delivered.delete(agent.id)
      this.report(agent.id, {
        state: 'blocked', summary: 'Worker ended its turn without a completed, blocked, or failed task report.',
      })
    }), host.context.on('agent/error', ({ agent, error }) => {
      if (host.closing() || !this.delivered.has(agent.id) || !this.worker(agent.id)) return
      this.report(agent.id, { state: 'failed', summary: `Worker execution failed: ${String(error).slice(0, 1500)}` })
    }))
  }

  submit(value: unknown): { graph: TaskGraph; scheduled: string[] } {
    const plan = TaskPlanSchema.parse(value)
    for (const task of plan.tasks) {
      const profile = this.host.workers.require(task.worker)
      this.workspace({ id: 'pending' }, task as TaskRecord, profile)
    }
    const graph = this.host.engine.create(plan)
    const scheduled = this.start(graph.id)
    return { graph: this.host.engine.get(graph.id) ?? graph, scheduled }
  }

  list(): TaskGraph[] { return this.host.engine.list() }
  get(graphId: string): TaskGraph | undefined { return this.host.engine.get(graphId) }

  updateTask(graphId: string, taskId: string, value: unknown, expectedRevision?: number): { graph: TaskGraph; scheduled: string[] } {
    const current = this.host.engine.get(graphId)?.tasks.find(task => task.id === taskId)
    if (!current) throw new Error(`Task not found in graph ${graphId}: ${taskId}`)
    const patch = TaskUpdateSchema.parse(value)
    const candidate = { ...current, ...patch }
    this.workspace(this.host.engine.get(graphId)!, candidate, this.host.workers.require(candidate.worker))
    const graph = this.host.engine.updateTask(graphId, taskId, value, expectedRevision)
    const scheduled = this.start(graphId)
    return { graph: this.host.engine.get(graphId) ?? graph, scheduled }
  }

  addTask(graphId: string, value: unknown, expectedRevision?: number): { graph: TaskGraph; scheduled: string[] } {
    const task = TaskSpecSchema.parse(value)
    const current = this.host.engine.get(graphId)
    if (!current) throw new Error(`Task graph not found: ${graphId}`)
    this.workspace(current, task as TaskRecord, this.host.workers.require(task.worker))
    const graph = this.host.engine.addTask(graphId, value, expectedRevision)
    const scheduled = this.start(graphId)
    return { graph: this.host.engine.get(graphId) ?? graph, scheduled }
  }

  async instruct(graphId: string, taskId: string, text: string, expectedRevision?: number): Promise<{ graph: TaskGraph; delivered: boolean }> {
    const { graph, instruction } = this.host.engine.addInstruction(graphId, taskId, text, expectedRevision)
    const task = graph.tasks.find(item => item.id === taskId)!
    const run = task.run!
    const agent = this.host.context.agents.get(task.run!.sessionId as never)
    if (!agent) return { graph, delivered: false }
    await this.host.sessions.prompt(run.sessionId, `task-instruction:${instruction.id}`,
      JSON.stringify({ task_instruction: instruction.text, task_id: taskId }), 'steer', () => this.authorize(run))
    return { graph: this.host.engine.markInstructionDelivered(graphId, taskId, instruction.id), delivered: true }
  }

  retry(graphId: string, taskId: string): { graph: TaskGraph; scheduled: string[] } {
    const graph = this.host.engine.retry(graphId, taskId)
    const scheduled = this.start(graph.id)
    return { graph: this.host.engine.get(graph.id) ?? graph, scheduled }
  }

  cancel(graphId: string): TaskGraph {
    const before = this.host.engine.get(graphId)
    const graph = this.host.engine.cancel(graphId)
    for (const task of before?.tasks ?? []) {
      const sessionId = task.run?.sessionId
      const agent = sessionId && this.host.context.agents.get(sessionId as never)
      if (agent && agent.status !== 'idle') agent.cancel({ kind: 'user' }, { keepInbox: true })
      if (sessionId) { this.delivered.delete(sessionId); this.stopJobs(sessionId, 'Task graph cancelled') }
    }
    this.startWaiting()
    return graph
  }

  cancelTask(graphId: string, taskId: string, expectedRevision?: number): TaskGraph {
    const before = this.host.engine.get(graphId)?.tasks.find(task => task.id === taskId)
    const graph = this.host.engine.cancelTask(graphId, taskId, expectedRevision)
    const sessionId = before?.run?.sessionId
    const agent = sessionId && this.host.context.agents.get(sessionId as never)
    if (agent && agent.status !== 'idle') agent.cancel({ kind: 'user' }, { keepInbox: true })
    if (sessionId) { this.delivered.delete(sessionId); this.stopJobs(sessionId, 'Task cancelled') }
    this.startWaiting()
    return graph
  }

  worker(sessionId: string): TaskWorkerBinding | undefined {
    const current = this.host.engine.workerSession(sessionId)
    if (!current) return undefined
    const profile = this.host.workers.get(current.run.profile)
    return profile ? { ...current, profile } : undefined
  }

  report(sessionId: string, value: unknown): TaskGraph {
    const binding = this.worker(sessionId)
    if (!binding) throw new Error('This Session has no active task assignment')
    const report = TaskReportSchema.parse(value)
    const graph = this.recordReport(binding.graph.id, binding.task.id, report)
    if (report.state !== 'progress') this.delivered.delete(sessionId)
    if (report.state !== 'progress') {
      this.stopJobs(sessionId, `Task ${report.state}`)
      this.start(graph.id)
      this.startWaiting()
    }
    return this.host.engine.get(graph.id) ?? graph
  }

  /** Persist the report and its Host relay together, before scheduling any dependent work. */
  private recordReport(graphId: string, taskId: string, report: TaskReport): TaskGraph {
    return this.host.atomic(() => {
      const graph = this.host.engine.report(graphId, taskId, report)
      const task = graph.tasks.find(item => item.id === taskId)!
      const eventId = `task-report:${graph.id}:${task.run!.id}:${graph.revision}`
      this.host.sessions.relay(eventId, JSON.stringify({
        kind: 'task_report', event_id: eventId, graph_id: graph.id, revision: graph.revision,
        objective: graph.objective, graph_status: graph.status,
        task_id: task.id, title: task.title, worker: task.worker,
        run_id: task.run!.id, attempt: task.run!.attempt, ...task.report,
      }))
      return graph
    })
  }

  async readSkill(sessionId: string, name: string, signal: AbortSignal): Promise<{ name: string; description: string; provider: string; content: string; resourceBase?: unknown }> {
    const binding = this.worker(sessionId)
    if (!binding || !binding.profile.skills.includes(name)) throw new Error(`Skill ${name} is not allowed for this Worker`)
    const agent = this.host.context.agents.get(sessionId as never)
    if (!agent) throw new Error('Worker Session is not available')
    const cwd = this.workspace(binding.graph, binding.task, binding.profile)
    const lookup = { cwd, signal, scope: agent }
    const summary = (await this.host.context.skills.list(lookup)).find(skill => skill.name === name)
    if (!summary || !summary.invocation.modelInvocable) throw new Error(`Skill ${name} is unknown or unavailable to models`)
    const skill = await this.host.context.skills.get(name, lookup)
    if (!skill || !skill.invocation.modelInvocable) throw new Error(`Skill ${name} is unknown or unavailable to models`)
    return { name: skill.name, description: skill.description, provider: skill.provider, content: skill.content,
      ...(skill.resourceBase ? { resourceBase: skill.resourceBase } : {}) }
  }

  activeSessions(): string[] {
    return this.host.engine.list().flatMap(graph => graph.tasks.filter(task => task.status === 'running' && task.run?.state === 'running')
      .map(task => task.run!.sessionId))
  }

  /** Reattaches to persisted active runs after a Host restart and gives each worker a durable continuation message. */
  resume(): void {
    for (const graph of this.host.engine.list()) for (const task of graph.tasks) {
      if (task.status !== 'running' || task.run?.state !== 'running') continue
      if (!this.host.workers.get(task.run.profile)) {
        this.recordReport(graph.id, task.id, { state: 'failed', summary: `Worker profile ${task.run.profile} is no longer configured; restore it and retry this task.` })
      } else this.launch(graph.id, task, task.run, true)
    }
    this.startWaiting()
  }

  /** Claims all currently runnable work; the engine enforces each profile's instance cap across all graphs. */
  start(graphId: string): string[] {
    const scheduled: string[] = []
    while (!this.host.closing()) {
      const claimed = this.host.engine.claimReady(graphId)
      if (!claimed) break
      scheduled.push(claimed.task.id)
      this.launch(claimed.graph.id, claimed.task, claimed.run)
    }
    return scheduled
  }

  private startWaiting(): void {
    for (const graph of this.host.engine.list().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      if (graph.status === 'active') this.start(graph.id)
    }
  }

  private launch(graphId: string, task: TaskRecord, run: WorkerRun, recovery = false): void {
    const pending = this.launchSession(graphId, task, run, recovery)
    this.launches.add(pending)
    void pending.catch(() => {}).finally(() => this.launches.delete(pending))
  }

  async drain(): Promise<void> {
    while (this.launches.size || this.stops.size) await Promise.allSettled([...this.launches, ...this.stops])
  }

  private stopJobs(sessionId: string, reason: string): void {
    const pending = killJobs(this.host.context, sessionId, reason)
    this.stops.add(pending)
    void pending.catch(error => this.host.context.logger.warn('Could not stop task Worker background jobs: %s', String(error)))
      .finally(() => this.stops.delete(pending))
  }

  private authorize(run: WorkerRun): void {
    if (this.host.closing() || this.worker(run.sessionId)?.run.id !== run.id) throw new Error('Task assignment is no longer active')
  }

  async shutdown(): Promise<void> {
    for (const sessionId of this.activeSessions()) this.stopJobs(sessionId, 'Task Host stopped')
    await this.drain()
  }

  private async launchSession(graphId: string, task: TaskRecord, run: WorkerRun, recovery = false): Promise<void> {
    try {
      const graph = this.host.engine.get(graphId)
      if (!graph || this.host.closing()) return
      if (recovery) {
        const previous = this.host.context.agents.get(run.sessionId as never)
        if (previous) {
          previous.cancel({ kind: 'user' }, { keepInbox: true })
          const idle = await until(previous.whenIdle(), this.host.lifetime, 10_000)
          if (idle === false) throw new Error('Previous Worker turn did not stop before recovery')
        }
        await killJobs(this.host.context, run.sessionId, 'Task Worker recovering after Host restart')
      }
      const profile = this.host.workers.require(run.profile)
      const cwd = this.workspace(graph, task, profile)
      mkdirSync(cwd, { recursive: true })
      const agent = await this.host.sessions.ensure(run.sessionId, cwd, task.title, 'task-worker', profile)
      if (this.host.closing() || !this.worker(run.sessionId)) return
      const missingTools = workerToolNames(profile).filter(name => !agent.ctx.tools.get(name, agent))
      if (missingTools.length) throw new Error(`Worker profile ${profile.id} allows unavailable tools: ${missingTools.join(', ')}`)
      if (profile.skills.length) {
        const catalog = await this.host.context.skills.list({ cwd, scope: agent, signal: this.host.lifetime })
        const available = new Set(catalog.filter(skill => skill.invocation.modelInvocable).map(skill => skill.name))
        const missing = profile.skills.filter(name => !available.has(name))
        if (missing.length) throw new Error(`Worker profile ${profile.id} allows unavailable skills: ${missing.join(', ')}`)
      }
      this.authorize(run)
      // Instructions can arrive while Session creation or capability discovery is still pending.
      const current = this.worker(run.sessionId)!.task
      const dependencies = task.dependsOn.map(id => graph.tasks.find(item => item.id === id)).filter((item): item is TaskRecord => !!item)
        .map(item => ({ id: item.id, title: item.title, summary: item.report?.summary ?? '', artifacts: item.report?.artifacts ?? [] }))
      const message = JSON.stringify({
        graph_id: graph.id,
        objective: graph.objective,
        task_id: task.id,
        title: task.title,
        description: task.description,
        acceptance_criteria: task.acceptanceCriteria,
        dependencies,
        ...(current.instructions?.length ? { host_instructions: current.instructions.map(item => item.text) } : {}),
        attempt: run.attempt,
        ...(recovery ? { recovery: 'The Host restarted while this task was active. Continue from the existing Session and workspace, then report the current task state.' } : {}),
        worker: { id: profile.id, name: profile.name, description: profile.description },
      })
      this.delivered.add(run.sessionId)
      const requestId = recovery ? `task-recovery:${run.id}:${Date.now()}` : `task:${run.id}`
      await this.host.sessions.prompt(run.sessionId, requestId, message, 'queue', () => this.authorize(run))
      for (const instruction of current.instructions ?? []) {
        if (!instruction.deliveredAt) this.host.engine.markInstructionDelivered(graphId, task.id, instruction.id)
      }
    } catch (error) {
      if (this.host.closing() || !this.worker(run.sessionId)) return
      this.delivered.delete(run.sessionId)
      this.report(run.sessionId, { state: 'failed', summary: `Worker launch failed: ${String(error).slice(0, 1500)}` })
    }
  }

  private workspace(graph: Pick<TaskGraph, 'id'>, task: TaskRecord, profile: WorkerProfile): string {
    const root = resolve(profile.workspaceRoot ?? join(this.host.stateDir, 'task-workspaces'))
    const cwd = resolve(task.workspace ?? join(root, graph.id, task.id ?? 'task'))
    const within = relative(root, cwd)
    if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
      throw new Error(`Task workspace must be inside Worker profile ${profile.id}'s workspaceRoot`)
    }
    return cwd
  }

  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose()
    this.delivered.clear()
  }
}
