/**
 * phase 1874 Step L（cli-command-protocol-partial-adoption）: 顶层单命令 catalog parity。
 *
 * 单源守卫：stop/status/start/init 的 summary 只由 ROOT_COMMAND_CATALOG 派生、
 * cli/index.ts 注册点经 rootShape 投影消费（零手写 description 字面）。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ROOT_COMMAND_CATALOG,
  getRootCommandSpec,
} from '../../../src/cli-protocol/index.js';

describe('phase 1874 Step L: 顶层单命令 catalog parity', () => {
  const indexSource = fs.readFileSync(path.join(process.cwd(), 'src/cli/index.ts'), 'utf8');

  it('catalog 单源：四个 id + summary', () => {
    expect(ROOT_COMMAND_CATALOG.map((spec) => spec.id)).toEqual(['stop', 'status', 'start', 'init']);
    expect(getRootCommandSpec('stop')!.summary).toBe('Stop all chestnut processes (watchdog → motion → claws)');
    expect(getRootCommandSpec('status')!.summary).toBe('Show status of all chestnut processes');
    expect(getRootCommandSpec('start')!.summary).toBe('Start the system (initializes if needed) and open Motion chat');
    expect(getRootCommandSpec('init')!.summary).toBe('Initialize chestnut workspace');
  });

  it('四命令经 rootShape 投影；顶层段不再手写对应 description 字面', () => {
    for (const id of ['stop', 'status', 'start', 'init'] as const) {
      expect(indexSource).toContain(`rootShape(program.command('${id}'), '${id}')`);
    }
    for (const desc of [
      "'Stop all chestnut processes (watchdog → motion → claws)'",
      "'Show status of all chestnut processes'",
      "'Start the system (initializes if needed) and open Motion chat'",
      "'Initialize chestnut workspace'",
    ]) {
      expect(indexSource).not.toContain(desc);
    }
  });
});
