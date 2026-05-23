import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as nativePath from 'path';
import * as nativeFs from 'fs';
import * as os from 'os';
import { StreamWriter, STREAM_FILE } from '../../src/foundation/stream/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/index.js';
import { createAuditWriter, type AuditLog } from '../../src/foundation/audit/index.js';

describe('StreamWriter open() race-safe (phase 1120)', () => {
  let tempDir: string;
  let fs: NodeFileSystem;
  let audit: AuditLog;
  let auditPath: string;
  let streamPath: string;

  beforeEach(() => {
    tempDir = nativeFs.mkdtempSync(nativePath.join(os.tmpdir(), 'stream-race-'));
    fs = new NodeFileSystem({ baseDir: tempDir });
    auditPath = nativePath.join(tempDir, 'audit.tsv');
    audit = createAuditWriter(fs, auditPath);
    streamPath = nativePath.join(tempDir, STREAM_FILE);
  });

  afterEach(() => {
    nativeFs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('normal path: exclusive create empty file + emit WRITER_OPEN_CREATED_EMPTY', () => {
    const w = new StreamWriter(fs, audit);
    w.open();
    expect(nativeFs.existsSync(streamPath)).toBe(true);
    expect(nativeFs.readFileSync(streamPath, 'utf-8')).toBe('');
    const auditContent = nativeFs.readFileSync(auditPath, 'utf-8');
    expect(auditContent).toMatch(/stream_writer_open_created_empty/);
    expect(auditContent).not.toMatch(/stream_writer_open_preserved_raced/);
  });

  it('race won path: pre-create with CLI content → exclusive create EEXIST → preserve + emit WRITER_OPEN_PRESERVED_RACED', () => {
    // 1) 先让第一次 open() 完成 archive（清场）
    const w1 = new StreamWriter(fs, audit);
    w1.open();

    // 2) 模拟 CLI cross-process append: 在 daemon 新 session open() 前写入
    const cliLine = JSON.stringify({ ts: 100, type: 'user_notify', subtype: 'contract_created', contractId: 'c-001' }) + '\n';
    nativeFs.writeFileSync(streamPath, cliLine);

    // 3) 新 StreamWriter，mock existsSync 跳过 archive 阶段，直接触发 create EEXIST
    const fsSpy = new NodeFileSystem({ baseDir: tempDir });
    vi.spyOn(fsSpy, 'existsSync').mockReturnValue(false);

    const w2 = new StreamWriter(fsSpy, audit);
    w2.open();

    // CLI 写完整保留（不被覆盖）
    expect(nativeFs.readFileSync(streamPath, 'utf-8')).toBe(cliLine);

    // audit emit WRITER_OPEN_PRESERVED_RACED
    const auditContent = nativeFs.readFileSync(auditPath, 'utf-8');
    expect(auditContent).toMatch(/stream_writer_open_preserved_raced/);
    expect(auditContent).toMatch(/cli_cross_process_append_race_won/);
    expect(auditContent).toMatch(new RegExp(`bytes=${cliLine.length}`));
  });

  it('race won path: subsequent write() appends after CLI content', () => {
    // 1) 先让第一次 open() 完成 archive（清场）
    const w1 = new StreamWriter(fs, audit);
    w1.open();

    // 2) 模拟 CLI cross-process append
    const cliLine = JSON.stringify({ ts: 100, type: 'user_notify' }) + '\n';
    nativeFs.writeFileSync(streamPath, cliLine);

    // 3) 新 StreamWriter，mock existsSync 跳过 archive
    const fsSpy = new NodeFileSystem({ baseDir: tempDir });
    vi.spyOn(fsSpy, 'existsSync').mockReturnValue(false);

    const w2 = new StreamWriter(fsSpy, audit);
    w2.open();
    w2.write({ ts: 200, type: 'daemon_evt' });

    const content = nativeFs.readFileSync(streamPath, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ ts: 100, type: 'user_notify' });
    expect(JSON.parse(lines[1])).toMatchObject({ ts: 200, type: 'daemon_evt' });
  });
});
