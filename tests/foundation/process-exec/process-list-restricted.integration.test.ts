import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';

import { ProcessListUnavailable } from '../../../src/foundation/process-exec/errors.js';
import { createProcessListBackends } from '../../../src/foundation/process-exec/find-by-pattern.js';
import { selectProcessListBackend } from '../../../src/foundation/process-exec/process-list-backend.js';

// Three bounded listing commands (two probes + one query) plus cleanup margin.
const HOST_AUDIT_RUNNER_TIMEOUT_MS = 20_000;
// Bound each real pgrep/ps invocation so a restricted host cannot hang the audit.
const HOST_COMMAND_TIMEOUT_MS = 5_000;
// Outlives the runner budget; the finally cleanup, not this timer, owns termination.
const CHILD_KEEPALIVE_MS = 30_000;

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
      selected = await selectProcessListBackend(backends, 'phase2177-probe', {
        timeoutMs: HOST_COMMAND_TIMEOUT_MS,
      });
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
    const child = spawn(
      process.execPath,
      ['-e', `setTimeout(() => {}, ${CHILD_KEEPALIVE_MS})`, token],
      { stdio: 'ignore' },
    );
    try {
      await once(child, 'spawn');
      const matches = await selected.backend.findByPattern(token, {
        timeoutMs: HOST_COMMAND_TIMEOUT_MS,
      });
      expect(matches).toContainEqual(expect.objectContaining({ pid: child.pid }));
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    }
  }, HOST_AUDIT_RUNNER_TIMEOUT_MS);
});
