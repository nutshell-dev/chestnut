# Phase 1447 — edit/multi_edit replaceAll fullread+stale gate（破坏面对称化）

**起 phase**: 2026-05-30
**worktree**: `/Users/lleefir/code/mess/260315/worktree/phase1447/`
**branch**: `phase1447`（基线 main `ebd2b7c9`）
**性质**: 单 Step A、edit / multi_edit + replaceAll 加 write overwrite 同型 gate

---

## 1. 当前状态

main `ebd2b7c9` 已含 phase 1444（isFullRead 新语义：`limit >= totalLines` 也算 fullread）+ phase 1437（edit/multi_edit 不 unconditionally promote isFullRead）。但 `replaceAll=true` 当前无 gate：

- agent 不 read → edit({oldText: "foo", newText: "bar", replaceAll: true}) → 成功（盲改所有匹配）
- 破坏面与 write overwrite 同级——agent 改的可能是它没看过的 context（注释 / 字符串字面 / 不相关 scope 里的 substring）
- 与 write overwrite 严 gate（fullread + stale 双层）的对称性破缺：相同破坏面 / 不同护栏

## 2. 目标

phase 结束后行为：

- `edit({..., replaceAll: true})` 加 fullread + stale 双层 gate（同 write overwrite 严轨）
- `multi_edit({..., edits: [...]})` 若 **任一** edit `replaceAll: true` → 整批同 gate（原子批 + 任一严则全严）
- 默认 unique-match edit（`replaceAll: false` 或未传）gate 行为不变（phase 1437 路径 B 保留）
- gate 失败错误文案提供两条 actionable：要么 `read` 全文、要么改回 `replaceAll: false` + 唯一匹配
- design row 同步、§7.A 加 closure row

**可测试目标**：

- 不 read + replaceAll → reject（"requires fully read"）
- partial read（limit < totalLines）+ replaceAll → reject
- 全 read + replaceAll → 通过
- 全 read 后文件被外部改 + replaceAll → reject（"modified since"）
- 全 read + multi_edit 含 replaceAll → 通过
- 全 read + multi_edit 含 mixed（部分 replaceAll、部分不）→ 通过（同 gate 即可）
- 不 read + multi_edit 全 unique → 通过（无 replaceAll、不触 gate）
- 不 read + multi_edit 任一 replaceAll → reject

## 3. 修改文件

| 文件 | 类型 | 改什么 |
|---|---|---|
| `src/foundation/file-tool/edit.ts` | MODIFY | 在 match check 通过后、backup 前插入 replaceAll gate 块（L1 fullread + L2 stale），fail 即 return |
| `src/foundation/file-tool/multi_edit.ts` | MODIFY | 在 `if (!edits || edits.length === 0)` 之后、`exists` 前插入 hasReplaceAll = edits.some(e => e.replaceAll === true) → 若 true 跑同 gate |
| `src/foundation/file-tool/edit-format.ts`（或 new helper file） | NEW or MODIFY | 抽 helper `enforceFullReadGate(ctx, resolved, filePath, opSummary): Promise<ToolResult | null>` —— null = 通过、ToolResult = reject 返回。edit + multi_edit + write 共享（write 仍保留既有内联逻辑、本期不动） |
| `tests/foundation/file-tool/edit.test.ts` | MODIFY+NEW | NEW 4 case: no-read+replaceAll reject / partial+replaceAll reject / full+replaceAll pass / replaceAll stale reject |
| `tests/foundation/file-tool/multi_edit.test.ts` | MODIFY+NEW | NEW 4 case: 含 replaceAll 触 gate / 全 unique 不触 / mixed 触 / multi_edit stale reject |
| `design/modules/l2_file_tool.md` | MODIFY | §10.5【6】edit 关键设计点 + §10.6【6】multi_edit 关键设计点：加 replaceAll gate 说明；§7.A 加 `A.phase1447-edit-replaceAll-gate-asymmetry-fix`；§7.D 加 phase 1447 entry |

## 4. 设计细节

### 4.1 共享 helper `enforceFullReadGate`

放在 `file-state.ts`（与 `computeContentHash` 同 module、`readFileState` 语义所在）：

