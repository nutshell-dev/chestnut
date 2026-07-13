/**
 * phase 320 Step D: notifyRunningDaemons producer 侧测试。
 *
 * 用 self pid + 真实 fs（tmpDir + CHESTNUT_ROOT env override）走端到端：
 *   - daemon 存活（pid 文件存在 + kill(self,0) 成功）→ inbox/pending/ 出现 reload 消息
 *   - daemon 不存活（无 pid 文件）→ silent skip，无消息写入
 *   - 多 daemon（motion + 2 claws）→ 各自 inbox 都有
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { notifyRunningDaemons } from '../../../src/cli/commands/config.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

function writePidFile(rootDir: string, agentSubpath: string, pid: number) {
  const statusDir = path.join(rootDir, '.chestnut', agentSubpath, 'status');
  fs.mkdirSync(statusDir, { recursive: true });
  fs.writeFileSync(path.join(statusDir, 'pid'), JSON.stringify({ pid }));
}

function listInbox(rootDir: string, agentSubpath: string): string[] {
  const inboxDir = path.join(rootDir, '.chestnut', agentSubpath, 'inbox', 'pending');
  if (!fs.existsSync(inboxDir)) return [];
  return fs
    .readdirSync(inboxDir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.md'))
    .map(e => e.name);
}

describe('phase 320 Step D: notifyRunningDaemons', () => {
  let tmpDir: string;
  let originalRoot: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chestnut-reload-test-'));
    originalRoot = process.env.CHESTNUT_ROOT;
    process.env.CHESTNUT_ROOT = tmpDir;
    // Ensure chestnut root exists
    fs.mkdirSync(path.join(tmpDir, '.chestnut'), { recursive: true });
  });

  afterEach(() => {
    if (originalRoot === undefined) delete process.env.CHESTNUT_ROOT;
    else process.env.CHESTNUT_ROOT = originalRoot;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('motion 存活 → reload 消息写入 motion inbox', () => {
    writePidFile(tmpDir, 'motion', process.pid);

    notifyRunningDaemons({ fsFactory }, 'set-primary');

    const motionInbox = listInbox(tmpDir, 'motion');
    expect(motionInbox.length).toBe(1);
    const fileBody = fs.readFileSync(
      path.join(tmpDir, '.chestnut', 'motion', 'inbox', 'pending', motionInbox[0]),
      'utf8',
    );
    expect(fileBody).toContain('type: reload_llm_config');
    expect(fileBody).toMatch(/from:\s*"?cli-set-primary"?/);
    expect(fileBody).toContain('priority: high');
  });

  it('motion 不存活（无 pid 文件）→ silent skip、无 inbox 消息、无 throw', () => {
    expect(() => notifyRunningDaemons({ fsFactory }, 'remove')).not.toThrow();
    expect(listInbox(tmpDir, 'motion')).toEqual([]);
  });

  it('motion + 2 claws 都存活 → 三方 inbox 各有 1 条 reload 消息', () => {
    writePidFile(tmpDir, 'motion', process.pid);
    writePidFile(tmpDir, 'claws/foo', process.pid);
    writePidFile(tmpDir, 'claws/bar', process.pid);

    notifyRunningDaemons({ fsFactory }, 'set-primary');

    expect(listInbox(tmpDir, 'motion').length).toBe(1);
    expect(listInbox(tmpDir, 'claws/foo').length).toBe(1);
    expect(listInbox(tmpDir, 'claws/bar').length).toBe(1);
  });

  it('混合：motion 存活、1 claw 死 → 仅 motion 收到', () => {
    writePidFile(tmpDir, 'motion', process.pid);
    // 写一个不存在的 pid（pid 0 / 大概率 dead）
    writePidFile(tmpDir, 'claws/dead', 999999);

    notifyRunningDaemons({ fsFactory }, 'add');

    expect(listInbox(tmpDir, 'motion').length).toBe(1);
    expect(listInbox(tmpDir, 'claws/dead').length).toBe(0);
  });
});
