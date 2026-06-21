/**
 * dependency-cruiser config — phase 1298 立
 * ML#3 + ML#7 fs invariant enforce at lint phase
 * cross-ref: phase 1283 + 1291 + 1295 fs cluster
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-core-to-assembly',
      comment: [
        'L4/L5 core + L1/L2 foundation modules 不应反向 import L6 Assembly (ML#5 strict)。',
        'phase 238 + 242 真治后 imports 已 cleared、rule 立 strict 防 future drift。',
        'phase 298 V12 real-治：wrapper 反向迁 assembly/config-load、type-only import 改源 compose-config (assembly own)、allowlist 0 例外。',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src/(core|foundation)/',
      },
      to: { path: '^src/assembly/' },
    },
    {
      name: 'no-foundation-to-core',
      comment: [
        'ML#5 单向依赖 + 底层不预设上层语义。',
        'src/foundation/ (L2c) 不得 import src/core/ (L3 业务)、含 type-only import。',
        'phase 1337 r138 D fork derive / user 2026-05-26 ratify「type-only import 仍预设上层语义」。',
        '替代 tests/design/foundation-no-l3-business-import.test.ts grep-based lint (单源)。',
      ].join(' '),
      severity: 'error',
      from: { path: '^src/foundation/' },
      to: { path: '^src/core/' },
    },
    {
      name: 'no-subagent-to-runtime',
      comment: [
        'ML#5 单向依赖 strict + M#3 资源唯一归属。',
        'src/core/subagent/ (L3) 不得 import src/core/runtime/ (L5)、含 type-only import。',
        'phase 317 真治 phase 283 turn-event-commit module 层 misown (drift-backlog A.phase283、subagent → runtime reverse import 违 M#5)、',
        '与 phase 238 / 242 ML#5 strict reverse era trade-off 同型 cluster。',
        'ML#9 优先编译器检查、防 future L3 → L5 反向 import regression。',
      ].join(' '),
      severity: 'error',
      from: { path: '^src/core/subagent/' },
      to: { path: '^src/core/runtime/' },
    },
    {
      name: 'fs-only-via-foundation-filesystem',
      comment: [
        'ML#3 资源唯一归属：file I/O 必经 L1 FileSystem 接口。',
        'allowlist 4 design intent file:',
        '  - foundation/fs/* impl 自身 (唯一 owner)',
        '  - foundation/audit/writer.ts: phase 1214 ratify dumpFallback boundary 防 audit-of-audit 递归',
        '  - foundation/audit/reader.ts: tail/follow direct fs read (reader API single source)',
        '  - foundation/process-exec/spawn-detached.ts: fd-level openSync(/dev/null) 非 path-level',
        '其他 src 必经 fsFactory inject (phase 1283 α-1)',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/foundation/fs/',
          '^src/foundation/audit/writer\\.ts$',
          '^src/foundation/audit/reader\\.ts$',
          '^src/foundation/process-exec/spawn-detached\\.ts$',
        ],
      },
      to: {
        path: '^(fs|node:fs|fs/promises|node:fs/promises)$',
      },
    },
    {
      name: 'no-orphans',
      comment: [
        'orphan file (无人 import) = 死代码累债 / phase 1301 立 / phase 1302 整目录 allowlist 改',
        'severity warn 持续 future drift 监测',
        'allowlist: SDK entry / config file (.config/ 整目录) / .d.ts',
        '未来加 NEW config 入 .config/ 自动 cover, 无需更新 allowlist',
      ].join(' '),
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          '^src/index\\.ts$',
          '^\\.config/',  // ← NEW phase 1302: 整目录 allowlist / 替换原 leaf file 路径
        ],
      },
      to: {},
    },
    {
      name: 'nodefilesystem-only-from-bootstrap',
      comment: [
        'ML#7 耦合界面稳定：NodeFileSystem 直构造仅 6 bootstrap site:',
        '  - assembly/assemble.ts',
        '  - assembly/core-infrastructure.ts',
        '  - cli/index.ts',
        '  - daemon-entry.ts',
        '  - daemon-handlers.ts (phase 375 抽出)',
        '  - watchdog-entry.ts',
        '  - foundation/fs/* impl 自身',
        '其他必经 fsFactory inject (phase 1283 α-1 + phase 1291 α-2 deps object pattern)',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/assembly/assemble\\.ts$',
          '^src/assembly/core-infrastructure\\.ts$',
          '^src/cli/index\\.ts$',
          '^src/daemon-entry\\.ts$',
          '^src/daemon-handlers\\.ts$',
          '^src/watchdog-entry\\.ts$',
          '^src/foundation/fs/',
        ],
      },
      to: {
        path: '^src/foundation/fs/node-fs(\\.ts)?$',
      },
    },
    {
      name: 'no-deep-into-audit-types',
      comment: [
        'ML#7 + ML#9 — Audit type 对外通道仅 barrel（core/, assembly/, cli/, daemon/, watchdog/）。',
        'foundation/ 同层 peer（tools/, dialog-store/, llm-provider/）走 sibling-direct pattern',
        '深穿 audit/types.js 避循环（phase 1312 ratify）—— audit/index.ts → reader → ',
        'dialog-store/lookup → tool-protocol → llm-provider/types → audit/index 循环。',
        'phase 519 立、5 处 core/+assembly/ deep import 迁 barrel。',
        'barrel 已 re-export: AuditLog / IdNamingEntry / ColSchemaEntry / TraceId / makeTraceId。',
      ].join(' '),
      severity: 'error',
      from: { path: '^src', pathNot: '^src/foundation/' },
      to: { path: '^src/foundation/audit/types\\.ts$' },
    },
    {
      name: 'no-deep-into-assembly-config-defaults',
      comment: [
        'ML#7 + ML#9 — Assembly CONFIG_DEFAULTS 对外通道仅 barrel。',
        '跨模块消费者（cli/, daemon-entry.ts, watchdog/）只能 import',
        'src/assembly/index.ts、不得深穿 src/assembly/config-defaults.ts。',
        'phase 1413 立、treat finding `A.phase1413-config-defaults-exposure-channel` ⏳ → ✅。',
        'phase 1448 扩 sister 2 rule（audit-events + snapshot-patterns）一并归并 barrel。',
        '示例 fix: import { CONFIG_DEFAULTS } from "../../assembly/index.js"',
        '而非 "../../assembly/config-defaults.js"',
      ].join(' '),
      severity: 'error',
      from: { path: '^src', pathNot: '^src/assembly/' },
      to: { path: '^src/assembly/config-defaults\\.ts$' },
    },
    {
      name: 'no-deep-into-assembly-audit-events',
      comment: [
        'ML#7 + ML#9 — Assembly ASSEMBLY_AUDIT_EVENTS 对外通道仅 barrel。',
        '跨模块消费者（daemon-entry.ts）只能 import src/assembly/index.ts、',
        '不得深穿 src/assembly/audit-events.ts。',
        'phase 1448 立、sister to no-deep-into-assembly-config-defaults。',
        'scope: 本规则仅治 ASSEMBLY_AUDIT_EVENTS。',
        '示例 fix: import { ASSEMBLY_AUDIT_EVENTS } from "./assembly/index.js"',
        '而非 "./assembly/audit-events.js"',
      ].join(' '),
      severity: 'error',
      from: { path: '^src', pathNot: '^src/assembly/' },
      to: { path: '^src/assembly/audit-events\\.ts$' },
    },
    {
      name: 'no-deep-into-assembly-snapshot-patterns',
      comment: [
        'ML#7 + ML#9 — Assembly SNAPSHOT_IGNORE_PATTERNS 对外通道仅 barrel。',
        '跨模块消费者（cli/commands/motion.ts）只能 import src/assembly/index.ts、',
        '不得深穿 src/assembly/snapshot-patterns.ts。',
        'phase 1448 立、sister to no-deep-into-assembly-config-defaults。',
        'scope: 本规则仅治 SNAPSHOT_IGNORE_PATTERNS。',
        '示例 fix: import { SNAPSHOT_IGNORE_PATTERNS } from "../../assembly/index.js"',
        '而非 "../../assembly/snapshot-patterns.js"',
      ].join(' '),
      severity: 'error',
      from: { path: '^src', pathNot: '^src/assembly/' },
      to: { path: '^src/assembly/snapshot-patterns\\.ts$' },
    },
    {
      name: 'no-deep-into-pm-factories-or-agent-factory',
      comment: [
        'ML#7 + ML#9 — process-manager factories.ts + agent-factory.ts 跨模块通道仅 barrel。',
        '跨模块 caller（cli/, daemon/, watchdog/）只能 import',
        'src/foundation/process-manager/index.ts、不得深穿 factories.ts (CLI-scoped)',
        '或 agent-factory.ts (daemon-scoped)。',
        'phase 1416 F1 立 factories.ts、phase 1423 F5 扩 agent-factory.ts。',
        'allowlist (by-design):',
        '  - src/assembly/assemble.ts: 装配根 bootstrap、L6 装配胶水允许 deep import L2 internal',
        '  - src/assembly/core-infrastructure.ts: 装配子工厂、bootstrap 同级 allowlist',
        'scope: 本规则治 factories.ts + agent-factory.ts。sister deep imports（paths.ts /',
        'signal-clean-stop.ts）按 case-by-case 评估、不一律 barrel-only。',
        '示例 fix: import { createAgentProcessManager } from "../../foundation/process-manager/index.js"',
        '而非 "../../foundation/process-manager/agent-factory.js"',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/foundation/process-manager/',
          '^src/assembly/assemble\\.ts$',
          '^src/assembly/core-infrastructure\\.ts$',
        ],
      },
      to: { path: '^src/foundation/process-manager/(factories|agent-factory)\\.ts$' },
    },
    {
      name: 'no-deep-into-llm-orchestrator-defaults-errors',
      comment: [
        'ML#7 + ML#9 — llm-orchestrator defaults/errors 跨模块暴露通道仅 barrel。',
        '跨模块 caller（cli/, daemon/）只能 import',
        'src/foundation/llm-orchestrator/index.ts、不得深穿',
        'src/foundation/llm-orchestrator/{defaults,errors}.ts。',
        'phase 1416 F3 立、treat finding `A.phase1416-llm-orchestrator-barrel-incomplete` ⏳ → ✅。',
        'allowlist (by-design):',
        '  - src/index.ts: SDK 顶层 re-export (公共 SDK 表面边界、直 re-export owner files 是 SDK 模式)',
        '  - src/foundation/config/schemas.ts: sister L2 (config 模块 schema 直消费 llm-orchestrator owner const，',
        '    走 barrel 反而引入不必要的层级)',
        'scope: 本规则治 defaults.ts + errors.ts。sister deep imports（types.ts / orchestrator.ts）',
        '按 case-by-case 评估、types.ts 走 phase 1312 ratify sibling-direct pattern 不强制 barrel。',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/foundation/llm-orchestrator/',
          '^src/index\\.ts$',
          '^src/foundation/config/schemas\\.ts$',
        ],
      },
      to: { path: '^src/foundation/llm-orchestrator/(defaults|errors)\\.ts$' },
    },
    {
      name: 'no-deep-into-utils-format',
      comment: [
        'ML#7 + ML#9 — foundation/utils/format.ts 跨模块通道仅 barrel。',
        '跨模块 caller (cli/, core/, daemon/, watchdog/) 只能 import',
        'src/foundation/utils/index.ts、不得深穿 src/foundation/utils/format.ts。',
        'phase 1423 F2 立、treat finding F2 utils/format ⏳ → ✅。',
        'allowlist (by-design):',
        '  - src/index.ts: SDK 顶层 re-export (公共 SDK 表面边界)',
        '  - src/core/{spawn-system,async-task-system,summon-system/internal/shadow}/_helpers.ts:',
        '    模块内 helper file 直 re-export owner 给同模块用、是合法 re-export pattern',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/foundation/utils/',
          '^src/index\\.ts$',
          '^src/core/spawn-system/_helpers\\.ts$',
          '^src/core/async-task-system/_helpers\\.ts$',
          '^src/core/shadow-system/_helpers\\.ts$',
        ],
      },
      to: { path: '^src/foundation/utils/format\\.ts$' },
    },
    {
      name: 'no-deep-into-messaging-dirs',
      comment: [
        'ML#7 + ML#9 — foundation/messaging/dirs.ts path const 跨模块通道仅 barrel。',
        '跨模块 caller (daemon/, core/) 只能 import',
        'src/foundation/messaging/index.ts、不得深穿 src/foundation/messaging/dirs.ts。',
        'phase 1423 F4 立、treat finding F4 messaging/dirs ⏳ → ✅。',
        'allowlist (by-design):',
        '  - src/foundation/paths.ts: sister L2 在 foundation/ 顶层、',
        '    path 聚合 owner 直消费 messaging dirs 是合理 sister 内部协作',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/foundation/messaging/',
          '^src/foundation/paths\\.ts$',
        ],
      },
      to: { path: '^src/foundation/messaging/dirs\\.ts$' },
    },
    {
      name: 'no-deep-into-dialog-store-dirs',
      comment: [
        'ML#7 + ML#9 — foundation/dialog-store/dirs.ts path const 跨模块通道仅 barrel。',
        '跨模块 caller (cli/) 只能 import',
        'src/foundation/dialog-store/index.ts、不得深穿 src/foundation/dialog-store/dirs.ts。',
        'phase 1432 F6 立、treat finding F6 dialog-store/dirs ⏳ → ✅。',
        'allowlist (by-design):',
        '  - src/assembly/assemble.ts: 装配根 bootstrap、L6 装配胶水允许 deep import L2 internal。',
        '  - src/foundation/audit/reader.ts: dialog-store/store.ts → validate.ts → audit/index.ts → reader.ts',
        '    存在的 audit ← dialog-store 已有依赖链，若 reader 走 dialog-store/index.ts barrel 会形成',
        '    no-circular 违反（reader → dialog-store/index → store → validate → audit）。仅需 DIALOG_DIR',
        '    路径常量、直 import dirs.ts 叶子 const file 避免 import 环，phase 397 立。',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/foundation/dialog-store/',
          '^src/assembly/assemble\\.ts$',
          '^src/foundation/audit/reader\\.ts$',
        ],
      },
      to: { path: '^src/foundation/dialog-store/dirs\\.ts$' },
    },
    {
      name: 'no-deep-into-utils-assert-never',
      comment: [
        'M#7 + M#9 — foundation/utils/assert-never.ts 跨模块通道仅 barrel。',
        '跨模块 caller (foundation sister + cli/, core/, daemon/, watchdog/, assembly/) 只能',
        'import src/foundation/utils/index.ts、不得深穿 src/foundation/utils/assert-never.ts。',
        'phase 200 立、phase 196 + 199 inline 抽共享 utility 收官。',
        'allowlist (by-design):',
        '  - src/index.ts: SDK 顶层 re-export (公共 SDK 表面边界)',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/foundation/utils/',
          '^src/index\\.ts$',
        ],
      },
      to: { path: '^src/foundation/utils/assert-never\\.ts$' },
    },
    {
      name: 'no-deep-into-utils-result',
      comment: [
        'ML#7 + ML#9 — foundation/utils/result.ts 跨模块通道仅 barrel。',
        '跨模块 caller (foundation sister + cli/, core/) 只能 import',
        'src/foundation/utils/index.ts、不得深穿 src/foundation/utils/result.ts。',
        'phase 1432 F7 立、treat finding F7 utils/result ⏳ → ✅。',
        'allowlist (by-design):',
        '  - src/index.ts: SDK 顶层 re-export (公共 SDK 表面边界)',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/foundation/utils/',
          '^src/index\\.ts$',
        ],
      },
      to: { path: '^src/foundation/utils/result\\.ts$' },
    },
    {
      name: 'no-deep-into-messaging-audit-events',
      comment: [
        'ML#7 + ML#9 — foundation/messaging/audit-events.ts const 跨模块通道仅 barrel。',
        '跨模块 caller (cli/, daemon/) 只能 import messaging/index.ts、',
        '不得深穿 audit-events.ts。',
        'phase 1435 F8 立、treat finding F8 messaging/audit-events ⏳ → ✅。',
      ].join(' '),
      severity: 'error',
      from: { path: '^src', pathNot: '^src/foundation/messaging/' },
      to: { path: '^src/foundation/messaging/audit-events\\.ts$' },
    },
    {
      name: 'no-deep-into-skill-paths',
      comment: [
        'ML#7 + ML#9 — foundation/skill-system/skill-paths.ts const 跨模块通道仅 barrel。',
        '跨模块 caller (cli/) 只能 import skill-system/index.ts、',
        '不得深穿 skill-paths.ts。',
        'phase 1435 F9 立、treat finding F9 skill-paths ⏳ → ✅。',
      ].join(' '),
      severity: 'error',
      from: { path: '^src', pathNot: '^src/foundation/skill-system/' },
      to: { path: '^src/foundation/skill-system/skill-paths\\.ts$' },
    },
    {
      name: 'crypto-only-from-foundation',
      comment: [
        'M#3 资源唯一归属：node:crypto 直 import 仅 foundation/uuid + foundation/hash owner module。',
        '其他 src 必经 foundation/uuid (newUuid / newShortUuid / randomHex) 或',
        'foundation/hash (sha256Hex / sha256ShortHex / createSha256Hasher)。',
        'phase 449 立 foundation/uuid owner + sweep 25 randomUUID importer。',
        'phase 452 立 foundation/hash owner + sweep 4 createHash importer。',
        'phase 455 立 lint rule 防 future drift（同型 fs-only-via-foundation-filesystem phase 1298）。',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/foundation/uuid\\.ts$',
          '^src/foundation/hash\\.ts$',
        ],
      },
      to: {
        path: '^(node:)?crypto$',
      },
    },
    {
      name: 'no-daemon-to-watchdog',
      comment: [
        'M#5 模块依赖单向：daemon 模块 (src/daemon/*) 不得 import watchdog 模块 (src/watchdog/*)。',
        '装配责任归 daemon-entry.ts 装配胶水（按 phase 444 Step A 设计、watchdogAliveProbe DI 注入）。',
        'phase 456 立、F1 future drift guard、同型 no-foundation-to-core / no-subagent-to-runtime。',
      ].join(' '),
      severity: 'error',
      from: { path: '^src/daemon/' },
      to: { path: '^src/watchdog/' },
    },
    {
      name: 'no-watchdog-to-daemon',
      comment: [
        'M#5 模块依赖单向：watchdog 模块 (src/watchdog/*) 不得 import daemon 模块 (src/daemon/*)。',
        '装配责任归 watchdog-entry.ts + cli/index.ts 装配胶水（按 phase 444 Step B 设计、DAEMON_LOG DI 注入）。',
        'phase 456 立、F1 future drift guard、同型 no-daemon-to-watchdog。',
      ].join(' '),
      severity: 'error',
      from: { path: '^src/watchdog/' },
      to: { path: '^src/daemon/' },
    },
    {
      name: 'no-deep-into-tool-protocol-permission',
      comment: [
        'M#7 + M#9 — foundation/tool-protocol/permission.ts barrel-only。',
        '10 cross-module caller (core + foundation/tools) 走 tool-protocol/index.ts barrel、',
        '不深穿 permission.ts。phase 457 立、F4 top deep import target (10 caller) 收口。',
        'allowlist: tool-protocol 自家 + src/index.ts SDK 顶层 re-export。',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/foundation/tool-protocol/',
          '^src/index\\.ts$',
        ],
      },
      to: { path: '^src/foundation/tool-protocol/permission\\.ts$' },
    },
    {
      name: 'no-deep-into-tool-use-id',
      comment: [
        'M#7 + M#9 — foundation/tool-protocol/tool-use-id.ts barrel-only。',
        '跨模块 caller 走 tool-protocol/index.ts barrel、不深穿 tool-use-id.ts。',
        'phase 459 立、F4 deep import target (3 caller、foundation sister direct) 收口。',
        'allowlist:',
        '  - tool-protocol 自家',
        '  - src/index.ts SDK 顶层',
        '  - foundation/llm-provider/types.ts: tool-protocol/index.ts import llm-provider/types',
        '    走 barrel 会形成循环、保 sibling-direct（phase 1312 ratify 同型 audit←dialog-store 防环 phase 397）。',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/foundation/tool-protocol/',
          '^src/index\\.ts$',
          '^src/foundation/llm-provider/types\\.ts$',
        ],
      },
      to: { path: '^src/foundation/tool-protocol/tool-use-id\\.ts$' },
    },
    {
      name: 'no-deep-into-identity-step-number',
      comment: [
        'M#7 + M#9 — foundation/identity/step-number.ts barrel-only。',
        '跨模块 caller (foundation/tools + core) 走 identity/index.ts barrel。',
        'phase 460 立、F4 deep import target (5 caller) 收口。',
        'allowlist: identity 自家 + src/index.ts SDK。',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/foundation/identity/',
          '^src/index\\.ts$',
        ],
      },
      to: { path: '^src/foundation/identity/step-number\\.ts$' },
    },
    {
      name: 'no-deep-into-llm-provider-config-schema',
      comment: [
        'M#7 + M#9 — foundation/llm-orchestrator/llm-provider-config-schema.ts barrel-only。',
        '跨模块 caller (cli/, core/) 走 llm-orchestrator/index.ts barrel。',
        'phase 461 立、F4 deep import target (4 cross-module caller) 收口。',
        'allowlist: llm-orchestrator 自家 sister direct + src/index.ts SDK。',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/foundation/llm-orchestrator/',
          '^src/index\\.ts$',
        ],
      },
      to: { path: '^src/foundation/llm-orchestrator/llm-provider-config-schema\\.ts$' },
    },
    {
      name: 'no-deep-into-subagent-constants',
      comment: [
        'M#7 + M#9 — core/subagent/constants.ts barrel-only。',
        '跨模块 caller (cli/, core/) 走 subagent/index.ts barrel。',
        'phase 463 立、F4 deep import target (3 cross-module caller) 收口。',
        'allowlist:',
        '  - subagent 自家 + src/index.ts SDK',
        '  - core/async-task-system/dirs.ts: 走 subagent barrel 会形成 dirs ↔ subagent/run 循环',
        '    保 sibling-direct（同型 phase 397 audit←dialog-store 防环）。',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/core/subagent/',
          '^src/index\\.ts$',
          '^src/core/async-task-system/dirs\\.ts$',
        ],
      },
      to: { path: '^src/core/subagent/constants\\.ts$' },
    },
    {
      name: 'no-deep-into-contract-errors',
      comment: [
        'M#7 + M#9 — core/contract/errors.ts barrel-only。',
        '跨模块 caller (cli/, core/runtime/) 走 contract/index.ts barrel。',
        'phase 465 立、F4 deep import target (3 caller) 收口。',
        'allowlist: contract 自家 + src/index.ts SDK。',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/core/contract/',
          '^src/index\\.ts$',
        ],
      },
      to: { path: '^src/core/contract/errors\\.ts$' },
    },
    {
      name: 'no-deep-into-command-tool-constants',
      comment: [
        'M#7 + M#9 — foundation/command-tool/constants.ts barrel-only。',
        '跨模块 caller (cli/, core/) 走 command-tool/index.ts barrel。',
        'phase 466 立、F4 deep import target (3 caller) 收口。',
        'allowlist: command-tool 自家 + src/index.ts SDK。',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/foundation/command-tool/',
          '^src/index\\.ts$',
        ],
      },
      to: { path: '^src/foundation/command-tool/constants\\.ts$' },
    },
    {
      name: 'no-deep-into-llm-provider-token-estimator',
      comment: [
        'M#7 + M#9 — foundation/llm-provider/token-estimator.ts barrel-only。',
        '跨模块 caller (core/step-executor + core/l4_context_manager) 走 llm-provider/index.ts barrel。',
        'phase 468 立、F4 deep import target (3 caller) 收口。',
        'allowlist: llm-provider 自家 + src/index.ts SDK。',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/foundation/llm-provider/',
          '^src/index\\.ts$',
        ],
      },
      to: { path: '^src/foundation/llm-provider/token-estimator\\.ts$' },
    },
    {
      name: 'no-deep-into-messaging-inbox-writer',
      comment: [
        'M#7 + M#9 — foundation/messaging/inbox-writer.ts barrel-only。',
        '跨模块 caller (core/contract) 走 messaging/index.ts barrel。',
        'phase 469 立、F4 deep import target (2 caller) 收口。',
        'allowlist: messaging 自家 + src/index.ts SDK。',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/foundation/messaging/',
          '^src/index\\.ts$',
        ],
      },
      to: { path: '^src/foundation/messaging/inbox-writer\\.ts$' },
    },
    {
      name: 'no-deep-into-summon-dispatch-skills-paths',
      comment: [
        'M#7 + M#9 — core/summon-system/dispatch-skills-paths.ts barrel-only。',
        'phase 470 立、F4 deep import target (3 caller incl. assembly) 收口。',
        'allowlist:',
        '  - summon-system 自家',
        '  - src/index.ts SDK',
        '  - assembly/business-systems.ts: 装配胶水（phase 1416 同型 allowlist）。',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/core/summon-system/',
          '^src/index\\.ts$',
          '^src/assembly/business-systems\\.ts$',
        ],
      },
      to: { path: '^src/core/summon-system/dispatch-skills-paths\\.ts$' },
    },
    {
      name: 'no-deep-into-async-task-system-constants',
      comment: [
        'M#7 + M#9 — core/async-task-system/constants.ts barrel-only。',
        '跨模块 caller (core/runtime + cli/) 走 async-task-system/index.ts。',
        'phase 471 立、F4 deep import target (2 caller) 收口。',
        'allowlist: async-task-system 自家 + src/index.ts SDK。',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/core/async-task-system/',
          '^src/index\\.ts$',
        ],
      },
      to: { path: '^src/core/async-task-system/constants\\.ts$' },
    },
    {
      name: 'no-deep-into-file-tool-resolve-path',
      comment: [
        'M#7 + M#9 — foundation/file-tool/resolve-path.ts barrel-only。',
        'phase 473 立、F4 deep import target (2 cli caller) 收口。',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/foundation/file-tool/',
          '^src/index\\.ts$',
        ],
      },
      to: { path: '^src/foundation/file-tool/resolve-path\\.ts$' },
    },
    {
      name: 'no-deep-into-process-manager-audit-events',
      comment: [
        'M#7 + M#9 — foundation/process-manager/audit-events.ts barrel-only。',
        'phase 474 立、F4 deep import target (2 caller: cli + watchdog) 收口。',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/foundation/process-manager/',
          '^src/index\\.ts$',
        ],
      },
      to: { path: '^src/foundation/process-manager/audit-events\\.ts$' },
    },
    {
      name: 'no-deep-into-dialog-store-store',
      comment: [
        'M#7 + M#9 — foundation/dialog-store/store.ts barrel-only。',
        '跨模块 caller (cli/) 走 dialog-store/index.ts barrel（migrateAndValidateSession + validateSessionData 已通过 validate.ts -> index.ts 同名 re-export）。',
        'phase 475 立、F4 deep import target (2 cli caller) 收口。',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/foundation/dialog-store/',
          '^src/index\\.ts$',
        ],
      },
      to: { path: '^src/foundation/dialog-store/store\\.ts$' },
    },
    {
      name: 'no-deep-into-utils-frontmatter-frame',
      comment: [
        'M#7 + M#9 — foundation/utils/frontmatter-frame.ts barrel-only。',
        'phase 476 立、F4 deep import target (1 cross-module caller messaging/codec-inbox) 收口。',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/foundation/utils/',
          '^src/index\\.ts$',
        ],
      },
      to: { path: '^src/foundation/utils/frontmatter-frame\\.ts$' },
    },
    {
      name: 'no-deep-into-audit-helpers',
      comment: [
        'M#7 + M#9 — foundation/audit/_helpers.ts barrel-only (private helper)。',
        'clipPreview/clipMessage/clipSummary 走 audit/index.ts barrel。',
        'phase 478 立、F4 deep import target (1 caller subagent/noop-writers) 收口。',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/foundation/audit/',
          '^src/index\\.ts$',
        ],
      },
      to: { path: '^src/foundation/audit/_helpers\\.ts$' },
    },
    {
      name: 'no-deep-into-file-tool-file-state-persist',
      comment: [
        'M#7 + M#9 — foundation/file-tool/file-state-persist.ts barrel-only。',
        'phase 479 立、F4 deep import target (1 caller runtime) 收口。',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/foundation/file-tool/',
          '^src/index\\.ts$',
        ],
      },
      to: { path: '^src/foundation/file-tool/file-state-persist\\.ts$' },
    },
    {
      name: 'no-deep-into-async-task-system-audit-events',
      comment: [
        'M#7 + M#9 — core/async-task-system/audit-events.ts barrel-only。',
        'phase 481 立、F4 deep import target (1 caller runtime) 收口。',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/core/async-task-system/',
          '^src/index\\.ts$',
        ],
      },
      to: { path: '^src/core/async-task-system/audit-events\\.ts$' },
    },
    {
      name: 'no-deep-into-contract-audit-events',
      comment: [
        'M#7 + M#9 — core/contract/audit-events.ts barrel-only。',
        'phase 482 立、F4 deep import target 收口。',
        'allowlist: contract 自家 + src/index.ts SDK + assembly/{id-naming-aggregator, file-routing-aggregator}.ts',
        '(assembly aggregator 装配胶水 by-design 直 import CONTRACT_ID_NAMING / CONTRACT_FILE_ROUTING).',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/core/contract/',
          '^src/index\\.ts$',
          '^src/assembly/id-naming-aggregator\\.ts$',
          '^src/assembly/file-routing-aggregator\\.ts$',
        ],
      },
      to: { path: '^src/core/contract/audit-events\\.ts$' },
    },
    {
      name: 'no-deep-into-dialog-store-audit-events',
      comment: [
        'M#7 + M#9 — foundation/dialog-store/audit-events.ts barrel-only。',
        'phase 483 立、F4 deep import target 收口。',
        'allowlist: dialog-store + src/index.ts SDK + assembly/id-naming-aggregator (DIALOG_ID_NAMING).',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/foundation/dialog-store/',
          '^src/index\\.ts$',
          '^src/assembly/id-naming-aggregator\\.ts$',
        ],
      },
      to: { path: '^src/foundation/dialog-store/audit-events\\.ts$' },
    },
    {
      name: 'no-deep-into-contract-verification-types',
      comment: [
        'M#7 + M#9 — core/contract/verification-types.ts barrel-only。',
        'phase 484 立、F4 deep import target (1 caller memory/claw-contract-bridge) 收口。',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/core/contract/',
          '^src/index\\.ts$',
        ],
      },
      to: { path: '^src/core/contract/verification-types\\.ts$' },
    },
    {
      name: 'no-deep-into-async-task-system-task-schemas',
      comment: [
        'M#7 + M#9 — core/async-task-system/task-schemas.ts barrel-only。',
        'phase 485 立、F4 deep import target (1 caller shadow-system/types) 收口。',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/core/async-task-system/',
          '^src/index\\.ts$',
        ],
      },
      to: { path: '^src/core/async-task-system/task-schemas\\.ts$' },
    },
    {
      name: 'no-deep-into-messaging-notify',
      comment: [
        'M#7 + M#9 — foundation/messaging/notify.ts barrel-only。',
        'phase 486 立、F4 deep import target (1 cli caller) 收口。',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/foundation/messaging/',
          '^src/index\\.ts$',
        ],
      },
      to: { path: '^src/foundation/messaging/notify\\.ts$' },
    },
    {
      name: 'no-deep-into-process-manager-manager',
      comment: [
        'M#7 + M#9 — foundation/process-manager/manager.ts barrel-only。',
        'phase 487 立、F4 deep import target (1 cli caller) 收口。',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/foundation/process-manager/',
          '^src/index\\.ts$',
        ],
      },
      to: { path: '^src/foundation/process-manager/manager\\.ts$' },
    },
    {
      name: 'no-deep-into-runtime-audit-events',
      comment: [
        'M#7 + M#9 — core/runtime/runtime-audit-events.ts barrel-only。',
        'phase 488 立、F4 deep import target 收口。',
        'allowlist: runtime/ + src/index.ts + assembly/id-naming-aggregator (RUNTIME_ID_NAMING 由 aggregator 直 import).',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/core/runtime/',
          '^src/index\\.ts$',
          '^src/assembly/id-naming-aggregator\\.ts$',
        ],
      },
      to: { path: '^src/core/runtime/runtime-audit-events\\.ts$' },
    },
    {
      name: 'no-deep-into-identity-claw-id',
      comment: [
        'M#7 + M#9 — foundation/identity/claw-id.ts barrel-only。',
        '跨模块 caller (cli/, core/, assembly/, src/constants.ts) 走 identity/index.ts barrel。',
        'phase 489 立 + NEW identity/index.ts barrel + 15 caller sweep。',
        'allowlist: identity 自家 + src/index.ts SDK。',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/foundation/identity/',
          '^src/index\\.ts$',
        ],
      },
      to: { path: '^src/foundation/identity/claw-id\\.ts$' },
    },
    {
      name: 'child-process-only-from-foundation-process-exec',
      comment: [
        'M#3 资源唯一归属：child_process 直 import 仅 foundation/process-exec/ owner module。',
        '其他 src 必经 foundation/process-exec API（spawn / exec / spawnSync 等）。',
        'phase 490 立 lint rule、与 fs-only-via-foundation-filesystem (phase 1298) +',
        'crypto-only-from-foundation (phase 455) 同型保护 child_process 资源。',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/foundation/process-exec/',
        ],
      },
      to: {
        path: '^(node:)?child_process$',
      },
    },
    {
      name: 'net-only-from-foundation-transport',
      comment: [
        'M#3 资源唯一归属：node:net 直 import 仅 foundation/transport/ owner module。',
        '其他 src 必经 foundation/transport API (unix-socket / 等)。',
        'phase 491 立、同型 fs/crypto/child_process forbidden rules。',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/foundation/transport/',
        ],
      },
      to: {
        path: '^(node:)?net$',
      },
    },
    {
      name: 'no-unused-node-modules',
      comment: [
        'Defensive forbid for Node modules that should not be needed in chestnut:',
        'http/https (chestnut uses LLM providers via undici, not raw http)',
        'tls/dns (delegated to undici / LLM provider)',
        'stream (chestnut composes higher-level abstractions、避免直 stream)',
        'worker_threads/cluster (单 process daemon 模式、no clustering)',
        'process (process.env etc. 不该走 import、用 global)',
        'phase 511 立、防 future drift introducing these unintended deps.',
      ].join(' '),
      severity: 'error',
      from: { path: '^src' },
      to: { path: '^(node:)?(http|https|tls|dns|stream|worker_threads|cluster|process)$' },
    },
    {
      name: 'no-root-constants-readd',
      comment: [
        'phase 520 删 src/constants.ts、MOTION_CLAW_ID 归位 core/claw-topology/motion-claw-id.ts、ClawId/makeClawId 走 foundation/identity、UUID_SHORT_LEN 内联 foundation/uuid.ts。',
        'ML#3 资源唯一归属：root-level shared constants 桶违反「Domain-specific constants belong in their owner modules」。',
        '本 rule 防 future drift 再加回 src/constants.ts。新常量应归各自语义 owner module。',
      ].join(' '),
      severity: 'error',
      from: { path: '^src' },
      to: { path: '^src/constants(\\.ts)?$' },
    },
    {
      name: 'no-circular',
      comment: [
        'ML#5 模块依赖单向、禁止双向/循环',
        'history: phase 1306 立 → phase 1308 hotfix warn 临时 + cleanup roadmap → phase 1312-1315 mechanical cleanup (foundation barrel + shadow/summon + async-task hub + contract + assembly + watchdog) = 48 → 0 cycle 全消 → phase 1316 终升 severity error 兑现 transition commitment',
        'invariant: 0 cycle 不容回归 / future drift CI fail-loud',
      ].join(' '),
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,  // NEW phase 1301: 追 TS type-only import 进 dep graph / 修 phase 1298 orphan 假阳 3 file (tool-protocol/index + tool-protocol/permission + tools/async-dispatch) / TS 项目 must-have / per `feedback_design_claim_requires_empirical_evidence` Tier 1 N+1 实证
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node'],
    },
    doNotFollow: { path: 'node_modules' },
    exclude: {
      path: '^(tests|scripts|dist|node_modules)',
    },
  },
};
