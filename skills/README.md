# Skills — developer contract

A **skill** extends Emma with domain-specific knowledge, tools, or MCP servers. Skills live in this directory, one folder per skill. The `andybioticlaw` core service loads skills at startup (and on demand via the CLI) and injects their `SKILL.md` into the agent's system prompt whenever they are active in the current scope.

> **Phase 1 note:** the loader scans for skills but does not yet parse manifests, install dependencies, or start MCP servers. Those steps land with Phase 3. This document nails down the contract so future skills can be authored against a stable shape.

## Folder layout

```
skills/<skill-name>/
├── manifest.yaml        # required — declarative skill metadata
├── SKILL.md             # required — prose injected into the system prompt
├── install.sh           # optional — idempotent installer (apt deps, etc.)
├── uninstall.sh         # optional — clean inverse of install.sh
└── assets/              # optional — any file referenced by SKILL.md or MCP server
```

`<skill-name>` must be **kebab-case** and match the `name` field in `manifest.yaml`. Names prefixed with `_` (e.g. `_template`) are reserved and skipped by the loader.

## manifest.yaml schema

```yaml
name: <kebab-case matching the folder name>
version: <semver string>
description: <single-line summary>
enabled: true | false                 # if false, the skill is registered but not injected
scope:                                 # list of scopes this skill applies to
  - dm                                 # direct-message sessions
  # - group                            # PLANNED — rejected in v1

required_secrets:                      # keys from .env this skill may read
  - GOOGLE_OAUTH_CLIENT_ID
  - GOOGLE_OAUTH_CLIENT_SECRET

apt_dependencies: []                   # (optional) apt packages required on Linux
system_commands: []                    # (optional) binaries that must be in PATH

mcp_servers:                           # (optional) list of MCP servers this skill runs
  - name: <kebab-case>
    command: <executable>
    args: [...]
    env:
      OAUTH_CLIENT_ID: ${GOOGLE_OAUTH_CLIENT_ID}   # interpolation of required_secrets
```

Fields:

| Field | Required | Purpose |
| ----- | -------- | ------- |
| `name` | yes | registry key; must equal folder name |
| `version` | yes | semver; shown in CLI and dashboard |
| `description` | yes | one-line summary for the CLI/dashboard |
| `enabled` | yes | hard switch — false means never injected |
| `scope` | yes | non-empty subset of `[dm, group]`. Group is planned; DM-only in v1 |
| `required_secrets` | no | subset of `.env` keys this skill is permitted to read |
| `apt_dependencies` | no | OS packages the install.sh assumes to be present |
| `system_commands` | no | PATH binaries the skill relies on at runtime |
| `mcp_servers` | no | MCP servers spawned per session when the skill is active |

### Secret scoping

Secrets listed in `required_secrets` are the ONLY secrets this skill may read at runtime. Core secrets (`TELEGRAM_BOT_TOKEN`, `DASHBOARD_BASIC_AUTH_PASSWORD`) are never exposed to skills. A skill attempting to read a secret not in its manifest raises a `SecretScopeViolationError` and produces a `secret_scope_violation` row in the audit log.

The Claude subprocess env for a session is:

```
env = filter(host_env, drop=.env secrets)
    + scoped_secrets_for_active_skills(session.scope)
```

i.e. nothing from `.env` ever leaks to a subprocess except what an active skill has explicitly requested.

## Lifecycle

```
andybioticlaw skill install <name>      # validates manifest, runs install.sh
andybioticlaw skill uninstall <name>    # runs uninstall.sh, de-registers
andybioticlaw skill enable <name>       # flips manifest.enabled true
andybioticlaw skill disable <name>      # flips manifest.enabled false
andybioticlaw skill list                # show all registered
```

`install.sh` must be idempotent: re-running it on an already-installed skill must be a no-op.

## Session wiring

When a session for scope `<S>` starts, the core:

1. Assembles the system prompt:
   1. Base prompt from `src/agent/prompts/system.base.md` with `{{agent.name}}` substituted.
   2. Active memory entries in scope (bullet list).
   3. `SKILL.md` contents for each skill with `enabled: true` AND `scope` includes `<S>`.
   4. Meta info (current time, user, etc.).
2. Generates a working-directory `.mcp.json` from the union of `mcp_servers` across active skills, interpolating secrets via `required_secrets`.
3. Spawns `claude` with `--mcp-config .mcp.json`, `--system-prompt <assembled>`, scoped env.

## Template skill

See `skills/_template/` for a starter. Copy it to `skills/<your-name>/`, fill in `manifest.yaml` and `SKILL.md`, and run `andybioticlaw skill install <your-name>` (Phase 3+).
