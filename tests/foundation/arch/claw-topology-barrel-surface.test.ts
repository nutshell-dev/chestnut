/**
 * phase 1864 Step K（CT-D14）架构锁：ClawTopology barrel 公开面白名单。
 *
 * 收口语义（design/modules/l4_claw_topology.md §4「对外契约」）：
 * barrel 只暴露拓扑查询、owner 工厂、跨目标/notify adapter 与工具构造、
 * 以及汇总业务的必要入口；机制 helper（安装路径群 / notify 路由 / brand 构造 /
 * 内部 capability 名）不经 barrel 回流。
 *
 * 双向锁：
 * - 源码导出名单 == 白名单（禁 wildcard `export *`、禁 `as` 别名回流）
 * - 运行时导出键 == 值白名单（类型导出不产生运行时键）
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = process.cwd();
const barrelRel = 'src/core/claw-topology/index.ts';
const barrel = fs.readFileSync(path.join(root, barrelRel), 'utf8');

/** 白名单：值导出（运行时键）。 */
const VALUE_EXPORTS = [
  'createClawTopology',
  'MOTION_CLAW_ID',
  'makeClawNotifyTargetResolver',
  'resolveClawDaemonDir',
  'createNotifyClawTool',
  'createCrossClawReadTool',
  'createCrossClawLsTool',
  'createCrossClawSearchTool',
  'decodeOutboxSummaryGuidance',
  'createOutboxSummaryJob',
] as const;

/** 白名单：类型导出（仅编译期）。 */
const TYPE_EXPORTS = [
  'ClawTopology',
  'ClawEnumerationSnapshot',
  'CrossTargetAccess',
  'OutboxSummaryGuidanceState',
] as const;

/** 收口后不得回流的机制面（含 phase 1864 已迁出/已删除名）。 */
const FORBIDDEN = [
  'routeNotifyClaw',
  'routeNotifyClawAsync',
  'getClawDir',
  'getRelativeClawDir',
  'getClawConfigPath',
  'CONFIG_YAML_FILE',
  'getChestnutRoot',
  'getWorkspaceRoot',
  'makeChestnutRoot',
  'getNamedSubrootDir',
  'resolveChestnutRoot',
  'CLAWS_DIR',
  'enumerateClaws',
  'BroadcastGrant',
] as const;

/** 抽取 barrel 中 `export { ... }` / `export type { ... }` 的导出名。 */
function collectExportedNames(source: string): { values: string[]; types: string[] } {
  const values: string[] = [];
  const types: string[] = [];
  const re = /export\s+(type\s+)?\{([\s\S]*?)\}\s+from\s+'[^']+';/g;
  for (const m of source.matchAll(re)) {
    const isType = Boolean(m[1]);
    for (const raw of m[2].split(',')) {
      const spec = raw.trim();
      if (!spec) continue;
      const inlineType = /^type\s+/.test(spec);
      const name = spec.replace(/^type\s+/, '').split(/\s+as\s+/).pop()!.trim();
      if (isType || inlineType) types.push(name);
      else values.push(name);
    }
  }
  return { values: values.sort(), types: types.sort() };
}

describe('phase 1864 Step K (CT-D14): claw-topology barrel surface', () => {
  it('源码导出名单 == 白名单（值 + 类型）', () => {
    const { values, types } = collectExportedNames(barrel);
    expect(values).toEqual([...VALUE_EXPORTS].sort());
    expect(types).toEqual([...TYPE_EXPORTS].sort());
  });

  it('运行时导出键 == 值白名单（无 wildcard / 别名回流）', async () => {
    const mod = await import('../../../src/core/claw-topology/index.js');
    expect(Object.keys(mod).sort()).toEqual([...VALUE_EXPORTS].sort());
  });

  it('收口后机制面不经 barrel 回流（含别名形态）', () => {
    for (const symbol of FORBIDDEN) {
      expect(barrel).not.toMatch(new RegExp(`\\b${symbol}\\b`));
      expect(barrel).not.toMatch(new RegExp(`\\bas\\s+${symbol}\\b`));
    }
    expect(barrel).not.toMatch(/export\s+\*/);
  });
});
