import { describe, expect, it } from 'vitest'
import { TaskEngine, type TaskGraph, type TaskGraphRepository, WorkerRegistry } from '../src/tasks/index.ts'

class MemoryGraphs implements TaskGraphRepository {
  private readonly graphs = new Map<string, TaskGraph>()
  get(id: string) { return this.graphs.get(id) }
  list() { return [...this.graphs.values()] }
  save(graph: TaskGraph) { this.graphs.set(graph.id, graph) }
  atomic<T>(operation: () => T): T { return operation() }
}

const workers = WorkerRegistry.parse({ version: 1, defaultProfile: 'coder', profiles: [
  { id: 'coder', name: 'Coder', maxInstances: 1, tools: ['read', 'edit'], mcps: [{ server: 'repo', tools: ['repo_search'] }], skills: ['typescript'] },
  { id: 'reviewer', name: 'Reviewer', maxInstances: 2, tools: ['read'], mcps: [], skills: [] },
] })
function setup() {
  let sequence = 0
  const repository = new MemoryGraphs()
  const engine = new TaskEngine({ repository, workers, now: () => '2026-11-04T00:00:00.000Z', id: () => `id-${++sequence}` })
  return { engine, repository }
}

describe('WorkerRegistry', () => {
  it('uses exact tool, MCP tool, and skill allowlists and keeps empty access empty', () => {
    expect(workers.allowedTools(workers.require('coder'))).toEqual(['read', 'edit', 'mcp__repo__repo_search'])
    expect(workers.require('reviewer').skills).toEqual([])
  })

  it('requires MCP tools to be granted through their named server', () => {
    expect(() => WorkerRegistry.parse({ version: 1, profiles: [{ id: 'coder', name: 'Coder', maxInstances: 1, tools: ['mcp__repo__repo_search'] }] }))
      .toThrow(/MCP tools must be granted under mcps/)
    const scoped = WorkerRegistry.parse({ version: 1, profiles: [{ id: 'coder', name: 'Coder', maxInstances: 1,
      mcps: [{ server: 'repo', tools: ['search'] }, { server: 'issues', tools: ['search'] }] }] })
    expect(scoped.allowedTools(scoped.require('coder'))).toEqual(['mcp__repo__search', 'mcp__issues__search'])
  })

  it('rejects unknown fields, duplicate profiles, and invalid defaults', () => {
    expect(() => WorkerRegistry.parse({ version: 1, profiles: [], extra: true })).toThrow()
    expect(() => WorkerRegistry.parse({ version: 1, defaultProfile: 'missing', profiles: [{ id: 'coder', name: 'Coder', maxInstances: 1 }] })).toThrow()
    expect(() => WorkerRegistry.parse({ version: 1, profiles: [
      { id: 'coder', name: 'Coder', maxInstances: 1 }, { id: 'coder', name: 'Other', maxInstances: 1 },
    ] })).toThrow()
    expect(() => WorkerRegistry.parse({ version: 1, profiles: [{ id: 'coder', name: 'Coder', maxInstances: 1, tools: ['skill'] }] })).toThrow(/managed by the task runtime/)
  })
})

