import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { NodeFileSystem } from '../../src/foundation/fs/index.js';
import { createTempDir, cleanupTempDir } from '../utils/temp.js';
import { createToolRegistry } from '../../src/foundation/tools/index.js';
import { createFileTools } from '../../src/foundation/file-tool/index.js';
import { wireClawTopology } from '../../src/assembly/wire-claw-topology.js';
import { MOTION_CLAW_ID } from '../../src/constants.js';
import { CLAW_TOPOLOGY_AUDIT_EVENTS } from '../../src/core/claw-topology/audit-events.js';
import type { ExecContext } from '../../src/foundation/tools/index.js';
import type { AuditLog } from '../../src/foundation/audit/index.js';

describe('wireClawTopology', () => {
  let tempDir: string;
  let fs: NodeFileSystem;
  let auditWrites: [string, ...(string | number)[]][];

  beforeEach(async () => {
    tempDir = await createTempDir();
    fs = new NodeFileSystem({ baseDir: tempDir });
    auditWrites = [];
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  function makeAudit(): AuditLog {
    return {
      write: vi.fn((...args: [string, ...(string | number)[]]) => {
        auditWrites.push(args);
      }),
      preview: vi.fn((s: string) => s),
      message: vi.fn((s: string) => s),
      summary: vi.fn((s: string) => s),
      __brand: 'AuditLog',
    } as unknown as AuditLog;
  }

  function setup() {
    const toolRegistry = createToolRegistry();
    for (const tool of createFileTools()) {
      toolRegistry.register(tool);
    }
    const topology = wireClawTopology({
      fs,
      chestnutRoot: tempDir,
      toolRegistry,
      motionClawId: MOTION_CLAW_ID,
    });
    return { toolRegistry, topology };
  }

  function makeCtx(overrides?: Partial<ExecContext>): ExecContext {
    const motionDir = path.join(tempDir, 'motion');
    const workspaceDir = path.join(motionDir, 'clawspace');
    return {
      clawId: MOTION_CLAW_ID,
      clawDir: motionDir,
      clawsDir: path.join(tempDir, 'claws'),
      workspaceDir,
      syncDir: path.join(motionDir, 'sync'),
      isMotionChain: true,
      profile: 'full',
      allowedGroups: new Set(['fs-read']),
      callerLabel: 'motion',
      fs: new NodeFileSystem({ baseDir: motionDir }),
      fsFactory: (dir: string) => new NodeFileSystem({ baseDir: dir }),
      stepNumber: 1,
      maxSteps: 100,
      stopRequested: false,
      requestStop: vi.fn(),
      getElapsedMs: vi.fn().mockReturnValue(0),
      incrementStep: vi.fn(),
      readFileState: new Map(),
      auditWriter: makeAudit(),
      permissionChecker: {
        checkRead: () => {},
        checkWrite: () => {},
        resolveAndCheck: (relPath: string) => relPath,
      },
      ...overrides,
    } as ExecContext;
  }

  it('wire 后 toolRegistry.get("read") 是 wrap 版本（schema 含 claw 字段）', () => {
    const { toolRegistry } = setup();
    const read = toolRegistry.get('read');
    expect(read).toBeDefined();
    expect(read!.schema.properties).toHaveProperty('claw');
  });

  it('wire 后 toolRegistry.get("ls") 是 wrap 版本（schema 含 claw 字段）', () => {
    const { toolRegistry } = setup();
    const ls = toolRegistry.get('ls');
    expect(ls).toBeDefined();
    expect(ls!.schema.properties).toHaveProperty('claw');
  });

  it('wire 后 toolRegistry.get("search") 是 wrap 版本（schema 含 claw 字段）', () => {
    const { toolRegistry } = setup();
    const search = toolRegistry.get('search');
    expect(search).toBeDefined();
    expect(search!.schema.properties).toHaveProperty('claw');
  });

  it('wire 后调 read 不传 claw → 行为透明 delegate base（同 claw read）', async () => {
    const motionDir = path.join(tempDir, 'motion');
    const filePath = path.join(motionDir, 'clawspace', 'test.txt');
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeAtomic(filePath, 'hello motion');

    const { toolRegistry } = setup();
    const ctx = makeCtx();
    const result = await toolRegistry.get('read')!.execute({ path: 'test.txt' }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toBe('hello motion');
  });

  it('wire 后调 read 传 claw="<id>" → cross-claw（改 ctx + base execute）', async () => {
    const targetDir = path.join(tempDir, 'claws', 'target');
    const filePath = path.join(targetDir, 'clawspace', 'test.txt');
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeAtomic(filePath, 'hello target');

    const { toolRegistry } = setup();
    const callerReadFileState = new Map();
    const ctx = makeCtx({ readFileState: callerReadFileState });
    const result = await toolRegistry.get('read')!.execute({ path: 'test.txt', claw: 'target' }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toBe('hello target');
    // caller readFileState 不污染
    expect(callerReadFileState.size).toBe(0);
  });

  it('wire 后调 search 传 claw="*"、非 motion caller → 拒 + audit', async () => {
    const { toolRegistry } = setup();
    const audit = makeAudit();
    const ctx = makeCtx({
      clawId: 'claw1',
      isMotionChain: false,
      auditWriter: audit,
    });
    const result = await toolRegistry.get('search')!.execute({ query: 'foo', claw: '*' }, ctx);
    expect(result.success).toBe(false);
    expect(result.content).toContain('broadcast');
    expect(audit.write).toHaveBeenCalledWith(
      CLAW_TOPOLOGY_AUDIT_EVENTS.CROSS_CLAW_BROADCAST_MOTION_ONLY_VIOLATION,
      expect.any(String),
      expect.any(String),
    );
  });
});
