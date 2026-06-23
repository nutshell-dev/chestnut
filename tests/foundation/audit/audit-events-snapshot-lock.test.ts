import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CRON_FILE_ROUTING } from '../../../src/foundation/cron/audit-events.js';
import { DAEMON_FILE_ROUTING } from '../../../src/daemon/audit-events.js';
import { VIEWPORT_FILE_ROUTING } from '../../../src/cli/commands/viewport-audit-events.js';

// phase 163 新加 14 业主
import { ASSEMBLY_FILE_ROUTING } from '../../../src/assembly/audit-events.js';
import { ASSEMBLY_LLM_FILE_ROUTING } from '../../../src/assembly/llm-audit-events.js';
import { CLI_FILE_ROUTING } from '../../../src/cli/audit-events.js';
import { CONTRACT_FILE_ROUTING } from '../../../src/core/contract/audit-events.js';
import { GATEWAY_FILE_ROUTING } from '../../../src/core/gateway/audit-events.js';
import { HEARTBEAT_FILE_ROUTING } from '../../../src/core/heartbeat/audit-events.js';
import { MEMORY_FILE_ROUTING } from '../../../src/core/memory/audit-events.js';
import { PERMISSIONS_FILE_ROUTING } from '../../../src/core/permissions/audit-events.js';
import { SUBAGENT_FILE_ROUTING } from '../../../src/core/subagent/audit-events.js';
import { MESSAGING_FILE_ROUTING } from '../../../src/foundation/messaging/audit-events.js';
import { SNAPSHOT_FILE_ROUTING } from '../../../src/foundation/snapshot/audit-events.js';
import { STREAM_FILE_ROUTING } from '../../../src/foundation/stream/audit-events.js';
import { TOOLS_FILE_ROUTING } from '../../../src/foundation/tools/audit-events.js';
import { WATCHDOG_FILE_ROUTING } from '../../../src/watchdog/audit-events.js';
import { FILE_TOOL_FILE_ROUTING } from '../../../src/foundation/file-tool/audit-events.js';
import { COMMAND_TOOL_FILE_ROUTING } from '../../../src/foundation/command-tool/audit-events.js';
import { RUNTIME_FILE_ROUTING } from '../../../src/core/runtime/runtime-audit-events.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(__dirname, '../../../src');
const SNAPSHOT_PATH = path.join(SRC_ROOT, 'foundation/audit/audit-events.snapshot.json');

interface ColSchema {
  name: string;
  type: string;
  required: boolean;
  max_chars?: number;
}

interface SnapshotEntry {
  type: string;
  cols?: ColSchema[];
}

interface SnapshotJson {
  schema_version: string;
  modules: Record<string, (string | SnapshotEntry)[]>;
  fileRouting?: Record<string, string>;
  stepColOwner?: {
    file: string;
    eventType: string;
    valueType: string;
    _comment?: string;
  };
}

/**
 * Phase 1019 r124 E fork + phase 140 β: audit-events const 不变承诺 CI lock.
 * 任意 module 改 audit-events.ts 字符串值 → snapshot fail → PR 必同 ratify update snapshot.
 * Phase 140 Step E: snapshot.json 升 β 第 2 步，lock test 强制 tool 类 event 必填 cols。
 */
