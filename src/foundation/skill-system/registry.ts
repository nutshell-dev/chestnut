/**
 * SkillSystem - 技能系统
 * 
 * 采用渐进式披露：
 * - 启动时只加载元信息（frontmatter）
 * - 调用 skill 工具时才加载完整内容
 */

import { isFileNotFound, type FileSystem } from '../../foundation/fs/index.js';
import { formatErr } from "../node-utils/index.js";
import { parseFrontmatterFrame } from "../messaging/index.js";
import type { AuditLog } from '../../foundation/audit/index.js';
import { ToolError } from '../tools/errors.js';
import { SKILL_AUDIT_EVENTS } from './audit-events.js';

// phase 1235 B.1: namespace pattern + duplicate reject
const SKILL_NAME_NAMESPACE_PATTERN = /^[a-z0-9-]+(\/[a-z0-9-]+)?$/;

/**
 * Minimal semver prefix match: accepts X.Y.Z + optional pre-release / build metadata.
 * Examples accepted: 1.0.0, 0.0.0, 1.2.3-beta, 1.2.3+build.123
 * Examples rejected: latest, v1, 1.0, beta, foo
 *
 * phase 59 / skillsystem-auditor §P4 follow-up.
 */
const SKILL_VERSION_PATTERN = /^\d+\.\d+\.\d+/;

export class SkillDuplicateError extends Error {
  constructor(
    public readonly skillName: string,
    public readonly existingDir: string,
    public readonly attemptedDir: string,
  ) {
    super(
      `Skill duplicate registration rejected: ${skillName} (existing=${existingDir}, attempted=${attemptedDir}). per DP 不丢弃 + M#3 资源唯一归属`,
    );
  }
}

/**
 * Phase 1084: 校验/解析失败（frontmatter 损坏、namespace 非法等）。
 * 这类错误在 loadAll 中按单个坏 skill skip（audit LOAD_FAILED），不影响整轮快照。
 */
export class SkillParseError extends Error {
  constructor(
    public readonly skillDir: string,
    message: string,
  ) {
    super(`Skill parse/validation failed: ${skillDir}: ${message}`);
  }
}

export interface SkillMeta {
  name: string;
  description: string;
  version: string;
  skillDir: string;
}

export class SkillSystem {
  private fs: FileSystem;
  private skillsDir: string;
  private metaMap: Map<string, SkillMeta> = new Map();
  // phase 953 (r118 H fork): track name source for duplicate diagnostics
  private nameSourceMap: Map<string, 'frontmatter' | 'fallback_dirname'> = new Map();
  private audit?: AuditLog;

  // phase 1053 α-6: lazy init guard (cold-start sync chain removal)
  private _loaded = false;
  private _loadPromise: Promise<void> | null = null;
  // phase 432 Step A (review N6 partial): per-instance guard — first sync accessor
  // called while !_loaded emits one console.error; subsequent silent。
  private unloadedWarnEmitted = false;

  constructor(fs: FileSystem, skillsDir: string, audit?: AuditLog) {
    this.fs = fs;
    this.skillsDir = skillsDir;
    this.audit = audit;
  }

  private async _ensureLoaded(): Promise<void> {
    if (this._loaded) return;
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = this.loadAll().then(() => {
      this._loaded = true;
    }).finally(() => {
      this._loadPromise = null;
    });
    return this._loadPromise;
  }

