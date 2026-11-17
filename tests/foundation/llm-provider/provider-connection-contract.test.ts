import { describe, expect, it } from 'vitest';
import {
  describeProviderInput,
  type ProviderConnection,
  type ProviderFactory,
  type ProviderInput,
} from '../../../src/foundation/llm-provider/provider-connection.js';

const connection: ProviderConnection = {
  providerId: 'example',
  model: 'model',
  apiFormat: 'openai',
  authentication: { kind: 'api_key', value: 'secret' },
};

describe('ProviderConnection contract', () => {
  it('contains neither catalog/backend nor orchestration runtime fields', () => {
    expect(Object.keys(connection).sort()).toEqual([
      'apiFormat',
      'authentication',
      'model',
      'providerId',
    ]);
    expect(connection).not.toHaveProperty('credentialStore');
    expect(connection).not.toHaveProperty('inputArtifactOwner');
    expect(connection).not.toHaveProperty('catalogResolution');
    expect(connection).not.toHaveProperty('recoveryState');
  });

  it('rejects forbidden fields at compile time', () => {
    // @ts-expect-error catalog entries stay behind the L1 setup resolver
    const withCatalog: ProviderConnection = { ...connection, catalogProvider: 'anthropic' };
    // @ts-expect-error credential backends are assembly-private
    const withStore: ProviderConnection = { ...connection, credentialStore: {} };
    // @ts-expect-error recovery is owned by L2 and is not provider connection data
    const withRecovery: ProviderConnection = { ...connection, recoveryState: {} };
    expect(withCatalog).toBeDefined();
    expect(withStore).toBeDefined();
    expect(withRecovery).toBeDefined();
  });

  it('uses public input and returns a handle at the ordinary factory boundary', () => {
    const input: ProviderInput = {
      model: 'model',
      protocol: 'openai',
      authentication: { kind: 'api_key', value: 'secret' },
    };
    const provider = { name: 'example', model: 'model', call: async () => { throw new Error('unused'); } };
    const factory: ProviderFactory = { create: received => {
      expect(received).toBe(input);
      return { provider: provider as never, descriptor: describeProviderInput(received) };
    } };
    const handle = factory.create(input);
    expect(handle.provider).toBe(provider);
    expect(handle.descriptor.model).toBe('model');
  });
});
