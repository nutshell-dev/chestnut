/**
 * dependency-cruiser config — production architecture invariants
 *
 * ============================================================
 * Policy: lint 范围治理（phase 696 精简；phase 1346/1348 恢复并泛化 barrel 边界）
 * ============================================================
 *
 * **本 config 守三类规则**：
 *
 * (a) **资源唯一归属**（M#3）：fs / crypto / child_process / net 等 Node 资源
 *     必经具体 owner 模块、按文件名 allowlist 锁定。这类 rule 不依赖应然层
 *     假设、只锁具体 owner 文件、应然漂移不触发。
 *
 * (b) **tool-detected 结构属性**：no-circular（M#5 真禁 cycle、tool 算法检测
 *     不依赖物理路径）、no-orphans（warn、死代码警告）、no-root-constants-readd
 *     （phase 520 治理回退守）、no-unused-node-modules（防误 import）。
 *
 * (c) **模块耦合表面**（M#7/M#8/M#9）：全部生产模块的跨模块 import 必经 owner
 *     `index.ts` barrel。phase 696 曾撤旧的逐层手写规则；phase 1291 重立程序化规则，
 *     phase 1346 扩至全部 `src/**` caller，phase 1348 改为从整个源码树发现模块根。
 *
 * **phase 696 撤的 rule 族**：
 *
 * - 7 物理路径层 rule：no-foundation-to-core / no-core-to-assembly /
 *   no-subagent-to-runtime / no-daemon-to-watchdog / no-watchdog-to-daemon /
 *   no-audit-to-dialog-store / no-assembly-to-cli-shared-formatter
 * - 39 barrel-only rule：no-deep-into-* 整族（phase 1291 起以程序化形态重立）
 *
 * **治理判例链**：
 * - phase 682：撤「audit→dialog-store 防 cycle」allowlist + 立反向 forbid rule
 * - phase 691：撤 3 处「防 cycle 类」allowlist + 立 phase 691 Step D policy 头
 * - phase 695：Cron @module L5→L2a 应然重分类（design-only、物理 path 未迁）
 * - phase 696：拆物理路径层 rule + 当时的 barrel-only 一族
 * - phase 1291/1346：程序化重立 barrel boundary，并扩全部 production caller
 * - phase 1348：owner 发现从按层/手写名单扩为整个 production source tree
 *
 * 物理路径只用于表达已经由 architecture 确立的模块根；模块边界变化须先按 M#11
 * 讨论并同步目录，而不是为 lint 加 allowlist。
 * ============================================================
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * 全 production source tree 的 barrel 边界程序化生成（phase 1291 / 1346 / 1348）。
 * 模块物理形态只有两种：core/foundation grouping 下的直接子目录模块，及拥有
 * 自身 index.ts 的 src 顶层模块。只发现模块根，不把模块内部 nested index 误判
 * 为独立模块。跨模块 import 必经 owner index.ts（M#7/M#8/M#9）。
 */
function childDirectoriesWithIndex(parentDir) {
  return fs
    .readdirSync(parentDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(parentDir, name, 'index.ts')));
}

function discoverProductionModuleRoots() {
  const srcDir = path.join(__dirname, '..', 'src');
  const grouped = ['core', 'foundation'].flatMap((group) =>
    childDirectoriesWithIndex(path.join(srcDir, group)).map((name) => `${group}/${name}`),
  );
  const topLevel = childDirectoriesWithIndex(srcDir)
    .filter((name) => name !== 'core' && name !== 'foundation');
  return [...grouped, ...topLevel].sort();
}

