import { describe, expect, it, vi } from 'vitest';
import {
  encodeProcessEvidence,
  type ProcessEvidenceValue,
} from '../../../src/foundation/process-exec/process-evidence.js';

type Node = {
  id: number;
  type: string;
  properties: Property[];
  bytesBase64?: string;
};
type Property = {
  key: ProcessEvidenceValue;
  enumerable: boolean;
  configurable: boolean;
  descriptor: ProcessEvidenceValue;
};

function asNode(value: ProcessEvidenceValue | undefined): Node {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
      || !('id' in value) || !('properties' in value)) {
    throw new Error(`Expected encoded node, got ${JSON.stringify(value)}`);
  }
  return value as unknown as Node;
}

function property(node: Node, key: string): Property {
  const found = node.properties.find(candidate => candidate.key === key);
  if (!found) throw new Error(`Missing property ${key} on ${node.type}`);
  return found;
}

function valueOf(node: Node, key: string): ProcessEvidenceValue {
  const descriptor = property(node, key).descriptor;
  if (typeof descriptor !== 'object' || descriptor === null || Array.isArray(descriptor)
      || !('kind' in descriptor) || descriptor.kind !== 'data' || !('value' in descriptor)) {
    throw new Error(`Expected data descriptor for ${key}`);
  }
  return descriptor.value;
}

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('process evidence JSON graph encoding', () => {
  it('preserves raw errors, bytes, aliases, descriptors, holes, and special scalars', () => {
    const stdout = Buffer.alloc(4096, 0xff);
    stdout[0] = 0;
    stdout[1] = 0xc3;
    stdout[2] = 0x28;
    Object.assign(stdout, { diagnostic: 'stdout-extra' });
    const stderr = Buffer.from([0xfe, 0xff, 0x00, 0x41]);
    const output = [null, stdout, stderr];
    const raw = { pid: 4321, status: 0, signal: null, stdout, stderr, output };

    const cause = new TypeError('inner cause');
    Object.assign(cause, { errno: -2 });
    const error = new Error('outer failure');
    Object.assign(error, {
      cause, code: 'EIO', errno: -1, syscall: 'spawnSync ps', path: '/bin/ps',
      spawnargs: ['-p', '123', '-o', 'lstart='], unknownDetail: { retained: true },
    });
    Object.defineProperty(error, 'nonEnumerableDetail', {
      value: Buffer.from([0x00, 0xff]), enumerable: false, writable: false, configurable: true,
    });
    const getter = vi.fn(() => { throw new Error('getter must not run'); });
    const setter = vi.fn(() => { throw new Error('setter must not run'); });
    Object.defineProperty(error, 'lazy', {
      get: getter, set: setter, enumerable: true, configurable: true,
    });

    const symbol = Symbol.for('phase2071.evidence');
    const shared: Record<PropertyKey, unknown> = { marker: 'shared', [symbol]: 'first' };
    const toJSON = vi.fn(() => { throw new Error('toJSON must not run'); });
    const root: Record<PropertyKey, unknown> = {
      raw, error, shared, sharedAgain: shared,
      values: [undefined, , NaN, Infinity, -Infinity, -0, 12345678901234567890n],
      toJSON, [symbol]: 'second',
    };
    root.self = root;
    Object.assign(error, { [symbol]: 'third' });

    const evidence = encodeProcessEvidence(1234, [root]);
    expect(getter).not.toHaveBeenCalled();
    expect(setter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
    expect(roundTrip(evidence)).toEqual(evidence);

    const rootNode = asNode(evidence.facts[0]);
    const rawNode = asNode(valueOf(rootNode, 'raw'));
    const stdoutNode = asNode(valueOf(rawNode, 'stdout'));
    const stderrNode = asNode(valueOf(rawNode, 'stderr'));
    const outputNode = asNode(valueOf(rawNode, 'output'));
    expect(stdoutNode.type).toBe('Buffer');
    expect(stdoutNode.bytesBase64).toBe(stdout.toString('base64'));
    expect(stderrNode.bytesBase64).toBe(stderr.toString('base64'));
    expect(valueOf(stdoutNode, 'diagnostic')).toBe('stdout-extra');
    expect(stdoutNode.properties.some(entry => entry.key === '0')).toBe(false);
    expect(valueOf(outputNode, '0')).toBeNull();
    expect(valueOf(outputNode, '1')).toEqual({ type: 'ref', id: stdoutNode.id });
    expect(valueOf(outputNode, '2')).toEqual({ type: 'ref', id: stderrNode.id });
    expect(asNode(valueOf(rawNode, 'stdout')).id).toBe(stdoutNode.id);

    const errorNode = asNode(valueOf(rootNode, 'error'));
    expect(errorNode.type).toBe('Error');
    expect(asNode(valueOf(errorNode, 'cause')).type).toBe('TypeError');
    expect(valueOf(errorNode, 'name')).toBe('Error');
    expect(valueOf(errorNode, 'message')).toBe('outer failure');
    expect(valueOf(errorNode, 'code')).toBe('EIO');
    expect(valueOf(errorNode, 'errno')).toBe(-1);
    expect(valueOf(errorNode, 'syscall')).toBe('spawnSync ps');
    expect(valueOf(errorNode, 'path')).toBe('/bin/ps');
    expect(valueOf(asNode(valueOf(errorNode, 'unknownDetail')), 'retained')).toBe(true);
    expect(valueOf(asNode(valueOf(errorNode, 'spawnargs')), '0')).toBe('-p');
    expect(property(errorNode, 'message').enumerable).toBe(false);
    expect(property(errorNode, 'stack').enumerable).toBe(false);
    const nonEnumerable = property(errorNode, 'nonEnumerableDetail');
    expect(nonEnumerable).toMatchObject({ enumerable: false, configurable: true });
    expect(nonEnumerable.descriptor).toMatchObject({ kind: 'data', writable: false });
    const nonEnumerableBuffer = asNode(valueOf(errorNode, 'nonEnumerableDetail'));
    expect(nonEnumerableBuffer.bytesBase64).toBe('AP8=');
    const accessor = property(errorNode, 'lazy').descriptor;
    expect(accessor).toMatchObject({ kind: 'accessor', executed: false });
    expect(asNode((accessor as { get: ProcessEvidenceValue }).get).type).toBe('Function');
    expect(asNode((accessor as { set: ProcessEvidenceValue }).set).type).toBe('Function');

    const values = asNode(valueOf(rootNode, 'values'));
    expect(values.properties.some(entry => entry.key === '1')).toBe(false);
    expect(valueOf(values, 'length')).toBe(7);
    expect(valueOf(values, '0')).toEqual({ type: 'undefined' });
    expect(valueOf(values, '2')).toEqual({ type: 'number', value: 'NaN' });
    expect(valueOf(values, '3')).toEqual({ type: 'number', value: 'Infinity' });
    expect(valueOf(values, '4')).toEqual({ type: 'number', value: '-Infinity' });
    expect(valueOf(values, '5')).toEqual({ type: 'number', value: '-0' });
    expect(valueOf(values, '6')).toEqual({ type: 'bigint', decimal: '12345678901234567890' });

    const sharedNode = asNode(valueOf(rootNode, 'shared'));
    expect(valueOf(rootNode, 'sharedAgain')).toEqual({ type: 'ref', id: sharedNode.id });
    expect(valueOf(rootNode, 'self')).toEqual({ type: 'ref', id: rootNode.id });
    const symbolKeys = [sharedNode, errorNode, rootNode].flatMap(node =>
      node.properties.map(entry => entry.key).filter(key => typeof key === 'object' && key !== null
        && !Array.isArray(key) && 'id' in key && 'type' in key));
    expect(symbolKeys).toHaveLength(3);
    expect(new Set(symbolKeys.map(key => key.id)).size).toBe(1);
    const symbolDefinition = symbolKeys.find(key => 'type' in key && key.type === 'symbol');
    expect(symbolDefinition).toMatchObject({
      type: 'symbol', description: 'phase2071.evidence', globalKey: 'phase2071.evidence',
    });
    expect(roundTrip(evidence)).toEqual(evidence);
  });

  it('aborts the complete result with input and cause when reflection fails', () => {
    const cause = new Error('ownKeys failed');
    const proxy = new Proxy({}, { ownKeys: () => { throw cause; } });
    const input = [{ before: true }, proxy, { after: true }];
    let thrown: unknown;
    try {
      encodeProcessEvidence(99, input);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toMatchObject({ name: 'ProcessEvidenceEncodingError', input, cause });
  });
});
