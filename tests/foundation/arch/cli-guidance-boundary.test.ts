/**
 * Phase 1263 Step C: CLI guidance typed boundary ratchet.
 *
 * 锁定 `claw_crashed` 首个 typed binding 纵向切片的边界（总览反向验收 2/3/4）：
 *  - CLIProtocol（src/cli-protocol/**）零实现依赖：不 import Runtime / Assembly /
 *    Watchdog / ContractSystem / CLI 等任何 implementation module；
 *  - Assembly crash binding 纯 typed：含 defineCliGuidanceBinding + owner decoder +
 *    exhaustive never；不含自由 text、CLI literal、presentation prose、renderer 调用；
 *  - composers aggregate 不再 direct register `claw_crashed`，必须经
 *    registerCliGuidance(registry, [...])；
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
const BINDING = path.join(srcRoot, 'assembly', 'guidance', 'bindings', 'claw-crashed.ts');
const COMPOSERS_INDEX = path.join(srcRoot, 'assembly', 'guidance', 'composers', 'index.ts');
const OLD_COMPOSER = path.join(srcRoot, 'assembly', 'guidance', 'composers', 'claw-crashed.ts');

/** import/export ... from 语句的 module specifier（含 mixed 与 type-only 形态）。 */
const IMPORT_SPECIFIER_RE = /(?:import|export)\s+(?:type\s+)?(?:[\w*{][^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;

/** crash binding 禁含：自由 entry 字段 / CLI literal / presentation prose / renderer 调用。 */
const BINDING_FORBIDDEN_RE = /text:|chestnut|To restart|renderClawInvocation|renderCliGuidance|CONTRACT_COMMANDS/;

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('phase 1263 Step C: cli guidance typed boundary', () => {
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

  it('crash binding 经 binding factory + owner decoder + exhaustive never', () => {
    const text = fs.readFileSync(BINDING, 'utf8');
    expect(text).toContain('defineCliGuidanceBinding');
    expect(text).toContain('decodeClawCrashedGuidance');
    expect(text).toMatch(/never\s*=\s*state\.crashClass/);
    expect(text).toMatch(/type:\s*'claw_crashed'/);
  });

  it('crash binding 纯 typed：无自由 text / CLI literal / prose / renderer 调用', () => {
    const text = fs.readFileSync(BINDING, 'utf8');
    expect(text).not.toMatch(BINDING_FORBIDDEN_RE);
  });

  it('crash binding 只从两侧稳定 protocol import（CLIProtocol barrel + Watchdog owner codec）', () => {
    const text = fs.readFileSync(BINDING, 'utf8');
    const specifiers = [...text.matchAll(IMPORT_SPECIFIER_RE)].map(m => m[1]).sort();
    expect(specifiers).toEqual([
      '../../../cli-protocol/index.js',
      '../../../watchdog/claw-crashed-guidance.js',
    ]);
  });

  it('composers aggregate 不再 direct register claw_crashed，必经 CLIProtocol helper', () => {
    const text = fs.readFileSync(COMPOSERS_INDEX, 'utf8');
    expect(text).not.toMatch(/\.register\(\s*['"]claw_crashed['"]/);
    expect(text).toMatch(/registerCliGuidance\(\s*registry\s*,\s*\[[^\]]*clawCrashedGuidanceBinding[^\]]*\]/);
  });

  it('旧 composer 文件物理删除、assembly 内无 shim / compat re-export', () => {
    expect(fs.existsSync(OLD_COMPOSER)).toBe(false);
    const assemblyDir = path.join(srcRoot, 'assembly');
    const leftovers: string[] = [];
    for (const file of walkTsFiles(assemblyDir)) {
      const content = fs.readFileSync(file, 'utf8');
      for (const m of content.matchAll(IMPORT_SPECIFIER_RE)) {
        if (/composers\/claw-crashed|^\.\/claw-crashed/.test(m[1])) {
          leftovers.push(`${path.relative(srcRoot, file)}: '${m[1]}'`);
        }
      }
    }
    expect(leftovers).toEqual([]);
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

    // binding forbidden scanner：四种违反形态均检出
    expect(BINDING_FORBIDDEN_RE.test("return { text: 'x' };")).toBe(true);
    expect(BINDING_FORBIDDEN_RE.test('`chestnut claw ${id} daemon`')).toBe(true);
    expect(BINDING_FORBIDDEN_RE.test("'To restart: ' + cmd")).toBe(true);
    expect(BINDING_FORBIDDEN_RE.test('renderCliGuidanceDocument(doc)')).toBe(true);
    expect(BINDING_FORBIDDEN_RE.test('renderClawInvocation(id, cmd)')).toBe(true);
    // 合法 typed binding 形态不误报
    expect(BINDING_FORBIDDEN_RE.test("defineCliGuidanceBinding({ type: 'claw_crashed', decode, toDocument })")).toBe(false);
    expect(BINDING_FORBIDDEN_RE.test("return { lines: [{ label: 'restart', action }] };")).toBe(false);

    // direct registration scanner
    expect(/\.register\(\s*['"]claw_crashed['"]/.test("registry.register('claw_crashed', composer)")).toBe(true);
    expect(/\.register\(\s*['"]claw_crashed['"]/.test('registerCliGuidance(registry, [clawCrashedGuidanceBinding])')).toBe(false);
  });
});
