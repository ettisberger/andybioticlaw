#!/usr/bin/env bash
# Template skill installer — idempotent.
# `andybioticlaw skill install <name>` runs this script with the skill's
# folder as CWD. Do nothing here if your skill has no OS-level setup.
set -euo pipefail

echo "template skill has nothing to install"
