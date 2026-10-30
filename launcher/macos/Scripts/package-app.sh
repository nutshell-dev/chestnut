#!/bin/bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
MACOS_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)
REPO_ROOT=$(CDPATH= cd -- "$MACOS_DIR/../.." && pwd -P)
OUTPUT_DIR="$MACOS_DIR/.build/app"
NODE_PATH=""
LAUNCHER_PATH=""

usage() {
  cat <<'EOF'
Usage: package-app.sh [--output DIR] [--node PATH] [--launcher PATH]

Build Chestnut Launcher.app in DIR (default: launcher/macos/.build/app).
The CLI is always rebuilt with pnpm build. --launcher is intended for test fixtures.
EOF
}

fail() {
  printf 'package-app: %s\n' "$*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      [[ $# -ge 2 ]] || fail "--output requires a directory"
      OUTPUT_DIR=$2
      shift 2
      ;;
    --node)
      [[ $# -ge 2 ]] || fail "--node requires a path"
      NODE_PATH=$2
      shift 2
      ;;
    --launcher)
      [[ $# -ge 2 ]] || fail "--launcher requires a path"
      LAUNCHER_PATH=$2
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

absolute_file() {
  local path=$1
  if [[ "$path" != /* ]]; then
    path="$(CDPATH= cd -- "$(dirname -- "$path")" && pwd -P)/$(basename -- "$path")"
  fi
  printf '%s\n' "$path"
}

if [[ -z "$NODE_PATH" ]]; then
  NODE_PATH=$(command -v node) || fail "Node.js was not found; pass --node PATH"
fi
NODE_PATH=$(absolute_file "$NODE_PATH")
[[ -f "$NODE_PATH" && -x "$NODE_PATH" ]] || fail "Node.js is not executable: $NODE_PATH"
NODE_VERSION=$("$NODE_PATH" --version) || fail "cannot execute Node.js: $NODE_PATH"
command -v pnpm >/dev/null 2>&1 || fail "pnpm is required to build the CLI"

if [[ -n "$LAUNCHER_PATH" ]]; then
  LAUNCHER_PATH=$(absolute_file "$LAUNCHER_PATH")
  [[ -f "$LAUNCHER_PATH" && -x "$LAUNCHER_PATH" ]] || fail "launcher is not executable: $LAUNCHER_PATH"
else
  command -v swiftc >/dev/null 2>&1 || fail "swiftc is required when --launcher is not supplied"
fi

mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR=$(CDPATH= cd -- "$OUTPUT_DIR" && pwd -P)
APP_PATH="$OUTPUT_DIR/Chestnut Launcher.app"
STAGING_DIR=$(mktemp -d "$OUTPUT_DIR/.chestnut-launcher-package.XXXXXX")
cleanup() {
  if [[ -n "${STAGING_DIR:-}" && -d "$STAGING_DIR" ]]; then
    rm -rf "$STAGING_DIR"
  fi
}
trap cleanup EXIT

# Layout: Contents/MacOS/chestnut-launcher, Contents/Resources/chestnut-cli/dist,
# Contents/Resources/node/bin/node, Contents/Info.plist and build metadata.
BUILD_DIR="$STAGING_DIR/build"
APP_STAGING="$STAGING_DIR/Chestnut Launcher.app"
CONTENTS="$APP_STAGING/Contents"
MACOS_RESOURCES="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"
mkdir -p "$BUILD_DIR/core" "$MACOS_RESOURCES" "$RESOURCES/chestnut-cli" "$RESOURCES/node/bin"

# Always rebuild so the packaged dist cannot silently be an older development artifact.
(
  cd "$REPO_ROOT"
  pnpm --config.verify-deps-before-run=false --config.strict-dep-builds=false build
)
[[ -s "$REPO_ROOT/dist/cli.js" ]] || fail "CLI build did not produce dist/cli.js"

# tsup leaves package imports external. Install only the production dependency
# closure offline in an isolated directory; dist alone is not runnable and a
# legacy pnpm deploy would prune the source worktree's development dependencies.
CLI_DEPLOY="$STAGING_DIR/cli-deploy"
mkdir -p "$CLI_DEPLOY"
cp "$REPO_ROOT/package.json" "$REPO_ROOT/pnpm-lock.yaml" "$CLI_DEPLOY/"
(
  cd "$CLI_DEPLOY"
  pnpm --config.strict-dep-builds=false install --prod --offline
)
[[ -s "$CLI_DEPLOY/node_modules/commander/package.json" ]] || \
  fail "CLI production dependencies were not installed"

if [[ -z "$LAUNCHER_PATH" ]]; then
  LAUNCHER_PATH="$BUILD_DIR/chestnut-launcher"
  swiftc -emit-library -emit-module -enable-testing -module-name LauncherCore \
    "$REPO_ROOT"/launcher/core/Sources/LauncherCore/*.swift \
    -o "$BUILD_DIR/core/libLauncherCore.dylib" \
    -emit-module-path "$BUILD_DIR/core/LauncherCore.swiftmodule" \
    -Xlinker -install_name -Xlinker @rpath/libLauncherCore.dylib
  swiftc -I "$BUILD_DIR/core" -L "$BUILD_DIR/core" -lLauncherCore \
    "$MACOS_DIR"/Sources/LauncherMacOS/*.swift \
    -o "$LAUNCHER_PATH" \
    -Xlinker -rpath -Xlinker @executable_path/core
fi

cp "$LAUNCHER_PATH" "$MACOS_RESOURCES/chestnut-launcher"
chmod 755 "$MACOS_RESOURCES/chestnut-launcher"
if [[ -s "$BUILD_DIR/core/libLauncherCore.dylib" ]]; then
  mkdir -p "$MACOS_RESOURCES/core"
  cp "$BUILD_DIR/core/libLauncherCore.dylib" "$MACOS_RESOURCES/core/libLauncherCore.dylib"
fi
cp "$MACOS_DIR/Info.plist" "$CONTENTS/Info.plist"
# Copy the complete build output, including source maps and typings.
cp -R "$REPO_ROOT/dist" "$RESOURCES/chestnut-cli/dist"
# dist/cli.js is ESM and its imports remain external; ship package metadata and
# the relative, production-only node_modules closure alongside the complete dist.
cp "$REPO_ROOT/package.json" "$RESOURCES/chestnut-cli/package.json"
cp -R "$CLI_DEPLOY/node_modules" "$RESOURCES/chestnut-cli/node_modules"
cp -L "$NODE_PATH" "$RESOURCES/node/bin/node"
chmod 755 "$RESOURCES/node/bin/node"

BUNDLED_NODE="$RESOURCES/node/bin/node"
BUNDLED_CLI="$RESOURCES/chestnut-cli/dist/cli.js"
CLI_VERSION=$(PACKAGE_JSON="$REPO_ROOT/package.json" "$BUNDLED_NODE" -p \
  'require(process.env.PACKAGE_JSON).version')
ARCHITECTURE=$("$BUNDLED_NODE" -p 'process.arch')
SOURCE_REVISION=""
if command -v git >/dev/null 2>&1; then
  SOURCE_REVISION=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)
fi
GENERATED_AT=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
METADATA_PATH="$RESOURCES/build-metadata.json"
CLI_VERSION="$CLI_VERSION" \
NODE_VERSION="$NODE_VERSION" \
ARCHITECTURE="$ARCHITECTURE" \
SOURCE_REVISION="$SOURCE_REVISION" \
GENERATED_AT="$GENERATED_AT" \
METADATA_PATH="$METADATA_PATH" \
"$BUNDLED_NODE" --input-type=commonjs - <<'NODE'
const fs = require('fs');
const metadata = {
  schemaVersion: 1,
  cliVersion: process.env.CLI_VERSION,
  nodeVersion: process.env.NODE_VERSION,
  architecture: process.env.ARCHITECTURE,
  sourceRevision: process.env.SOURCE_REVISION || null,
  generatedAt: process.env.GENERATED_AT,
};
fs.writeFileSync(process.env.METADATA_PATH, JSON.stringify(metadata, null, 2) + '\n');
NODE

# Validate each shipped resource before replacing an existing app.
[[ -x "$MACOS_RESOURCES/chestnut-launcher" ]] || fail "packaged launcher is missing"
[[ -x "$BUNDLED_NODE" ]] || fail "packaged Node.js is missing"
[[ -s "$BUNDLED_CLI" ]] || fail "packaged CLI is missing"
[[ -s "$RESOURCES/chestnut-cli/node_modules/commander/package.json" ]] || \
  fail "packaged CLI production dependencies are missing"
[[ -s "$CONTENTS/Info.plist" ]] || fail "packaged Info.plist is missing"
[[ -s "$METADATA_PATH" ]] || fail "build metadata is missing"
diff -r "$REPO_ROOT/dist" "$RESOURCES/chestnut-cli/dist" >/dev/null || \
  fail "packaged CLI dist differs from the build output"
[[ $("$BUNDLED_NODE" --version) == "$NODE_VERSION" ]] || fail "bundled Node.js version mismatch"
if command -v plutil >/dev/null 2>&1; then
  plutil -lint "$CONTENTS/Info.plist" >/dev/null
fi
if find "$APP_STAGING" -name .chestnut -print -quit | read -r _; then
  fail "application bundle must not contain .chestnut state"
fi

# Keep the previous app until the new bundle has built and passed all checks.
if [[ -e "$APP_PATH" || -L "$APP_PATH" ]]; then
  rm -rf "$APP_PATH"
fi
mv "$APP_STAGING" "$APP_PATH"
printf 'Created %s\n' "$APP_PATH"
printf 'CLI %s; Node %s; architecture %s\n' "$CLI_VERSION" "$NODE_VERSION" "$ARCHITECTURE"
