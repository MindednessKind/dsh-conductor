import { randomUUID } from 'node:crypto'
import { TaskInstructionSchema, TaskPlanSchema, TaskReportSchema, TaskSpecSchema, TaskUpdateSchema,
  type TaskGraph, type TaskInstruction, type TaskRecord, type TaskReport, type TaskSpec, type WorkerRun } from './model.ts'
import type { WorkerRegistry } from './workers.ts'

export interface TaskGraphRepository {
  get(id: string): TaskGraph | undefined
  list(): TaskGraph[]
  save(graph: TaskGraph): void
  atomic<T>(operation: () => T): T
}

export interface TaskEngineOptions {
  repository: TaskGraphRepository
  workers: WorkerRegistry
  now?: () => string
  id?: () => string
  sessionId?: (taskId: string, attempt: number) => string
}

function topological(specs: TaskSpec[]): string[] {
  const byId = new Map(specs.map((task, index) => [task.id ?? `task-${index + 1}`, task]))
  const visiting = new Set<string>(), visited = new Set<string>(), order: string[] = []
  const visit = (id: string): void => {
    if (visited.has(id)) return
    if (visiting.has(id)) throw new Error(`Task dependencies contain a cycle at ${id}`)
    const task = byId.get(id)
    if (!task) throw new Error(`Task dependency does not exist: ${id}`)
    visiting.add(id)
    for (const dependency of task.dependsOn) visit(dependency)
    visiting.delete(id)
    visited.add(id)
    order.push(id)
  }
  for (const id of byId.keys()) visit(id)
  return order
}

