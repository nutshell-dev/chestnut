#!/usr/bin/env node

// lint:arch 守卫包装器（phase 1894 Step D，coding plan/phase1894/Step D）。
//
// 背景：dependency-cruiser 对 supportedTranspilers 区间外的 typescript 版本
// 会「静默」产出 0 modules 仍 exit 0（meta.cjs 版本区间 → try-import 返回
// false → extract-ts-config 自述 "Silently fails"），架构门禁整体空跑假绿
// （phase 1894 §4.4 实证：depcruise16 + TS6 组合下 0 modules / exit 0）。
// 本守卫把该形态从「静默」变为「显式失败」，正常路径对外输出与旧
// bash + sed 形态逐字一致：
//   1. depcruise 非零退出 → 原样透传 stdout/stderr + 同码退出（现行语义）；
//   2. exit 0 但汇总行不可解析 → exit 1（输出格式漂移，fail loud 即设计意图）；
//   3. exit 0 且 graph nodes ≤ MIN_GRAPH_NODES → exit 1（疑似 transpiler
//      版本错配 / 扫描空跑）。
//
// 阈值取 50 不锁精确值（实然全图 688 nodes，2026-09-21 实测）：失效形态是
// 0（数量级差异），50 在「正常演进绝不误触」与「静默空跑必然抓住」之间取
// 地板；锁精确值会把门禁变成随模块增删的日常维护负担。

import { spawnSync } from 'node:child_process';

const MIN_GRAPH_NODES = 50;

const SUMMARY_PATTERN = /\((\d+) modules, (\d+) dependencies cruised\)/;

const result = spawnSync(
  'depcruise',
  ['--config', '.config/dependency-cruiser.cjs', 'src'],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);

if (result.error) {
  console.error(`lint:arch guard: failed to spawn depcruise: ${result.error.message}`);
  process.exit(1);
}

// 形态 1：depcruise 自身非零退出（真实违规）→ 原样透传 stdout/stderr + 同码退出
if (result.status !== 0) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const summaryMatch = result.stdout ? result.stdout.match(SUMMARY_PATTERN) : null;

// 形态 2：exit 0 但汇总行不可解析 → 显式失败（附原始输出供诊断）
if (!summaryMatch) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  console.error(
    'lint:arch guard: depcruise 输出格式未识别（汇总行 "(N modules, M dependencies cruised)" 缺失）。\n' +
      '可能原因：dependency-cruiser 升级改了输出措辞 → 按实然调整本脚本（scripts/lint-arch.mjs）的正则。',
  );
  process.exit(1);
}

const graphNodes = Number(summaryMatch[1]);

// 形态 3：graph nodes ≤ 下限 → 疑似 transpiler 版本错配、架构门禁空跑 → 显式失败
if (graphNodes <= MIN_GRAPH_NODES) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  console.error(
    `lint:arch guard: depcruise 仅 cruising 到 ${graphNodes} 个 graph nodes（下限 ${MIN_GRAPH_NODES}），` +
      '疑似 transpiler 版本错配导致架构门禁空跑。\n' +
      'depcruise 的 supportedTranspilers.typescript 区间与实装 typescript 版本不匹配时会静默产出 0 modules 仍 exit 0。\n' +
      '处置：核 dependency-cruiser × typescript 版本耦合登记（design/practices.md，phase 1894）。',
  );
  process.exit(1);
}

// 正常路径：与旧 bash + sed 形态同一对外输出措辞（" modules," → " graph nodes,"）
if (result.stdout) {
  process.stdout.write(result.stdout.replaceAll(' modules,', ' graph nodes,'));
}
if (result.stderr) process.stderr.write(result.stderr);
