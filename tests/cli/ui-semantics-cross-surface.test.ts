import { describe, expect, it } from 'vitest';
import {
  createLauncherUiSemantics,
  renderTerminalActivity,
  type LauncherUiSemantics,
} from '../../src/cli-protocol/index.js';

// This fixture is produced by the CLI owner, not a second hand-written copy of business copy.
const fixture: LauncherUiSemantics = createLauncherUiSemantics({
  providerCount: 2,
  providerDescription: 'OpenAI API',
  defaultModel: 'gpt-test',
});

describe('cross-surface UI semantic fixture', () => {
  it('covers setup, credentials, language, repair, composer, activity and errors with stable ids', () => {
    expect(Object.keys(fixture.screens)).toEqual(expect.arrayContaining([
      'setup.provider', 'setup.credentials', 'setup.language', 'setup.repair', 'chat',
    ]));
    expect(Object.keys(fixture.fields)).toEqual(expect.arrayContaining([
      'credentials.apiKey', 'credentials.model', 'credentials.baseUrl', 'setup.language', 'chat.composer',
    ]));
    expect(Object.keys(fixture.actions)).toEqual(expect.arrayContaining([
      'provider.submit', 'credentials.submit', 'repair.retry', 'repair.edit', 'language.submit', 'chat.send',
    ]));
    expect(fixture.errors['setup.auth'].label).toContain('API Key');
    expect(fixture.errors['setup.network'].label).toContain('Base URL');
  });

  it('keeps business text equal across terminal and native projection inputs', () => {
    const cases = [
      { phase: 'waiting', expected: fixture.states['activity.waiting'].label },
      { phase: 'responding', expected: fixture.states['activity.responding'].label },
      { phase: 'processing', label: 'tool', expected: fixture.states['activity.tool'].label },
      { phase: 'error', expected: fixture.states['activity.error'].label },
      { phase: 'interrupted', expected: fixture.states['activity.interrupted'].label },
      { phase: 'retry', expected: fixture.states['activity.retry'].label },
      { phase: 'blocked', expected: fixture.states['activity.blocked'].label },
    ] as const;
    for (const item of cases) {
      expect(renderTerminalActivity(fixture, item)).toBe(item.expected);
    }
  });

  it('exposes secure metadata only and forbids platform-specific or secret-bearing fields', () => {
    expect(fixture.fields['credentials.apiKey']).toEqual({
      id: 'credentials.apiKey', label: 'API Key', placeholder: 'API Key', secure: true, required: true,
    });
    const serialized = JSON.stringify(fixture);
    expect(serialized).not.toMatch(/AXRole|SwiftUI|AppKit|ANSI|apiKeyRef|clipboard|secret|draft/);
  });
});
