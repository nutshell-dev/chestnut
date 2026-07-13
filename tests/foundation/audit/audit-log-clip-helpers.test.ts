import { describe, it, expect } from 'vitest';
import { createAuditWriter } from '../../../src/foundation/audit/index.js';
import type { FileSystem } from '../../../src/foundation/fs/types.js';

function makeMockFs(): FileSystem {
  return {
    exists: () => true,
    list: async () => [],
    read: async () => '',
    write: () => {},
    appendSync: () => {},
    syncSync: () => {},
    deleteSync: () => {},
    moveSync: () => {},
    statSync: () => ({ size: 0, mtime: new Date(), ctime: new Date(), isDirectory: false, isFile: true }),
    listSync: () => [],
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    baseDir: '/tmp',
  } as unknown as FileSystem;
}

describe('AuditLog clip helpers', () => {
  it('preview cap = 100', () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    const aw = createAuditWriter(makeMockFs(), '/tmp/audit.tsv');
    const long = 'a'.repeat(150);
    expect(aw.preview(long)).toBe('a'.repeat(100) + '…');
  });

  it('message cap = 200', () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    const aw = createAuditWriter(makeMockFs(), '/tmp/audit.tsv');
    const long = 'b'.repeat(250);
    expect(aw.message(long)).toBe('b'.repeat(200) + '…');
  });

  it('summary cap = 500', () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    const aw = createAuditWriter(makeMockFs(), '/tmp/audit.tsv');
    const long = 'c'.repeat(550);
    expect(aw.summary(long)).toBe('c'.repeat(500) + '…');
  });

  it('returns short content unchanged', () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    const aw = createAuditWriter(makeMockFs(), '/tmp/audit.tsv');
    expect(aw.preview('ok')).toBe('ok');
    expect(aw.message('ok')).toBe('ok');
    expect(aw.summary('ok')).toBe('ok');
  });

  it('trims leading whitespace', () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    const aw = createAuditWriter(makeMockFs(), '/tmp/audit.tsv');
    expect(aw.preview('   spaced')).toBe('spaced');
  });

  it('preserves newlines in content (AuditWriter esc handles escaping)', () => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    const aw = createAuditWriter(makeMockFs(), '/tmp/audit.tsv');
    expect(aw.message('line1\nline2')).toBe('line1\nline2');
  });
});
