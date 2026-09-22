#!/usr/bin/env bash
# Boot a scratch profile through the real DSH loader and assert the host half
# applies. Uses a workspace-local DSH_HOME and symlinks the source profile's
# node_modules, so it never touches ~/.dsh and binds only a random port.
#
# Usage: scripts/smoke-boot.sh [source-profile-dir]
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_profile="${1:-$HOME/.dsh/profiles/web}"
home="$root/.dsh-home"
profile="$home/profiles/ctl-test"
port="${SMOKE_PORT:-0}"

rm -rf "$home"
mkdir -p "$profile/node_modules"
cp "$source_profile/package.json" "$profile/package.json"
cp "$source_profile/cordis.patch.yml" "$profile/cordis.patch.yml" 2>/dev/null || true
printf '[]\n' > "$profile/cordis.yml"

# Symlink every package the source profile resolves; writing inside a symlinked
# node_modules would escape the workspace, so the directory itself is real.
for entry in "$source_profile"/node_modules/*; do
  ln -sfn "$entry" "$profile/node_modules/$(basename "$entry")"
done
ln -sfn "$root" "$profile/node_modules/dsh-llm-ctl"

node -e "
const fs = require('fs');
const path = '$profile/package.json';
const manifest = JSON.parse(fs.readFileSync(path, 'utf8'));
manifest.name = 'dsh-profile-ctl-test';
manifest.dependencies = { ...manifest.dependencies, 'dsh-llm-ctl': 'file:$root' };
if (!manifest.dsh.profile.bundles.includes('dsh-llm-ctl')) manifest.dsh.profile.bundles.push('dsh-llm-ctl');
fs.writeFileSync(path, JSON.stringify(manifest, null, 2));
"

echo "smoke-boot: composed tree"
DSH_HOME="$home" dsh --profile ctl-test --dump-config | grep -A1 'id: llm-ctl' || {
  echo "smoke-boot: llm-ctl row missing from composed tree" >&2
  exit 1
}

echo "smoke-boot: booting (binds 127.0.0.1:$port, no browser)"
DSH_HOME="$home" dsh --profile ctl-test --port "$port" --no-open > "$home/boot.log" 2>&1 &
pid=$!
for _ in $(seq 1 40); do
  if grep -q 'dsh web: http' "$home/boot.log" 2>/dev/null; then break; fi
  if grep -q 'plugin tree failed to load' "$home/boot.log" 2>/dev/null; then break; fi
  sleep 1
done
kill "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true

if grep -q 'plugin tree failed to load' "$home/boot.log"; then
  echo "smoke-boot: FAILED" >&2
  grep -A3 'plugin tree failed to load' "$home/boot.log" >&2
  exit 1
fi
if ! grep -q 'dsh web: http' "$home/boot.log"; then
  echo "smoke-boot: FAILED (server never reported a URL)" >&2
  tail -n 20 "$home/boot.log" >&2
  exit 1
fi
echo "smoke-boot: OK — loader composed and booted with dsh-llm-ctl mounted"
