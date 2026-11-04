import { z } from 'zod'
import { TaskPlanSchema, TaskReportSchema, TaskSpecSchema, TaskUpdateSchema } from '../../tasks/model.ts'
import type { TaskRunner } from '../../executor/tasks.ts'
import { tool, type Tool } from './tool.ts'

export interface TaskToolsHost { taskRunner: TaskRunner }

const graphCard = (graph: ReturnType<TaskRunner['get']>) => graph && ({
  id: graph.id,
  revision: graph.revision,
  objective: graph.objective,
  status: graph.status,
  tasks: graph.tasks.map(task => ({ id: task.id, title: task.title, description: task.description, worker: task.worker, status: task.status,
    depends_on: task.dependsOn, acceptance_criteria: task.acceptanceCriteria, attempts: task.attempts,
    ...(task.workspace ? { workspace: task.workspace } : {}), ...(task.instructions?.length ? { instructions: task.instructions } : {}),
    ...(task.report ? { report: task.report } : {}), ...(task.blockedBy ? { blocked_by: task.blockedBy } : {}) })),
})

export function mainTaskTools(host: TaskToolsHost): Tool[] {
  return [
    tool({
      name: 'task_submit',
      description: 'Create a general task graph for an explicit user instruction, split work into dependency-linked tasks, choose a configured worker profile for each, then dispatch all runnable tasks. Use only configured worker ids. A task with no dependencies can start immediately.',
      schema: TaskPlanSchema,
      execute: async plan => {
        const submitted = host.taskRunner.submit(plan)
        return { graph: graphCard(submitted.graph), scheduled: submitted.scheduled }
      },
    }),
    tool({
      name: 'task_list',
      description: 'List task graphs and their current worker, dependency, and report states.',
      schema: z.object({ graph_id: z.string().optional() }).strict(),
      execute: async ({ graph_id }) => graph_id
        ? { graph: graphCard(host.taskRunner.get(graph_id)) }
        : { graphs: host.taskRunner.list().map(graph => graphCard(graph)) },
    }),
    tool({
      name: 'task_add',
      description: 'Add a new task to an active task graph. Use an existing graph revision and valid dependency ids; runnable work is dispatched immediately.',
      schema: z.object({ graph_id: z.string(), expected_revision: z.number().int().nonnegative(), task: TaskSpecSchema }).strict(),
      execute: async ({ graph_id, expected_revision, task }) => {
        const added = host.taskRunner.addTask(graph_id, task, expected_revision)
        return { graph: graphCard(added.graph), scheduled: added.scheduled }
      },
    }),
    tool({
      name: 'task_update',
      description: 'Change a task that has not started or has stopped. Running tasks need task_instruct so the active Worker receives the new direction; completed and cancelled tasks are immutable.',
      schema: z.object({ graph_id: z.string(), task_id: z.string(), expected_revision: z.number().int().nonnegative(), changes: TaskUpdateSchema }).strict(),
      execute: async ({ graph_id, task_id, expected_revision, changes }) => {
        const updated = host.taskRunner.updateTask(graph_id, task_id, changes, expected_revision)
        return { graph: graphCard(updated.graph), scheduled: updated.scheduled }
      },
    }),
    tool({
      name: 'task_instruct',
      description: 'Persist and send a user-requested direction change to a running Worker. The instruction is retained for recovery if delivery is interrupted.',
      schema: z.object({ graph_id: z.string(), task_id: z.string(), expected_revision: z.number().int().nonnegative(), instruction: z.string().trim().min(1).max(8000) }).strict(),
      execute: async ({ graph_id, task_id, expected_revision, instruction }) => {
        const result = await host.taskRunner.instruct(graph_id, task_id, instruction, expected_revision)
        return { graph: graphCard(result.graph), delivered: result.delivered }
      },
    }),
    tool({
      name: 'task_retry',
      description: 'Retry a blocked or failed task in a task graph. Its dependencies must be complete before it can run again.',
      schema: z.object({ graph_id: z.string(), task_id: z.string() }).strict(),
      execute: async ({ graph_id, task_id }) => {
        const retried = host.taskRunner.retry(graph_id, task_id)
        return { graph: graphCard(retried.graph), scheduled: retried.scheduled }
      },
    }),
    tool({
      name: 'task_cancel',
      description: 'Cancel a task graph and stop its running worker sessions.',
      schema: z.object({ graph_id: z.string() }).strict(),
      execute: async ({ graph_id }) => ({ graph: graphCard(host.taskRunner.cancel(graph_id)) }),
    }),
    tool({
      name: 'task_cancel_task',
      description: 'Cancel one pending, ready, or running task. Its dependents become blocked and the running Worker is stopped.',
      schema: z.object({ graph_id: z.string(), task_id: z.string(), expected_revision: z.number().int().nonnegative() }).strict(),
      execute: async ({ graph_id, task_id, expected_revision }) => ({ graph: graphCard(host.taskRunner.cancelTask(graph_id, task_id, expected_revision)) }),
    }),
  ]
}

export function workerTaskTools(host: TaskToolsHost, sessionId: string, skills: string[] = []): Tool[] {
  return [tool({
    name: 'task_report',
    description: 'Report task progress or its final state to the Host. Use completed only when the acceptance criteria are met; blocked for one concrete dependency or question; failed when execution cannot continue. Include concise evidence and artifact paths or identifiers.',
    schema: TaskReportSchema,
    execute: async (report, signal) => {
      if (signal.aborted) throw signal.reason
      const current = host.taskRunner.worker(sessionId)
      if (!current) throw new Error('This Session has no active task assignment')
      const graph = host.taskRunner.report(sessionId, report)
      return { graph_id: graph.id, status: graph.status, task_id: current.task.id, report: report.state }
    },
  }), ...(skills.length ? [tool({
    name: 'task_skill',
    description: `Load one approved DSH skill by exact name. Available: ${skills.join(', ')}. Other skills cannot be loaded.`,
    schema: z.object({ name: z.string().min(1) }).strict(),
    execute: async ({ name }, signal) => host.taskRunner.readSkill(sessionId, name, signal),
  })] : [])]
}
