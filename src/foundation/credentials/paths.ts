/**
 * @module L2a.Credentials
 *
 * Credentials 路径原语（Phase 1925 Step B）。
 *
 * 凭据根目录是**用户级 home**（默认 `~/.chestnut`），与 workspace 的
 * `.chestnut/` 完全无关；`CHESTNUT_HOME` 环境变量可覆盖该根目录
 * （测试/便携场景）。项目 .env 的项目根 = `CHESTNUT_ROOT ?? process.cwd()`
 * （Credentials 独立读取该旧环境约定，不依赖 claw-identity 路径 API）。
 *
 * os.homedir 使用：依赖巡航不禁 `os` 模块（仅 fs/crypto/child_process/net 等
 * 有 owner 锁定），无既有先例冲突。
 */

import * as os from 'os';
import * as path from 'path';

/** 凭据根目录：CHESTNUT_HOME 优先，否则 ~/.chestnut。 */
export function getCredentialsHome(): string {
  const override = process.env.CHESTNUT_HOME;
  if (override !== undefined && override !== '') return override;
  return path.join(os.homedir(), '.chestnut');
}

/** 用户级凭据文件路径（$CREDENTIALS_HOME/credentials.yaml）。 */
export function getCredentialsFilePath(): string {
  return path.join(getCredentialsHome(), 'credentials.yaml');
}

/** 用户级 .env 回退路径（$CREDENTIALS_HOME/.env）。 */
export function getUserDotEnvPath(): string {
  return path.join(getCredentialsHome(), '.env');
}

/** 项目 .env 回退路径（项目根 = CHESTNUT_ROOT ?? cwd）。 */
export function getProjectDotEnvPath(): string {
  const projectRoot = process.env.CHESTNUT_ROOT ?? process.cwd();
  return path.join(projectRoot, '.env');
}
