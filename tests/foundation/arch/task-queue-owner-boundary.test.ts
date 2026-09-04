/**
 * Phase 1758 Step B: task queue owner boundary ratchet（STATUS-TASK-QUEUE-OWNER-BYPASS）。
 *
 * 锁 StatusService 不再 bypass AsyncTaskSystem 资源布局：
 *  - src/core/status-service 对 queue path 常量（TASKS_QUEUES_*）零引用；
 *  - src/core/status-service 对 validateTaskShape 零引用（task shape 校验归 owner）；
 *  - src/core/status-service 零 async-task-system 深链 import（仅经 index.js barrel）；
 *  - computeTaskView 经 owner 最小只读 capability readTaskQueueCounts 读取 task 状态。
 *
 * scanner 手法与 viewport-routing-boundary.test.ts 同型：注释剥离后扫描，
 * 避免注释/文档串命中造成假阳性。
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { walkTsFiles } from './cli-guidance-boundary-helpers.js';

const SRC_ROOT = path.join(__dirname, '..', '..', '..', 'src');
const STATUS_SERVICE_DIR = path.join(SRC_ROOT, 'core', 'status-service');

/** 简化注释剥离：块注释保换行、行注释删除（与 viewport-routing-boundary 同型）。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, prefix) => prefix);
}

const IMPORT_SPECIFIER_RE = /(?:import|export)\s+(?:type\s+)?(?:[\w*{][^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;

function scanStatusServiceFiles(): string[] {
  return walkTsFiles(STATUS_SERVICE_DIR);
}

describe('phase 1758: task queue owner boundary (STATUS-TASK-QUEUE-OWNER-BYPASS)', () => {
  it('status-service has zero queue path constant references', () => {
    const violations: string[] = [];
    for (const file of scanStatusServiceFiles()) {
      const stripped = stripComments(fs.readFileSync(file, 'utf8'));
      if (stripped.includes('TASKS_QUEUES_')) {
        violations.push(path.relative(SRC_ROOT, file));
      }
    }
    expect(violations).toEqual([]);
  });

  it('status-service has zero validateTaskShape references (shape validation stays in owner)', () => {
    const violations: string[] = [];
    for (const file of scanStatusServiceFiles()) {
      const stripped = stripComments(fs.readFileSync(file, 'utf8'));
      if (stripped.includes('validateTaskShape')) {
        violations.push(path.relative(SRC_ROOT, file));
      }
    }
    expect(violations).toEqual([]);
  });

  it('status-service imports async-task-system only through the barrel', () => {
    const violations: string[] = [];
    for (const file of scanStatusServiceFiles()) {
      const stripped = stripComments(fs.readFileSync(file, 'utf8'));
      for (const m of stripped.matchAll(IMPORT_SPECIFIER_RE)) {
        const specifier = m[1];
        if (
          specifier.includes('async-task-system') &&
          !specifier.endsWith('async-task-system/index.js')
        ) {
          violations.push(`${path.relative(SRC_ROOT, file)}: ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('computeTaskView delegates to owner capability readTaskQueueCounts', () => {
    const aggregatorsSrc = stripComments(
      fs.readFileSync(path.join(STATUS_SERVICE_DIR, 'aggregators.ts'), 'utf8'),
    );
    // 经 barrel 导入 owner capability（非深链、非本地重实现）
    expect(aggregatorsSrc).toMatch(
      /import\s*{\s*readTaskQueueCounts\s*}\s*from\s*'[^']*async-task-system\/index\.js'/,
    );
    expect(aggregatorsSrc).toMatch(/await readTaskQueueCounts\(/);
  });
});
