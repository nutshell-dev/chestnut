/**
 * dependency-cruiser config — phase 1298 立
 * ML#3 + ML#7 fs invariant enforce at lint phase
 * cross-ref: phase 1283 + 1291 + 1295 fs cluster
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
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
      name: 'fs-only-via-foundation-filesystem',
      comment: [
        'ML#3 资源唯一归属：file I/O 必经 L1 FileSystem 接口。',
        'allowlist 3 design intent file:',
        '  - foundation/fs/* impl 自身 (唯一 owner)',
        '  - foundation/audit/writer.ts: phase 1214 ratify dumpFallback boundary 防 audit-of-audit 递归',
        '  - foundation/process-exec/spawn-detached.ts: fd-level openSync(/dev/null) 非 path-level',
        '其他 src 必经 fsFactory inject (phase 1283 α-1)',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/foundation/fs/',
          '^src/foundation/audit/writer\\.ts$',
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
        'ML#7 耦合界面稳定：NodeFileSystem 直构造仅 4 bootstrap site:',
        '  - assembly/assemble.ts',
        '  - cli/index.ts',
        '  - daemon-entry.ts',
        '  - watchdog-entry.ts',
        '  - foundation/fs/* impl 自身',
        '其他必经 fsFactory inject (phase 1283 α-1 + phase 1291 α-2 deps object pattern)',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/assembly/assemble\\.ts$',
          '^src/cli/index\\.ts$',
          '^src/daemon-entry\\.ts$',
          '^src/watchdog-entry\\.ts$',
          '^src/foundation/fs/',
        ],
      },
      to: {
        path: '^src/foundation/fs/node-fs(\\.ts)?$',
      },
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
        '  - src/core/{spawn-system,async-task-system,shadow-system}/_helpers.ts:',
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
        '  - src/assembly/assemble.ts: 装配根 bootstrap、L6 装配胶水允许 deep import L2 internal',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/foundation/dialog-store/',
          '^src/assembly/assemble\\.ts$',
        ],
      },
      to: { path: '^src/foundation/dialog-store/dirs\\.ts$' },
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
