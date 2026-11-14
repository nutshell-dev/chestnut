import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');
const productionFiles = (relativeDir: string): string[] =>
  fs.readdirSync(path.join(root, relativeDir), { recursive: true })
    .filter(file => file.endsWith('.ts'))
    .map(file => read(path.join(relativeDir, file)));

describe('Phase 2150 B4: Runtime treats task results as opaque inbox content', () => {
  it('Runtime and EventLoop do not import or call ATS result persistence/terminal semantics', () => {
    const sources = [
      ...productionFiles('src/core/runtime'),
      ...productionFiles('src/core/event-loop'),
    ];
    for (const source of sources) {
      for (const forbidden of [
        'ProcessedTaskResult',
        'sendFallbackResult',
        'sendToolResult',
        'moveTaskToDone',
        'moveTaskToFailed',
        'TASKS_QUEUES_RESULTS_DIR',
        'createProcessedResultStore',
        'decodeMigratedExecResult',
        'recovery-fallback',
      ]) {
        expect(source).not.toContain(forbidden);
      }
    }
  });

  it('formatPreparedInbox neither parses task bodies nor settles inbox handles', () => {
    const runtime = read('src/core/runtime/runtime.ts');
    const method = runtime.match(/  async formatPreparedInbox\([\s\S]*?\n  \}/)?.[0];
    expect(method).toBeDefined();
    expect(method).toContain('message.content');
    expect(method).not.toContain('task_result');
    expect(method).not.toContain('JSON.parse');
    expect(method).not.toMatch(/(?:ack|nack|defer)(?:Handles)?\(/);

    const positiveControl = 'JSON.parse(message.content); ackHandles(handles);';
    expect(positiveControl).toContain('JSON.parse');
    expect(positiveControl).toMatch(/(?:ack|nack|defer)(?:Handles)?\(/);
  });
});
