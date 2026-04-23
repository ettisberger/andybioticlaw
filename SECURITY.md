# Security policy

## Reporting a vulnerability

**Do not open a public GitHub issue** for security-relevant bugs.

Report privately via **GitHub Security Advisories**:

1. Go to https://github.com/ettisberger/andybioticlaw/security/advisories
2. Click "Report a vulnerability"
3. Fill in what you've found; the maintainer is notified privately

This is the same flow whether you have a proof-of-concept, a suspected issue, or just want a second opinion on something that looks off.

## Scope

In scope:

- Authentication/authorization bypasses (e.g. dashboard basic-auth, allowed-Telegram-user gating, CSRF on mutating routes).
- Secret exposure (e.g. `.env` leakage, skill-secret scope violations, credentials in logs).
- Remote command execution via the scheduler's `bash` task type if triggerable from untrusted input.
- SQL injection (even though we use prepared statements, bug reports welcome).
- The three-layer subscription-auth protection being bypassable.

Out of scope (accepted risk, documented):

- Anything an operator with root / service-user shell access can already do — this is a self-hosted single-principal tool.
- `bash` schedules written by the operator running as the operator's own service user.
- Dashboard auth disabled when `dashboard.basicAuth.enabled: false`. Docs are explicit about this being a loopback-only deployment posture.

## What to expect

- Acknowledgment within 5 business days.
- A fix timeline proportional to severity — critical issues get a same-week patch release; lower-impact issues get queued.
- Public disclosure coordinated with the reporter, usually after a patched release is tagged.

## Credits

If you report a valid issue, I'll credit you in the release's CHANGELOG entry (opt-in during the advisory).
