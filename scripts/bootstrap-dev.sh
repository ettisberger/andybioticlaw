#!/usr/bin/env bash
# Developer bootstrap — run once after cloning.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm not found — enabling via corepack"
  corepack enable pnpm
fi

pnpm install

if [[ ! -f "$ROOT/config/config.yaml" ]]; then
  echo "creating config/config.yaml from example"
  cp "$ROOT/config/config.example.yaml" "$ROOT/config/config.yaml"
fi

if [[ ! -f "$ROOT/.env" ]]; then
  echo "creating .env from .env.example (secrets still empty — fill in)"
  cp "$ROOT/.env.example" "$ROOT/.env"
fi

echo "validate config:"
pnpm exec tsx src/cli/admin.ts config validate || true

echo
echo "next steps:"
echo "  pnpm dev                                           # run the service"
echo "  pnpm exec tsx src/cli/admin.ts config validate     # validate config"
echo "  pnpm test                                          # run unit tests"
