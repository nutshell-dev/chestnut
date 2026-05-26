/**
 * dependency-cruiser config — phase 1298 立
 * ML#3 + ML#7 fs invariant enforce at lint phase
 * cross-ref: phase 1283 + 1291 + 1295 fs cluster
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
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
        'orphan file (无人 import) = 死代码累债 / phase 1301 立',
        'severity warn 持续 future drift 监测 (当前 phase 1301 删 constants.ts 后真 orphan 0)',
        '未来 NEW file 必有 import 才能 land、否则 warn signal',
        'allowlist: SDK entry / config file / .d.ts (已 by tsPreCompilationDeps 修)',
        '升档锚: 真 orphan 持续 0 → 升 severity error (phase 1304+)',
      ].join(' '),
      severity: 'warn',
      from: {
        orphan: true,
        pathNot: [
          '\\.d\\.ts$',
          '^src/index\\.ts$',
          '\\.dependency-cruiser\\.cjs$',
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
