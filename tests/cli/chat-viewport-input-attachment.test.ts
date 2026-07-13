import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { writeUserChat } from '../../src/cli/commands/chat-viewport-utils.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';

describe('writeUserChat - phase 142 attachment fallback', () => {
  let tempDir: string;
  let originalEnv: string | undefined;
  let motionDir: string;
  let fsFactory: (baseDir: string) => import('../../../src/foundation/fs/types.js').FileSystem;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase142-'));
    originalEnv = process.env.CHESTNUT_ROOT;
    process.env.CHESTNUT_ROOT = tempDir;
    motionDir = path.join(tempDir, '.chestnut', 'motion');
    fs.mkdirSync(path.join(motionDir, 'inbox', 'pending'), { recursive: true });
    fsFactory = (baseDir: string) => new NodeFileSystem({ baseDir });
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CHESTNUT_ROOT;
    } else {
      process.env.CHESTNUT_ROOT = originalEnv;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('short message → inline body (no attachment file)', () => {
    writeUserChat(motionDir, 'short message', fsFactory, 2000);

    const attachmentsDir = path.join(motionDir, 'inbox', 'attachments');
    expect(fs.existsSync(attachmentsDir)).toBe(false);

    const inboxPending = path.join(motionDir, 'inbox', 'pending');
    const files = fs.readdirSync(inboxPending);
    expect(files.length).toBe(1);
    const content = fs.readFileSync(path.join(inboxPending, files[0]), 'utf-8');
    expect(content).toContain('short message');
  });

  it('long message > maxInlineChars → attachment file written + body has placeholder', () => {
    const longMessage = 'x'.repeat(3000);
    writeUserChat(motionDir, longMessage, fsFactory, 2000);

    const attachmentsDir = path.join(motionDir, 'inbox', 'attachments');
    const attachmentFiles = fs.readdirSync(attachmentsDir);
    expect(attachmentFiles.length).toBe(1);
    const attachmentContent = fs.readFileSync(path.join(attachmentsDir, attachmentFiles[0]), 'utf-8');
    expect(attachmentContent).toBe(longMessage);

    const inboxPending = path.join(motionDir, 'inbox', 'pending');
    const inboxFiles = fs.readdirSync(inboxPending);
    expect(inboxFiles.length).toBe(1);
    const inboxContent = fs.readFileSync(path.join(inboxPending, inboxFiles[0]), 'utf-8');
    expect(inboxContent).toContain('[user-input attachment: 3000 chars]');
    expect(inboxContent).toContain('path: ../inbox/attachments/');
    expect(inboxContent).toContain('preview (first 200 chars):');
    expect(inboxContent).not.toContain(longMessage);
  });

  it('maxInlineChars override via param', () => {
    const message = 'x'.repeat(500);
    writeUserChat(motionDir, message, fsFactory, 100);

    const attachmentsDir = path.join(motionDir, 'inbox', 'attachments');
    expect(fs.existsSync(attachmentsDir)).toBe(true);
    const attachmentFiles = fs.readdirSync(attachmentsDir);
    expect(attachmentFiles.length).toBe(1);
  });

  it('attachment write failure → fallback inline (best-effort)', () => {
    // 使用 motionDir（clawId === MOTION_CLAW_ID）避免 DLQ 路径干扰
    const failingFsFactory = (baseDir: string) => {
      const realFs = new NodeFileSystem({ baseDir });
      return new Proxy(realFs, {
        get(target, prop) {
          if (prop === 'writeAtomicSync') {
            return (relativePath: string, content: string) => {
              if (relativePath.includes('attachments/')) {
                throw new Error('disk full');
              }
              return target.writeAtomicSync(relativePath, content);
            };
          }
          return (target as Record<string, unknown>)[prop as string];
        },
      }) as import('../../src/foundation/fs/types.js').FileSystem;
    };

    const longMessage = 'x'.repeat(3000);
    expect(() => {
      writeUserChat(motionDir, longMessage, failingFsFactory, 2000);
    }).not.toThrow();

    // inbox 中应包含完整消息（fallback inline）
    const inboxPending = path.join(motionDir, 'inbox', 'pending');
    const inboxFiles = fs.readdirSync(inboxPending);
    const latestFile = inboxFiles.sort().at(-1);
    expect(latestFile).toBeDefined();
    const inboxContent = fs.readFileSync(path.join(inboxPending, latestFile!), 'utf-8');
    expect(inboxContent).toContain(longMessage);
  });

  it('phase 142 Step B: writeUserChat reads config-injected threshold', () => {
    // 4000 字符 message + 阈值 4000 → 仍 inline（边界、严格 >）
    writeUserChat(motionDir, 'x'.repeat(4000), fsFactory, 4000);
    let attachmentsDir = path.join(motionDir, 'inbox', 'attachments');
    expect(fs.existsSync(attachmentsDir)).toBe(false);

    // 4001 字符 → 触发 attachment
    writeUserChat(motionDir, 'x'.repeat(4001), fsFactory, 4000);
    attachmentsDir = path.join(motionDir, 'inbox', 'attachments');
    expect(fs.existsSync(attachmentsDir)).toBe(true);
    const attachmentFiles = fs.readdirSync(attachmentsDir);
    expect(attachmentFiles.length).toBe(1);
  });
});
