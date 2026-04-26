#!/usr/bin/env bash
# notes skill — no-op installer.
#
# The MCP server is pure Node + better-sqlite3 (hoisted at the repo root)
# and reads ANDYBIOTICLAW_DB_PATH from the env the harness injects at
# spawn time. Nothing to set up beyond confirming the framework env will
# reach the server when the service runs.

set -euo pipefail

echo "✓ notes skill needs no per-install setup."
echo "  At runtime the harness injects ANDYBIOTICLAW_DB_PATH into the MCP server."
echo "  Restart the service to pick up the new skill."
