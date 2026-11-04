import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { z } from 'zod'

const IdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
const ToolNameSchema = z.string().regex(/^[a-zA-Z0-9_.:-]{1,160}$/)
const McpServerNameSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/)
const RESERVED_TOOLS = new Set(['skill', 'task_report', 'task_skill', 'subagent', 'list_agents', 'send_message', 'interrupt_agent'])

export const mcpToolName = (server: string, tool: string): string => `mcp__${server}__${tool}`

export function workerToolNames(profile: Pick<WorkerProfile, 'tools' | 'mcps'>): string[] {
  return [...profile.tools, ...profile.mcps.flatMap(({ server, tools }) => tools.map(name => mcpToolName(server, name)))]
}

export const WorkerProfileSchema = z.object({
  id: IdSchema,
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000).default(''),
  maxInstances: z.number().int().min(1).max(64),
  permissionPreset: z.enum(['read-only', 'workspace-write', 'danger-full-access']).default('workspace-write'),
  tools: z.array(ToolNameSchema).default([]),
  mcps: z.array(z.object({
    server: McpServerNameSchema,
    tools: z.array(ToolNameSchema).default([]),
  }).strict()).default([]),
  skills: z.array(IdSchema).default([]),
  prompt: z.string().trim().max(20_000).default(''),
  model: z.object({ provider: z.string().trim().min(1), model: z.string().trim().min(1), reasoningEffort: z.string().trim().min(1).optional() }).strict().optional(),
  workspaceRoot: z.string().trim().min(1).optional(),
}).strict().superRefine((profile, context) => {
  const unique = (values: string[], path: (string | number)[], label: string) => {
    if (new Set(values).size !== values.length) context.addIssue({ code: 'custom', path, message: `${label} must be unique` })
  }
  unique(profile.tools, ['tools'], 'Tool names')
  unique(profile.skills, ['skills'], 'Skill names')
  unique(profile.mcps.map(server => server.server), ['mcps'], 'MCP server names')
  for (const [index, server] of profile.mcps.entries()) unique(server.tools, ['mcps', index, 'tools'], 'MCP tool names')
  const granted = workerToolNames(profile)
  if (new Set(granted).size !== granted.length) context.addIssue({ code: 'custom', path: ['mcps'], message: 'A tool can be granted only once' })
  for (const [index, name] of profile.tools.entries()) {
    if (name.startsWith('mcp__')) context.addIssue({ code: 'custom', path: ['tools', index], message: 'MCP tools must be granted under mcps with their server name' })
    if (RESERVED_TOOLS.has(name)) {
      context.addIssue({ code: 'custom', path: ['tools', index], message: `${name} is managed by the task runtime and cannot be configured` })
    }
  }
  if (profile.workspaceRoot && !isAbsolute(profile.workspaceRoot)) context.addIssue({ code: 'custom', path: ['workspaceRoot'], message: 'Worker workspaceRoot must be absolute' })
})
export type WorkerProfile = z.infer<typeof WorkerProfileSchema>

export const WorkerConfigSchema = z.object({
  version: z.literal(1),
  defaultProfile: IdSchema.optional(),
  profiles: z.array(WorkerProfileSchema).min(1).max(100),
}).strict().superRefine((config, context) => {
  const ids = config.profiles.map(profile => profile.id)
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', path: ['profiles'], message: 'Worker profile ids must be unique' })
  if (config.defaultProfile && !ids.includes(config.defaultProfile)) {
    context.addIssue({ code: 'custom', path: ['defaultProfile'], message: 'Default worker profile must name a configured profile' })
  }
})
export type WorkerConfig = z.infer<typeof WorkerConfigSchema>

/** A validated worker profile catalog. An empty capability list grants no DSH tools, MCP tools, or skills. */
export class WorkerRegistry {
  private readonly profiles: ReadonlyMap<string, WorkerProfile>
  constructor(readonly config: WorkerConfig) {
    this.profiles = new Map(config.profiles.map(profile => [profile.id, profile]))
  }
  get(id: string): WorkerProfile | undefined { return this.profiles.get(id) }
  get defaultProfile(): WorkerProfile | undefined { return this.config.defaultProfile ? this.get(this.config.defaultProfile) : undefined }
  require(id: string): WorkerProfile {
    const profile = this.get(id)
    if (!profile) throw new Error(`Unknown worker profile: ${id}`)
    return profile
  }
  list(): WorkerProfile[] { return [...this.profiles.values()] }
  allowedTools(profile: WorkerProfile): string[] {
    return workerToolNames(profile)
  }
  static parse(value: unknown): WorkerRegistry { return new WorkerRegistry(WorkerConfigSchema.parse(value)) }
  static read(path: string): WorkerRegistry {
    let value: unknown
    try { value = JSON.parse(readFileSync(path, 'utf8')) }
    catch (error) { throw new Error(`Could not read worker configuration ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }) }
    try { return WorkerRegistry.parse(value) }
    catch (error) { throw new Error(`Invalid worker configuration ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }) }
  }
}
