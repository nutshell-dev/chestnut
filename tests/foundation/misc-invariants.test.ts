/**
 * misc invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - cross-claw-must-via-topology.test.ts
 *  - file-watcher-persistent.test.ts
 *  - messaging-codec-generic.test.ts
 *  - unix-socket.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createWatcher } from '../../src/foundation/file-watcher/index.js';
import * as chokidar from 'chokidar';
import { UnixDomainSocketTransport } from '../../src/foundation/transport/unix-socket.js';
import { createServer } from 'node:net';

vi.mock('chokidar', () => ({
  watch: vi.fn(() => ({
    on: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock('node:net', () => ({
  createServer: vi.fn(() => createMockServer()),
  connect: vi.fn(),
}));

describe('cross-claw-must-via-topology', () => {
  const REPO_ROOT = path.resolve(__dirname, '../..');

  /**
   * cross-claw 直拼模式（应经 ClawTopology API）
   *
   * 抓：
   * - path.join(...clawsDir..., ...clawId...)
   * - path.join(...CLAWS_DIR..., ...<some>Id...)
   * - enumerateClaws( ... ) 直调
   *
   * 业务层（src/core/）禁直拼、应经 topology.read / topology.resolve / topology.enumerate API。
   *
   * 白名单（path-based、ML 元约束泛化）：
   * - src/core/claw-topology/* （拓扑业务 own 模块、自己 own）
   *
   * 防 regression 抓范围：
   * - src/core/**（业务层）
   * - src/cli/commands/chat-viewport-claw-manager.ts、chat-viewport-claw-panel.ts、chat-viewport-commands.ts（phase 260 cascade、防 regression）
   *
   * 不抓（by-design）：
   * - src/foundation/**（primitive 层、phase 238 ratify foundation 单源）
   * - src/assembly/**（L6 装配协议、phase 84/98 ratify）
   * - src/cli/**（除 cascade 3 file 外、CLI 命令装配派生 by-design）
   */

  const SCAN_DIRS_AND_FILES: string[] = [
    'src/core',
    'src/cli/commands/chat-viewport-claw-manager.ts',
    'src/cli/commands/chat-viewport-claw-panel.ts',
    'src/cli/commands/chat-viewport-commands.ts',
  ];

  const WHITELIST_PATH_PREFIXES: string[] = [
    'src/core/claw-topology/',
  ];

  const FORBIDDEN_PATTERNS: Array<{ name: string; re: RegExp }> = [
    // path.join(...clawsDir..., ...clawId...)
    {
      name: 'path.join(clawsDir, clawId, ...)',
      re: /\bpath\.join\([^)]*\bclawsDir\b[^)]*,[^)]*\bclawId\b/,
    },
    // path.join(...CLAWS_DIR..., ...<Id>...)
    {
      name: 'path.join(CLAWS_DIR, <id>, ...)',
      re: /\bpath\.join\([^)]*\bCLAWS_DIR\b[^)]*,[^)]*\b[a-zA-Z]+Id\b/,
    },
    // enumerateClaws( 直调
    {
      name: 'enumerateClaws( ... )',
      re: /\benumerateClaws\s*\(/,
    },
  ];

  function isWhitelisted(relPath: string): boolean {
    return WHITELIST_PATH_PREFIXES.some(prefix => relPath.startsWith(prefix));
  }

  function collectTsFiles(entry: string): string[] {
    const abs = path.join(REPO_ROOT, entry);
    const stats = fs.statSync(abs);
    if (stats.isDirectory()) {
      const results: string[] = [];
      const entries = fs.readdirSync(abs, { withFileTypes: true });
      for (const e of entries) {
        const child = path.posix.join(entry, e.name);
        if (e.isDirectory()) {
          results.push(...collectTsFiles(child));
        } else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
          results.push(child);
        }
      }
      return results;
    }
    return [entry];
  }

  function collectFilesToScan(): string[] {
    const files: string[] = [];
    for (const entry of SCAN_DIRS_AND_FILES) {
      files.push(...collectTsFiles(entry));
    }
    return files;
  }

  describe('cross-claw must go via ClawTopology', () => {
    it('业务层 + 已 cascade 子模块禁直拼 cross-claw path / 禁直调 enumerateClaws', () => {
      const files = collectFilesToScan();
      const violations: Array<{ file: string; pattern: string; lineNo: number; line: string }> = [];

      for (const relPath of files) {
        if (isWhitelisted(relPath)) continue;
        const abs = path.join(REPO_ROOT, relPath);
        const src = fs.readFileSync(abs, 'utf-8');
        const lines = src.split('\n');
        for (let i = 0; i < lines.length; i++) {
          for (const { name, re } of FORBIDDEN_PATTERNS) {
            if (re.test(lines[i])) {
              violations.push({ file: relPath, pattern: name, lineNo: i + 1, line: lines[i].trim() });
            }
          }
        }
      }

      if (violations.length > 0) {
        const detail = violations
          .map(v => `  ${v.file}:${v.lineNo} [${v.pattern}]\n    ${v.line}`)
          .join('\n');
        throw new Error(
          `Cross-claw direct path detected (${violations.length} violations).\n` +
          `Business modules must go via ClawTopology API:\n` +
          `  - topology.read(clawId, relPath)\n` +
          `  - topology.resolve(clawId).clawDir\n` +
          `  - topology.enumerate()\n\n` +
          `Whitelisted paths (own/primitive layers):\n${WHITELIST_PATH_PREFIXES.map(p => `  - ${p}`).join('\n')}\n\n` +
          `Violations:\n${detail}`,
        );
      }
    });
  });
});

