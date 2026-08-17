/**
 * Phase 1396 Step I: summon public surface inventory ratchet.
 *
 * Motion/user-facing surfaces must only teach: summon({ goal }) is an async tool
 * that eventually delivers either a created contractId or a concise failure reason.
 * No claw selection, shadow/mining/subagent implementation, dispatch-skills matching,
 * or technical failure recovery may leak into the summon-specific public surface.
 */

import { describe, it, expect } from 'vitest';
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

function extractSection(text: string, heading: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim().startsWith(heading));
  if (start === -1) return '';
  const depth = lines[start].match(/^(#+)/)?.[1].length ?? 1;
  const end = lines.slice(start + 1).findIndex((l) => {
    const m = l.match(/^(#+)/);
    return m !== null && m[1].length <= depth;
  });
  return lines.slice(start + 1, end === -1 ? undefined : start + 1 + end).join('\n');
}

describe('Phase 1396 Step I: summon public surface inventory', () => {
  describe('Motion templates', () => {
    it('AGENTS.md summon usage section must not expose implementation or recovery', () => {
      const agents = readAllText(path.join(MOTION_DIR, 'AGENTS.md'));
      const summonSection = extractSection(agents, '### summon 用法');
      expect(summonSection).not.toMatch(FORBIDDEN_SUMMON_PATTERN);
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
      const result = await new SummonTool(undefined, undefined, undefined, false).execute(
        { goal: 'test' },
        {
          auditWriter: null,
          currentToolUseId: 'tu_test',
        } as any,
      );
      expect(result).toMatchObject({ success: false, error: 'summon_unavailable' });
      expect(result.content).not.toMatch(FORBIDDEN_ERROR_DETAIL_PATTERN);
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
