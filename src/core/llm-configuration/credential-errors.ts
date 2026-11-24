import type { LLMProviderSlot } from './selection.js';

export interface MissingCredentialRevision {
  readonly id: string;
  readonly revision: number;
}

export type MissingCredentialField = 'api_key' | 'other' | 'multiple';

export type MissingCredentialTarget = Readonly<{
  slot: LLMProviderSlot;
  field: MissingCredentialField;
}>;

export type MissingCredentialContext =
  | {
    readonly kind: 'document';
    readonly revision: MissingCredentialRevision;
    readonly targets: readonly MissingCredentialTarget[];
  }
  | { readonly kind: 'draft' };

/** Typed absence of a referenced credential; resolver IO/permission errors stay distinct. */
export class LLMConfigurationCredentialUnavailableError extends Error {
  readonly code = 'credential_unavailable';

  constructor(readonly context: MissingCredentialContext, options?: ErrorOptions) {
    super('Credential unavailable', options);
    this.name = 'LLMConfigurationCredentialUnavailableError';
  }
}
