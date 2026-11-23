import fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginRetentionScope,
  inspectRetention,
  RETENTION_RECORD_FILENAME,
  RetentionWriteError,
} from './resource-retention.js';
import { cleanupTempDirSync, createTrackedTempDirSync, untrackTempDir } from './temp.js';

const roots: string[] = [];

function makeRoot(label = 'retention-unit-'): string {
  const root = createTrackedTempDirSync(label);
  roots.push(root);
  return root;
}

function recordPath(root: string): string {
  return path.join(root, RETENTION_RECORD_FILENAME);
}

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) {
    const root = roots.pop()!;
    fs.rmSync(root, { recursive: true, force: true });
    untrackTempDir(root);
  }
});

describe('resource retention state folding', () => {
  it('folds pending, retained and completed scopes independently', () => {
    const root = makeRoot();
    const successPath = path.join(root, 'success');
    const failedPath = path.join(root, 'failed');
    const success = beginRetentionScope({ runRoot: root, protectedPaths: [successPath], label: 'success' });
    const failed = beginRetentionScope({ runRoot: root, protectedPaths: [failedPath], label: 'failed' });

    expect(inspectRetention(root, successPath)).toMatchObject({ kind: 'preserve', reasons: ['scope_pending'] });
    success.complete();
    expect(inspectRetention(root, successPath)).toEqual({ kind: 'allow' });
    expect(inspectRetention(root, failedPath)).toMatchObject({ kind: 'preserve', scopeIds: [failed.id] });

    failed.retain({ code: 'test_failed', error: new Error('assertion') });
    failed.complete();
    expect(inspectRetention(root, failedPath)).toMatchObject({
      kind: 'preserve',
      scopeIds: [failed.id],
      reasons: ['test_failed'],
    });
    expect(inspectRetention(root)).toMatchObject({ kind: 'preserve', scopeIds: [failed.id] });
  });

  it('treats duplicate completion and events before begin as indeterminate', () => {
    const root = makeRoot();
    const scope = beginRetentionScope({ runRoot: root, protectedPaths: [], label: 'duplicate' });
    scope.complete();
    scope.complete();
    expect(inspectRetention(root).kind).toBe('indeterminate');

    const other = makeRoot();
    fs.writeFileSync(recordPath(other), `${JSON.stringify({
      version: 1,
      type: 'scope_completed',
      id: 'missing-begin',
      recordedAt: new Date().toISOString(),
    })}\n`);
    expect(inspectRetention(other).kind).toBe('indeterminate');
  });

  it.each([
    ['legacy marker', '{"type":"unconfirmed-direct-child","pid":123}\n', 'preserve'],
    ['empty file', '', 'indeterminate'],
    ['partial json', '{"version":1,"type":"scope_begin"', 'indeterminate'],
    ['bad line', '{bad}\n', 'indeterminate'],
    ['unknown version', '{"version":99,"type":"scope_begin","id":"x","recordedAt":"now","label":"x","protectedPaths":[]}\n', 'indeterminate'],
  ])('conservatively retains %s without rewriting its bytes', (_name, bytes, kind) => {
    const root = makeRoot();
    fs.writeFileSync(recordPath(root), bytes);
    expect(inspectRetention(root).kind).toBe(kind);
    expect(fs.readFileSync(recordPath(root), 'utf8')).toBe(bytes);
  });

  it('serializes Error cause, AggregateError, special values and circular evidence', () => {
    const root = makeRoot();
    const scope = beginRetentionScope({ runRoot: root, protectedPaths: [], label: 'serialization' });
    const cause = Object.assign(new Error('disk failed'), { code: 'EIO', retry: undefined });
    const primary = new Error('sample failed', { cause });
    const evidence: Record<string, unknown> = {
      bigint: 123n,
      undefinedValue: undefined,
      infinite: Number.POSITIVE_INFINITY,
      aggregate: new AggregateError([primary, cause], 'both failed', { cause: primary }),
    };
    evidence.self = evidence;
    scope.retain({ code: 'test_failed', error: primary, evidence });

    const events = fs.readFileSync(recordPath(root), 'utf8').trim().split('\n')
      .map(line => JSON.parse(line) as { evidence?: any; error?: any });
    const retained = events.at(-1)!;
    expect(retained.error).toMatchObject({
      $type: 'Error',
      message: 'sample failed',
      cause: { message: 'disk failed', code: 'EIO', retry: { $type: 'undefined' } },
    });
    expect(retained.evidence.bigint).toEqual({ $type: 'bigint', value: '123' });
    expect(retained.evidence.infinite).toEqual({ $type: 'number', value: 'Infinity' });
    expect(retained.evidence.aggregate.$type).toBe('AggregateError');
    expect(retained.evidence.self).toEqual({ $ref: '$.evidence' });
    expect(inspectRetention(root)).toMatchObject({ kind: 'preserve', reasons: ['test_failed'] });
  });
});

