/**
 * Phase 1263 Step C + Phase 1264 Step A: CLI guidance typed boundary ratchet.
 *
 * 锁定 `claw_crashed`（首个）与 `claw_inactivity`（第二个）typed binding 纵向切片的边界
 * （总览反向验收 2/3/4）：
 *  - CLIProtocol（src/cli-protocol/**）零实现依赖：不 import Runtime / Assembly /
 *    Watchdog / ContractSystem / CLI 等任何 implementation module；
 *  - Assembly typed binding 纯 typed：含 defineCliGuidanceBinding + owner decoder +
 *    exhaustive never；不含自由 text、CLI literal、presentation prose、renderer 调用，
 *    也不读取不参与 affordance 的 owner state 字段；
 *  - composers aggregate 不再 direct register 两个已迁 type，必须经同一次
 *    registerCliGuidance(registry, [...]) 聚合调用；
 *  - 旧 composer 文件物理删除，无 shim / compat re-export。
 *
 * scanner 沿用 Phase 1262 Step D 教训：识别 mixed / type-only import 形态，
 * 配正反 fixture 自证（不过宽匹配、不漏检）。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const srcRoot = path.join(__dirname, '..', '..', '..', 'src');

const CLI_PROTOCOL_DIR = path.join(srcRoot, 'cli-protocol');
const COMPOSERS_INDEX = path.join(srcRoot, 'assembly', 'guidance', 'composers', 'index.ts');

/**
 * 已迁 typed binding 的 test-local 边界配置（逐 case 明确、不用过宽 regex）。
 * prose：该 binding 旧 composer 曾产的 presentation 前缀字面（迁后必消失）；
 * forbiddenFields：不参与 CLI affordance 的 owner state 字段（binding 不得跨边界消费）。
 */
const BINDINGS = [
  {
    file: 'claw-crashed.ts',
    type: 'claw_crashed',
    ident: 'clawCrashedGuidanceBinding',
    decoder: 'decodeClawCrashedGuidance',
    exhaustive: 'crashClass',
    ownerCodec: '../../../watchdog/claw-crashed-guidance.js',
    prose: 'To restart',
    forbiddenFields: [] as readonly string[],
  },
  {
    file: 'claw-inactivity.ts',
    type: 'claw_inactivity',
    ident: 'clawInactivityGuidanceBinding',
    decoder: 'decodeClawInactivityGuidance',
    exhaustive: 'failureClass',
    ownerCodec: '../../../watchdog/claw-inactivity-guidance.js',
    prose: 'To inspect',
    forbiddenFields: ['inactiveMs', 'sourcePath', 'lastError'] as readonly string[],
  },
] as const;

