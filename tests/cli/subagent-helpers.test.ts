import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';
import { scanSubagentResults, type SubagentKind } from '../../src/cli/commands/subagent-helpers.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { TASKS_SYNC_SPAWN_DIR } from '../../src/core/spawn-system/constants.js';
import { TASKS_SYNC_SHADOW_DIR } from '../../src/core/shadow-system/constants.js';

describe('subagent-helpers SubagentKind', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTrackedTempDir('subagent-helpers-test-');
  });
  afterEach(async () => {
    await cleanupTempDir(tmpDir);
  });

  it('SubagentKind union 含 shadow 成员（compile-time）', () => {
    const s: SubagentKind = 'shadow';
    expect(s).toBe('shadow');
  });

  it('scanSyncDir 走 shadow path 返 kind shadow', () => {
    const shadowDir = path.join(tmpDir, TASKS_SYNC_SHADOW_DIR);
    fs.mkdirSync(path.join(shadowDir, 'shadow-abc'), { recursive: true });
    // 模拟 audit.tsv 含 task_completed 让 inferStatus 返 completed
    fs.writeFileSync(path.join(shadowDir, 'shadow-abc', 'audit.tsv'),
      `${new Date().toISOString()}\tshadow_start\tabc\n${new Date().toISOString()}\ttask_completed\tabc\n`);

    const fsFactory = (dir: string) => {
      const fs = new NodeFileSystem({ baseDir: dir });
      const orig = fs.listSync.bind(fs);
      fs.listSync = (p: string, opts?: any) => orig(p, { ...opts, includeDirs: true });
      return fs;
    };
    const entries = scanSubagentResults({ fsFactory }, tmpDir);
    const shadowEntry = entries.find(e => e.id === 'shadow-abc');
    expect(shadowEntry).toBeDefined();
    expect(shadowEntry!.kind).toBe('shadow');
  });

  it('scanSyncDir 走 spawn path 返 kind spawn 不走 inferKind 错位', () => {
    const spawnDir = path.join(tmpDir, TASKS_SYNC_SPAWN_DIR);
    fs.mkdirSync(path.join(spawnDir, 'spawn-xyz'), { recursive: true });
    fs.writeFileSync(path.join(spawnDir, 'spawn-xyz', 'audit.tsv'),
      `${new Date().toISOString()}\tspawn_start\txyz\n${new Date().toISOString()}\ttask_completed\txyz\n`);

    const fsFactory = (dir: string) => {
      const fs = new NodeFileSystem({ baseDir: dir });
      const orig = fs.listSync.bind(fs);
      fs.listSync = (p: string, opts?: any) => orig(p, { ...opts, includeDirs: true });
      return fs;
    };
    const entries = scanSubagentResults({ fsFactory }, tmpDir);
    const spawnEntry = entries.find(e => e.id === 'spawn-xyz');
    expect(spawnEntry).toBeDefined();
    expect(spawnEntry!.kind).toBe('spawn');
  });
});
