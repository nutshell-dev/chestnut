import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { writeUserChat } from '../../../src/cli/commands/chat-viewport-utils.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

describe('phase 1388 Bug A: writeUserChat 普通 claw 不嵌套 claws/claws/', () => {
  let tempDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1388-bug-a-'));
    originalEnv = process.env.CHESTNUT_ROOT;
    process.env.CHESTNUT_ROOT = tempDir;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CHESTNUT_ROOT;
    } else {
      process.env.CHESTNUT_ROOT = originalEnv;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('writeUserChat for regular claw writes to .chestnut/claws/<id>/inbox/pending (NOT claws/claws/)', () => {
    const clawDir = path.join(tempDir, '.chestnut', 'claws', 'test-claw');
    fs.mkdirSync(path.join(clawDir, 'inbox', 'pending'), { recursive: true });

    const fsFactory = (baseDir: string) => new NodeFileSystem({ baseDir });

    expect(() => {
      writeUserChat(clawDir, 'test message', fsFactory);
    }).not.toThrow();

    // 正确路径有文件
    const inboxPending = path.join(tempDir, '.chestnut', 'claws', 'test-claw', 'inbox', 'pending');
    const files = fs.readdirSync(inboxPending);
    expect(files.length).toBe(1);

    // 嵌套路径不存在
    const nestedWrong = path.join(tempDir, '.chestnut', 'claws', 'claws', 'test-claw');
    expect(fs.existsSync(nestedWrong)).toBe(false);
  });

  it('writeUserChat for Motion writes to .chestnut/motion/inbox/pending (regression-guard)', () => {
    const motionDir = path.join(tempDir, '.chestnut', 'motion');
    fs.mkdirSync(path.join(motionDir, 'inbox', 'pending'), { recursive: true });

    const fsFactory = (baseDir: string) => new NodeFileSystem({ baseDir });

    expect(() => {
      writeUserChat(motionDir, 'motion test', fsFactory);
    }).not.toThrow();

    const inboxPending = path.join(tempDir, '.chestnut', 'motion', 'inbox', 'pending');
    const files = fs.readdirSync(inboxPending);
    expect(files.length).toBe(1);
  });
});
