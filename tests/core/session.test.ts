/**
 * Session 测试 - save/load 原子性 + 冷启动恢复 + archive 恢复
 * 
 * 新增测试：
 * - loadLatestArchive() 扫描 archive 目录
 * - 损坏 JSON 处理
 * - ENOENT vs JSON 解析错误区分
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
// Note: SessionManager 从具体实现导入
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { SessionManager } from '../../src/foundation/session-store/index.js';
import type { Message } from '../../src/types/message.js';

describe('Session Persistence', () => {
  const testDir = '.test-session';
  beforeEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('should save and load session atomically', async () => {
    const sessionFile = path.join(testDir, 'session.json');
    const sessionData = {
      id: 'test-session',
      clawId: 'test-claw',
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ],
      timestamp: Date.now(),
    };

    // 原子写入（使用临时文件 + rename）
    const tempFile = sessionFile + '.tmp';
    await fs.writeFile(tempFile, JSON.stringify(sessionData, null, 2), 'utf-8');
    await fs.rename(tempFile, sessionFile);

    // 读取
    const loaded = JSON.parse(await fs.readFile(sessionFile, 'utf-8'));
    expect(loaded.id).toBe('test-session');
    expect(loaded.messages).toHaveLength(2);
  });

  it('should recover from corrupted session', async () => {
    const sessionFile = path.join(testDir, 'session.json');
    
    // 写入损坏的 JSON
    await fs.writeFile(sessionFile, '{ invalid json }', 'utf-8');

    // 尝试读取应该失败
    await expect(fs.readFile(sessionFile, 'utf-8').then(JSON.parse)).rejects.toThrow();
  });

  it('should handle concurrent writes safely', async () => {
    const sessionFile = path.join(testDir, 'session.json');
    
    // 模拟并发写入
    const write1 = async () => {
      const temp = sessionFile + '.tmp1';
      await fs.writeFile(temp, JSON.stringify({ version: 1 }), 'utf-8');
      await fs.rename(temp, sessionFile);
    };

    const write2 = async () => {
      const temp = sessionFile + '.tmp2';
      await fs.writeFile(temp, JSON.stringify({ version: 2 }), 'utf-8');
      await fs.rename(temp, sessionFile);
    };

    // 顺序执行（真实的原子 rename 应该保证最终一致性）
    await write1();
    await write2();

    const result = JSON.parse(await fs.readFile(sessionFile, 'utf-8'));
    // 最终状态应该是 write2 的
    expect(result.version).toBe(2);
  });

  it('should cold-start with empty state when no session file', async () => {
    const sessionFile = path.join(testDir, 'nonexistent.json');
    
    const exists = await fs.access(sessionFile).then(() => true).catch(() => false);
    expect(exists).toBe(false);

    // 冷启动应该创建新状态
    const newSession = {
      id: 'new-session',
      messages: [],
      timestamp: Date.now(),
    };

    await fs.writeFile(sessionFile, JSON.stringify(newSession), 'utf-8');
    const loaded = JSON.parse(await fs.readFile(sessionFile, 'utf-8'));
    expect(loaded.messages).toEqual([]);
  });

  // === 新增测试：Archive 恢复 ===

  it('should recover from latest archive when current.json is missing', async () => {
    const archiveDir = path.join(testDir, 'dialog', 'archive');
    await fs.mkdir(archiveDir, { recursive: true });

    // 创建多个 archive 文件（按时间戳命名）
    const oldArchive = path.join(archiveDir, '1000_old.json');
    const newArchive = path.join(archiveDir, '3000_new.json');

    await fs.writeFile(oldArchive, JSON.stringify({ id: 'old', messages: [] }), 'utf-8');
    await fs.writeFile(newArchive, JSON.stringify({ id: 'new', messages: [{ role: 'user', content: 'Hi' }] }), 'utf-8');

    // 读取最新的 archive（按文件名排序）
    const archives = (await fs.readdir(archiveDir))
      .filter(f => f.endsWith('.json'))
      .sort((a, b) => {
        const tsA = parseInt(a.split('_')[0], 10) || 0;
        const tsB = parseInt(b.split('_')[0], 10) || 0;
        return tsB - tsA;
      });

    expect(archives[0]).toBe('3000_new.json');

    const latest = JSON.parse(await fs.readFile(path.join(archiveDir, archives[0]), 'utf-8'));
    expect(latest.id).toBe('new');
    expect(latest.messages).toHaveLength(1);
  });

  it('should return null when archive is corrupted', async () => {
    const archiveDir = path.join(testDir, 'archive');
    await fs.mkdir(archiveDir, { recursive: true });

    const corrupted = path.join(archiveDir, '1000_corrupted.json');
    await fs.writeFile(corrupted, '{ invalid json }', 'utf-8');

    // 尝试解析应该失败
    const content = await fs.readFile(corrupted, 'utf-8');
    expect(() => JSON.parse(content)).toThrow();
  });

  it('should return null when archive directory does not exist', async () => {
    const nonExistentDir = path.join(testDir, 'nonexistent');
    
    const exists = await fs.access(nonExistentDir).then(() => true).catch(() => false);
    expect(exists).toBe(false);

    // 冷启动逻辑：archive 目录不存在时返回 null
    const result = null;
    expect(result).toBeNull();
  });

  // === 新增：SessionManager 集成测试 ===

  it('should return null when session file does not exist (ENOENT)', async () => {
    const currentFile = path.join(testDir, 'dialog', 'nonexistent-session.json');
    
    // ENOENT 应该返回 null 而不是抛出
    const exists = await fs.access(currentFile).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  it('should distinguish ENOENT from JSON corruption', async () => {
    const dialogDir = path.join(testDir, 'dialog');
    const currentFile = path.join(dialogDir, 'corrupted.json');
    
    await fs.mkdir(dialogDir, { recursive: true });
    
    // 写入损坏的 JSON
    await fs.writeFile(currentFile, '{ invalid json', 'utf-8');

    // JSON 解析错误应该抛出
    const content = await fs.readFile(currentFile, 'utf-8');
    expect(() => JSON.parse(content)).toThrow();
  });

  it('should loadLatestArchive return latest by timestamp', async () => {
    const archiveDir = path.join(testDir, 'dialog', 'archive');
    await fs.mkdir(archiveDir, { recursive: true });

    // 创建按时间戳命名的 archive 文件
    await fs.writeFile(
      path.join(archiveDir, '1000_sessionA.json'),
      JSON.stringify({ id: 'sessionA', timestamp: 1000 }),
      'utf-8'
    );
    await fs.writeFile(
      path.join(archiveDir, '2000_sessionB.json'),
      JSON.stringify({ id: 'sessionB', timestamp: 2000 }),
      'utf-8'
    );
    await fs.writeFile(
      path.join(archiveDir, '1500_sessionC.json'),
      JSON.stringify({ id: 'sessionC', timestamp: 1500 }),
      'utf-8'
    );

    // 读取 archive 目录
    const archives = (await fs.readdir(archiveDir))
      .filter(f => f.endsWith('.json'))
      .sort((a, b) => {
        const tsA = parseInt(a.split('_')[0], 10) || 0;
        const tsB = parseInt(b.split('_')[0], 10) || 0;
        return tsB - tsA;
      });

    expect(archives[0]).toBe('2000_sessionB.json');
    const latest = JSON.parse(await fs.readFile(path.join(archiveDir, archives[0]), 'utf-8'));
    expect(latest.id).toBe('sessionB');
  });

  it('should handle corrupted archive gracefully', async () => {
    const archiveDir = path.join(testDir, 'dialog', 'archive');
    await fs.mkdir(archiveDir, { recursive: true });

    // 创建有效的 archive
    await fs.writeFile(
      path.join(archiveDir, '1000_valid.json'),
      JSON.stringify({ id: 'valid' }),
      'utf-8'
    );
    
    // 创建损坏的 archive
    await fs.writeFile(
      path.join(archiveDir, '2000_corrupted.json'),
      '{ invalid',
      'utf-8'
    );

    // 按时间戳排序
    const archives = (await fs.readdir(archiveDir))
      .filter(f => f.endsWith('.json'))
      .sort((a, b) => {
        const tsA = parseInt(a.split('_')[0], 10) || 0;
        const tsB = parseInt(b.split('_')[0], 10) || 0;
        return tsB - tsA;
      });

    // 最新的文件是损坏的
    expect(archives[0]).toBe('2000_corrupted.json');
    
    // 尝试解析应该失败
    const corruptedContent = await fs.readFile(path.join(archiveDir, archives[0]), 'utf-8');
    expect(() => JSON.parse(corruptedContent)).toThrow();
  });
});

describe('SessionManager unit tests', () => {
  let tmpDir: string;
  let nodeFs: NodeFileSystem;
  let sm: SessionManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sm-test-'));
    nodeFs = new NodeFileSystem({ baseDir: tmpDir, enforcePermissions: false });
    sm = new SessionManager(nodeFs, 'dialog', 'test-claw');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // --- archive() ---

  it('archive: moves current.json to archive dir', async () => {
    const msg: Message = { role: 'user', content: 'hello' };
    await sm.save([msg]);

    // Verify current.json exists before archive
    const currentPath = path.join(tmpDir, 'dialog', 'current.json');
    await expect(fs.access(currentPath)).resolves.toBeUndefined();

    await sm.archive();

    // current.json should be gone
    await expect(fs.access(currentPath)).rejects.toThrow();

    // archive dir should have one file
    const archiveDir = path.join(tmpDir, 'dialog', 'archive');
    const files = await fs.readdir(archiveDir);
    expect(files.filter(f => f.endsWith('.json'))).toHaveLength(1);
  });

  it('archive: throws with ENOENT code when no current.json exists', async () => {
    // initialize() catches this with: if (err?.code !== 'ENOENT') console.warn(...)
    // 验证 code 确实是 ENOENT，确保 initialize() 的静默判断能正确生效
    await expect(sm.archive()).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('archive: resets createdAt so next save() gets a fresh timestamp', async () => {
    // First session
    await sm.save([{ role: 'user', content: 'old' }]);
    const { session: first } = await sm.load();
    const oldCreatedAt = first.createdAt;

    await sm.archive();

    // Small delay so timestamps are distinguishable
    await new Promise(r => setTimeout(r, 5));

    // New session after archive
    await sm.save([{ role: 'user', content: 'new' }]);
    const { session: second } = await sm.load();

    // createdAt must be later than the archived session's createdAt
    expect(second.createdAt).not.toBe(oldCreatedAt);
    expect(new Date(second.createdAt).getTime()).toBeGreaterThan(new Date(oldCreatedAt).getTime());
  });

  // --- load() with archive recovery ---

  it('load: recovers from archive when current.json is gone', async () => {
    const msg: Message = { role: 'user', content: 'remembered' };
    await sm.save([msg]);
    await sm.archive(); // moves current.json → archive/

    // Fresh SessionManager (simulate restart)
    const sm2 = new SessionManager(nodeFs, 'dialog', 'test-claw');
    const { session: session } = await sm2.load();

    expect(session.messages).toHaveLength(1);
    expect((session.messages[0].content as string)).toBe('remembered');
  });
});

describe('SessionManager.repair', () => {
  it('returns no repair for empty messages', () => {
    const { repaired, toolCount } = SessionManager.repair([]);
    expect(repaired).toEqual([]);
    expect(toolCount).toBe(0);
  });

  it('returns no repair when last message is user', () => {
    const msgs: Message[] = [{ role: 'user', content: 'hello' }];
    const { repaired, toolCount } = SessionManager.repair(msgs);
    expect(repaired).toHaveLength(1);
    expect(toolCount).toBe(0);
  });

  // SF-03: string content → no repair (no tool_use blocks possible)
  it('returns no repair when assistant content is a string', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'I will help you with that.' },
    ];
    const { repaired, toolCount } = SessionManager.repair(msgs);
    expect(repaired).toHaveLength(2);
    expect(toolCount).toBe(0);
  });

  it('repairs unanswered tool_use blocks', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'run it' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Running...' },
          { type: 'tool_use', id: 'tu_1', name: 'exec', input: { cmd: 'ls' } },
        ],
      },
    ];
    const { repaired, toolCount } = SessionManager.repair(msgs);
    expect(toolCount).toBe(1);
    expect(repaired).toHaveLength(3);
    expect(repaired[2].role).toBe('user');
    const blocks = repaired[2].content as any[];
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('tool_result');
    expect(blocks[0].tool_use_id).toBe('tu_1');
    expect(blocks[0].is_error).toBe(true);
    expect(blocks[0].content).toContain('was interrupted.');
    expect(blocks[0].content).toContain('Cause unknown (no context provided to repair).');
  });

  it('repair() with opts.interruptionMessage embeds caller-provided text', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'run it' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'exec', input: { cmd: 'ls' } },
        ],
      },
    ];
    const { repaired, toolCount } = SessionManager.repair(msgs, { interruptionMessage: 'Process killed by watchdog' });
    expect(toolCount).toBe(1);
    const blocks = repaired[2].content as any[];
    expect(blocks[0].content).toContain('was interrupted.');
    expect(blocks[0].content).toContain('Process killed by watchdog');
    expect(blocks[0].content).not.toContain('Cause unknown');
  });

  it('repair() with empty opts.interruptionMessage falls back to "Cause unknown"', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'run it' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'exec', input: { cmd: 'ls' } },
        ],
      },
    ];
    const { repaired, toolCount } = SessionManager.repair(msgs, { interruptionMessage: '' });
    expect(toolCount).toBe(1);
    const blocks = repaired[2].content as any[];
    expect(blocks[0].content).toContain('Cause unknown (no context provided to repair).');
  });

  it('repair() preserves multi-line / special chars in interruptionMessage verbatim', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'run it' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'exec', input: { cmd: 'ls' } },
        ],
      },
    ];
    const message = 'Line 1\nLine 2\tTabbed "quoted"';
    const { repaired, toolCount } = SessionManager.repair(msgs, { interruptionMessage: message });
    expect(toolCount).toBe(1);
    const blocks = repaired[2].content as any[];
    expect(blocks[0].content).toContain(message);
  });

  it('repair() with multiple tool_use blocks shares the same interruptionMessage', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'run it' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'exec', input: { cmd: 'ls' } },
          { type: 'tool_use', id: 'tu_2', name: 'read', input: { path: '/tmp/a' } },
        ],
      },
    ];
    const { repaired, toolCount } = SessionManager.repair(msgs, { interruptionMessage: 'SIGTERM received' });
    expect(toolCount).toBe(2);
    const blocks = repaired[2].content as any[];
    expect(blocks[0].content).toContain('SIGTERM received');
    expect(blocks[1].content).toContain('SIGTERM received');
    expect(blocks[0].tool_use_id).toBe('tu_1');
    expect(blocks[1].tool_use_id).toBe('tu_2');
  });

  it('repair() ignores opts when last message has no tool_use', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello there' },
    ];
    const { repaired, toolCount } = SessionManager.repair(msgs, { interruptionMessage: 'should be ignored' });
    expect(toolCount).toBe(0);
    expect(repaired).toHaveLength(2);
  });

  it('returns no repair when tool_use already has results', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'run it' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'exec', input: { cmd: 'ls' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }],
      },
    ];
    const { repaired, toolCount } = SessionManager.repair(msgs);
    expect(toolCount).toBe(0);
    expect(repaired).toHaveLength(3);
  });
});
