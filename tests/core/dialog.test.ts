/**
 * Dialog module tests
 * 
 * Tests:
 * - DialogStore: load, save, archive, crash recovery
 * - ContextInjector: system prompt building
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'crypto';
import { DIALOG_ARCHIVE_DIR } from '../../src/foundation/dialog-store/dirs.js';

import { DialogStore } from '../../src/foundation/dialog-store/index.js';
import { ContextInjector } from '../../src/core/runtime/injector.js';
import { Runtime } from '../../src/core/runtime/runtime.js';
import { createSkillSystem } from '../../src/foundation/skill-system/index.js';

import type { Message } from '../../src/foundation/dialog-store/index.js';
import { makeSession } from '../helpers/session-fixtures.js';
import type { SessionData } from '../../src/foundation/dialog-store/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/index.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
// phase 1909 Step C（M17）：断言期望值经模板单源，不复制字面（防双源）
import { AVAILABLE_SKILLS_HEADING } from '../../src/templates/messages/index.js';

describe('Dialog', () => {
  describe('DialogStore', () => {
    let tempDir: string;
    let nodeFs: NodeFileSystem;
    let sessionManager: DialogStore;

    beforeEach(async () => {
      tempDir = await createTempDir();
      nodeFs = new NodeFileSystem({ baseDir: tempDir });
      await nodeFs.ensureDir('dialog');
      sessionManager = new DialogStore(nodeFs, 'dialog', { write: () => {} }, 'current.json', 'test-claw');
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it('should return empty session when current.json does not exist', async () => {
      const { session: session } = await sessionManager.load();
      
      expect(session.messages).toEqual([]);
      expect(session.clawId).toBeDefined();
    });

    it('should save and load messages consistently', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
      ];

      await sessionManager.save({ systemPrompt: 'test-system-prompt', messages, toolsForLLM: [] });
      const { session: loaded } = await sessionManager.load();

      expect(loaded.messages).toHaveLength(2);
      expect(loaded.messages[0].role).toBe('user');
      expect(loaded.messages[1].role).toBe('assistant');
    });

    it('should archive current.json to archive directory', async () => {
      const messages: Message[] = [{ role: 'user', content: 'Test' }];
      await sessionManager.save({ systemPrompt: 'test-system-prompt', messages, toolsForLLM: [] });

      // Verify current.json exists
      expect(await nodeFs.exists('dialog/current.json')).toBe(true);

      // Archive
      await sessionManager.archive();

      // current.json should be gone
      expect(await nodeFs.exists('dialog/current.json')).toBe(false);
      
      // Archive directory should have the file
      const entries = await nodeFs.list(DIALOG_ARCHIVE_DIR);
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toMatch(/\.json$/);
    });

    it('should recover from archive on cold start', async () => {
      // Create and archive a session
      const messages: Message[] = [
        { role: 'user', content: 'Archived message' },
      ];
      await sessionManager.save({ systemPrompt: 'test-system-prompt', messages, toolsForLLM: [] });
      await sessionManager.archive();

      // Verify current.json doesn't exist
      expect(await nodeFs.exists('dialog/current.json')).toBe(false);

      // Load should recover from archive
      const { session: recovered } = await sessionManager.load();
      expect(recovered.messages).toHaveLength(1);
      expect(recovered.messages[0].content).toBe('Archived message');
    });

    it('should save and load messages', async () => {
      const msg: Message = { role: 'user', content: 'New message' };
      
      await sessionManager.save({ systemPrompt: 'test-system-prompt', messages: [msg], toolsForLLM: [] });
      
      const { session: loaded } = await sessionManager.load();
      expect(loaded.messages).toHaveLength(1);
      expect(loaded.messages[0].content).toBe('New message');
    });

    it('should track session metadata', async () => {
      const messages: Message[] = [{ role: 'user', content: 'Test' }];
      await sessionManager.save({ systemPrompt: 'test-system-prompt', messages, toolsForLLM: [] });

      const { session: loaded } = await sessionManager.load();
      
      expect(loaded.version).toBe(2);
      expect(loaded.clawId).toBeDefined();
      expect(loaded.createdAt).toBeDefined();
      expect(loaded.updatedAt).toBeDefined();
    });

    describe('crash recovery', () => {
      it('should recover from archive when current.json is missing', async () => {
        // Create archive directory and an archived session
        await nodeFs.ensureDir(DIALOG_ARCHIVE_DIR);
        const archivedSession: SessionData = makeSession({
          clawId: 'test-claw',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T01:00:00Z',
          messages: [{ role: 'user', content: 'Archived message' }],
        });
        await nodeFs.writeAtomic(
          `${DIALOG_ARCHIVE_DIR}/20240101_120000.json`,
          JSON.stringify(archivedSession)
        );

        // Load without current.json
        const { session: loaded } = await sessionManager.load();

        expect(loaded.messages).toHaveLength(1);
        expect(loaded.messages[0].content).toBe('Archived message');
      });

      it('should recover from archive when current.json has invalid JSON', async () => {
        // Create invalid current.json
        await nodeFs.writeAtomic('dialog/current.json', 'invalid json {');

        // Create archive
        await nodeFs.ensureDir(DIALOG_ARCHIVE_DIR);
        const archivedSession: SessionData = makeSession({
          clawId: 'test-claw',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T01:00:00Z',
          messages: [{ role: 'user', content: 'Recovered from archive' }],
        });
        await nodeFs.writeAtomic(
          `${DIALOG_ARCHIVE_DIR}/20240101_120000.json`,
          JSON.stringify(archivedSession)
        );

        const { session: loaded } = await sessionManager.load();

        expect(loaded.messages).toHaveLength(1);
        expect(loaded.messages[0].content).toBe('Recovered from archive');

        // SF-02: corrupted current.json should be renamed
        expect(await nodeFs.exists('dialog/current.json')).toBe(false);
        const corruptedExists = await nodeFs.exists('dialog/current.json.corrupted');
        expect(corruptedExists).toBe(false);
        // Phase 984: corrupted files are isolated with a timestamp + short UUID suffix.
        const dirEntries = await nodeFs.list('dialog');
        expect(dirEntries.some(e => /current\.json\.corrupted\.\d+_[a-z0-9]+/.test(e.name))).toBe(true);
      });

      it('should return empty session when nothing exists', async () => {
        // No current.json, no archive - fresh start
        const { session: loaded } = await sessionManager.load();

        expect(loaded.messages).toHaveLength(0);
        expect(loaded.version).toBe(2);
        expect(loaded.clawId).toBeDefined();
        expect(loaded.createdAt).toBeDefined();
      });

      it('should return empty session when archive directory is empty', async () => {
        // Create empty archive directory
        await nodeFs.ensureDir(DIALOG_ARCHIVE_DIR);

        const { session: loaded } = await sessionManager.load();

        expect(loaded.messages).toHaveLength(0);
      });

      // SF-01: latest archive corrupted → fall back to older valid archive
      it('should fall back to older archive when latest is corrupted', async () => {
        await nodeFs.ensureDir(DIALOG_ARCHIVE_DIR);

        // Old valid archive
        const oldSession: SessionData = makeSession({
          clawId: 'test-claw',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          messages: [{ role: 'user', content: 'Old but valid' }],
        });
        await nodeFs.writeAtomic(
          'dialog/archive/1000_old.json',
          JSON.stringify(oldSession)
        );

        // New corrupted archive
        await nodeFs.writeAtomic(
          'dialog/archive/2000_corrupted.json',
          '{ invalid json'
        );

        // No current.json
        const { session: loaded } = await sessionManager.load();

        // Should recover from the older valid archive, not return empty
        expect(loaded.messages).toHaveLength(1);
        expect(loaded.messages[0].content).toBe('Old but valid');
      });
    });

  });

  describe('ContextInjector', () => {
    let tempDir: string;
    let nodeFs: NodeFileSystem;
    let injector: ContextInjector;

    beforeEach(async () => {
      tempDir = await createTempDir();
      nodeFs = new NodeFileSystem({ baseDir: tempDir });
      injector = new ContextInjector({ fs: nodeFs });
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it('should build system prompt from AGENTS.md and MEMORY.md', async () => {
      // Create AGENTS.md
      await nodeFs.writeAtomic('AGENTS.md', '# Agent Instructions\nBe helpful.');
      // Create MEMORY.md
      await nodeFs.writeAtomic('MEMORY.md', '# Memory\nUser likes TypeScript.');

      const prompt = await injector.buildSystemPrompt();

      expect(prompt).toContain('Agent Instructions');
      expect(prompt).toContain('Be helpful');
      expect(prompt).toContain('Memory');
      expect(prompt).toContain('User likes TypeScript');
    });

    it('should return empty string when AGENTS.md does not exist', async () => {
      const prompt = await injector.buildSystemPrompt();

      expect(prompt).toBe('');
    });

    it('should handle missing MEMORY.md gracefully', async () => {
      await nodeFs.writeAtomic('AGENTS.md', '# Instructions\nTest.');
      // MEMORY.md doesn't exist

      const prompt = await injector.buildSystemPrompt();

      expect(prompt).toContain('Instructions');
      // Should not crash, just have AGENTS content
      expect(prompt).not.toContain('Memory');
    });

    // buildParts: skill 注入（真 SkillRegistry + tmp fixture / 不再 mock tautology）
    it('should include skills in buildParts when skillRegistry is provided', async () => {
      // arrange: 写真 SKILL.md fixture 到 outer tempDir
      await nodeFs.ensureDir('skills/skill1');
      await nodeFs.writeAtomic(
        'skills/skill1/SKILL.md',
        '---\nname: skill1\ndescription: Test fixture skill\nversion: 0.0.1\n---\n# skill1\n',
      );

      // act: 真 SkillSystem + loadAll（契约 §2.1）
      // phase 1872 Step G: 工厂内完成首载（async 工厂）
      const registry = await createSkillSystem(nodeFs, 'skills', { write: () => {} });
      await registry.loadAll();

      const inj = new ContextInjector({ fs: nodeFs, skillRegistry: registry });
      const parts = await inj.buildParts();

      // assert: 真契约语义（heading + skill name + description）/ 容忍非语义文案变化
      expect(parts.skills).toContain(AVAILABLE_SKILLS_HEADING);
      expect(parts.skills).toContain('skill1');
      expect(parts.skills).toContain('Test fixture skill');
      expect(parts).not.toHaveProperty('contract');
    });

    // Phase 2193 C1: legacy contract loader 不再是 system prompt 输入。
    it('should not read or include active contract in buildParts', async () => {
      await nodeFs.writeAtomic('AGENTS.md', '# Agent Instructions');
      const mockContractManager = {
        loadActive: vi.fn().mockResolvedValue({
          id: 'c1',
          title: 'Build Tool',
          goal: 'Create a search tool',
          subtasks: [
            { id: 'design', description: 'Design API', status: 'completed' },
            { id: 'impl', description: 'Implement', status: 'pending' },
          ],
        }),
      };
      const inj = new ContextInjector({
        fs: nodeFs,
        loadActiveContract: () => mockContractManager.loadActive(),
      } as any);

      const parts = await inj.buildParts();

      expect(mockContractManager.loadActive).not.toHaveBeenCalled();
      expect(parts).not.toHaveProperty('contract');
      expect(Object.values(parts).join('\n')).not.toContain('Build Tool');
      expect(Object.values(parts).join('\n')).not.toContain('Implement');
    });

    it('should ignore a legacy loadActive callback even when it throws', async () => {
      const mockContractManager = {
        loadActive: vi.fn().mockRejectedValue(new Error('corrupted')),
      };
      const inj = new ContextInjector({
        fs: nodeFs,
        loadActiveContract: () => mockContractManager.loadActive(),
      } as any);

      const parts = await inj.buildParts();

      expect(mockContractManager.loadActive).not.toHaveBeenCalled();
      expect(parts).not.toHaveProperty('contract');
    });

    // buildParts: AGENTS.md 内容为空白 → agents 为空
    it('should return empty agents when AGENTS.md is whitespace only', async () => {
      await nodeFs.writeAtomic('AGENTS.md', '   \n  ');
      const parts = await injector.buildParts();
      expect(parts.agents).toBe('');
    });

    // buildSystemPrompt: 保留 skill，排除 active contract 与 checkbox 状态。
    it('should include skills but no active contract in buildSystemPrompt', async () => {
      await nodeFs.writeAtomic('AGENTS.md', '# Agent Instructions');
      const mockSkillRegistry = {
        formatForContext: vi.fn().mockReturnValue('## Skills\n- skill1'),
      } as any;
      const mockContractManager = {
        loadActive: vi.fn().mockResolvedValue({
          id: 'c1', title: 'T', goal: 'G',
          subtasks: [{ id: 'x', description: 'do x', status: 'pending' }],
        }),
      };
      const inj = new ContextInjector({
        fs: nodeFs,
        skillRegistry: mockSkillRegistry,
        loadActiveContract: () => mockContractManager.loadActive(),
      } as any);

      const prompt = await inj.buildSystemPrompt();

      expect(prompt).toContain('Agent Instructions');
      expect(prompt).toContain('## Skills');
      expect(prompt).not.toContain('## Active Contract');
      expect(prompt).not.toContain('do x');
      expect(prompt).not.toContain('[ ]');
      expect(mockContractManager.loadActive).not.toHaveBeenCalled();
    });

    it('should keep full prompt, identity, and content revision stable when only contract changes', async () => {
      const loadActive = vi.fn()
        .mockResolvedValueOnce({
          id: 'c1', title: 'Contract A', goal: 'Goal A',
          subtasks: [{ id: 'x', description: 'do x', status: 'pending' }],
        })
        .mockResolvedValueOnce({
          id: 'c2', title: 'Contract B', goal: 'Goal B',
          subtasks: [{ id: 'y', description: 'do y', status: 'completed' }],
        });
      const inj = new ContextInjector({
        fs: {
          read: vi.fn(async (file: string) => {
            if (file === 'AGENTS.md') return '# Stable Agents';
            if (file === 'MEMORY.md') return 'Stable memory';
            return '';
          }),
        } as any,
        skillRegistry: { formatForContext: () => '## Skills\n- stable-skill' } as any,
        loadActiveContract: () => loadActive(),
      } as any);
      const runtime = new Runtime({
        clawId: 'test-claw',
        clawDir: tempDir,
        llmConfig: {} as any,
        dependencies: { auditWriter: { write: vi.fn() } } as any,
      });
      (runtime as unknown as { contextInjector: ContextInjector }).contextInjector = inj;

      const beforeRegime = await inj.buildSystemPromptForRegime();
      const before = await runtime.getSystemPromptSnapshot();
      const afterRegime = await inj.buildSystemPromptForRegime();
      const after = await runtime.getSystemPromptSnapshot();

      expect(afterRegime).toEqual(beforeRegime);
      expect(after).toEqual(before);
      expect(before.content).toBe(beforeRegime.full);
      expect(before.revision).toBe(createHash('sha256').update(before.content).digest('hex'));
      expect(before.content).not.toContain('Active Contract');
      expect(loadActive).not.toHaveBeenCalled();
    });

    it('should change full revision for AGENTS/MEMORY/skills but identity only for AGENTS/skills', async () => {
      let agents = '# Agents v1';
      let memory = 'Memory v1';
      let skills = '## Skills\n- skill v1';
      const readSnapshot = async () => {
        const inj = new ContextInjector({
          fs: {
            read: vi.fn(async (file: string) => {
              if (file === 'AGENTS.md') return agents;
              if (file === 'MEMORY.md') return memory;
              return '';
            }),
          } as any,
          skillRegistry: { formatForContext: () => skills } as any,
        });
        const regime = await inj.buildSystemPromptForRegime();
        const runtime = new Runtime({
          clawId: 'test-claw',
          clawDir: tempDir,
          llmConfig: {} as any,
          dependencies: { auditWriter: { write: vi.fn() } } as any,
        });
        (runtime as unknown as { contextInjector: ContextInjector }).contextInjector = inj;
        const snapshot = await runtime.getSystemPromptSnapshot();
        return { regime, snapshot };
      };

      const baseline = await readSnapshot();
      agents = '# Agents v2';
      const agentsChanged = await readSnapshot();
      agents = '# Agents v1';
      memory = 'Memory v2';
      const memoryChanged = await readSnapshot();
      memory = 'Memory v1';
      skills = '## Skills\n- skill v2';
      const skillsChanged = await readSnapshot();

      for (const variant of [agentsChanged, memoryChanged, skillsChanged]) {
        expect(variant.regime.full).not.toBe(baseline.regime.full);
        expect(variant.snapshot.content).toBe(variant.regime.full);
        expect(variant.snapshot.revision).not.toBe(baseline.snapshot.revision);
        expect(variant.snapshot.revision).toBe(
          createHash('sha256').update(variant.snapshot.content).digest('hex'),
        );
      }
      expect(agentsChanged.regime.identityContent).not.toBe(baseline.regime.identityContent);
      expect(memoryChanged.regime.identityContent).toBe(baseline.regime.identityContent);
      expect(skillsChanged.regime.identityContent).not.toBe(baseline.regime.identityContent);
    });

  });
});