describe('resource retention paths and publication', () => {
  it('uses path-segment boundaries in both directions and accepts spaces', () => {
    const root = makeRoot('retention paths with spaces-');
    const protectedPath = path.join(root, 'fixture', 'nested file');
    const scope = beginRetentionScope({ runRoot: root, protectedPaths: [protectedPath], label: 'paths' });
    scope.retain({ code: 'test_failed' });

    expect(inspectRetention(root, path.join(root, 'fixture'))).toMatchObject({ kind: 'preserve' });
    expect(inspectRetention(root, path.join(protectedPath, 'child'))).toMatchObject({ kind: 'preserve' });
    expect(inspectRetention(root, path.join(root, 'fixture-other'))).toEqual({ kind: 'allow' });
    expect(inspectRetention(root, `${root}-sibling`)).toEqual({ kind: 'allow' });
    expect(() => beginRetentionScope({
      runRoot: root,
      protectedPaths: [`${root}-sibling`],
      label: 'escape',
    })).toThrow(/escapes run root/);
  });

  it('normalizes an existing symlink parent and rejects a symlink escape', () => {
    const root = makeRoot();
    const actual = path.join(root, 'actual');
    const alias = path.join(root, 'alias');
    fs.mkdirSync(actual);
    fs.symlinkSync(actual, alias, 'dir');
    const scope = beginRetentionScope({
      runRoot: root,
      protectedPaths: [path.join(alias, 'fixture')],
      label: 'alias',
    });
    expect(fs.existsSync(path.join(actual, 'fixture'))).toBe(false);
    expect(inspectRetention(root, path.join(actual, 'fixture'))).toMatchObject({ kind: 'preserve' });

    const outside = makeRoot('retention-outside-');
    const escape = path.join(root, 'escape');
    fs.symlinkSync(outside, escape, 'dir');
    expect(() => beginRetentionScope({
      runRoot: root,
      protectedPaths: [path.join(escape, 'fixture')],
      label: 'escape',
    })).toThrow(/escapes run root/);
    scope.complete();
  });

  it('reports not_published when open fails and leaves the pending begin authoritative', () => {
    const root = makeRoot();
    const scope = beginRetentionScope({ runRoot: root, protectedPaths: [], label: 'open failure' });
    const failure = new Error('injected open EIO');
    vi.spyOn(fs, 'openSync').mockImplementationOnce(() => { throw failure; });
    let caught: unknown;
    try { scope.retain({ code: 'test_failed' }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(RetentionWriteError);
    expect(caught).toMatchObject({ publication: 'not_published', path: recordPath(root), cause: failure });
    expect(inspectRetention(root)).toMatchObject({ kind: 'preserve', reasons: ['scope_pending'] });
  });

  it('reports published after a complete append even when fsync fails', () => {
    const root = makeRoot();
    const scope = beginRetentionScope({ runRoot: root, protectedPaths: [], label: 'fsync failure' });
    const failure = new Error('injected fsync EIO');
    vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw failure; });
    let caught: unknown;
    try { scope.retain({ code: 'test_failed' }); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ publication: 'published', cause: failure });
    expect(inspectRetention(root)).toMatchObject({ kind: 'preserve', reasons: ['test_failed'] });
  });

  it('reports indeterminate for a short append and protects the earlier begin', () => {
    const root = makeRoot();
    const scope = beginRetentionScope({ runRoot: root, protectedPaths: [], label: 'short write' });
    vi.spyOn(fs, 'writeSync').mockReturnValueOnce(0);
    expect(() => scope.retain({ code: 'test_failed' })).toThrow(expect.objectContaining({
      publication: 'indeterminate',
    }));
    expect(inspectRetention(root)).toMatchObject({ kind: 'preserve', reasons: ['scope_pending'] });
  });

  it('returns indeterminate on a read failure', () => {
    const root = makeRoot();
    const failure = new Error('injected read EIO');
    vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => { throw failure; });
    expect(inspectRetention(root)).toEqual({ kind: 'indeterminate', error: failure });
  });
});