describe('file-watcher-persistent', () => {
  /**
   * FileWatcher persistent option tests
   *
   * Module-level mock of chokidar to verify options passed through.
   */

  describe('createWatcher persistent option', () => {
    beforeEach(() => {
      vi.mocked(chokidar.watch).mockClear();
    });

    it('defaults to persistent: true', () => {
      createWatcher('/tmp/x', () => {});
      expect(vi.mocked(chokidar.watch)).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ persistent: true }),
      );
    });

    it('passes persistent: false through to chokidar', () => {
      createWatcher('/tmp/x', () => {}, { persistent: false });
      expect(vi.mocked(chokidar.watch)).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ persistent: false }),
      );
    });
  });
});

describe('messaging-codec-generic', () => {
  const MESSAGING_FILES = [
    'src/foundation/messaging/types.ts',
    'src/foundation/messaging/codec-inbox.ts',
    'src/foundation/messaging/codec-outbox.ts',
    'src/foundation/messaging/outbox-writer.ts',
  ];

  describe('foundation/messaging codec generic metadata invariant', () => {
    it('messaging 域不字面感知 contract_id', () => {
      for (const file of MESSAGING_FILES) {
        const src = readFileSync(file, 'utf-8');
        // ban quoted contract_id literal as string key
        const m = src.match(/['"`]contract_id['"`]/);
        if (m) {
          expect.fail(`messaging/ 持 quoted "contract_id" literal in ${file}: ${m[0]}`);
        }
        // ban schema field declaration `contract_id?: string`
        expect(src, `${file} 持 contract_id?: string field`).not.toMatch(/contract_id\?\s*:\s*string/);
        // ban hardcode `msg.contract_id` direct access
        expect(src, `${file} 持 msg.contract_id 直接访问`).not.toMatch(/msg\.contract_id/);
      }
    });

    it('messaging types.ts 提供 metadata schema', () => {
      const src = readFileSync('src/foundation/messaging/types.ts', 'utf-8');
      expect(src).toMatch(/metadata\?\s*:\s*Record<string,\s*string>/);
    });
  });
});

describe('unix-socket', () => {
  const mockDelete = vi.fn().mockResolvedValue(undefined);
  const mockFs = { delete: mockDelete };

  function createMockServer(scenario: {
    error?: { code: string };
    closeError?: Error;
  } = {}) {
    const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    return {
      once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'error' && scenario.error) {
          handler({ code: scenario.error.code } as unknown as Error);
        } else {
          (listeners[event] ||= []).push(handler);
        }
      }),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        (listeners[event] ||= []).push(handler);
      }),
      off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        const idx = listeners[event]?.indexOf(handler) ?? -1;
        if (idx !== -1) listeners[event].splice(idx, 1);
      }),
      listen: vi.fn((_path: string, cb: () => void) => {
        if (!scenario.error) cb();
      }),
      close: vi.fn((cb: (err?: Error) => void) => {
        cb(scenario.closeError);
      }),
    };
  }

  describe('UnixDomainSocketTransport', () => {
    let transport: UnixDomainSocketTransport;

    beforeEach(() => {
      vi.clearAllMocks();
      mockDelete.mockResolvedValue(undefined);
      transport = new UnixDomainSocketTransport({ fs: mockFs as unknown as import('../../src/foundation/fs/index.js').FileSystem });
    });

    it('cleans socketPath even when server.close() fails', async () => {
      const socketPath = '/tmp/test-phase971.sock';
      const mockServer = createMockServer({ closeError: new Error('EIO') });
      (createServer as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockServer);

      await transport.listen({ socketPath });
      expect((transport as { socketPath: string | null }).socketPath).toBe(socketPath);

      await expect(transport.close()).rejects.toThrow('EIO');
      expect(mockDelete).toHaveBeenCalledWith(socketPath);
      expect((transport as { socketPath: string | null }).socketPath).toBeNull();
    });

    it('does not set socketPath when listen fails', async () => {
      const socketPath = '/tmp/test-phase971.sock';
      const mockServer = createMockServer({ error: { code: 'EACCES' } });
      (createServer as ReturnType<typeof vi.fn>).mockReturnValueOnce(mockServer);

      await expect(transport.listen({ socketPath })).rejects.toThrow();
      expect((transport as { socketPath: string | null }).socketPath).toBeNull();
    });
  });
});
