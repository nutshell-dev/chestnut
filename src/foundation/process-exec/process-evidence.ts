/**
 * Lossless JSON evidence for ProcessExec's raw observations.
 *
 * This is deliberately an encoder, not a general-purpose object serializer: it
 * records object identity and own property descriptors without evaluating user
 * code. Rehydrating Errors, functions, or native handles is not supported.
 */

export type ProcessEvidenceValue = null | boolean | number | string
  | readonly ProcessEvidenceValue[]
  | { readonly [key: string]: ProcessEvidenceValue };

export interface ProcessEvidence {
  readonly version: 1;
  readonly atMs: number;
  readonly facts: readonly ProcessEvidenceValue[];
}

type EncodedProperty = {
  key: ProcessEvidenceValue;
  enumerable: boolean;
  configurable: boolean;
  descriptor: ProcessEvidenceValue;
  inherited?: boolean;
};

type EncodedNode = {
  id: number;
  type: string;
  properties: readonly EncodedProperty[];
  bytesBase64?: string;
};

class ProcessEvidenceEncodingError extends Error {
  constructor(readonly input: readonly unknown[], cause: unknown) {
    super('Process evidence could not be encoded without executing input accessors', { cause });
    this.name = 'ProcessEvidenceEncodingError';
  }
}

const ERROR_PROTOTYPES: readonly (readonly [object, string])[] = [
  [EvalError.prototype, 'EvalError'],
  [RangeError.prototype, 'RangeError'],
  [ReferenceError.prototype, 'ReferenceError'],
  [SyntaxError.prototype, 'SyntaxError'],
  [TypeError.prototype, 'TypeError'],
  [URIError.prototype, 'URIError'],
  [AggregateError.prototype, 'AggregateError'],
  [Error.prototype, 'Error'],
];

function errorType(value: object): string | undefined {
  let prototype = Object.getPrototypeOf(value) as object | null;
  while (prototype !== null) {
    for (const [candidate, label] of ERROR_PROTOTYPES) {
      if (prototype === candidate) return label;
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  return undefined;
}

function inheritedErrorName(value: object, fallback: string): {
  value: string; enumerable: boolean; configurable: boolean; writable: boolean;
} {
  let prototype = Object.getPrototypeOf(value) as object | null;
  while (prototype !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'name');
    if (descriptor && 'value' in descriptor && typeof descriptor.value === 'string') {
      return {
        value: descriptor.value,
        enumerable: descriptor.enumerable ?? false,
        configurable: descriptor.configurable ?? false,
        writable: descriptor.writable ?? false,
      };
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  return { value: fallback, enumerable: false, configurable: true, writable: true };
}

function isBufferByteKey(key: string, length: number): boolean {
  if (!/^(?:0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

/** Encode one complete result. Any reflection failure aborts the whole result. */
export function encodeProcessEvidence(
  atMs: number,
  facts: readonly unknown[],
): ProcessEvidence {
  try {
    const objectIds = new Map<object, number>();
    const symbolIds = new Map<symbol, number>();
    let nextId = 0;

    const encodeSymbol = (value: symbol): ProcessEvidenceValue => {
      const existing = symbolIds.get(value);
      if (existing !== undefined) return { type: 'ref', id: existing };
      const id = nextId++;
      symbolIds.set(value, id);
      return {
        type: 'symbol', id, description: value.description ?? null,
        globalKey: Symbol.keyFor(value) ?? null,
      };
    };

    const encode = (value: unknown): ProcessEvidenceValue => {
      if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
      if (typeof value === 'number') {
        if (Number.isNaN(value)) return { type: 'number', value: 'NaN' };
        if (value === Infinity) return { type: 'number', value: 'Infinity' };
        if (value === -Infinity) return { type: 'number', value: '-Infinity' };
        if (Object.is(value, -0)) return { type: 'number', value: '-0' };
        return value;
      }
      if (typeof value === 'undefined') return { type: 'undefined' };
      if (typeof value === 'bigint') return { type: 'bigint', decimal: value.toString(10) };
      if (typeof value === 'symbol') return encodeSymbol(value);
      if (typeof value !== 'object' && typeof value !== 'function') {
        throw new TypeError(`Unsupported process evidence scalar: ${typeof value}`);
      }

      const object = value as object;
      const existing = objectIds.get(object);
      if (existing !== undefined) return { type: 'ref', id: existing };
      const id = nextId++;
      objectIds.set(object, id);

      const buffer = Buffer.isBuffer(value);
      const diagnosticErrorType = buffer ? undefined : errorType(object);
      const type = buffer ? 'Buffer'
        : Array.isArray(value) ? 'Array'
          : typeof value === 'function' ? 'Function'
            : diagnosticErrorType ?? 'Object';
      const properties: EncodedProperty[] = [];
      if (diagnosticErrorType && !Object.prototype.hasOwnProperty.call(value, 'name')) {
        // Error name normally lives on the prototype; retain it without calling Error methods.
        const name = inheritedErrorName(object, diagnosticErrorType);
        properties.push({
          key: 'name', enumerable: name.enumerable, configurable: name.configurable,
          inherited: true,
          descriptor: { kind: 'data', value: name.value, writable: name.writable },
        });
      }
      for (const key of Reflect.ownKeys(value)) {
        if (buffer && typeof key === 'string' && isBufferByteKey(key, value.length)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined) {
          throw new TypeError('An own property disappeared while encoding process evidence');
        }
        const encodedDescriptor: ProcessEvidenceValue = 'value' in descriptor
          ? {
              kind: 'data', value: encode(descriptor.value), writable: descriptor.writable ?? false,
            }
          : {
              kind: 'accessor', get: encode(descriptor.get), set: encode(descriptor.set),
              executed: false,
            };
        properties.push({
          key: typeof key === 'symbol' ? encodeSymbol(key) : key,
          enumerable: descriptor.enumerable ?? false,
          configurable: descriptor.configurable ?? false,
          descriptor: encodedDescriptor,
        });
      }
      const node: EncodedNode = { id, type, properties };
      if (buffer) {
        // Call the intrinsic directly: an own toJSON/toString property is data, never a hook.
        node.bytesBase64 = Buffer.prototype.toString.call(value, 'base64') as string;
      }
      return node;
    };

    return { version: 1, atMs, facts: facts.map(encode) };
  } catch (cause) {
    throw new ProcessEvidenceEncodingError(facts, cause);
  }
}