/** Persistent task-graph state machine. It validates the plan and is the sole writer of task/run transitions. */
export class TaskEngine {
  private readonly now: () => string
  private readonly id: () => string
  private readonly sessionId: (taskId: string, attempt: number) => string
  constructor(private readonly options: TaskEngineOptions) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.id = options.id ?? randomUUID
    this.sessionId = options.sessionId ?? ((taskId, attempt) => `task-worker-${taskId.replaceAll(':', '-')}-run-${attempt}`)
  }

  create(value: unknown): TaskGraph {
    const plan = TaskPlanSchema.parse(value)
    const specs = plan.tasks.map((task, index) => ({ ...task, id: task.id ?? `task-${index + 1}` }))
    this.validateSpecs(specs)
    const at = this.now(), graphId = `graph-${this.id()}`
    const tasks: TaskRecord[] = specs.map(task => ({ ...task, status: task.dependsOn.length ? 'pending' : 'ready', attempts: 0, createdAt: at, updatedAt: at }))
    const graph: TaskGraph = { id: graphId, objective: plan.objective, revision: 1, status: 'active', tasks, createdAt: at, updatedAt: at }
    this.options.repository.atomic(() => this.options.repository.save(graph))
    return graph
  }

  list(): TaskGraph[] { return this.options.repository.list().map(graph => this.normalize(graph)) }
  get(graphId: string): TaskGraph | undefined {
    const graph = this.options.repository.get(graphId)
    return graph ? this.normalize(graph) : undefined
  }

  updateTask(graphId: string, taskId: string, value: unknown, expectedRevision?: number): TaskGraph {
    const patch = TaskUpdateSchema.parse(value)
    return this.options.repository.atomic(() => {
      const graph = this.mustGet(graphId)
      this.checkRevision(graph, expectedRevision)
      const task = this.mustTask(graph, taskId)
      if (['running', 'completed', 'cancelled'].includes(task.status)) throw new Error(`Task ${taskId} cannot be edited while ${task.status}`)
      const spec: TaskSpec = TaskSpecSchema.parse({
        id: task.id, title: task.title, description: task.description, worker: task.worker,
        dependsOn: task.dependsOn, acceptanceCriteria: task.acceptanceCriteria, workspace: task.workspace,
        ...patch,
      })
      const specs = graph.tasks.map(item => item.id === taskId ? spec : item)
      topological(specs)
      this.validateSpecs(specs)
      const at = this.now()
      const tasks = this.refresh(graph.tasks.map(item => item.id === taskId ? {
        ...spec, id: taskId, status: this.dependenciesDone(spec, graph.tasks) ? 'ready' as const : 'pending' as const,
        attempts: item.attempts, createdAt: item.createdAt, updatedAt: at, instructions: item.instructions,
      } : item), at)
      return this.saveNext(graph, tasks, at)
    })
  }

  addTask(graphId: string, value: unknown, expectedRevision?: number): TaskGraph {
    const spec = TaskSpecSchema.parse(value)
    this.options.workers.require(spec.worker)
    return this.options.repository.atomic(() => {
      const graph = this.mustGet(graphId)
      this.checkRevision(graph, expectedRevision)
      if (graph.status === 'cancelled' || graph.status === 'completed') throw new Error(`Task graph ${graphId} is ${graph.status}`)
      const id = spec.id ?? `task-${this.id()}`
      if (graph.tasks.some(task => task.id === id)) throw new Error(`Task id already exists: ${id}`)
      const added = { ...spec, id }
      const specs = [...graph.tasks, added]
      this.validateSpecs(specs)
      const at = this.now()
      const task: TaskRecord = { ...added, status: 'pending', attempts: 0, createdAt: at, updatedAt: at }
      const tasks = this.refresh([...graph.tasks, task], at)
      return this.saveNext(graph, tasks, at)
    })
  }

  addInstruction(graphId: string, taskId: string, value: unknown, expectedRevision?: number): { graph: TaskGraph; instruction: TaskInstruction } {
    const instruction = TaskInstructionSchema.parse({ id: this.id(), text: value, at: this.now() })
    return this.options.repository.atomic(() => {
      const graph = this.mustGet(graphId)
      this.checkRevision(graph, expectedRevision)
      const task = this.mustTask(graph, taskId)
      if (task.status !== 'running' || !task.run) throw new Error(`Task ${taskId} has no active worker to instruct`)
      const at = this.now()
      const tasks = graph.tasks.map(item => item.id === taskId
        ? { ...item, instructions: [...item.instructions ?? [], instruction], updatedAt: at }
        : item)
      return { graph: this.saveNext(graph, tasks, at), instruction }
    })
  }

  markInstructionDelivered(graphId: string, taskId: string, instructionId: string): TaskGraph {
    return this.options.repository.atomic(() => {
      const graph = this.mustGet(graphId), task = this.mustTask(graph, taskId)
      const instruction = task.instructions?.find(item => item.id === instructionId)
      if (!instruction || instruction.deliveredAt) return graph
      const at = this.now()
      const deliveredAt = at
      const instructions = task.instructions!.map(item => item.id === instructionId ? { ...item, deliveredAt } : item)
      return this.saveNext(graph, graph.tasks.map(item => item.id === taskId ? { ...item, instructions, updatedAt: at } : item), at)
    })
  }

  cancelTask(graphId: string, taskId: string, expectedRevision?: number): TaskGraph {
    return this.options.repository.atomic(() => {
      const graph = this.mustGet(graphId)
      this.checkRevision(graph, expectedRevision)
      const task = this.mustTask(graph, taskId)
      if (['completed', 'failed', 'cancelled'].includes(task.status)) throw new Error(`Task ${taskId} is already ${task.status}`)
      const at = this.now()
      const tasks = this.refresh(graph.tasks.map(item => item.id === taskId ? {
        ...item, status: 'cancelled' as const,
        ...(item.run?.state === 'running' ? { run: { ...item.run, state: 'cancelled' as const, endedAt: at } } : {}), updatedAt: at,
      } : item), at)
      return this.saveNext(graph, tasks, at)
    })
  }
  workerSession(sessionId: string): { graph: TaskGraph; task: TaskRecord; run: WorkerRun } | undefined {
    for (const graph of this.options.repository.list()) {
      const task = graph.tasks.find(item => item.status === 'running' && item.run?.state === 'running' && item.run.sessionId === sessionId)
      if (task?.run) return { graph, task, run: task.run }
    }
    return undefined
  }

  /** Claims the first ready task whose worker profile has capacity and persists its WorkerRun atomically. */
  claimReady(graphId: string): { graph: TaskGraph; task: TaskRecord; run: WorkerRun } | undefined {
    return this.options.repository.atomic(() => {
      const graph = this.mustGet(graphId)
      if (graph.status !== 'active') return undefined
      const active = this.options.repository.list().flatMap(item => item.tasks).filter(task => task.status === 'running' && task.run)
      const task = graph.tasks.find(candidate => {
        const profile = this.options.workers.get(candidate.worker)
        return candidate.status === 'ready' && !!profile
          && active.filter(run => run.worker === candidate.worker).length < profile.maxInstances
      })
      if (!task) return undefined
      const at = this.now(), attempt = task.attempts + 1
      const run: WorkerRun = { id: this.id(), profile: task.worker, sessionId: this.sessionId(`${graph.id}:${task.id}`, attempt), attempt, state: 'running', startedAt: at }
      const updated = { ...task, status: 'running' as const, attempts: attempt, run, updatedAt: at }
      const next = { ...graph, tasks: graph.tasks.map(item => item.id === task.id ? updated : item), updatedAt: at }
      const revised = { ...next, revision: (graph.revision ?? 0) + 1 }
      this.save(revised)
      return { graph: revised, task: updated, run }
    })
  }

  report(graphId: string, taskId: string, value: unknown): TaskGraph {
    const report = TaskReportSchema.parse(value)
    return this.options.repository.atomic(() => {
      const graph = this.mustGet(graphId)
      const task = this.mustTask(graph, taskId)
      if (task.status !== 'running' || !task.run) throw new Error(`Task ${taskId} has no active worker run`)
      const at = this.now()
      const terminal = report.state !== 'progress'
      const run = terminal ? { ...task.run, state: report.state, endedAt: at } : task.run
      let tasks = graph.tasks.map(item => item.id === taskId ? {
        ...item, status: report.state === 'progress' ? 'running' : report.state, run,
        report: { ...report, at }, updatedAt: at,
      } as TaskRecord : item)
      tasks = this.refresh(tasks, at)
      return this.saveNext(graph, tasks, at)
    })
  }

  retry(graphId: string, taskId: string): TaskGraph {
    return this.options.repository.atomic(() => {
      const graph = this.mustGet(graphId), task = this.mustTask(graph, taskId)
      if (task.status !== 'failed' && task.status !== 'blocked') throw new Error(`Task ${taskId} is not retryable`)
      const at = this.now()
      const tasks = this.refresh(graph.tasks.map(item => item.id === taskId
        ? { ...item, status: this.dependenciesDone(item, graph.tasks) ? 'ready' : 'pending', run: undefined, report: undefined, blockedBy: undefined, updatedAt: at }
        : item), at)
      return this.saveNext(graph, tasks, at, 'active')
    })
  }

  cancel(graphId: string): TaskGraph {
    return this.options.repository.atomic(() => {
      const graph = this.mustGet(graphId), at = this.now()
      const tasks = graph.tasks.map(task => ['completed', 'failed', 'cancelled'].includes(task.status) ? task : {
        ...task, status: 'cancelled' as const,
        ...(task.run?.state === 'running' ? { run: { ...task.run, state: 'cancelled' as const, endedAt: at } } : {}), updatedAt: at,
      })
      return this.saveNext(graph, tasks, at, 'cancelled')
    })
  }

  private refresh(tasks: TaskRecord[], at: string): TaskRecord[] {
    const byId = new Map(tasks.map(task => [task.id, task]))
    // Resolve upstream state first, even if a plan lists dependents before their dependencies.
    for (const id of topological(tasks)) {
      const task = byId.get(id)!
      if (task.status !== 'pending' && !(task.status === 'blocked' && task.blockedBy?.length)) continue
      const failed = task.dependsOn.filter(id => ['failed', 'blocked', 'cancelled'].includes(byId.get(id)?.status ?? ''))
      const status = failed.length ? 'blocked' : task.dependsOn.every(id => byId.get(id)?.status === 'completed') ? 'ready' : 'pending'
      byId.set(id, { ...task, status, blockedBy: failed.length ? failed : undefined, updatedAt: at })
    }
    return tasks.map(task => byId.get(task.id)!)
  }
  private dependenciesDone(task: Pick<TaskRecord, 'dependsOn'>, tasks: TaskRecord[]): boolean {
    const byId = new Map(tasks.map(item => [item.id, item]))
    return task.dependsOn.every(id => byId.get(id)?.status === 'completed')
  }
  private graphStatus(tasks: TaskRecord[]): TaskGraph['status'] {
    if (tasks.every(task => task.status === 'completed')) return 'completed'
    if (tasks.some(task => task.status === 'running' || task.status === 'ready' || task.status === 'pending')) return 'active'
    if (tasks.some(task => task.status === 'blocked')) return 'blocked'
    if (tasks.some(task => task.status === 'failed')) return 'failed'
    return 'cancelled'
  }
  private checkRevision(graph: TaskGraph, expected?: number): void {
    if (expected !== undefined && expected !== (graph.revision ?? 0)) {
      throw new Error(`Task graph revision changed to ${graph.revision ?? 0}; read the latest graph before editing`)
    }
  }
  private validateSpecs(specs: TaskSpec[]): void {
    const ids = specs.map(task => task.id!)
    if (new Set(ids).size !== ids.length) throw new Error('Task ids must be unique')
    for (const task of specs) {
      if (!this.options.workers.get(task.worker)) throw new Error(`Task ${task.id} names unknown worker profile ${task.worker}`)
      if (new Set(task.dependsOn).size !== task.dependsOn.length) throw new Error(`Task ${task.id} repeats a dependency`)
      if (task.dependsOn.includes(task.id!)) throw new Error(`Task ${task.id} cannot depend on itself`)
    }
    topological(specs)
  }
  private saveNext(graph: TaskGraph, tasks: TaskRecord[], at: string, status = this.graphStatus(tasks)): TaskGraph {
    const next = { ...graph, tasks, status, revision: (graph.revision ?? 0) + 1, updatedAt: at }
    this.save(next)
    return next
  }
  private mustGet(id: string): TaskGraph {
    const graph = this.options.repository.get(id)
    if (!graph) throw new Error(`Task graph not found: ${id}`)
    return this.normalize(graph)
  }
  private normalize(graph: TaskGraph): TaskGraph { return graph.revision === undefined ? { ...graph, revision: 0 } : graph }
  private mustTask(graph: TaskGraph, id: string): TaskRecord {
    const task = graph.tasks.find(item => item.id === id)
    if (!task) throw new Error(`Task not found in graph ${graph.id}: ${id}`)
    return task
  }
  private save(graph: TaskGraph): void {
    this.options.repository.save(graph)
  }
}