```typescript
// file-state.ts NEW export
import type { ExecContext } from '../tools/index.js';
import type { ToolResult } from '../tool-protocol/index.js';

/**
 * Enforce the same fullread + stale gate that write overwrite uses, for
 * destructive operations on existing files (write overwrite, edit replaceAll,
 * multi_edit containing any replaceAll).
 *
 * Returns null if the gate passes; otherwise returns a ToolResult to surface
 * to the caller (success: false, with actionable hint).
 *
 * Caller must pass the resolved (clawDir-relative) path that the operation
 * will write, the display path for error messaging, and an op summary used
 * in the hint (e.g. "replaceAll=true requires the file to have been fully
 * read").
 */
export async function enforceFullReadGate(
  ctx: ExecContext,
  resolved: string,
  filePath: string,
  opSummary: string,
): Promise<ToolResult | null> {
  const state = ctx.readFileState.get(resolved);
  // L1: never-read or partial-read
  if (!state || !state.isFullRead) {
    return {
      success: false,
      content: `Error: ${opSummary} '${filePath}' to have been fully read in this session. Use \`read\` (start at line 1, with limit >= totalLines, no byte-cap truncation) first.`,
    };
  }
  // L2: stale (mtime + hash double check, same as write overwrite)
  try {
    const stat = await ctx.fs.stat(resolved);
    const currentMtime = stat.mtime.getTime();
    if (currentMtime > state.timestamp) {
      const currentContent = await ctx.fs.read(resolved);
      if (computeContentHash(currentContent) !== state.hash) {
        return {
          success: false,
          content: `Error: File '${filePath}' has been modified since your last read (either by the user or by another tool). Read it again before this operation.`,
        };
      }
      state.timestamp = currentMtime;  // mtime touched but content same — refresh + allow
    }
  } catch {
    return {
      success: false,
      content: `Error: Could not verify '${filePath}' is unchanged since last read. Read it again before this operation.`,
    };
  }
  return null;
}
```

> **注**：本期 write.ts 不复用此 helper（既有内联逻辑、保 phase 1430 测试稳定）。下一 phase 可顺手 refactor write 接入、统一 3 工具 gate 入口。

### 4.2 edit.ts 集成

```typescript
// 在 match check 后、backup 前插入：
if (replaceAll) {
  const gateError = await enforceFullReadGate(
    ctx, resolved, filePath,
    'replaceAll=true requires',
  );
  if (gateError) {
    // 改错误文案：加 "or set replaceAll=false with a uniquely-matching oldText" 引导
    return {
      success: false,
      content: gateError.content + ` Alternatively, set replaceAll=false with a uniquely-matching oldText to scope the change.`,
    };
  }
}
```

### 4.3 multi_edit.ts 集成

```typescript
// 在 file exists check 前插入：
const hasReplaceAll = edits.some(e => e.replaceAll === true);
if (hasReplaceAll) {
  const gateError = await enforceFullReadGate(
    ctx, resolved, filePath,
    'multi_edit with any replaceAll=true requires',
  );
  if (gateError) {
    return {
      success: false,
      content: gateError.content + ` Alternatively, remove replaceAll from all edits (each edit must uniquely match).`,
    };
  }
}
```

### 4.4 行为表

| 场景 | 旧（无 gate） | 新 |
|---|---|---|
| 不 read + edit replaceAll | success | **reject** ✓ |
| partial read + edit replaceAll | success | **reject** ✓ |
| full read + edit replaceAll | success | success ✓ |
| full read + stale (外部改) + edit replaceAll | success（覆盖外部改） | **reject** ✓ |
| edit replaceAll=false (默认) | success | success ✓（未触 gate） |
| 不 read + multi_edit 全 unique | success | success ✓（无 replaceAll） |
| 不 read + multi_edit 任一 replaceAll | success | **reject** ✓ |
| full read + multi_edit mixed | success | success ✓ |
| full read + stale + multi_edit replaceAll | success | **reject** ✓ |

### 4.5 设计原则映射

- **DP「不丢弃/静默」**：旧路径下 agent 盲改未见 context = silent X、加 gate 显式提示
- **ML#7 对称性**：write overwrite + edit replaceAll 破坏面同级、护栏对称
- **Philosophy P2 上下文工程**：默认 unique-match 仍 cheap（不强求 read 大文件）、replaceAll 是"我知道我在做什么"的显式声明、贵就贵
- **ML#1 SRP**：gate helper 集中到 `file-state.ts`、各调用方只表达"我是 destructive op"语义

## 5. 不做

- write.ts 接入 enforceFullReadGate helper（保 phase 1430 / 1437 测试稳定、下一 phase refactor 统一 3 工具）
- READ_DEFAULT_LINES / HARD_CAP_BYTES 调整（phase 1444 已锁、本期不动）
- replaceAll 默认行为改变（仍允许、只是加 gate）
- edit 加 fullread 硬 gate（user 已 ratify edit 默认不 gate、仅 replaceAll）
- multi_edit edits[] 内部 per-edit gate（原子批 + 整批同 gate / 任一 replaceAll 全批严）

## 6. 验收

```bash
cd /Users/lleefir/code/mess/260315/worktree/phase1447

# 单元 + 集成
pnpm exec vitest run tests/foundation/file-tool/ tests/core/builtins.test.ts
# 预期：全 PASS（含新 8 case）

# typecheck
pnpm exec tsc --noEmit
# 预期：0 output

# 全量
pnpm exec vitest run
# 预期：全 PASS、0 regression

# main 不动
git rev-parse main
# 预期：ebd2b7c9...

# 反证：enforceFullReadGate 仅在 file-state.ts 定义、edit/multi_edit 导入
grep -rn "enforceFullReadGate" src/foundation/file-tool/
# 预期：file-state.ts 1 export + edit.ts 1 import+call + multi_edit.ts 1 import+call

# 反证：design row 含本 phase closure
grep -n "A.phase1447-edit-replaceAll-gate" /Users/lleefir/code/mess/260315/design/modules/l2_file_tool.md
# 预期：1+ lines
```

## 7. 风险

- **风险 1**：既有 replaceAll 测试是否假设 "无 read 也能 replaceAll" → 我已先 grep 过、phase 1422+ 后 search 用 text 不用 replaceAll、edit/multi_edit 既有 replaceAll 测试用 `mockFs.writeAtomic` 准备文件后直接 edit、未 read。这些测试在新 gate 下会 fail、需更新（先 read 再 replaceAll）
- **风险 2**：multi_edit edits 数组里 replaceAll undefined vs false 的判断 → 我用 `e.replaceAll === true` 显式三等比较、undefined / false / 任何 non-true 都不算 replaceAll
- **风险 3**：helper 在 file-state.ts 中导致循环引用 → file-state.ts 仅 export 函数 + 接口、不 import edit/multi_edit；edit/multi_edit import file-state、单向 ✓
- **风险 4**：error 文案叠加 "Alternatively" 后过长 → 已控制在单行 2 句、对 agent 仍 actionable
