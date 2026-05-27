# Worktree Topology

clawforum 用 git worktree 跨多 phase 并行开发。本文档说明 worktree 资源拓扑 + 共享/独立边界。

## 仓库结构

```
/Users/lleefir/code/mess/260315/
├── clawforum/              # bare repo（core.bare=true）+ pre-bare 时代 working tree 残留
│   ├── .git/               # 全 worktree 共享 git db
│   ├── node_modules/       # 全 worktree symlink 共享（pnpm 包 read-only / 资源高效）
│   └── ...                 # pre-bare 时代 source file 残留（不被任何 worktree 使用 / 仅 stale leftover）
├── worktree/
│   ├── phase1363/          # main 真 working tree
│   ├── phase1365/          # ongoing phase
│   ├── phase1366/          # ongoing phase
│   └── ...                 # 145 worktrees registered
```

## 资源边界：共享 vs 独立

| 资源 | 边界 | 实施 |
|---|---|---|
| `.git/` (git db) | **共享**（bare repo / 单源） | 自然 |
| `node_modules/` (pnpm packages) | **symlink 共享** | 每 worktree `node_modules -> clawforum/node_modules` |
| `node_modules/.vite/vitest/` | ⚠️ 历史共享 → **vitest cacheDir 重定向独立**（phase 1367） | vitest.config.ts `cacheDir: '.vitest-cache'` |
| `.vitest-cache/` | **独立**（per-worktree CWD） | gitignore'd |
| `dist/` | **独立**（per-worktree real dir） | `pnpm build` 自动创建 |
| `.tsbuildinfo` / `.tsbuildinfo.test` | **独立**（tsc 落 CWD） | 自然 / gitignore'd |
| `coverage/` | **独立**（vitest coverage 落 CWD） | gitignore'd |
| src/tests 内容 | **独立**（per-worktree git checkout） | 自然 |

## 新建 worktree 标准流程

```bash
# 1. 创建 worktree（git 默认行为：node_modules 不自动 link / 需手工）
cd /Users/lleefir/code/mess/260315/clawforum
git worktree add /Users/lleefir/code/mess/260315/worktree/phase<N> -b phase<N>-branch

# 2. symlink node_modules（pnpm packages 共享 / 跳过 install）
cd /Users/lleefir/code/mess/260315/worktree/phase<N>
ln -s /Users/lleefir/code/mess/260315/clawforum/node_modules node_modules

# 3. 不要 symlink dist! dist 独立 per worktree
#    pnpm build 自动创建
```

## 反模式（不要做）

- ❌ `dist -> clawforum/dist` symlink — main worktree build 污染 bare repo dist / 任何 process run from clawforum/dist 拿到 wrong worktree code
- ❌ 在 `clawforum/` (bare dir) 顶层运行 `pnpm build` / `pnpm test` — bare repo 不该有 working tree state、那些 build cache + tsbuildinfo 是 stale pollution
- ❌ 跨 worktree 共享 `.vitest-cache/` — race / ordering 错乱

## phase 1367 治理（2026-05-27）

- vitest cacheDir 落 worktree-local（`.vitest-cache/`）— 防 results.json 跨 worktree race
- `.gitignore` 加 `.vitest-cache/`
- main worktree (phase1363) dist symlink → 真目录
- 本文档立

## 历史污染（容忍 / 不主动清）

`/Users/lleefir/code/mess/260315/clawforum/` bare dir 顶层有：
- pre-bare 时代 working tree 残留（src/ tests/ docs/ package.json 等）
- `.tsbuildinfo` `dist/` `coverage/` pre-bare 时代 build cache

这些不影响任何 worktree（worktree 各自独立 git checkout + build），但占磁盘空间。**手工 cleanup 风险中（需确认无 reference）/ 留着不动**。
