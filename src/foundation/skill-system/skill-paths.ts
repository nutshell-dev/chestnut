/**
 * SkillSystem 路径常量集中定义
 * 
 * 集中 'skills' / 'clawspace/dispatch-skills' 字面量 / caller 风格统一并轨第 5 次复用模板
 * 同 phase345 audit event / phase347 tool name / phase349 watchdog audit / phase355 audit factory + skill events
 * 
 * phase370 已立 + phase399 补 SUBDIR 派生 / B.p169-2 完整闭环
 * 
 * 应然（design/modules/l2_skill_system.md）：
 * - skillsDir 必填 / 不预设默认值（B.p169-3 闭环）
 * - 字符串字面量集中 const（B.p169-2 闭环）
 */


/** per-agent 自身 skills 目录默认值（motion 自有 + 各 claw 各自 skills） */
export const SKILLS_DIR_DEFAULT = 'skills' as const;

/** 源码树 bundled skills 资源目录名（非运行期 agent subdir） */
export const BUNDLED_SKILLS_DIR_NAME = 'skills' as const;

// dispatch-skills const 物理迁 evolution-system/dispatch-skills-paths.ts (phase411 / 资源归属 EvolutionSystem)