describe('audit-events snapshot lock', () => {
  it('schema_version is locked to 2.0.0 (β 第 2 步)', () => {
    const snapshot: SnapshotJson = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8'));
    expect(snapshot.schema_version).toBe('2.0.0');
  });

  it('all audit-events.ts string values match snapshot (β 兼容期)', () => {
    const actual = collectAuditEventsFromSrc(SRC_ROOT);
    const snapshot: SnapshotJson = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8'));
    const expected = parseSnapshotEvents(snapshot);
    expect(actual).toEqual(expected);
  });

  it('snapshot contains at least one {type, cols} object demo (phase 140 β)', () => {
    const snapshot: SnapshotJson = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8'));
    let found = false;
    for (const entries of Object.values(snapshot.modules)) {
      for (const entry of entries) {
        if (typeof entry === 'object' && entry !== null && 'cols' in entry) {
          found = true;
          break;
        }
      }
      if (found) break;
    }
    expect(found).toBe(true);
  });

  it('event emit 站点包含 snapshot.json 所有 required cols (β 第 2 步，phase 180 扩 cron scope)', () => {
    const snapshot: SnapshotJson = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8'));
    const emitSites = collectAuditWriteEmitSites(SRC_ROOT, snapshot);

    for (const site of emitSites) {
      const eventDef = findEventInSnapshot(snapshot, site.module, site.eventType);
      if (!eventDef || !eventDef.cols) continue;

      const requiredCols = eventDef.cols.filter(c => c.required).map(c => c.name);
      for (const required of requiredCols) {
        expect(site.emittedCols).toContain(
          required,
          `${site.module}/${site.eventType} at ${site.file}:${site.line} missing required col '${required}'`,
        );
      }
    }
  });

  it('`step=` col 单源 emit = snapshot.stepColOwner (phase 216 white-list)', () => {
    const snapshot: SnapshotJson = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8'));
    const sot = snapshot.stepColOwner;
    expect(sot).toBeDefined();
    expect(sot.file).toBe('src/core/runtime/runtime.ts');
    expect(sot.eventType).toBe('tool_call_input');
    expect(sot.valueType).toBe('StepNumber');

    const emitSites = collectAuditWriteEmitSites(SRC_ROOT, snapshot);
    for (const site of emitSites) {
      if (!site.emittedCols.includes('step')) continue;  // 没 step= 的不管
      // 有 step= 的必是 SoT
      expect(site.file).toBe(sot.file,
        `${site.module}/${site.eventType} at ${site.file}:${site.line} emits 'step=' but not SoT (= ${sot.file}/${sot.eventType})`,
      );
      expect(site.eventType).toBe(sot.eventType,
        `${site.module}/${site.eventType} at ${site.file}:${site.line} emits 'step=' on wrong event type (SoT = ${sot.eventType})`,
      );
    }
  });

  it('snapshot fileRouting keys are a subset of owner-declared routings (phase 159 + 163)', () => {
    const snapshot: SnapshotJson = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8'));
    expect(snapshot.fileRouting).toBeDefined();
    const ownerRoutings = {
      ...CRON_FILE_ROUTING,
      ...DAEMON_FILE_ROUTING,
      ...VIEWPORT_FILE_ROUTING,
      ...ASSEMBLY_FILE_ROUTING,
      ...ASSEMBLY_LLM_FILE_ROUTING,
      ...CLI_FILE_ROUTING,
      ...CONTRACT_FILE_ROUTING,
      ...GATEWAY_FILE_ROUTING,
      ...HEARTBEAT_FILE_ROUTING,
      ...MEMORY_FILE_ROUTING,
      ...PERMISSIONS_FILE_ROUTING,
      ...SUBAGENT_FILE_ROUTING,
      ...MESSAGING_FILE_ROUTING,
      ...SNAPSHOT_FILE_ROUTING,
      ...STREAM_FILE_ROUTING,
      ...TOOLS_FILE_ROUTING,
      ...WATCHDOG_FILE_ROUTING,
      ...FILE_TOOL_FILE_ROUTING,
      ...COMMAND_TOOL_FILE_ROUTING,
      ...RUNTIME_FILE_ROUTING,
    };
    for (const [type, file] of Object.entries(snapshot.fileRouting!)) {
      expect(ownerRoutings).toHaveProperty(type);
      expect(ownerRoutings[type as keyof typeof ownerRoutings]).toBe(file);
    }
  });

  it('snapshot fileRouting contains all non-audit owner-declared types (phase 159 + 163)', () => {
    const snapshot: SnapshotJson = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8'));
    const ownerRoutings = {
      ...CRON_FILE_ROUTING,
      ...DAEMON_FILE_ROUTING,
      ...VIEWPORT_FILE_ROUTING,
      ...ASSEMBLY_FILE_ROUTING,
      ...ASSEMBLY_LLM_FILE_ROUTING,
      ...CLI_FILE_ROUTING,
      ...CONTRACT_FILE_ROUTING,
      ...GATEWAY_FILE_ROUTING,
      ...HEARTBEAT_FILE_ROUTING,
      ...MEMORY_FILE_ROUTING,
      ...PERMISSIONS_FILE_ROUTING,
      ...SUBAGENT_FILE_ROUTING,
      ...MESSAGING_FILE_ROUTING,
      ...SNAPSHOT_FILE_ROUTING,
      ...STREAM_FILE_ROUTING,
      ...TOOLS_FILE_ROUTING,
      ...WATCHDOG_FILE_ROUTING,
    };
    for (const [type, file] of Object.entries(ownerRoutings)) {
      if (file === 'audit') continue; // audit is default, may be omitted from snapshot.fileRouting
      expect(snapshot.fileRouting!).toHaveProperty(type);
      expect(snapshot.fileRouting![type]).toBe(file);
    }
  });

  it('all owner-declared types exist in snapshot.json (phase 163 coverage)', () => {
    const snapshot: SnapshotJson = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8'));
    const allSnapshotTypes = new Set<string>();
    for (const entries of Object.values(snapshot.modules)) {
      for (const entry of entries) {
        allSnapshotTypes.add(typeof entry === 'string' ? entry : entry.type);
      }
    }

    const ownerRoutings = {
      ...CRON_FILE_ROUTING,
      ...DAEMON_FILE_ROUTING,
      ...VIEWPORT_FILE_ROUTING,
      ...ASSEMBLY_FILE_ROUTING,
      ...ASSEMBLY_LLM_FILE_ROUTING,
      ...CLI_FILE_ROUTING,
      ...CONTRACT_FILE_ROUTING,
      ...GATEWAY_FILE_ROUTING,
      ...HEARTBEAT_FILE_ROUTING,
      ...MEMORY_FILE_ROUTING,
      ...PERMISSIONS_FILE_ROUTING,
      ...SUBAGENT_FILE_ROUTING,
      ...MESSAGING_FILE_ROUTING,
      ...SNAPSHOT_FILE_ROUTING,
      ...STREAM_FILE_ROUTING,
      ...TOOLS_FILE_ROUTING,
      ...WATCHDOG_FILE_ROUTING,
    };

    for (const type of Object.keys(ownerRoutings)) {
      expect(allSnapshotTypes.has(type)).toBe(
        true,
        `owner-declared type "${type}" not found in snapshot.json (stale or typo)`,
      );
    }
  });

  it('phase 163 owner modules have OWNER_FILE_ROUTING declaration', () => {
    const ownerModules = [
      'assembly/audit-events.ts',
      'assembly/llm-audit-events.ts',
      'cli/audit-events.ts',
      'core/contract/audit-events.ts',
      'core/gateway/audit-events.ts',
      'core/heartbeat/audit-events.ts',
      'core/memory/audit-events.ts',
      'core/permissions/audit-events.ts',
      'core/subagent/audit-events.ts',
      'foundation/messaging/audit-events.ts',
      'foundation/snapshot/audit-events.ts',
      'foundation/stream/audit-events.ts',
      'foundation/tools/audit-events.ts',
      'watchdog/audit-events.ts',
      // phase 159 已有
      'foundation/cron/audit-events.ts',
      'daemon/audit-events.ts',
      'cli/commands/viewport-audit-events.ts',
    ];

    for (const mod of ownerModules) {
      const modPath = path.join(SRC_ROOT, mod);
      const content = fs.readFileSync(modPath, 'utf-8');
      expect(content).toMatch(
        /_FILE_ROUTING\s*[:=]/,
        `owner module ${mod} missing OWNER_FILE_ROUTING declaration`,
      );
    }
  });

  it('snapshot fileRouting values are within allowed file names (phase 159)', () => {
    const snapshot: SnapshotJson = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8'));
    const allowedFiles = new Set(['audit', 'tick', 'viewport']);
    for (const file of Object.values(snapshot.fileRouting!)) {
      expect(allowedFiles).toContain(file);
    }
  });

  it('reverse: synthetic source with unauthorized const diverges from snapshot', () => {
    const syntheticSource = `
      export const FAKE_AUDIT_EVENTS = {
        LEGIT_EVENT: 'legit_event',
        UNAUTHORIZED_FAKE: 'unauthorized_fake_event',
      } as const;
    `;
    const matches = Array.from(syntheticSource.matchAll(/[A-Z_][A-Z0-9_]*:\s*'([a-z0-9_]+)'/g));
    const syntheticEvents = matches.map(m => m[1]);
    expect(syntheticEvents).toContain('unauthorized_fake_event');
    const snapshot: SnapshotJson = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8'));
    const allLegitEvents = Object.values(snapshot.modules)
      .flat()
      .map(e => (typeof e === 'string' ? e : e.type)) as string[];
    expect(allLegitEvents).not.toContain('unauthorized_fake_event');
    expect(syntheticEvents).not.toEqual(allLegitEvents);
  });
});

