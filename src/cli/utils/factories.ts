/**
 * CLI 层装配收拢工厂
 *
 * §1 所有权：
 *   - 职责：为 CLI 命令（非 daemon）提供 ProcessManager / DirContext 的统一构造入口
 *   - 消费者：src/cli/commands/** 的 CLI 命令（非 daemon，非 Assembly 内部）
 *   - 非职责：不装配 Runtime / Snapshot / Stream 等 L2+ 对象（由 Assembly 负责）
 *
 * §7 B 类偏差（#7/#8 权衡登记）：
 *   - 不升格为独立模块：本文件是 L6 CLI 入口层的实现细节，职责非独立可变；若未来 L2+ 装配并入，
 *     合入 Assembly 或新 L2 工厂模块，届时拆出
 *
 * Phase1101: 工厂实现已下沉到 foundation/process-manager/factories.ts。
 * 本文件保留 re-export 以平滑过渡 CLI 内部调用方。
 */

export { createProcessManagerForCLI, createDirContext } from '../../foundation/process-manager/factories.js';
