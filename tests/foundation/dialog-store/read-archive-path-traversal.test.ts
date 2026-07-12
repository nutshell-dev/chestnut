import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DialogStore } from '../../../src/foundation/dialog-store/store.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

describe('DialogStore readArchive path containment (phase 921)', () => {
  let tempDir: string;
  let fs: NodeFileSystem;
  let audit: ReturnType<typeof makeAudit>;
  let store: DialogStore;
  const filename = 'current.json';
  const clawId = 'test-claw';

  beforeEach(async () => {
    tempDir = await createTempDir();
    fs = new NodeFileSystem({ baseDir: tempDir });
    audit = makeAudit();
    store = new DialogStore(fs, '', audit.audit, filename, clawId);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('rejects path traversal in readArchive', async () => {
    await expect(store.readArchive('../../current.json')).rejects.toThrow(/Invalid archive filename/);
  });

  it('rejects nested path traversal in readArchive', async () => {
    await expect(store.readArchive('foo/../../current.json')).rejects.toThrow(/Invalid archive filename/);
  });

  it('rejects directory traversal dots in readArchive', async () => {
    await expect(store.readArchive('..')).rejects.toThrow(/Invalid archive filename/);
  });
});