/** import/export ... from 语句的 module specifier（含 mixed 与 type-only 形态）。 */
const IMPORT_SPECIFIER_RE = /(?:import|export)\s+(?:type\s+)?(?:[\w*{][^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;

/** typed binding 禁含：自由 entry 字段 / CLI literal / presentation prose / renderer 调用 / 无关 owner state 字段。 */
function bindingForbiddenRe(binding: (typeof BINDINGS)[number]): RegExp {
  const parts = [
    'text:',
    'chestnut',
    binding.prose,
    'renderClawInvocation',
    'renderCliGuidance',
    'CONTRACT_COMMANDS',
    ...binding.forbiddenFields,
  ];
  return new RegExp(parts.join('|'));
}

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('phase 1263 Step C + phase 1264 Step A: cli guidance typed boundary', () => {
  it('CLIProtocol 零实现依赖：所有 import 解析后仍在 src/cli-protocol 内', () => {
    const violations: string[] = [];
    for (const file of walkTsFiles(CLI_PROTOCOL_DIR)) {
      const content = fs.readFileSync(file, 'utf8');
      for (const m of content.matchAll(IMPORT_SPECIFIER_RE)) {
        const specifier = m[1];
        if (!specifier.startsWith('.')) {
          violations.push(`${path.relative(srcRoot, file)}: external specifier '${specifier}'`);
          continue;
        }
        const resolved = path.resolve(path.dirname(file), specifier);
        if (!resolved.startsWith(CLI_PROTOCOL_DIR + path.sep) && resolved !== CLI_PROTOCOL_DIR) {
          violations.push(`${path.relative(srcRoot, file)}: escapes cli-protocol via '${specifier}'`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  for (const binding of BINDINGS) {
    const bindingPath = path.join(srcRoot, 'assembly', 'guidance', 'bindings', binding.file);

    it(`${binding.type} binding 经 binding factory + owner decoder + exhaustive never`, () => {
      const text = fs.readFileSync(bindingPath, 'utf8');
      expect(text).toContain('defineCliGuidanceBinding');
      expect(text).toContain(binding.decoder);
      expect(text).toMatch(new RegExp(`never\\s*=\\s*state\\.${binding.exhaustive}`));
      expect(text).toMatch(new RegExp(`type:\\s*'${binding.type}'`));
    });

    it(`${binding.type} binding 纯 typed：无自由 text / CLI literal / prose / renderer 调用 / 无关 owner state`, () => {
      const text = fs.readFileSync(bindingPath, 'utf8');
      expect(text).not.toMatch(bindingForbiddenRe(binding));
    });

    it(`${binding.type} binding 只从两侧稳定 protocol import（CLIProtocol barrel + 对应 Watchdog owner codec）`, () => {
      const text = fs.readFileSync(bindingPath, 'utf8');
      const specifiers = [...text.matchAll(IMPORT_SPECIFIER_RE)].map(m => m[1]).sort();
      expect(specifiers).toEqual([
        '../../../cli-protocol/index.js',
        binding.ownerCodec,
      ].sort());
    });

    it(`旧 ${binding.type} composer 文件物理删除、assembly 内无 shim / compat re-export`, () => {
      const oldComposer = path.join(srcRoot, 'assembly', 'guidance', 'composers', binding.file);
      expect(fs.existsSync(oldComposer)).toBe(false);
      const assemblyDir = path.join(srcRoot, 'assembly');
      const basename = binding.file.replace(/\.ts$/, '');
      const leftovers: string[] = [];
      for (const file of walkTsFiles(assemblyDir)) {
        const content = fs.readFileSync(file, 'utf8');
        for (const m of content.matchAll(IMPORT_SPECIFIER_RE)) {
          if (new RegExp(`composers/${basename}|^\\./${basename}`).test(m[1])) {
            leftovers.push(`${path.relative(srcRoot, file)}: '${m[1]}'`);
          }
        }
      }
      expect(leftovers).toEqual([]);
    });
  }

  it('composers aggregate 不再 direct register 两个 typed type，必经同一次 CLIProtocol helper 聚合调用', () => {
    const text = fs.readFileSync(COMPOSERS_INDEX, 'utf8');
    for (const binding of BINDINGS) {
      expect(text).not.toMatch(new RegExp(`\\.register\\(\\s*['"]${binding.type}['"]`));
    }
    // 两个 typed binding 在同一次 registerCliGuidance(registry, [...]) 调用中（contribution 聚合，
    // duplicate preflight 覆盖全部 CLI binding）；bindings 之间不分散成多次 helper 调用。
    const calls = [...text.matchAll(/registerCliGuidance\(\s*registry\s*,\s*\[([^\]]*)\]/g)];
    expect(calls).toHaveLength(1);
    const idents = calls[0][1].split(',').map(s => s.trim()).filter(Boolean);
    expect(idents).toEqual(BINDINGS.map(b => b.ident));
  });

  it('反向 fixture：scanner 能检出违反形态、不误放合法形态', () => {
    // import specifier scanner：识别 default / named / namespace / type-only / mixed / bare side-effect
    const samples = [
      "import x from '../core/runtime/index.js';",
      "import { a } from '../../watchdog/x.js';",
      "import * as ns from '../assembly/y.js';",
      "import type { T } from '../core/contract/index.js';",
      "import { type T, v } from '../core/mixed.js';",
      "export type { U } from '../../watchdog/z.js';",
      "import '../cli/side-effect.js';",
    ];
    for (const s of samples) {
      const m = [...s.matchAll(IMPORT_SPECIFIER_RE)];
      expect(m, s).toHaveLength(1);
      expect(m[0][1].startsWith('.')).toBe(true);
    }
    // 合法同模块引用不判逃逸
    const inner = "import { renderClawInvocation } from './invocation.js';";
    const innerSpec = [...inner.matchAll(IMPORT_SPECIFIER_RE)][0][1];
    expect(path.resolve(CLI_PROTOCOL_DIR, innerSpec).startsWith(CLI_PROTOCOL_DIR + path.sep)).toBe(true);

    // binding forbidden scanner：四种违反形态 + 无关 owner state 字段均检出
    const inactivityRe = bindingForbiddenRe(BINDINGS[1]);
    expect(bindingForbiddenRe(BINDINGS[0]).test("return { text: 'x' };")).toBe(true);
    expect(bindingForbiddenRe(BINDINGS[0]).test('`chestnut claw ${id} daemon`')).toBe(true);
    expect(bindingForbiddenRe(BINDINGS[0]).test("'To restart: ' + cmd")).toBe(true);
    expect(inactivityRe.test("'To inspect: ' + cmd")).toBe(true);
    expect(bindingForbiddenRe(BINDINGS[0]).test('renderCliGuidanceDocument(doc)')).toBe(true);
    expect(bindingForbiddenRe(BINDINGS[0]).test('renderClawInvocation(id, cmd)')).toBe(true);
    expect(inactivityRe.test('state.inactiveMs > 0')).toBe(true);
    expect(inactivityRe.test('state.sourcePath')).toBe(true);
    expect(inactivityRe.test('state.lastError')).toBe(true);
    // 合法 typed binding 形态不误报（含 typed action value '5m'、label/discriminant 字面）
    expect(bindingForbiddenRe(BINDINGS[0]).test("defineCliGuidanceBinding({ type: 'claw_crashed', decode, toDocument })")).toBe(false);
    expect(bindingForbiddenRe(BINDINGS[0]).test("return { lines: [{ label: 'restart', action }] };")).toBe(false);
    expect(inactivityRe.test("return { lines: [{ label: 'watch-after-intervention', action: { kind: 'claw.watch', target, inactiveAfter: '5m' } }] };")).toBe(false);

    // direct registration scanner
    for (const binding of BINDINGS) {
      const re = new RegExp(`\\.register\\(\\s*['"]${binding.type}['"]`);
      expect(re.test(`registry.register('${binding.type}', composer)`)).toBe(true);
      expect(re.test(`registerCliGuidance(registry, [${binding.ident}])`)).toBe(false);
    }
  });
});
