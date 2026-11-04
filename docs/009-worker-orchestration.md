# 009 Worker orchestration

This document describes the general task graph path. It runs alongside GitHub and Feishu Sources, which continue to create authorized Tickets through Policy. Deployment setup is in [006 Deployment](006-deployment.md); the code structure is in [007 Architecture](007-architecture.md).

## Request flow

The Host Session receives a direct user instruction and uses `task_submit` to create a graph. Its general task prompt is independent of the Ticket prompt and includes the configured roles, capabilities, concurrency caps and workspace roots. Each task names a configured Worker profile and may depend on other task IDs. Ready tasks start as DSH Sessions; independent tasks can run in parallel while each profile's `maxInstances` is respected across every active graph. This path can start while GitHub and Feishu setup is pending; only Source-backed Ticket work waits for those integrations.

Workers report `progress`, `completed`, `blocked` or `failed` through `task_report`. Each report and its Host notification enter the same database transaction. The durable Effects queue retries delivery with a stable event ID; the Host receives `task_report` events even without a configured Source. Launch failures, execution errors and a Worker ending without a final report also notify the Host. Completion releases dependents with upstream summaries and artifact references.

A later Host instruction can edit a task that has not started, add a task, steer a running Worker with `task_instruct`, retry a blocked or failed task in a new Session, or cancel a task or graph. Graphs and reports persist under `stateDir`; active runs resume with a continuation message and saved instructions after a Host restart. Cancelled and terminal runs reject further tool calls and reports. Cancellation, terminal reports and Host shutdown stop that run's managed shell jobs; recovery first stops a previous live turn before sending continuation.

The Host tools are `task_submit`, `task_list`, `task_add`, `task_update`, `task_instruct`, `task_retry`, `task_cancel` and `task_cancel_task`. A Worker gets `task_report` and gets `task_skill` only if its profile has a non-empty Skill allowlist.

## Configuration

Create `<stateDir>/workers.json` from [the combined example](../examples/workers.json), [Coding roles](../examples/workers.coding.json), or [security analysis roles](../examples/workers.security.json). The file is validated and loaded once when Runtime starts. Restart dsh-conductor after editing it. Unknown fields, duplicate IDs or tool grants, invalid Worker names and invalid paths prevent startup.

The top-level `version` is currently `1`; `profiles` contains one entry per Worker. The catalog is deliberately static at runtime, so a profile cannot increase its own permissions through task instructions.

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Stable lowercase ID used by task plans |
| `name` | yes | Display name shown to the Host and Worker |
| `description` | no | Routing guidance shown to the Host |
| `maxInstances` | yes | Concurrent task cap shared across all task graphs |
| `permissionPreset` | no | DSH preset: `read-only`, `workspace-write` (default) or `danger-full-access` |
| `tools` | no | Exact DSH tool names to inherit; empty by default |
| `mcps` | no | Rows of `{ "server": "serverName", "tools": ["remote_tool_name"] }`; DSH exposes each as `mcp__<serverName>__<remote_tool_name>`, which must exist in the registered Session tool scope |
| `skills` | no | Exact DSH Skill names this Worker may load through `task_skill`; empty by default |
| `prompt` | no | Additional Worker-specific direction |
| `model` | no | Optional provider, model and reasoning-effort override |
| `workspaceRoot` | no | Absolute root for this profile's task workspaces |

`defaultProfile` may name a catalog entry for existing Ticket workers. General task graphs select a profile per task and do not need a default.

The templates include coding roles (frontier, backend and web coding, review and standards) and security-analysis roles (binary, API, endpoint and script analysis, vulnerability discovery and exploit validation). They start without shell, MCP or Skill grants. Add the tools installed in your profile for the job; on Windows grant `pwsh`, on Unix grant `bash`, and add the relevant `job_output`, `job_list` and `job_kill` tools if needed. Do not grant both shells unless both are registered. Listing a capability does not install it. Before delivering work, the runtime rejects the run with a clear failure report if any granted tool or Skill is unavailable.

For an existing repository, artifact directory or project-local Skill, set the task's structured `workspace` field to that absolute directory. A directory written only in `description` does not select it. The directory must be beneath the selected profile's `workspaceRoot`; otherwise submission fails. If omitted, a new directory is created at `<workspaceRoot>/<graph>/<task>`, with `<stateDir>/task-workspaces` as the default root. `task_list` returns descriptions, dependencies, acceptance criteria, explicit workspace and saved instructions so the Host can inspect the current plan before changing it.

For example, a Coding graph can run backend and web tasks independently and make review depend on both; a standards task may follow the review. A local analysis graph can assign a supplied script to `script-reverse-engineering`, then send its findings and artifact references to `vulnerability-discovery`. The scheduler uses the same task schema in either domain.

## Access limits

Task Worker Sessions use a domain-neutral DSH preset without child-agent delegation or the global `skill` tool. They inherit only configured tool names registered in their DSH scope, and a per-call guard rejects any unconfigured tool, including tools registered directly on an Agent. MCP entries pair the DSH `serverName` with remote tool names; the Host converts each pair to DSH's `mcp__<serverName>__<tool>` name before applying the Session allowlist. The Host does not start an MCP server or grant every tool from that server. A configured but unregistered name fails the run. The filesystem Skill provider remains available for discovery; its content is fetched by exact name only after `task_skill` verifies the profile allowlist, without the global Skill tool or automatic content injection.

The DSH `permissionPreset` controls DSH permission behavior. It does not isolate the process from the operator's OS account, filesystem, programs or network. In particular, shell tools can still run programs and access anything permitted to that account. Tool, MCP and Skill allowlists are not a substitute for OS/container isolation. Use a dedicated OS account or an external sandbox for untrusted or security-testing work, and configure an explicitly authorized target scope in the task.

`workspaceRoot` constrains the selected DSH workspace path. It is not a security sandbox and does not constrain programs launched by a Worker. The legacy Web panel manages Source Tickets; general task graphs are available through the Host tools and the Conductor API/TUI.
