import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';

import { ProcessListUnavailable } from '../../../src/foundation/process-exec/errors.js';
import { createProcessListBackends } from '../../../src/foundation/process-exec/find-by-pattern.js';
import { selectProcessListBackend } from '../../../src/foundation/process-exec/process-list-backend.js';

function evidenceOf(error: ProcessListUnavailable): Record<string, unknown> {
  return {
    code: error.code,
    backendId: error.backendId,
    operation: error.operation,
    classification: error.classification,
    evidenceChain: error.evidenceChain,
  };
}

describe('real restricted-host process-list capability audit', () => {
  it('records selection evidence and cleans up its own child when capability exists', async () => {
    const backends = createProcessListBackends();
    let selected;
    try {
      selected = await selectProcessListBackend(backends, 'phase2177-probe');
    } catch (cause) {
      expect(cause).toBeInstanceOf(ProcessListUnavailable);
      if (!(cause instanceof ProcessListUnavailable)) throw cause;
      console.info('PROCESS_LIST_HOST_CAPABILITY', JSON.stringify({
        status: 'unavailable',
        registeredBackends: backends.map(backend => backend.id),
        alternativeBackendAvailable: backends.some(backend => backend.id !== 'posix-ps'),
        ...evidenceOf(cause),
      }));
      return;
    }

    console.info('PROCESS_LIST_HOST_CAPABILITY', JSON.stringify({
      status: 'available',
      registeredBackends: backends.map(backend => backend.id),
      selectedBackend: selected.backend.id,
      alternativeBackendAvailable: selected.backend.id !== 'posix-ps',
      evidence: selected.evidence,
    }));

    const token = `chestnut_phase2177_${process.pid}_${Date.now()}`;
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', token], {
      stdio: 'ignore',
    });
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      const matches = await selected.backend.findByPattern(token, { timeoutMs: 5_000 });
      expect(matches).toContainEqual(expect.objectContaining({ pid: child.pid }));
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    }
  }, 15_000);
});