function barrelBoundaryRules() {
  return discoverProductionModuleRoots().map((moduleRoot) => {
    // rule name 需 kebab-case（phase 649 invariant test）：路径分隔符和 `_`
    // （如 core/context_manager）均转 `-`，path 仍保留真实 module root。
    const ruleSuffix = moduleRoot.replace(/[\/_]/g, '-');
    return {
      name: `no-deep-into-module-${ruleSuffix}`,
      comment: [
        'M#8 耦合界面最小 / M#7 耦合界面稳定：跨模块 import 必经',
        `${moduleRoot}/index.ts barrel，不得深路径直达内部文件。`,
        'owner internal 相对边排除；phase 1348 全 production module root 自动纳管。',
      ].join(' '),
      severity: 'error',
      from: { path: '^src/', pathNot: [`^src/${moduleRoot}/`] },
      to: { path: `^src/${moduleRoot}/(?!index\\.ts$).+` },
    };
  });
}

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // phase 696 Step A 撤 3 layer rule (no-core-to-assembly / no-foundation-to-core /
    // no-subagent-to-runtime)、由 code review 守应然层方向、no-circular 守 cycle。
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
      name: 'crypto-only-from-foundation',
      comment: [
        'M#3 资源唯一归属：node:crypto 直 import 仅 L1.NodeUtils owner module。',
        '其他 src 必经 foundation/node-utils (newUuid / newShortUuid / randomHex / sha256Hex / sha256ShortHex / createSha256Hasher)。',
        'phase 449 立 foundation/uuid owner + sweep 25 randomUUID importer。',
        'phase 452 立 foundation/hash owner + sweep 4 createHash importer。',
        'phase 455 立 lint rule 防 future drift（同型 fs-only-via-foundation-filesystem phase 1298）。',
      ].join(' '),
      severity: 'error',
      from: {
        path: '^src',
        pathNot: [
          '^src/foundation/node-utils/crypto\\.ts$',
          '^src/foundation/node-utils/id\\.ts$',
        ],
      },
      to: {
        path: '^(node:)?crypto$',
      },
    },
    // phase 696 Step A 撤 2 layer rule (no-daemon-to-watchdog / no-watchdog-to-daemon)
    // 由 code review 守、no-circular 守 cycle 类违反。
    // phase 691 Step A: rule `no-deep-into-tool-use-id` 撤
    // 理由：tool-use-id.ts 物理 file 已迁到 llm-provider/、target path 不存在、rule 失目标。
    // 原 allowlist 是「llm-provider/types 走 barrel 形成循环」类防 cycle 豁免、
    // 真治 = M#11 重构（迁 ToolUseId 归 L1 canonical owner）、不再需要 allowlist。
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
        'phase 682: 修配置 bug — 原 L944-L962 把本 rule 与 no-assembly-to-cli-shared-formatter 错揉同 object literal、',
        '后者同名字段覆盖前者所有 from/to/severity、致本 rule 完全失效。phase 682 拆成 2 独立 object 恢复。',
      ].join(' '),
      severity: 'error',
      from: { path: '^src' },
      to: { path: '^src/constants(\\.ts)?$' },
    },
    {
      name: 'no-foundation-to-outside',
      comment: [
        'M#5 单向依赖：foundation 层不依赖任何上层模块。',
        'foundation 内部子层依赖方向由 code review 守（M#5 应然方向、不靠物理路径 lint）。',
        'phase 725 立：718-725 六 phase 治理后 foundation→outside 已 0 违反、lint 守 invariant 防回退。',
        'phase 1828 用户拍板：src/templates/** 是层中性纯静态文案/提示资源（无业务、无 IO、无运行时配置），',
        'foundation 可依赖它；据此加 pathNot 而非 allowlist 单文件。其余 outside 仍禁。',
      ].join(' '),
      severity: 'error',
      from: { path: '^src/foundation/' },
      to: { path: '^src/(?!foundation/)', pathNot: '^src/templates/' },
    },
    {
      name: 'no-cli-protocol-to-outside',
      comment: [
        'M#5 单向依赖：CLIProtocol 是 L6 叶子协议模块（phase 1252 应然冻结）、零实现依赖。',
        'phase 1253 Step D 立：claw command catalog / invocation / help renderer 归 CLIProtocol 后，',
        'lint 守「CLIProtocol 只能依赖自身」、防反向 import CLIProcess / Assembly 实现模块。',
        '同型 precedent：no-foundation-to-outside（phase 725）。',
        'phase 1877 Step B 例外：design l6_cli_protocol §2.1 ratify「message priority 合法集合',
        '与顺序归 Messaging、CLIProtocol 消费其稳定声明」——据此放行 messaging barrel 单文件',
        '（与 router 同一导入面）；其余 outside 仍禁。',
      ].join(' '),
      severity: 'error',
      from: { path: '^src/cli-protocol/' },
      to: {
        path: '^src/(?!cli-protocol/)',
        pathNot: '^src/foundation/messaging/index\\.ts$',
      },
    },
    {
      name: 'no-outside-to-cli-process',
      comment: [
        'phase 1346：CLIProcess 是有副作用进程根，所有 production owner 对 src/cli/** 零入边。',
        '可复用 CLI 语义唯一归 CLIProtocol；CLI owner internal 边排除。',
      ].join(' '),
      severity: 'error',
      from: { path: '^src/', pathNot: ['^src/cli/'] },
      to: { path: '^src/cli/' },
    },
    // phase 696 Step A 撤 2 layer rule (no-assembly-to-cli-shared-formatter / no-audit-to-dialog-store)
    // 由 code review 守、no-circular 守 cycle 类违反。
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
    ...barrelBoundaryRules(),
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