function parseSnapshotEvents(snapshot: SnapshotJson): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [moduleName, entries] of Object.entries(snapshot.modules)) {
    result[moduleName] = entries.map(e => (typeof e === 'string' ? e : e.type)).sort();
  }
  return result;
}

function findEventInSnapshot(
  snapshot: SnapshotJson,
  moduleName: string,
  eventType: string,
): SnapshotEntry | undefined {
  const entries = snapshot.modules[moduleName];
  if (entries) {
    for (const entry of entries) {
      if (typeof entry === 'object' && entry.type === eventType) {
        return entry;
      }
    }
  }
  // Fallback: search all modules for this eventType (phase 180 cron emit sites跨文件)
  for (const modEntries of Object.values(snapshot.modules)) {
    for (const entry of modEntries) {
      if (typeof entry === 'object' && entry.type === eventType) {
        return entry;
      }
    }
  }
  return undefined;
}

interface EmitSite {
  file: string;
  module: string;
  eventType: string;
  line: number;
  emittedCols: string[];
  isCron: boolean;
}

/**
 * Scan source files for audit write calls that emit events defined in snapshot.json with cols.
 *
 * Heuristic: find lines matching `.write(EVENT_CONST, ...)` or `.write('event_type', ...)`
 * and extract `key=` patterns from the arguments.
 */
