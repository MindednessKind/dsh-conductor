/** Human command handlers shared by the slash command and full-screen composer. */
import type { ConductorTuiStore } from './store.ts'

export const commandHelp = `/conductor [host|tasks|workers|inspect <graph>|say <text>|instruct <graph> <task> <text>|cancel <graph> [task]|retry <graph> <task>|panel]
Inside the Conductor screen, type instructions to Host. Use /tasks, /workers, /inspect, /instruct, /cancel, /retry for local controls. Esc detaches; tasks keep running.`
export async function executeConductorCommand(store: ConductorTuiStore, input: string): Promise<string> {
  const [command = 'status', ...args] = input.trim().split(/\s+/)
  if (command === 'help') return commandHelp
  if (command === 'say') { await store.say(args.join(' ')); return 'Instruction accepted by Host.' }
  const state = await store.refresh()
  if (command === 'status' || command === 'host') return `Host ${state.host.sessionId}: ${state.host.status}; ${state.workers.length} worker roles; ${state.graphs.length} task graphs.`
  if (command === 'workers') return state.workers.map(worker => `${worker.id} ×${worker.maxInstances}\n  ${worker.description}\n  tools: ${worker.tools.join(', ') || '(none)'}; MCP: ${worker.mcps.map(m => `${m.server}[${m.tools.join(', ')}]`).join(', ') || '(none)'}; skills: ${worker.skills.join(', ') || '(none)'}`).join('\n')
  if (command === 'tasks') return state.graphs.map(graph => `${graph.id} [${graph.status}] r${graph.revision} ${graph.objective}\n${graph.tasks.map(task => `  ${task.id} [${task.status}] → ${task.worker}: ${task.title}`).join('\n')}`).join('\n') || 'No task graphs yet.'
  const graph = state.graphs.find(item => item.id === args[0])
  if (!graph) throw new Error('Graph not found. Use /conductor tasks to find its ID.')
  if (command === 'inspect') return JSON.stringify(graph, null, 2)
  if (command === 'instruct') {
    if (!args[1] || !args[2]) throw new Error('Usage: instruct <graph> <task> <text>')
    const result = await store.act({ type: 'task.instruct', graphId: graph.id, taskId: args[1], expectedRevision: graph.revision, text: args.slice(2).join(' ') }) as { delivered: boolean }
    return result.delivered ? 'Instruction saved and sent to Worker.' : 'Instruction saved; Worker will receive it when execution resumes.'
  }
  if (command === 'cancel') {
    await store.act({ type: 'task.cancel', graphId: graph.id, ...(args[1] ? { taskId: args[1] } : {}), expectedRevision: graph.revision })
    return 'Cancellation applied.'
  }
  if (command === 'retry') {
    if (!args[1]) throw new Error('Usage: retry <graph> <task>')
    await store.act({ type: 'task.retry', graphId: graph.id, taskId: args[1], expectedRevision: graph.revision })
    return 'Retry scheduled.'
  }
  throw new Error(commandHelp)
}