describe('TaskEngine', () => {
  it('validates dependencies and cycles before persisting a graph', () => {
    const { engine, repository } = setup()
    expect(() => engine.create({ objective: 'bad graph', tasks: [
      { id: 'first', title: 'First', description: 'Do first', worker: 'coder', dependsOn: ['missing'] },
    ] })).toThrow(/does not exist/)
    expect(() => engine.create({ objective: 'cycle', tasks: [
      { id: 'first', title: 'First', description: 'Do first', worker: 'coder', dependsOn: ['second'] },
      { id: 'second', title: 'Second', description: 'Do second', worker: 'reviewer', dependsOn: ['first'] },
    ] })).toThrow(/cycle/)
    expect(() => engine.create({ objective: 'bad worker', tasks: [
      { id: 'first', title: 'First', description: 'Do first', worker: 'unknown' },
    ] })).toThrow(/unknown worker/)
    expect(repository.list()).toHaveLength(0)
  })

  it('dispatches independent tasks within per-profile capacity and unlocks dependents on completion', () => {
    const { engine } = setup()
    const graph = engine.create({ objective: 'Implement and review', tasks: [
      { id: 'implement', title: 'Implement', description: 'Implement the change', worker: 'coder' },
      { id: 'review', title: 'Review', description: 'Review the change', worker: 'reviewer', dependsOn: ['implement'] },
      { id: 'parallel', title: 'Parallel', description: 'Inspect an independent item', worker: 'reviewer' },
    ] })
    const first = engine.claimReady(graph.id)!
    expect(first.task.id).toBe('implement')
    expect(engine.claimReady(graph.id)?.task.id).toBe('parallel')
    expect(engine.claimReady(graph.id)).toBeUndefined()
    const done = engine.report(graph.id, 'implement', { state: 'completed', summary: 'Implemented', artifacts: ['commit:abc123'] })
    expect(done.tasks.find(task => task.id === 'review')?.status).toBe('ready')
    expect(done.tasks.find(task => task.id === 'implement')?.report?.artifacts).toEqual(['commit:abc123'])
    expect(engine.claimReady(graph.id)?.task.id).toBe('review')
  })

  it('enforces worker capacity across graphs and creates a fresh Session for each retry', () => {
    const { engine } = setup()
    const first = engine.create({ objective: 'First graph', tasks: [
      { id: 'first', title: 'First', description: 'Use the only coder slot.', worker: 'coder' },
    ] })
    const second = engine.create({ objective: 'Second graph', tasks: [
      { id: 'second', title: 'Second', description: 'Wait for the coder slot.', worker: 'coder' },
    ] })
    const firstRun = engine.claimReady(first.id)!
    expect(engine.claimReady(second.id)).toBeUndefined()
    engine.report(first.id, 'first', { state: 'failed', summary: 'Retry after a transient failure.' })
    engine.retry(first.id, 'first')
    const retry = engine.claimReady(first.id)!
    expect(retry.run.attempt).toBe(2)
    expect(retry.run.sessionId).not.toBe(firstRun.run.sessionId)
    expect(engine.claimReady(second.id)).toBeUndefined()
    engine.report(first.id, 'first', { state: 'completed', summary: 'Completed on retry.' })
    expect(engine.claimReady(second.id)?.task.id).toBe('second')
  })

  it('blocks dependent work on failure and restores it when its prerequisite is retried', () => {
    const { engine } = setup()
    const graph = engine.create({ objective: 'Build and inspect', tasks: [
      { id: 'build', title: 'Build', description: 'Build artifact', worker: 'coder' },
      { id: 'inspect', title: 'Inspect', description: 'Inspect artifact', worker: 'reviewer', dependsOn: ['build'] },
    ] })
    engine.claimReady(graph.id)
    const failed = engine.report(graph.id, 'build', { state: 'failed', summary: 'Build command failed' })
    expect(failed.status).toBe('blocked')
    expect(failed.tasks.find(task => task.id === 'inspect')).toMatchObject({ status: 'blocked', blockedBy: ['build'] })
    const retried = engine.retry(graph.id, 'build')
    expect(retried.tasks.map(task => [task.id, task.status])).toEqual([['build', 'ready'], ['inspect', 'pending']])
    engine.claimReady(graph.id)
    const completed = engine.report(graph.id, 'build', { state: 'completed', summary: 'Built' })
    expect(completed.tasks.find(task => task.id === 'inspect')?.status).toBe('ready')
  })

  it('records worker blocking, graph cancellation, and rejects stale reports', () => {
    const { engine } = setup()
    const graph = engine.create({ objective: 'Inspect', tasks: [
      { id: 'inspect', title: 'Inspect', description: 'Inspect target', worker: 'reviewer' },
    ] })
    engine.claimReady(graph.id)
    const blocked = engine.report(graph.id, 'inspect', { state: 'blocked', summary: 'Need a sample' })
    expect(blocked.status).toBe('blocked')
    expect(() => engine.report(graph.id, 'inspect', { state: 'completed', summary: 'Late result' })).toThrow(/active worker run/)
    expect(engine.retry(graph.id, 'inspect').tasks[0]?.status).toBe('ready')
    expect(engine.cancel(graph.id).tasks[0]?.status).toBe('cancelled')
  })

  it('revises task graphs when the Host edits, extends, or instructs active work', () => {
    const { engine } = setup()
    const graph = engine.create({ objective: 'Implement and review', tasks: [
      { id: 'implement', title: 'Implement', description: 'Implement the original request', worker: 'coder' },
      { id: 'review', title: 'Review', description: 'Review the result', worker: 'reviewer', dependsOn: ['implement'] },
    ] })
    expect(graph.revision).toBe(1)
    const edited = engine.updateTask(graph.id, 'review', { acceptanceCriteria: ['Findings cite file and line.'] }, graph.revision)
    expect(edited.revision).toBe(2)
    expect(edited.tasks[1]?.acceptanceCriteria).toEqual(['Findings cite file and line.'])
    expect(() => engine.updateTask(graph.id, 'review', { title: 'Stale update' }, graph.revision)).toThrow(/revision changed/)
    const extended = engine.addTask(graph.id, { id: 'docs', title: 'Update docs', description: 'Document the change', worker: 'reviewer' }, edited.revision)
    expect(extended.revision).toBe(3)
    expect(extended.tasks.find(task => task.id === 'docs')?.status).toBe('ready')
    engine.claimReady(graph.id)
    const active = engine.get(graph.id)!
    const { graph: instructed, instruction } = engine.addInstruction(graph.id, 'implement', 'Keep the public API backward compatible.', active.revision)
    expect(instructed.revision).toBe(active.revision + 1)
    expect(instructed.tasks.find(task => task.id === 'implement')?.instructions).toContainEqual(expect.objectContaining({
      id: instruction.id, text: 'Keep the public API backward compatible.',
    }))
    expect(engine.markInstructionDelivered(graph.id, 'implement', instruction.id).tasks[0]?.instructions?.[0]?.deliveredAt).toBeDefined()
    expect(() => engine.updateTask(graph.id, 'implement', { description: 'Replace current direction' })).toThrow(/cannot be edited while running/)
  })

  it('cancels one running task and blocks only its dependents', () => {
    const { engine } = setup()
    const graph = engine.create({ objective: 'Analyze', tasks: [
      { id: 'analyze', title: 'Analyze', description: 'Analyze artifact', worker: 'coder' },
      { id: 'report', title: 'Report', description: 'Write findings', worker: 'reviewer', dependsOn: ['analyze'] },
    ] })
    engine.claimReady(graph.id)
    const cancelled = engine.cancelTask(graph.id, 'analyze')
    expect(cancelled.tasks.find(task => task.id === 'analyze')?.status).toBe('cancelled')
    expect(cancelled.tasks.find(task => task.id === 'report')).toMatchObject({ status: 'blocked', blockedBy: ['analyze'] })
  })

  it('propagates a failure and its recovery through every dependency level in any task order', () => {
    const { engine } = setup()
    const graph = engine.create({ objective: 'Analyze, review and summarize', tasks: [
      { id: 'summary', title: 'Summary', description: 'Summarize the review.', worker: 'reviewer', dependsOn: ['review'] },
      { id: 'review', title: 'Review', description: 'Review the analysis.', worker: 'reviewer', dependsOn: ['analyze'] },
      { id: 'analyze', title: 'Analyze', description: 'Analyze the artifact.', worker: 'coder' },
    ] })
    engine.claimReady(graph.id)
    const failed = engine.report(graph.id, 'analyze', { state: 'failed', summary: 'Artifact unavailable.' })
    expect(failed.status).toBe('blocked')
    expect(failed.tasks.map(task => task.status)).toEqual(['blocked', 'blocked', 'failed'])
    const retried = engine.retry(graph.id, 'analyze')
    expect(retried.tasks.map(task => task.status)).toEqual(['pending', 'pending', 'ready'])
    engine.claimReady(graph.id)
    expect(engine.report(graph.id, 'analyze', { state: 'completed', summary: 'Analysis available.' }).tasks.map(task => task.status))
      .toEqual(['pending', 'ready', 'completed'])
  })
})
