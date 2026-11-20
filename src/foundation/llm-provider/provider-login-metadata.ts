/**
 * Canonical pi-ai provider login metadata.
 *
 * This capability validates the configured provider identity and owns only the
 * human-facing ambient/OAuth hint. Interactive login types remain pi-ai runtime
 * facts; legacy preset aliases and model metadata are deliberately not inputs.
 */
import { PROVIDER_INVENTORY } from './provider-inventory.generated.js';

export interface CatalogProviderLoginMetadata {
  readonly providerId: string;
  readonly authHint?: string;
}

const AUTH_HINTS: Readonly<Record<string, string>> = Object.freeze({
  'amazon-bedrock': 'AWS 凭证链（AWS_PROFILE / 默认链 / ECS / web identity）+ AWS_REGION；无需 api_key。',
  'google-vertex': 'GOOGLE_CLOUD_API_KEY 或 ADC（GOOGLE_APPLICATION_CREDENTIALS / gcloud）+ GOOGLE_CLOUD_PROJECT/LOCATION；无需 api_key。',
  'openai-codex': '需先经 config provider login <label> 完成 OAuth 登录（纯 OAuth provider，api_key 无效）。',
  'github-copilot': '需先经 config provider login <label> 完成 OAuth 登录（device code）。',
});

/** Unknown, custom and metadata-only wire identities have no implicit login alias. */
export function catalogProviderLoginMetadata(
  providerId: string,
): CatalogProviderLoginMetadata | undefined {
  if (!Object.hasOwn(PROVIDER_INVENTORY, providerId)) return undefined;
  const authHint = AUTH_HINTS[providerId];
  return Object.freeze({
    providerId,
    ...(authHint !== undefined && { authHint }),
  });
}
