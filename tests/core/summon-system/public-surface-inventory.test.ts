/**
 * Phase 1396 Step I: summon public surface inventory ratchet.
 *
 * Motion/user-facing surfaces must only teach: summon({ goal }) is an async tool
 * that eventually delivers either a created contractId or a concise failure reason.
 * No claw selection, shadow/mining/subagent implementation, dispatch-skills matching,
 * or technical failure recovery may leak into the summon-specific public surface.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { SummonTool } from '../../../src/core/summon-system/tools/summon.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');

const MOTION_DIR = path.join(repoRoot, 'src', 'templates', 'motion');
const SKILL_DIR = path.join(repoRoot, 'src', 'skills', 'chestnut-guide');

const FORBIDDEN_SUMMON_PATTERN = /targetClaw|shadow|mine|mining|subagent|子代理|分身|选择.{0,20}(claw|Claw)|创建.{0,20}(claw|Claw)|崩溃自动重启|明确卡住|重启因错误停止|Summoner|dispatch-skills/i;

const FORBIDDEN_MOTION_RECOVERY_PATTERN = /targetClaw|mine|mining|subagent|子代理|分身|选择.{0,20}(claw|Claw)|创建.{0,20}(claw|Claw)|崩溃自动重启|明确卡住|重启因错误停止|Summoner|dispatch-skills/i;

const FORBIDDEN_ERROR_DETAIL_PATTERN = /shadow|orphan|ExecContext|Assembly|caller snapshot|async-only routing/i;

/**
 * Phase 1396 Step M: 含 summon 的完整句子/表格行不得与实现实体同句绑定。
 * 扫描范围 = 三份 Motion 模板全文（不限 `### summon 用法` subsection）。
 */
const SUMMON_SENTENCE_FORBIDDEN = /claw|shadow|mining|subagent|子代理|分身|召唤任务|dispatch-skills/i;

function collectSummonLines(text: string): Array<{ heading: string; line: string }> {
  const out: Array<{ heading: string; line: string }> = [];
  let heading = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const h = line.match(/^#+\s+(.*)$/);
    if (h) heading = h[1];
    if (/summon/i.test(line)) out.push({ heading, line });
  }
  return out;
}

function collectTsFiles(...roots: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(p);
      } else if (entry.name.endsWith('.ts')) {
        out.push(p);
      }
    }
  };
  for (const root of roots) walk(root);
  return out;
}

function readAllText(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

function collectReachableReferences(skillMdPath: string): string[] {
  const text = readAllText(skillMdPath);
  const refs: string[] = [];
  const re = /\[.*?]\((references\/[^)]+)\)/g;
  for (const m of text.matchAll(re)) {
    refs.push(m[1]);
  }
  return refs;
}

describe('Phase 1396 Step I: summon public surface inventory', () => {
  describe('Motion templates', () => {
    it('every summon sentence across the full Motion templates must not bind implementation entities', () => {
      for (const file of ['AGENTS.md', 'SOUL.md', 'AUTH_POLICY.md']) {
        const text = readAllText(path.join(MOTION_DIR, file));
        for (const { heading, line } of collectSummonLines(text)) {
          expect(line, `${file} [${heading}]: ${line}`).not.toMatch(SUMMON_SENTENCE_FORBIDDEN);
        }
      }
    });

    it('SOUL.md must not authorize or teach summon/claw recovery', () => {
      const text = readAllText(path.join(MOTION_DIR, 'SOUL.md'));
      expect(text).not.toMatch(FORBIDDEN_MOTION_RECOVERY_PATTERN);
    });

    it('AUTH_POLICY.md must not authorize recovery of failed Claw', () => {
      const text = readAllText(path.join(MOTION_DIR, 'AUTH_POLICY.md'));
      expect(text).not.toMatch(FORBIDDEN_MOTION_RECOVERY_PATTERN);
    });
  });

  describe('SummonTool agent-facing surface', () => {
    const tool = new SummonTool();

    it('schema only exposes goal', () => {
      expect(Object.keys(tool.schema.properties)).toEqual(['goal']);
      expect(tool.schema.required).toEqual(['goal']);
      expect(tool.schema.additionalProperties).toBe(false);
    });

    it('description must not explain dispatch-skills or claw selection', () => {
      expect(tool.description).not.toMatch(FORBIDDEN_SUMMON_PATTERN);
    });

    it('shadow rejection error must not leak implementation words', async () => {
      // Phase 1866 Step B（SU-D1）: typed options 构造（旧第 3 位置参 → allowFromShadow）；
      // 注入完整 caller snapshot 并断言未被调用，
      // 确保拒绝真来自 allowFromShadow=false 分支而非 snapshot 缺失路径。
      const getCallerSnapshot = vi.fn();
      const result = await new SummonTool({ allowFromShadow: false }).execute(
        { goal: 'test' },
        {
          auditWriter: null,
          currentToolUseId: 'tu_test',
          getCallerSnapshot,
        } as any,
      );
      expect(result).toMatchObject({ success: false, error: 'summon_unavailable' });
      expect(result.content).not.toMatch(FORBIDDEN_ERROR_DETAIL_PATTERN);
      expect(getCallerSnapshot).not.toHaveBeenCalled();
    });

    it('SummonTool typed-deps ratchet: 位置参不得回流（options-only 构造）', () => {
      // phase 1866 Step B（SU-D1）：deps 有默认值 → 0 必填位置参
      expect(SummonTool.length).toBe(0);
      const files = collectTsFiles(
        path.join(repoRoot, 'src'),
        path.join(repoRoot, 'tests'),
      );
      // 带位置参的构造（首实参非 `{`）＝ 旧形态回流
      const positionalCall = /new SummonTool\(\s*(?!\)|\{)[^)\n]+\)/;
      for (const f of files) {
        expect(readAllText(f), f).not.toMatch(positionalCall);
      }
    });
  });

  describe('Bundled chestnut-guide skill', () => {
    it('SKILL.md and every reachable reference must not leak summon implementation', () => {
      const skillText = readAllText(path.join(SKILL_DIR, 'SKILL.md'));
      expect(skillText).not.toMatch(FORBIDDEN_SUMMON_PATTERN);

      const refRelPaths = collectReachableReferences(path.join(SKILL_DIR, 'SKILL.md'));
      expect(refRelPaths).not.toContain('claw-stagnation.md');
      expect(refRelPaths).not.toContain('summon-workflow.md');
      expect(refRelPaths).not.toContain('summoner-workflow.md');

      for (const rel of refRelPaths) {
        const refText = readAllText(path.join(SKILL_DIR, rel));
        expect(refText).not.toMatch(FORBIDDEN_SUMMON_PATTERN);
      }
    });
  });
});
