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
