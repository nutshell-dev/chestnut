/**
 * Dialog module tests
 * 
 * Tests:
 * - SessionManager: load, save, archive, crash recovery
 * - ContextInjector: system prompt building
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { SessionManager } from '../../src/foundation/session-store/index.js';
import { ContextInjector } from '../../src/core/dialog/injector.js';
import type { Message } from '../../src/types/message.js';
import type { SessionData } from '../../src/foundation/session-store/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/index.js';

async function createTempDir(): Promise<string> {
  const tempDir = path.join(tmpdir(), `clawforum-dialog-test-${randomUUID()}`);
  await fs.mkdir(tempDir, { recursive: true });
  return tempDir;
}

async function cleanupTempDir(tempDir: string): Promise<void> {
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

describe('Dialog', () => {
  describe('SessionManager', () => {
    let tempDir: string;
    let nodeFs: NodeFileSystem;
    let sessionManager: SessionManager;

    beforeEach(async () => {
      tempDir = await createTempDir();
      nodeFs = new NodeFileSystem({ baseDir: tempDir, enforcePermissions: false });
      await nodeFs.ensureDir('dialog');
      sessionManager = new SessionManager(nodeFs, 'dialog');
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

      await sessionManager.save(messages);
      const { session: loaded } = await sessionManager.load();

      expect(loaded.messages).toHaveLength(2);
      expect(loaded.messages[0].role).toBe('user');
      expect(loaded.messages[1].role).toBe('assistant');
    });

    it('should archive current.json to archive directory', async () => {
      const messages: Message[] = [{ role: 'user', content: 'Test' }];
      await sessionManager.save(messages);

      // Verify current.json exists
      expect(await nodeFs.exists('dialog/current.json')).toBe(true);

      // Archive
      await sessionManager.archive();

      // current.json should be gone
      expect(await nodeFs.exists('dialog/current.json')).toBe(false);
      
      // Archive directory should have the file
      const entries = await nodeFs.list('dialog/archive');
      expect(entries.length).toBeGreaterThan(0);
      expect(entries[0].name).toMatch(/\.json$/);
    });

    it('should recover from archive on cold start', async () => {
      // Create and archive a session
      const messages: Message[] = [
        { role: 'user', content: 'Archived message' },
      ];
      await sessionManager.save(messages);
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
      
      await sessionManager.save([msg]);
      
      const { session: loaded } = await sessionManager.load();
      expect(loaded.messages).toHaveLength(1);
      expect(loaded.messages[0].content).toBe('New message');
    });

    it('should track session metadata', async () => {
      const messages: Message[] = [{ role: 'user', content: 'Test' }];
      await sessionManager.save(messages);

      const { session: loaded } = await sessionManager.load();
      
      expect(loaded.version).toBe(1);
      expect(loaded.clawId).toBeDefined();
      expect(loaded.createdAt).toBeDefined();
      expect(loaded.updatedAt).toBeDefined();
    });

    describe('crash recovery', () => {
      it('should recover from archive when current.json is missing', async () => {
        // Create archive directory and an archived session
        await nodeFs.ensureDir('dialog/archive');
        const archivedSession: SessionData = {
          version: 1,
          clawId: 'test-claw',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T01:00:00Z',
          messages: [{ role: 'user', content: 'Archived message' }],
        };
        await nodeFs.writeAtomic(
          'dialog/archive/20240101_120000.json',
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
        await nodeFs.ensureDir('dialog/archive');
        const archivedSession: SessionData = {
          version: 1,
          clawId: 'test-claw',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T01:00:00Z',
          messages: [{ role: 'user', content: 'Recovered from archive' }],
        };
        await nodeFs.writeAtomic(
          'dialog/archive/20240101_120000.json',
          JSON.stringify(archivedSession)
        );

        const { session: loaded } = await sessionManager.load();

        expect(loaded.messages).toHaveLength(1);
        expect(loaded.messages[0].content).toBe('Recovered from archive');

        // SF-02: corrupted current.json should be renamed
        expect(await nodeFs.exists('dialog/current.json')).toBe(false);
        expect(await nodeFs.exists('dialog/current.json.corrupted')).toBe(true);
      });

      it('should return empty session when nothing exists', async () => {
        // No current.json, no archive - fresh start
        const { session: loaded } = await sessionManager.load();

        expect(loaded.messages).toHaveLength(0);
        expect(loaded.version).toBe(1);
        expect(loaded.clawId).toBeDefined();
        expect(loaded.createdAt).toBeDefined();
      });

      it('should return empty session when archive directory is empty', async () => {
        // Create empty archive directory
        await nodeFs.ensureDir('dialog/archive');

        const { session: loaded } = await sessionManager.load();

        expect(loaded.messages).toHaveLength(0);
      });

      // SF-01: latest archive corrupted → fall back to older valid archive
      it('should fall back to older archive when latest is corrupted', async () => {
        await nodeFs.ensureDir('dialog/archive');

        // Old valid archive
        const oldSession: SessionData = {
          version: 1,
          clawId: 'test-claw',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          messages: [{ role: 'user', content: 'Old but valid' }],
        };
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
      nodeFs = new NodeFileSystem({ baseDir: tempDir, enforcePermissions: false });
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

    // buildParts: skill 注入
    it('should include skills in buildParts when skillRegistry is provided', async () => {
      const mockSkillRegistry = {
        formatForContext: vi.fn().mockReturnValue('## Skills\n- skill1'),
      } as any;
      const inj = new ContextInjector({ fs: nodeFs, skillRegistry: mockSkillRegistry });

      const parts = await inj.buildParts();
      expect(parts.skills).toBe('## Skills\n- skill1');
      expect(parts.contract).toBe('');
    });

    // buildParts: contract 注入（含 completed/pending checkbox）
    it('should include contract in buildParts when contractManager has active contract', async () => {
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
      } as any;
      const inj = new ContextInjector({ fs: nodeFs, contractManager: mockContractManager });

      const parts = await inj.buildParts();
      expect(parts.contract).toContain('## Active Contract');
      expect(parts.contract).toContain('[x] `design`');
      expect(parts.contract).toContain('[ ] `impl`');
    });

    // buildParts: contractManager.loadActive 抛异常 → 静默跳过
    it('should skip contract silently when loadActive throws', async () => {
      const mockContractManager = {
        loadActive: vi.fn().mockRejectedValue(new Error('corrupted')),
      } as any;
      const inj = new ContextInjector({ fs: nodeFs, contractManager: mockContractManager });

      const parts = await inj.buildParts();
      expect(parts.contract).toBe('');
    });

    // buildParts: AGENTS.md 内容为空白 → agents 为空
    it('should return empty agents when AGENTS.md is whitespace only', async () => {
      await nodeFs.writeAtomic('AGENTS.md', '   \n  ');
      const parts = await injector.buildParts();
      expect(parts.agents).toBe('');
    });

    // buildSystemPrompt: 包含 skill 和 contract
    it('should include skills and contract in buildSystemPrompt', async () => {
      await nodeFs.writeAtomic('AGENTS.md', '# Agent Instructions');
      const mockSkillRegistry = {
        formatForContext: vi.fn().mockReturnValue('## Skills\n- skill1'),
      } as any;
      const mockContractManager = {
        loadActive: vi.fn().mockResolvedValue({
          id: 'c1', title: 'T', goal: 'G',
          subtasks: [{ id: 'x', description: 'do x', status: 'pending' }],
        }),
      } as any;
      const inj = new ContextInjector({ fs: nodeFs, skillRegistry: mockSkillRegistry, contractManager: mockContractManager });

      const prompt = await inj.buildSystemPrompt();
      expect(prompt).toContain('Agent Instructions');
      expect(prompt).toContain('## Skills');
      expect(prompt).toContain('## Active Contract');
      expect(prompt).toContain('[ ] `x`');
    });

  });
});