function collectAuditConstMap(root: string): Map<string, string> {
  const map = new Map<string, string>();
  walk(root, (file) => {
    if (!file.endsWith('audit-events.ts')) return;
    const content = fs.readFileSync(file, 'utf-8');
    const matches = Array.from(content.matchAll(/([A-Z_][A-Z0-9_]*)\s*:\s*['"]([a-z0-9_.]+)['"]/g));
    for (const m of matches) {
      map.set(m[1], m[2]);
    }
  });
  return map;
}

function collectAuditWriteEmitSites(root: string, snapshot: SnapshotJson): EmitSite[] {
  const result: EmitSite[] = [];
  const eventsWithCols = new Set<string>();
  const cronEventTypes = new Set<string>();
  for (const [moduleName, entries] of Object.entries(snapshot.modules)) {
    for (const entry of entries) {
      const eventType = typeof entry === 'string' ? entry : entry.type;
      if (typeof entry === 'object' && entry.cols && entry.cols.length > 0) {
        eventsWithCols.add(eventType);
      }
      if (moduleName.startsWith('core_cron_jobs_')) {
        cronEventTypes.add(eventType);
      }
    }
  }

  const auditConstMap = collectAuditConstMap(root);

  walk(root, (file) => {
    if (!file.endsWith('.ts')) return;
    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.split('\n');
    const moduleName = path.relative(root, file).replace(/\.ts$/, '').replace(/\//g, '_');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match audit.write( or .auditWriter.write( or opts.audit.write( etc.
      const match = line.match(/(\w+\.)?write\s*\(\s*([^,]+)(?:,\s*(.*))?\)/);
      if (!match) continue;
      const argsStr = match[2] + (match[3] ? ', ' + match[3] : '');

      // Resolve event type: either a const identifier or a string literal
      const eventArg = match[2].trim();
      let eventType: string | undefined;
      if (/^['"]/.test(eventArg)) {
        eventType = eventArg.slice(1, -1).replace(/['"]/g, '');
      } else if (eventArg.includes('_AUDIT_EVENTS.')) {
        const constName = eventArg.split('.').pop();
        // Look up the string value in the same file (heuristic)
        const constMatch = content.match(new RegExp(`${constName}\s*:\s*['"]([a-z0-9_]+)['"]`));
        if (constMatch) {
          eventType = constMatch[1];
        } else {
          // Cross-file lookup in global audit-events.ts const map
          eventType = constName ? auditConstMap.get(constName) : undefined;
        }
      } else if (/^[A-Z][A-Z0-9_]*$/.test(eventArg)) {
        // Direct const reference like SUBAGENT_AUDIT_EVENTS.TOOL_RESULT but without dot
        const constMatch = content.match(new RegExp(`${eventArg}\s*:\s*['"]([a-z0-9_]+)['"]`));
        if (constMatch) {
          eventType = constMatch[1];
        } else {
          eventType = auditConstMap.get(eventArg);
        }
      }

      if (!eventType || !eventsWithCols.has(eventType)) continue;

      // Extract key= patterns from arguments (best-effort)
      const emittedCols: string[] = [];
      const colMatches = argsStr.matchAll(/([a-z_][a-z0-9_]*)\s*=/g);
      for (const m of colMatches) {
        emittedCols.push(m[1]);
      }

      result.push({ file, module: moduleName, eventType, line: i + 1, emittedCols, isCron: cronEventTypes.has(eventType) });
    }
  });
  return result;
}


function collectAuditEventsFromSrc(root: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  walk(root, (file) => {
    if (!file.endsWith('audit-events.ts')) return;
    const content = fs.readFileSync(file, 'utf-8');
    const matches = Array.from(content.matchAll(/[A-Z_][A-Z0-9_]*\s*[:=]\s*'([a-z0-9_.]+)'/g));
    if (matches.length > 0) {
      const moduleName = path.relative(root, file).replace(/\.ts$/, '').replace(/\//g, '_');
      result[moduleName] = matches.map(m => m[1]).sort();
    }
  });
  return result;
}

function walk(dir: string, cb: (file: string) => void) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, cb);
    else if (entry.isFile()) cb(full);
  }
}
