# Contributing

Thanks for considering a contribution. This project is a single-operator self-hosted service, so PRs are welcome but triage is best-effort — I run this on one box and features that don't help that one box tend to linger.

## Dev setup

```bash
git clone https://github.com/ettisberger/andybioticlaw.git
cd andybioticlaw
./scripts/bootstrap-dev.sh      # installs deps + copies example configs
pnpm dev                        # watch-mode service
```

Requirements: Node 20+, pnpm 9+ (via `corepack enable pnpm`). The `claude` CLI must be logged in (`claude login`) for the service to boot — it refuses to start if Claude credentials aren't present.

## Before opening a PR

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm -r build
```

All four must pass. CI runs the same set on every PR.

## Commit messages — required format

Commit headers **must** follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>[optional scope]: <short description>

[optional body]
[optional footer]
```

Accepted types and their release impact:

| Type       | Appears in CHANGELOG | Version bump |
|------------|----------------------|--------------|
| `feat:`    | ✓ Features           | minor        |
| `fix:`     | ✓ Bug Fixes          | patch        |
| `perf:`    | ✓ Performance        | patch        |
| `docs:`    | (suppressed)         | —            |
| `refactor:`| (suppressed)         | —            |
| `test:`    | (suppressed)         | —            |
| `chore:`   | (suppressed)         | —            |
| `ci:`      | (suppressed)         | —            |
| `style:`   | (suppressed)         | —            |
| `build:`   | (suppressed)         | —            |

Breaking changes: add `!` after the type (e.g. `feat!: drop Node 18 support`) or a `BREAKING CHANGE:` footer. Either triggers a major bump.

This matters because [release-please](https://github.com/googleapis/release-please) parses commit headers to auto-generate `CHANGELOG.md` and bump the version on every merged release PR. If you write `wip` or `misc` your change won't appear in the release notes.

If you don't want to think about this on every commit, `feat:` or `fix:` is almost always the right answer for anything user-visible; `chore:` for everything else.

## What I'm likely to accept

- Bug fixes, especially with a regression test.
- Documentation corrections.
- New skills (`skills/*`) that follow the existing manifest contract.
- Small UX improvements to the CLI menu / setup wizard.

## What I'm likely to push back on

- New framework dependencies (unless they replace something awkward).
- Multi-user features — this is intentionally single-principal; see `README.md` → Design Decisions.
- Dropping subscription-auth protections — the three-layer API-key refusal is load-bearing.
- Feature flags / config toggles without a concrete use-case behind them.

## Reporting bugs

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md). Include: your install path (tarball vs clone), the version (`andybioticlaw --version` or the tag), `journalctl -u andybioticlaw -n 80 --no-pager`, and what you expected vs what happened.

## License

By contributing you agree your contributions are licensed under the project's MIT license (see `LICENSE`).
