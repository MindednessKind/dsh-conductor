# DSH Conductor

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

dsh-conductor is a configurable task orchestration host packaged as a bundle for [DeepSeek Harness](https://www.deepseek.com/en/harness/). Its Host turns direct user instructions into dependency-linked task graphs and dispatches work to Worker profiles, each with its own concurrency limit and allowlisted DSH tools, MCP tools and skills. GitHub and optional Feishu intake remain available through the existing Ticket workflow.

Start a role catalog from [Coding](examples/workers.coding.json) or [security analysis](examples/workers.security.json), then follow the [Worker orchestration guide](docs/009-worker-orchestration.md). Direct tasks can run without GitHub or Feishu setup.

For a background Host controlled from dsh-tui, follow [Daemon and TUI setup](docs/012-conductor-tui.md). The daemon owns all execution; closing the TUI leaves Host and Workers running. `/conductor` opens its dedicated Host conversation, with task commands, reconnecting updates and a task panel. The archived implementation plan is [011](docs/011-conductor-tui-daemon-plan.md).

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## Setup

For task orchestration and TUI use, start with the daemon guide above. For the optional GitHub/Feishu Ticket integrations, ask your coding agent:

> Read SETUP.md in this repository and set up dsh-conductor with me.

It asks one short question at a time, shows the full plan once, and then installs and configures everything. [SETUP.md](SETUP.md) is what it follows.

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md): manual setup, configuration, upgrades and troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md): adding a Source
- [009 Worker orchestration](docs/009-worker-orchestration.md): configuring task graphs and Worker capabilities
- [010 Host / Worker implementation plan](docs/010-host-worker-plan.md): design, milestones and local validation
- [011 Daemon / TUI implementation plan](docs/011-conductor-tui-daemon-plan.md): lifecycle and integration decisions
- [012 Daemon and TUI guide](docs/012-conductor-tui.md): installation, commands, API and verification

## Development

`pnpm check` runs the typecheck, the tests and the build.

## License

[MIT](LICENSE)
