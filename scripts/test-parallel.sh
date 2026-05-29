#!/usr/bin/env bash
# phase 1394: 并行跑 vitest fast/isolated 两 project / wall ~41s → ~31s (-24%)
#
# 原因: vitest projects 单进程内 sequential 调度 / 2 进程并行 OS-scheduled
# 实测: baseline ~41s avg / parallel ~31s avg (5 cold run)
#
# 退出码: 任一 project fail → 整体 fail（兼容 CI 语义）

set -uo pipefail

CFG=".config/vitest.config.ts"
LOG_FAST=$(mktemp -t vitest-fast.XXXXXX)
LOG_ISO=$(mktemp -t vitest-iso.XXXXXX)

# 清理 helper
cleanup() { rm -f "$LOG_FAST" "$LOG_ISO"; }
trap cleanup EXIT

# 启动 2 个 vitest 进程并行
npx vitest run --config "$CFG" --project=fast "$@" > "$LOG_FAST" 2>&1 &
PID_FAST=$!

npx vitest run --config "$CFG" --project=isolated "$@" > "$LOG_ISO" 2>&1 &
PID_ISO=$!

# 等 + 收 exit 码
wait $PID_FAST
EC_FAST=$?

wait $PID_ISO
EC_ISO=$?

# 透出两个 project 的 log 到 stdout（保留 vitest 完整输出顺序）
echo "===== fast project ====="
cat "$LOG_FAST"
echo
echo "===== isolated project ====="
cat "$LOG_ISO"

# 任一 fail 整体 fail
if [ $EC_FAST -ne 0 ] || [ $EC_ISO -ne 0 ]; then
  echo
  echo "fast project exit code: $EC_FAST"
  echo "isolated project exit code: $EC_ISO"
  exit 1
fi
