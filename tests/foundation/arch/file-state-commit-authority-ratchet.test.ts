/**
 * Phase 1229 Step A: read-state commit authority ratchet.
 *
 * FileTool owns the overwrite-gate entry/schema and the persistence primitive.
 * Runtime owns the timing: one aggregated snapshot is persisted only after the
 * complete step's dialog snapshot has been saved. This ratchet prevents the
 * fire-and-forget per-mutation persist and its Promise-chain drain from
 * returning to FileTool, and prevents Runtime from constructing its own chain.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const repoRoot = path.resolve(__dirname, '../../..');
const srcRoot = path.join(repoRoot, 'src');
const testsRoot = path.join(repoRoot, 'tests');
const selfFile = path.resolve(__filename);

function grep(pattern: string, roots: string[]): string[] {
  const cmd = `grep -rnE "${pattern}" ${roots.join(' ')} --include='*.ts' || true`;
  const out = execSync(cmd, { encoding: 'utf8' }).trim();
  return out === '' ? [] : out.split('\n');
}

function fileOf(line: string): string {
  return path.resolve(repoRoot, line.split(':')[0]);
}

describe('Phase 1229 Step A: read-state commit authority ratchet', () => {
  it('FileTool source contains no fire-and-forget persist or per-ctx Promise-chain', () => {
    const roots = [path.join(srcRoot, 'foundation', 'file-tool')];
    const patterns = [
      'inflightPersist',
      'WeakMap<ExecContext, Promise<void>>',
      'persistReadFileState\\(ctx\\)\\.catch',
      'void persistReadFileState',
    ];
    const offenders: string[] = [];
    for (const pattern of patterns) {
      offenders.push(...grep(pattern, roots));
    }
    expect(offenders.filter(line => fileOf(line) !== selfFile)).toEqual([]);
  });

  it('file-state-manager.ts no longer imports or calls persistReadFileState', () => {
    const file = path.join(srcRoot, 'foundation', 'file-tool', 'file-state-manager.ts');
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toContain('persistReadFileState');
    expect(text).not.toContain('READ_FILE_STATE_PERSIST_FAILED');
  });

  it('Runtime does not introduce its own read-state Promise-chain', () => {
    const roots = [path.join(srcRoot, 'core', 'runtime')];
    const patterns = [
      'inflightPersist',
      'WeakMap<ExecContext, Promise<void>>',
      'new Promise.*readFileState',
    ];
    const offenders: string[] = [];
    for (const pattern of patterns) {
      offenders.push(...grep(pattern, roots));
    }
    expect(offenders.filter(line => fileOf(line) !== selfFile)).toEqual([]);
  });

  it('Runtime step-commit protocol keeps dialog save before read-state persist (phase 1860 RT-D2)', () => {
    // phase 1860 (RT-D2)：提交序列收敛为单一编排方法 _commitStepBoundary；
    // 定点序 save → blockId 回写 → persistReadFileState 在该方法体内锁定，
    // onStepComplete / turn 尾仅允许调用协议（禁止方法外重排）。
    const file = path.join(srcRoot, 'core', 'runtime', 'runtime.ts');
    const text = fs.readFileSync(file, 'utf8');
    const protocol = text.match(/private async _commitStepBoundary\([\s\S]{0,900}?\n  \}/);
    expect(protocol).not.toBeNull();
    const body = protocol![0];
    expect(body).toMatch(/await this\.sessionManager\.save\(/);
    expect(body).toMatch(/applyBlockIdAssignments\(messages, saved\.assignedBlockIds\)/);
    expect(body).toMatch(/await persistReadFileState\(this\.execContext\)/);
    const saveIndex = body.indexOf('await this.sessionManager.save(');
    const blockIdIndex = body.indexOf('applyBlockIdAssignments(messages, saved.assignedBlockIds)');
    const persistIndex = body.indexOf('await persistReadFileState(this.execContext)');
    expect(saveIndex).toBeLessThan(blockIdIndex);
    expect(blockIdIndex).toBeLessThan(persistIndex);

    // onStepComplete 与 turn 尾必须经协议调用、且方法体外不得出现散点提交。
    expect(text).toMatch(/onStepComplete:[\s\S]{0,400}?await this\._commitStepBoundary\(systemPrompt, messages, tools\)/);
    expect(text).toContain('await this._commitStepBoundary(systemPrompt, messages, tools, { persistReadState: false });');
    const outsideProtocol = text.replace(protocol![0], '');
    expect(outsideProtocol).not.toMatch(/await persistReadFileState\(this\.execContext\)/);
  });
});
