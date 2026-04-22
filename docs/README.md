# docs/ — reading guide

Start with the repository root `README.md`. From there:

## Living documentation (maintained)

| File | Who should read this | 1-line summary |
|---|---|---|
| [QUICKSTART.md](./QUICKSTART.md) | First-time operator | 30-min VPS happy-path from bare Ubuntu to bot answering a DM. Uses `andybioticlaw init`. |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Operator going to production | Full Hetzner walkthrough: SSH hardening, UFW, logrotate, backup strategy, dashboard reverse-proxy. |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Contributor / new reader of the code | Component diagram + 4 data flows + source-tree map + key invariants. Prerequisite for modifying code. |
| [SECURITY.md](./SECURITY.md) | Operator evaluating trust / Contributor touching auth / secrets / scheduler | Trust boundaries, enforcement layers, incident response. Honest about what's NOT enforced. |

Plus, outside `docs/`:

- **[../README.md § Design decisions](../README.md)** — the *reasoning* behind each architectural shape. If ARCHITECTURE.md tells you "skills inject their SKILL.md into the system prompt at session start", this explains *why that and not an MCP-only approach*.
- **[../CHANGELOG.md](../CHANGELOG.md)** — per-phase additions. Useful when you're trying to understand when a feature landed and what shipped alongside it.
- **[../skills/README.md](../skills/README.md)** — skill contract: manifest schema, secret scoping, lifecycle hooks. If you're writing a skill, this is where you start.

## Historical snapshots (not maintained)

See [archive/](./archive/). Those documents were accurate at the time they were written — phase verification checklists from the six-phase build-out — but reference behaviors, test counts, and table schemas that have since evolved. **Do not follow them as current instructions.** They're kept for the occasional "why was X decided back in phase 3?" question.
