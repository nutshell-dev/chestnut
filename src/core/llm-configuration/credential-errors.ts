/** Typed absence of a referenced credential; resolver IO/permission errors stay distinct. */
export class LLMConfigurationCredentialUnavailableError extends Error {
  readonly code = 'credential_unavailable';

  constructor(readonly ref: string, options?: ErrorOptions) {
    super(`Credential unavailable: ${ref}`, options);
    this.name = 'LLMConfigurationCredentialUnavailableError';
  }
}
