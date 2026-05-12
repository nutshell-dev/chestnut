/**
 * @module L6.CLI.Subagent.List
 * subagent list command
 */

import * as fs from 'fs';
import { resolveClawDir, scanSubagentResults, formatDate, formatDuration, truncateId, type SubagentEntry, type SubagentKind, type SubagentStatus } from './subagent-helpers.js';
import { handleCliError, CliError } from '../errors.js';

interface ListOptions {
  claw: string;
  status?: string;
  kind?: string;
  contract?: string;
  limit?: string;
  from?: string;
  to?: string;
}

export async function subagentListCommand(options: ListOptions): Promise<void> {
  try {
    const clawDir = resolveClawDir(options.claw);
    if (!fs.existsSync(clawDir)) {
      throw new CliError(`Claw "${options.claw}" does not exist`);
    }

    let entries = scanSubagentResults(clawDir);

    // Filter by status
    if (options.status) {
      const s = options.status as SubagentStatus;
      entries = entries.filter(e => e.status === s);
    }

    // Filter by kind
    if (options.kind) {
      const k = options.kind as SubagentKind;
      entries = entries.filter(e => e.kind === k);
    }

    // Filter by contractId (verifier-specific)
    if (options.contract) {
      entries = entries.filter(e => e.contractId && e.contractId === options.contract);
    }

    // Filter by time range
    if (options.from) {
      const fromDate = new Date(options.from);
      entries = entries.filter(e => e.startedAt && e.startedAt >= fromDate);
    }
    if (options.to) {
      const toDate = new Date(options.to);
      entries = entries.filter(e => e.startedAt && e.startedAt <= toDate);
    }

    // Sort by started_at desc
    entries.sort((a, b) => {
      const ta = a.startedAt?.getTime() ?? 0;
      const tb = b.startedAt?.getTime() ?? 0;
      return tb - ta;
    });

    const limit = options.limit ? parseInt(options.limit, 10) : 20;
    if (!isNaN(limit) && limit > 0) {
      entries = entries.slice(0, limit);
    }

    if (entries.length === 0) {
      console.log('No subagent entries found.');
      return;
    }

    // Fixed column widths: ID 36 / KIND 14 / STATUS 10 / STARTED 19 / DURATION 8
    console.log(`${'ID'.padEnd(36)} ${'KIND'.padEnd(14)} ${'STATUS'.padEnd(10)} ${'STARTED'.padEnd(19)} ${'DURATION'.padEnd(8)}`);
    console.log('─'.repeat(92));

    for (const e of entries) {
      const id = truncateId(e.id, 36);
      const kind = e.kind;
      const status = e.status;
      const started = e.startedAt ? formatDate(e.startedAt) : '-';
      const duration = e.durationMs !== undefined ? formatDuration(e.durationMs) : '-';
      console.log(`${id.padEnd(36)} ${kind.padEnd(14)} ${status.padEnd(10)} ${started.padEnd(19)} ${duration.padEnd(8)}`);
    }

    console.log('─'.repeat(92));
    console.log(`\nTotal: ${entries.length} entries`);
  } catch (error) {
    process.exitCode = handleCliError(error);
  }
}
