import { describe, expect, it } from 'vitest';
import {
  LAUNCHER_UI_SEMANTICS_PROTOCOL,
  createLauncherUiSemantics,
  launcherSetupResponse,
  type LauncherUiSemantics,
} from '../../src/cli-protocol/index.js';

describe('launcher shared UI semantics', () => {
  it('publishes a versioned platform-neutral catalog with stable field/action ids', () => {
    const semantics = createLauncherUiSemantics({ providerCount: 4, defaultModel: 'gpt-test' });
    expect(semantics.protocol).toBe(LAUNCHER_UI_SEMANTICS_PROTOCOL);
    expect(semantics.locale).toBe('zh-CN');
    expect(semantics.screens['setup.provider'].status).toBe('共 4 个服务供应商');
    expect(semantics.fields['credentials.apiKey']).toMatchObject({ secure: true, required: true, label: 'API Key' });
    expect(semantics.fields['credentials.model'].hint).toBe('默认模型：gpt-test，可直接使用');
    expect(semantics.actions['credentials.submit'].enabledWhen).toEqual(['model.present']);
    expect(semantics.fields['chat.composer'].placeholder).toBe('询问 Motion…');
    expect(JSON.stringify(semantics)).not.toMatch(/AXRole|SwiftUI|ANSI|apiKeyRef|createdCredentialRefs/);
  });

  it('adds semantics to setup responses without replacing existing payload facts', () => {
    const response = launcherSetupResponse('req-ui', 'state', {
      phase: 'needs_credentials',
      provider: { id: 'openai', description: 'OpenAI API', defaultModel: 'gpt-test' },
      modelDefault: 'gpt-test',
      legacyFact: 'preserved',
    });
    expect(response.payload.phase).toBe('needs_credentials');
    expect(response.payload.legacyFact).toBe('preserved');
    const ui = response.payload.ui as LauncherUiSemantics;
    expect(ui.screens['setup.credentials'].subtitle).toBe('OpenAI API。填写配置后，验证通过才会保存。');
    expect(ui.fields['credentials.model'].placeholder).toBe('gpt-test');
  });

  it('projects safe errors and never copies secrets, values, lengths, or raw details into semantics', () => {
    const secret = 'sk-phase2023-secret';
    const response = launcherSetupResponse('req-safe', 'error', {
      phase: 'error', errorType: 'setup', message: 'redacted failure', actions: ['edit', 'cancel'],
    });
    const serialized = JSON.stringify(response.payload.ui);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('redacted failure');
    expect(serialized).not.toMatch(/clipboard|length|value/);
    expect(response.payload.ui).toMatchObject({
      errors: { 'setup.auth': { label: expect.stringContaining('API Key') } },
    });
  });
});
