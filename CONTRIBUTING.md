# Contributing to Clawforum

## Development setup

See [README.md](./README.md) for installation and quick start.

## Merge discipline

本项目使用 worktree + 分支合入 main 的工作流。历史上出现过 merge 后 import 悬空、
tsc 挂但合并已记录的事故。为避免重演：

1. 合并到 main 后必须立刻验证编译和测试：
   - 本地：启用 post-merge hook（见下），自动跑 `pnpm typecheck` 和 `pnpm test:run`
   - 远端：push 后等 `.github/workflows/ci.yml` 的 CI 绿

2. 若本地 post-merge 验证失败，merge 已完成。判断是 `git reset --hard HEAD~1` 回滚
   还是向前修复，不要"合完再补"——留着挂着的 main 会污染后续所有 worktree。

## Enabling the post-merge hook

一次性启用：

    git config core.hooksPath .githooks

之后每次 `git merge` 完成后自动跑 typecheck + test:run。

跳过单次检查（不推荐）：git 原生不支持 `--no-verify` 跳过 post-merge，只能临时
`git config core.hooksPath /dev/null`，或人工移 hook。

## Running checks manually

    pnpm typecheck       # TypeScript strict check, no emit
    pnpm test:run        # vitest one-shot run
    pnpm run lint        # alias for typecheck

CI 在 push / PR 时跑这三项于 Node 22.x / 23.x matrix。
