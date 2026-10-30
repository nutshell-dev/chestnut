#!/bin/bash
set -euo pipefail

fail() {
  printf 'smoke-installed-app: %s\n' "$*" >&2
  exit 1
}

[[ $# -eq 1 ]] || fail "usage: smoke-installed-app.sh '/path/to/Chestnut Launcher.app'"
APP_PATH=$1
if [[ "$APP_PATH" != /* ]]; then
  APP_PATH="$PWD/$APP_PATH"
fi
APP_PATH="$(CDPATH= cd -- "$(dirname -- "$APP_PATH")" && pwd -P)/$(basename -- "$APP_PATH")"
[[ -d "$APP_PATH" ]] || fail "app bundle does not exist: $APP_PATH"

TEMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/chestnut-installed-smoke.XXXXXX")
cleanup() {
  rm -rf "$TEMP_ROOT"
}
trap cleanup EXIT

require_layout() {
  local app=$1
  local contents="$app/Contents"
  [[ -s "$contents/Info.plist" ]] || fail "missing Info.plist in $app"
  [[ -x "$contents/MacOS/chestnut-launcher" ]] || fail "missing launcher executable in $app"
  [[ -x "$contents/Resources/node/bin/node" ]] || fail "missing bundled Node.js in $app"
  [[ -s "$contents/Resources/chestnut-cli/dist/cli.js" ]] || fail "missing bundled CLI in $app"
  [[ -s "$contents/Resources/chestnut-cli/package.json" ]] || fail "missing CLI package.json in $app"
  [[ -s "$contents/Resources/chestnut-cli/node_modules/commander/package.json" ]] || \
    fail "missing CLI production dependencies in $app"
  [[ -s "$contents/Resources/build-metadata.json" ]] || fail "missing build metadata in $app"
  if command -v plutil >/dev/null 2>&1; then
    plutil -lint "$contents/Info.plist" >/dev/null || fail "invalid Info.plist in $app"
  fi
  if find "$app" -name .chestnut -print -quit | read -r _; then
    fail "app bundle contains .chestnut state: $app"
  fi
}

run_status() {
  local app=$1
  local label=$2
  local sandbox="$TEMP_ROOT/$label"
  local home="$sandbox/home"
  local expected_root="$home/Library/Application Support/Chestnut"
  local empty_path="$sandbox/empty-path"
  local node="$app/Contents/Resources/node/bin/node"
  local cli="$app/Contents/Resources/chestnut-cli/dist/cli.js"
  local output

  mkdir -p "$expected_root" "$empty_path" "$sandbox/tmp"
  # env -i clears CHESTNUT_CLI_JS/CHESTNUT_ROOT and every other inherited override.
  # With no development overrides, the CLI root is its cwd. Use the production
  # default as cwd so this direct resource probe observes that exact root.
  output=$(
    cd "$expected_root"
    env -i \
      HOME="$home" \
      PATH="$empty_path" \
      TMPDIR="$sandbox/tmp" \
      "$node" "$cli" launcher status --json </dev/null
  ) || fail "bundled CLI status failed for $label"

  [[ -n "$output" ]] || fail "empty launcher status output for $label"
  [[ "$output" != *$'\n'* && "$output" != *$'\r'* ]] || \
    fail "launcher status must emit exactly one JSONL snapshot for $label"

  SNAPSHOT="$output" "$node" --input-type=commonjs - <<'NODE'
const envelope = JSON.parse(process.env.SNAPSHOT);
if (envelope.protocol !== 'chestnut.launcher.v2' || envelope.kind !== 'snapshot') {
  throw new Error('expected one chestnut.launcher.v2 snapshot');
}
if (!envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) {
  throw new Error('snapshot payload must be an object');
}
NODE
  [[ -d "$expected_root/.chestnut" ]] || \
    fail "status did not use expected root $expected_root for $label"
  [[ ! -e "$app/Contents/.chestnut" ]] || fail "status wrote state into app Contents"
  if find "$app" -name .chestnut -print -quit | read -r _; then
    fail "status wrote .chestnut state into app: $app"
  fi
  printf '%s: %s\n' "$label" "$output"
}

require_layout "$APP_PATH"
run_status "$APP_PATH" original

SPACED_PARENT="$TEMP_ROOT/moved app with spaces"
SPACED_APP="$SPACED_PARENT/Chestnut Launcher.app"
mkdir -p "$SPACED_PARENT"
cp -R "$APP_PATH" "$SPACED_APP"
require_layout "$SPACED_APP"
run_status "$SPACED_APP" relocated

printf '%s\n' 'PASS: layout, bundled Node/CLI status, isolated root, and relocation checks.'
printf '%s\n' 'PENDING: GUI launch and start/send/stream require separate macOS and credential-backed verification; not claimed by this smoke.'
