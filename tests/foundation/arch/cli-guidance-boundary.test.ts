/**
 * Phase 1263 Step C + Phase 1264 Step A/B + Phase 1265/1266/1267 Step A: CLI guidance typed boundary ratchet.
 *
 * 锁定已迁 5/5 typed binding 纵向切片（claw_crashed / claw_inactivity / claw_outbox_summary / contract_events / contract_cancelled）的边界（总览反向验收 2/3/4）：
 *  - Assembly typed binding 纯 typed：factory + owner decoder；exhaustive never 仅业务 union
 *    case（optional，无 union 不伪造）；无自由 text/CLI literal/prose/renderer/无关 owner state；
 *  - composers aggregate 不 direct register 已迁 type，全部 binding 同一次 helper 注册；
 *  - 旧 composer 文件物理删除，无 shim / compat re-export。
 * scanner 沿用 Phase 1262 Step D 教训：识别 mixed / type-only import 形态，配正反
 * fixture 自证。case 数据在 cli-guidance-boundary-cases.ts（phase 1266 Step A）、scanner 原语
 * 在 cli-guidance-boundary-helpers.ts（phase 1264 Step B），全部验收决策显式留在本文件。
 * phase 1283 Step C：CLIProtocol 模块级依赖边界（零实现依赖 + zod bare allowlist）
 * 拆至 cli-protocol-dependency-boundary.test.ts，本文件只守 guidance typed binding。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import {
  CLI_GUIDANCE_BINDINGS,
  COMPOSERS_INDEX,
  IMPORT_SPECIFIER_RE,
  bindingForbiddenRe,
  bindingPath,
  oldComposerPath,
  oldComposerSpecifierRe,
  assemblyDir,
  relativeToSrc,
  walkTsFiles,
} from './cli-guidance-boundary-helpers.js';

describe('phase 1263 Step C + phase 1264 Step A + phase 1265/1266/1267 Step A: cli guidance typed boundary', () => {
  for (const binding of CLI_GUIDANCE_BINDINGS) {
    it(`${binding.type} binding 经 binding factory + owner decoder（有业务 union 时 + exhaustive never）`, () => {
      const text = fs.readFileSync(bindingPath(binding.file), 'utf8');
      expect(text).toContain('defineCliGuidanceBinding');
      expect(text).toContain(binding.decoder);
      if (binding.exhaustive !== undefined) {
        expect(text).toMatch(new RegExp(`never\\s*=\\s*state\\.${binding.exhaustive}`));
      }
      expect(text).toMatch(new RegExp(`type:\\s*'${binding.type}'`));
    });

    it(`${binding.type} binding 纯 typed：无自由 text / CLI literal / prose / renderer 调用 / 无关 owner state`, () => {
      const text = fs.readFileSync(bindingPath(binding.file), 'utf8');
      expect(text).not.toMatch(bindingForbiddenRe(binding));
    });

    it(`${binding.type} binding 只从两侧稳定 protocol import（CLIProtocol barrel + 对应 owner codec）`, () => {
      const text = fs.readFileSync(bindingPath(binding.file), 'utf8');
      const specifiers = [...text.matchAll(IMPORT_SPECIFIER_RE)].map(m => m[1]).sort();
      expect(specifiers).toEqual(['../../../cli-protocol/index.js', binding.ownerCodec].sort());
    });

    it(`旧 ${binding.type} composer 文件物理删除、assembly 内无 shim / compat re-export`, () => {
      expect(fs.existsSync(oldComposerPath(binding.file))).toBe(false);
      const specifierRe = oldComposerSpecifierRe(binding.file);
      const leftovers: string[] = [];
      for (const file of walkTsFiles(assemblyDir())) {
        for (const m of fs.readFileSync(file, 'utf8').matchAll(IMPORT_SPECIFIER_RE)) {
          if (specifierRe.test(m[1])) leftovers.push(`${relativeToSrc(file)}: '${m[1]}'`);
        }
      }
      expect(leftovers).toEqual([]);
    });
  }

  it('composers aggregate 不再 direct register 已迁 typed type，必经同一次 CLIProtocol helper 聚合调用', () => {
    const text = fs.readFileSync(COMPOSERS_INDEX, 'utf8');
    for (const binding of CLI_GUIDANCE_BINDINGS) {
      expect(text).not.toMatch(new RegExp(`\\.register\\(\\s*['"]${binding.type}['"]`));
    }
    // 全部已迁 typed binding 在同一次 registerCliGuidance 调用中（contribution 聚合，duplicate
    // preflight 覆盖全部 CLI binding）；不得分散成多次 helper 调用。
    const calls = [...text.matchAll(/registerCliGuidance\(\s*registry\s*,\s*\[([^\]]*)\]/g)];
    expect(calls).toHaveLength(1);
    const idents = calls[0][1].split(',').map(s => s.trim()).filter(Boolean);
    expect(idents).toEqual(CLI_GUIDANCE_BINDINGS.map(b => b.ident));
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
    // binding forbidden scanner：违反形态（text/CLI literal/prose/renderer/无关 owner state）均检出
    const crashRe = bindingForbiddenRe(CLI_GUIDANCE_BINDINGS[0]), inactivityRe = bindingForbiddenRe(CLI_GUIDANCE_BINDINGS[1]);
    expect(crashRe.test("return { text: 'x' };")).toBe(true);
    expect(crashRe.test('`chestnut claw ${id} daemon`')).toBe(true);
    expect(crashRe.test("'To restart: ' + cmd")).toBe(true);
    expect(inactivityRe.test("'To inspect: ' + cmd")).toBe(true);
    expect(crashRe.test('renderCliGuidanceDocument(doc)')).toBe(true);
    expect(crashRe.test('renderClawInvocation(id, cmd)')).toBe(true);
    expect(inactivityRe.test('state.inactiveMs > 0')).toBe(true);
    expect(inactivityRe.test('state.sourcePath')).toBe(true);
    expect(inactivityRe.test('state.lastError')).toBe(true);
    const outboxRe = bindingForbiddenRe(CLI_GUIDANCE_BINDINGS[2]), eventsRe = bindingForbiddenRe(CLI_GUIDANCE_BINDINGS[3]), cancelledRe = bindingForbiddenRe(CLI_GUIDANCE_BINDINGS[4]);
    expect(outboxRe.test('state.counts')).toBe(true);
    expect(outboxRe.test('state.totalClaws')).toBe(true);
    expect(outboxRe.test("import { decodeOutboxSummaryGuidance } from '../../../core/claw-topology/jobs/outbox-summary/guidance-state.js';")).toBe(false);
    expect(eventsRe.test('(12 contract events、显示前 10)')).toBe(true);
    expect(cancelledRe.test('(12 cancellations、显示前 10)')).toBe(true);
    expect(eventsRe.test("import { decodeContractEventsGuidance } from '../../../core/contract/index.js';")).toBe(false);
    // 合法 typed binding 形态不误报（含 typed action value '5m'、label/discriminant 字面）
    expect(crashRe.test("defineCliGuidanceBinding({ type: 'claw_crashed', decode, toDocument })")).toBe(false);
    expect(crashRe.test("return { lines: [{ label: 'restart', action }] };")).toBe(false);
    expect(inactivityRe.test("return { lines: [{ label: 'watch-after-intervention', action: { kind: 'claw.watch', target, inactiveAfter: '5m' } }] };")).toBe(false);

    // direct registration scanner
    for (const binding of CLI_GUIDANCE_BINDINGS) {
      const re = new RegExp(`\\.register\\(\\s*['"]${binding.type}['"]`);
      expect(re.test(`registry.register('${binding.type}', composer)`)).toBe(true);
      expect(re.test(`registerCliGuidance(registry, [${binding.ident}])`)).toBe(false);
    }
  });
});
