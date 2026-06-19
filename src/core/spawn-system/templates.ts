/**
 * spawn 工具 template registry
 *
 * phase 11 立 / template = caller-side 预制 system prompt 选择 / 与 §10.1.8 recipe（subagent 内部 skill 套娃）正交。
 * 后续 NEW template 在 SPAWN_TEMPLATES 加条；prompt 体量大时拆 `templates/<name>.ts` sub-file 再 import 进 registry。
 */

import { DEFAULT_SUBAGENT_SYSTEM_PROMPT } from '../../templates/prompts/index.js';

export const SPAWN_TEMPLATES = {
  default: DEFAULT_SUBAGENT_SYSTEM_PROMPT,
} as const satisfies Record<string, string>;

export type SpawnTemplateName = keyof typeof SPAWN_TEMPLATES;

export const DEFAULT_SPAWN_TEMPLATE: SpawnTemplateName = 'default';

export function resolveSpawnTemplate(name: string): string | null {
  return Object.prototype.hasOwnProperty.call(SPAWN_TEMPLATES, name)
    ? SPAWN_TEMPLATES[name as SpawnTemplateName]
    : null;
}

export function listSpawnTemplateNames(): readonly string[] {
  return Object.keys(SPAWN_TEMPLATES);
}
