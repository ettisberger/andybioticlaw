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

# Install the `andybioticlaw` CLI wrapper on PATH. The package.json `bin`
# field only takes effect when the package is installed globally or linked,
# which nobody does in this repo. Emma's Bash tool and the user both need
# the command resolvable from their shell — symlinking into ~/.local/bin/
# achieves that without touching /usr/local.
USER_BIN="$HOME/.local/bin"
mkdir -p "$USER_BIN"
ln -sf "$ROOT/bin/andybioticlaw" "$USER_BIN/andybioticlaw"
echo "✓ andybioticlaw wrapper symlinked into $USER_BIN/"
case ":$PATH:" in
  *":$USER_BIN:"*) ;;
  *)
    echo "  NOTE: $USER_BIN is not on your \$PATH. Add it to your shell rc:"
    echo '    export PATH="$HOME/.local/bin:$PATH"'
    ;;
esac

echo
echo "next steps:"
echo "  pnpm build                                         # build dist/ (required — wrapper runs dist/cli/admin.js)"
echo "  pnpm dev                                           # run the service"
echo "  pnpm exec tsx src/cli/admin.ts config validate     # validate config"
echo "  pnpm test                                          # run unit tests"
