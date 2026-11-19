/**
 * @module L4.LLMConfiguration.LegacyCredentials
 *
 * Workspace credentials 路径原语（Phase 2206 Step B）。
 * 唯一可写文件为 `<workspace>/.chestnut/llm/credentials.yaml`，锁由 owner
 * 放在同目录；workspace 根 `.env` 仅作为只读回退。路径解析与 LLM 配置共用
 * `getChestnutRoot()`，不读取用户级凭据或 `CHESTNUT_HOME`。
 */

import * as path from 'path';
import { getChestnutRoot } from '../../../foundation/claw-identity/index.js';

export interface WorkspaceCredentialsPaths {
  readonly workspaceRoot: string;
  readonly credentialsFile: string;
  readonly lockFile: string;
  readonly workspaceDotEnv: string;
}

/** 从显式 workspace root 派生全部凭据路径；不读取进程环境或 cwd。 */
export function workspaceCredentialsPaths(workspaceRoot: string): WorkspaceCredentialsPaths {
  const root = path.resolve(workspaceRoot);
  const dir = path.join(root, '.chestnut', 'llm');
  return {
    workspaceRoot: root,
    credentialsFile: path.join(dir, 'credentials.yaml'),
    lockFile: path.join(dir, 'credentials.yaml.lock'),
    workspaceDotEnv: path.join(root, '.env'),
  };
}

function currentWorkspaceCredentialsPaths(): WorkspaceCredentialsPaths {
  return workspaceCredentialsPaths(path.dirname(getChestnutRoot()));
}

/** 当前 workspace 的唯一可写凭据文件。 */
export function getCredentialsFilePath(): string {
  return currentWorkspaceCredentialsPaths().credentialsFile;
}

/** 当前 workspace 的只读 .env 回退路径。 */
export function getProjectDotEnvPath(): string {
  return currentWorkspaceCredentialsPaths().workspaceDotEnv;
}