  /**
   * 扫描 skillsDir，加载所有技能元信息。
   *
   * phase 432 Step C (review N6 doc): caller 通常应优先 `ensureLoaded()`，
   * 它是 idempotent + lightweight（已 loaded 时 zero-cost）。`loadAll()` 直
   * 接重新扫描、即使已 loaded 也跑、用于 explicit 强制 re-scan（罕见）。
   */
  async loadAll(): Promise<void> {
    // 检查并列出 skills 目录；I/O 错误纳入统一错误边界
    let entries: { name: string; isDirectory: boolean }[];
    try {
      const exists = await this.fs.exists(this.skillsDir);
      if (!exists) {
        this.audit?.write(SKILL_AUDIT_EVENTS.DIR_NOT_FOUND, `dir=${this.skillsDir}`);
        this.metaMap.clear();
        this.nameSourceMap.clear();
        this._loaded = true; // 空目录也算加载完成
        return; // 空目录，不报错
      }

      // 列出 skills 目录下的子目录（按名称排序确保确定性遍历顺序）
      entries = (await this.fs.list(this.skillsDir, { includeDirs: true }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      if (isFileNotFound(err)) {
        // 空目录或 race 删除：清空快照
        this.audit?.write(SKILL_AUDIT_EVENTS.DIR_NOT_FOUND, `dir=${this.skillsDir}`);
        this.metaMap.clear();
        this.nameSourceMap.clear();
        this._loaded = true;
        return;
      }
      this.audit?.write(SKILL_AUDIT_EVENTS.RESCAN_ABORTED,
        `op=list_dir`, `dir=${this.skillsDir}`, `reason=${formatErr(err)}`);
      return; // 保留旧 Map
    }

    // phase 1070: 用临时 Map 完整扫描；phase 1079: I/O 错误时保留旧 Map
    // phase 1084: 翻转边界——仅 FileNotFound / SkillParseError 按单个 skill skip；
    // 其余未知读取错误中止提交并保留旧快照。
    const newMetaMap = new Map<string, SkillMeta>();
    const newNameSourceMap = new Map<string, 'frontmatter' | 'fallback_dirname'>();

    for (const entry of entries) {
      if (!entry.isDirectory) continue;

      const skillDir = `${this.skillsDir}/${entry.name}`;
      const skillMdPath = `${skillDir}/SKILL.md`;

      // 检查 SKILL.md 是否存在；I/O 错误纳入统一错误边界
      let hasSkillMd = false;
      try {
        hasSkillMd = await this.fs.exists(skillMdPath);
      } catch (err) {
        if (!isFileNotFound(err)) {
          this.audit?.write(SKILL_AUDIT_EVENTS.RESCAN_ABORTED,
            `op=exists`, `path=${skillMdPath}`, `reason=${formatErr(err)}`);
          return; // 保留旧 Map
        }
      }
      if (!hasSkillMd) continue;

      try {
        const { meta, nameSource } = await this.loadSkillMeta(skillDir);

        // Duplicate check: reject duplicate registration (phase 1235 B.1)
        // phase 1267 D.2: idempotent when same skillDir (prevents _ensureLoaded cascade duplicate)
        if (newMetaMap.has(meta.name)) {
          const existing = newMetaMap.get(meta.name)!;
          if (existing.skillDir === skillDir) {
            continue;
          }
          const existingNameSource = newNameSourceMap.get(meta.name) || 'unknown';
          this.audit?.write(SKILL_AUDIT_EVENTS.DUPLICATE_REJECTED,
            `name=${meta.name}`,
            `existing_skill_dir=${existing.skillDir}`,
            `attempted_skill_dir=${skillDir}`,
            `existing_name_source=${existingNameSource}`,
            `attempted_name_source=${nameSource}`,
            `existing_version=${existing.version}`,
            `attempted_version=${meta.version}`,
            `skills_dir=${this.skillsDir}`,
          );
          throw new SkillDuplicateError(meta.name, existing.skillDir, skillDir);
        }
        newMetaMap.set(meta.name, meta);
        newNameSourceMap.set(meta.name, nameSource);
      } catch (err) {
        if (err instanceof SkillDuplicateError) throw err;
        if (isFileNotFound(err)) continue; // race → treat as deleted
        if (err instanceof SkillParseError) {
          // 单个 skill 校验/解析失败 → audit + skip，不影响整轮快照
          this.audit?.write(SKILL_AUDIT_EVENTS.LOAD_FAILED,
            `skill_dir=${skillDir}`,
            `skills_dir=${this.skillsDir}`,
            `error=${formatErr(err)}`,
          );
          continue;
        }
        // 其余未知读取错误（EIO/EACCES/EPERM/ENFILE/EROFS/ENOSPC/ETIMEDOUT/unknown）
        // → 中止本轮提交，保留旧 Map
        this.audit?.write(SKILL_AUDIT_EVENTS.RESCAN_ABORTED,
          `skill=${entry.name}`,
          `skill_dir=${skillDir}`,
          `skills_dir=${this.skillsDir}`,
          `reason=${formatErr(err)}`,
        );
        return;
      }
    }

    // 原子替换
    this.metaMap = newMetaMap;
    this.nameSourceMap = newNameSourceMap;

    // 正常出口 audit
    this.audit?.write(SKILL_AUDIT_EVENTS.REGISTRY_LOADED,
      `skills_dir=${this.skillsDir}`,
      `count=${this.metaMap.size}`,
    );
    this._loaded = true;
  }

  /**
   * 加载单个 skill 的元信息（不写入 registry，供 register / loadAll 共享）。
   */
  private async loadSkillMeta(skillDir: string): Promise<{
    meta: SkillMeta;
    nameSource: 'frontmatter' | 'fallback_dirname';
    versionSource: 'frontmatter' | 'fallback_default';
  }> {
    const skillMdPath = `${skillDir}/SKILL.md`;
    const content = await this.fs.read(skillMdPath);

    // 解析 frontmatter (phase 62: frame syntax 共享 helper + caller-side unquote 自治)
    let rawMeta: Record<string, string>;
    try {
      const parsed = parseFrontmatterFrame(content, { eofTolerant: true });
      rawMeta = parsed.meta;
    } catch (parseErr) {
      throw new SkillParseError(skillDir, `failed to parse frontmatter: ${formatErr(parseErr)}`);
    }
    const frontmatter: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawMeta)) {
      frontmatter[k] = v.replace(/^["']|["']$/g, '');
    }

    // 从路径提取技能名（作为 fallback）
    const dirName = skillDir.split('/').pop() || 'unknown';

    // phase 953: track whether name came from frontmatter or fallback dirName
    const nameSource: 'frontmatter' | 'fallback_dirname' = frontmatter.name ? 'frontmatter' : 'fallback_dirname';

    const meta: SkillMeta = {
      name: frontmatter.name || dirName,
      description: frontmatter.description || '',
      version: frontmatter.version || '0.0.0',
      skillDir,
    };
    // Phase 1200: ratify first-wins design row + audit fallback usage
    const versionSource: 'frontmatter' | 'fallback_default' = frontmatter.version ? 'frontmatter' : 'fallback_default';

    // phase 59 / skillsystem-auditor §P4: semver validation (observation only)
    if (versionSource === 'frontmatter' && !SKILL_VERSION_PATTERN.test(meta.version)) {
      this.audit?.write(
        SKILL_AUDIT_EVENTS.VERSION_INVALID,
        `name=${meta.name}`,
        `version=${meta.version}`,
        `expected=X.Y.Z (semver prefix)`,
        `skillDir=${skillDir}`,
      );
      // 不抛、不修正 meta.version、observation only
    }

    // phase 1235 B.1: namespace validation
    if (!SKILL_NAME_NAMESPACE_PATTERN.test(meta.name)) {
      this.audit?.write(
        SKILL_AUDIT_EVENTS.NAMESPACE_INVALID,
        `name=${meta.name}`,
        `expected=<author>/<skill> or simple-kebab-name`,
        `skillDir=${skillDir}`,
      );
      throw new SkillParseError(
        skillDir,
        `Skill name namespace invalid: ${meta.name}. expected <author>/<skill> or simple-kebab-name matching ${SKILL_NAME_NAMESPACE_PATTERN.source}`,
      );
    }

    return { meta, nameSource, versionSource };
  }

  /**
   * 手动注册单个技能
   */
  async register(skillDir: string): Promise<SkillMeta> {
    const { meta, nameSource, versionSource } = await this.loadSkillMeta(skillDir);

    // Duplicate check: reject duplicate registration (phase 1235 B.1)
    // phase 1267 D.2: idempotent when same skillDir (prevents _ensureLoaded cascade duplicate)
    if (this.metaMap.has(meta.name)) {
      const existing = this.metaMap.get(meta.name)!;
      if (existing.skillDir === skillDir) {
        return existing;
      }
      const existingNameSource = this.nameSourceMap.get(meta.name) || 'unknown';
      this.audit?.write(SKILL_AUDIT_EVENTS.DUPLICATE_REJECTED,
        `name=${meta.name}`,
        `existing_skill_dir=${existing.skillDir}`,
        `attempted_skill_dir=${skillDir}`,
        `existing_name_source=${existingNameSource}`,
        `attempted_name_source=${nameSource}`,
        `existing_version=${existing.version}`,
        `attempted_version=${meta.version}`,
        `version_source=${versionSource}`,
        `skills_dir=${this.skillsDir}`,
      );
      throw new SkillDuplicateError(meta.name, existing.skillDir, skillDir);
    }
    this.metaMap.set(meta.name, meta);
    this.nameSourceMap.set(meta.name, nameSource);
    return meta;
  }

  /**
   * phase 432 Step B (review N6 partial): public proactive load API。
   * Caller can `await registry.ensureLoaded()` before first sync accessor
   * (getMeta / listMeta / formatForContext) to eliminate the cold-start
   * race that Step A's maybeWarnUnloaded only observes.
   * Idempotent (delegates to private _ensureLoaded、internal promise chain
   * dedupe)、safe to call repeatedly.
   */
  async ensureLoaded(): Promise<void> {
    return this._ensureLoaded();
  }

  // phase 432 Step A (review N6 partial): observability helper、不改 sync API 行为
  private maybeWarnUnloaded(op: string): void {
    if (!this._loaded && !this.unloadedWarnEmitted) {
      const msg = `[SkillSystem WARNING] ${op} called before async load completed — returning empty/partial result; first prompt may miss skills. Construct SkillSystem and await loaded state before first sync accessor.`;
      console.error(msg); // console: skill-system sync accessor race (review N6) — observability only, do not break (phase 432 Step A)
      this.unloadedWarnEmitted = true;
    }
  }

  /**
   * 获取元信息（sync）。
   *
   * phase 432 Step C (review N6 doc): cold-start race window — 首次调用且
   * `_loaded=false` 时返回 undefined（即使 skill 存在），后续调用 fire-and-forget
   * 的 `_ensureLoaded()` 完成后才稳定。Caller 应优先 `await ensureLoaded()`
   * 前置加载、再调 sync getMeta；否则 Step A 的 warn 会 emit 一次到 stderr。
   */
  getMeta(name: string): SkillMeta | undefined {
    this.maybeWarnUnloaded('getMeta');
    void this._ensureLoaded();
    return this.metaMap.get(name);
  }

  /**
   * 列出所有元信息（sync、cold-start race 同 getMeta、推 `await ensureLoaded()` 前置）。
   */
  listMeta(): SkillMeta[] {
    this.maybeWarnUnloaded('listMeta');
    void this._ensureLoaded();
    return Array.from(this.metaMap.values());
  }

  /**
   * 加载完整 SKILL.md 内容
   */
  async loadFull(name: string): Promise<string> {
    await this._ensureLoaded();
    const meta = this.metaMap.get(name);
    if (!meta) {
      throw new ToolError(`Skill "${name}" not found`);
    }

    const skillMdPath = `${meta.skillDir}/SKILL.md`;
    return await this.fs.read(skillMdPath);
  }

  /**
   * 生成注入到上下文的元信息摘要（sync）。
   *
   * phase 432 Step C (review N6 doc): cold-start race — first turn prompt
   * 可能 miss skills（返回 'No skills loaded.'）。Caller 应优先
   * `await registry.ensureLoaded()` 再调；e.g.
   * `summon.ts:103` / `retro-scheduler.ts:62` 已遵循此 pattern。
   */
  formatForContext(): string {
    this.maybeWarnUnloaded('formatForContext');
    void this._ensureLoaded();
    const metas = this.listMeta();
    if (metas.length === 0) {
      return '## Available Skills\nNo skills loaded.\n';
    }

    const lines = ['## Available Skills'];
    for (const meta of metas) {
      lines.push(`- ${meta.name}: ${meta.description || 'No description'}`);
    }
    return lines.join('\n') + '\n';
  }

}
