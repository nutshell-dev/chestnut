/**
 * M03 inbox 文案：验收结果/拒绝/错误/放行通知与验收执行反馈文本。
 * 触发/接收者：ContractSystem 验证流水线 → 契约所属 claw。
 * 原 owner：core/contract（verification-notify / verification / verification-format / verification-execution）。
 *
 * phase 1829：语义变更（非等价迁移）——通知正文携带契约/子任务/尝试身份与已提交处置。
 * 本文件为纯静态资源：入参仅标量或标量组成的只读对象；不读 FS/配置/时钟；
 * 不消费 ContractSystem 类型；业务分支（选哪个模板）归 owner。
 */

// ─── 通知身份与共用片段 ───

interface NoticeIdentity {
  contractId: string;
  subtaskId: string;
  attemptId?: string;
  observedAt?: string;
}

function identityLines(id: NoticeIdentity): string[] {
  const lines = [`契约：${id.contractId}；子任务：${id.subtaskId}；验收尝试：${id.attemptId ?? '（未提供）'}`];
  if (id.observedAt !== undefined) lines.push(`结果时间：${id.observedAt}`);
  return lines;
}

const RESULT_TITLE = '契约验收通知';
const ERROR_TITLE = '契约验收流程异常';

/** knownVerdict==='passed' 时的事实行：验收计算通过，但结果提交未确认。 */
function knownVerdictLine(knownVerdict?: 'passed' | 'not_passed' | 'unavailable'): string | null {
  return knownVerdict === 'passed' ? '验收计算通过，但结果提交未确认。' : null;
}

// ─── 正常结果通知 ───

/** 验收通过（状态已提交为完成）。 */
export function verificationPassedNotice(input: NoticeIdentity & { allCompleted: boolean }): string {
  return [
    RESULT_TITLE,
    ...identityLines(input),
    '本次验收通过，系统已将该子任务记为完成。',
    input.allCompleted
      ? '截至本次结果提交，该契约的全部子任务均已完成。'
      : '该契约仍有未完成子任务，请按当前契约进度继续执行。',
  ].join('\n');
}

/** 验收未通过（已提交退回待提交）。feedback 为空串/缺省视为无反馈。 */
export function verificationRejectedNotice(input: NoticeIdentity & { feedback?: string }): string {
  const lines = [
    RESULT_TITLE,
    ...identityLines(input),
    '本次验收未通过，系统已将该子任务退回待提交。',
  ];
  if (input.feedback !== undefined && input.feedback !== '') {
    lines.push(
      '验收反馈：',
      input.feedback,
      '请依据反馈处理该子任务，再重新提交以发起验收；系统尚未自动再次验收。',
    );
  } else {
    lines.push(
      '验收方未提供反馈，当前没有具体修改依据。',
      '请先核对该子任务的验收要求与提交材料；若仍无法定位问题，明确缺少的依据，不凭空修改交付物。',
    );
  }
  return lines.join('\n');
}

/** 正常未通过达到阈值后放行（verdict 元数据为 passed 但语义是放行，不是验收通过）。 */
export function verificationForceAcceptedNotice(input: NoticeIdentity & {
  retryCount: number;
  maxAttempts: number;
  allCompleted: boolean;
  feedback?: string;
}): string {
  const lines = [
    RESULT_TITLE,
    ...identityLines(input),
    `本次验收未通过；失败计数达到配置阈值 ${input.maxAttempts}，系统已按现行规则将该子任务记为完成。`,
    '这表示流程放行，不表示本次验收通过。',
  ];
  if (input.feedback !== undefined && input.feedback !== '') {
    lines.push('本次失败反馈：', input.feedback);
  }
  lines.push('请结合这项未通过的反馈判断交付质量；不需要再次提交已完成的子任务。');
  if (input.allCompleted) {
    lines.push('截至本次结果提交，该契约的全部子任务均已完成。');
  }
  return lines.join('\n');
}

// ─── 异常通知 ───

/** 流程异常且已确认退回待提交（含 fallback interrupt 确认提交的情形）。 */
export function verificationErrorReturnedNotice(input: NoticeIdentity & {
  errorMessage: string;
  stage: 'execution' | 'outcome_processing' | 'post_commit' | 'unspecified';
  knownVerdict?: 'passed' | 'not_passed' | 'unavailable';
  retryCount?: number;
  processingError?: string;
}): string {
  const stageText = input.stage === 'execution' ? '验收执行' : '验收流程';
  const lines = [
    ERROR_TITLE,
    ...identityLines(input),
    `本次${stageText}异常结束，系统已将该子任务退回待提交。`,
  ];
  const verdictLine = knownVerdictLine(input.knownVerdict);
  if (verdictLine !== null) lines.push(verdictLine);
  lines.push(`异常：${input.errorMessage}`);
  if (input.processingError !== undefined) {
    lines.push(`状态处置过程中另有异常：${input.processingError}`);
  }
  if (input.retryCount !== undefined) {
    lines.push(`当前已提交失败计数：${input.retryCount}。`);
  }
  lines.push(
    '此次异常不提供交付质量结论。系统尚未自动再次验收。',
    '如需重新验收，可重新提交该子任务；若持续受阻，说明验收环节的阻塞及所需条件。',
  );
  return lines.join('\n');
}

/** 流程异常达到阈值后放行：一条通知同时携带原异常与放行事实。 */
export function verificationErrorForceAcceptedNotice(input: NoticeIdentity & {
  errorMessage: string;
  retryCount: number;
  maxAttempts: number;
  allCompleted: boolean;
  feedback?: string;
}): string {
  const lines = [
    RESULT_TITLE,
    ...identityLines(input),
    `本次验收流程发生异常，未得到正常通过结论；失败计数达到配置阈值 ${input.maxAttempts}，系统已按现行规则将该子任务记为完成。`,
    '这表示流程放行，不表示验收通过。',
    `异常：${input.errorMessage}`,
  ];
  if (input.feedback !== undefined && input.feedback !== '') {
    lines.push('本次失败反馈：', input.feedback);
  }
  lines.push('不需要再次提交已完成的子任务；请结合上述异常判断交付质量。');
  if (input.allCompleted) {
    lines.push('截至本次结果提交，该契约的全部子任务均已完成。');
  }
  return lines.join('\n');
}

/** 流程异常但未据其推进状态（旧尝试/非活跃/冲突/不适用）。 */
export function verificationErrorNotAppliedNotice(input: NoticeIdentity & {
  errorMessage: string;
  reason: 'not_active' | 'not_in_progress' | 'missing_subtask' | 'late' | 'conflict' | 'skipped';
  detail?: string;
  observedStatus?: string;
  actualAttemptId?: string;
  knownVerdict?: 'passed' | 'not_passed' | 'unavailable';
}): string {
  const lines = [
    ERROR_TITLE,
    ...identityLines(input),
    `异常：${input.errorMessage}`,
  ];
  const verdictLine = knownVerdictLine(input.knownVerdict);
  if (verdictLine !== null) lines.push(verdictLine);
  if (input.reason === 'late') {
    lines.push('此异常属于上述尝试；系统未将其应用于当前状态（该异常属于旧尝试）。');
    if (input.actualAttemptId !== undefined) {
      lines.push(`系统当前记录的验收尝试为 ${input.actualAttemptId}。`);
    }
    lines.push('请以当前契约进度为准，不因该旧尝试通知重复执行。');
    return lines.join('\n');
  }
  let reasonLine: string;
  switch (input.reason) {
    case 'not_active':
      reasonLine = '该契约已不在活跃状态';
      break;
    case 'missing_subtask':
      reasonLine = '未找到该子任务的进行中记录';
      break;
    case 'not_in_progress':
      reasonLine = input.observedStatus !== undefined
        ? `该子任务当前不在验收中状态（观测状态：${input.observedStatus}）`
        : '该子任务当前不在验收中状态';
      break;
    case 'conflict':
      reasonLine = '已持久化的验收结果与本次内容冲突';
      break;
    case 'skipped':
      reasonLine = input.detail !== undefined ? `状态提交被跳过：${input.detail}` : '状态提交被跳过';
      break;
  }
  lines.push(
    `此异常属于上述尝试；系统未据其推进该子任务状态（${reasonLine}）。`,
    '请以当前契约进度为准，不要求重做当前尝试。',
  );
  return lines.join('\n');
}

/** 流程异常且状态处置无法确认。 */
export function verificationErrorUnconfirmedNotice(input: NoticeIdentity & {
  errorMessage: string;
  processingError: string;
  knownVerdict?: 'passed' | 'not_passed' | 'unavailable';
}): string {
  const lines = [
    ERROR_TITLE,
    ...identityLines(input),
    `异常：${input.errorMessage}`,
  ];
  const verdictLine = knownVerdictLine(input.knownVerdict);
  if (verdictLine !== null) lines.push(verdictLine);
  lines.push(
    `状态处置也发生异常：${input.processingError}`,
    `当前未确认该子任务已退回待提交。此通知不表示可以重新提交；需要核对 ${input.contractId}/${input.subtaskId} 的当前状态。`,
  );
  return lines.join('\n');
}

// ─── 结构化拒绝反馈（verification-format 委托的固定文案与纯布局） ───

export function structuredRejectionFeedback(input: {
  subtaskDesc: string;
  reason: string;
  issues: readonly string[];
  retryCount: number;
  maxRetries: number;
  verificationType: string;
  verificationFile: string;
}): string {
  const issuesList = input.issues.length > 0
    ? input.issues.map(i => `- ${i}`).join('\n')
    : '- (未提供具体问题)';
  return [
    `**子任务：** ${input.subtaskDesc}`,
    '',
    '**失败原因：**',
    input.reason,
    '',
    '**需要修正的问题：**',
    issuesList,
    '',
    `**验收标准：** ${input.verificationType} (${input.verificationFile})`,
    '',
    `已失败 ${input.retryCount}/${input.maxRetries} 次。`,
  ].join('\n');
}

// ─── 验收执行/配置上游反馈（系统编写的固定文案；动态异常与原输出由 owner 透传） ───

export function verificationConfigMissingScriptFileFeedback(): string {
  return 'verification config script 类型缺少 script_file';
}

export function verificationConfigMissingPromptFileFeedback(): string {
  return 'verification config llm 类型缺少 prompt_file';
}

export function scriptFilePathRejectedFeedback(): string {
  return '路径安全拒绝: script_file 必须在契约目录内（或为不可解析的 symlink）';
}

export function scriptVerificationPassedFeedback(): string {
  return 'Script verification passed';
}

export function scriptVerificationFailedFeedback(detail: string): string {
  return `验收失败: ${detail}`;
}

export function scriptVerificationTimeoutFeedback(detail: string): string {
  return `验收脚本超时: ${detail}`;
}

export function llmNotConfiguredFeedback(): string {
  return 'LLM 验收未配置（llm 未注入）';
}

export function promptFilePathRejectedFeedback(): string {
  return '路径安全拒绝: prompt_file 必须在契约目录内';
}

export function promptFileEscapedClawFeedback(): string {
  return '路径安全拒绝: prompt_file 解析后逃出 claw 目录';
}

export function promptFileReadFailedFeedback(relativePath: string, errorMsg: string): string {
  return `prompt_file 读失败 (${relativePath}): ${errorMsg}`;
}

export function verifierSubagentTimeoutFeedback(): string {
  return '验收子代理超时';
}

export function llmVerificationFailedFeedback(errorMsg: string): string {
  return `LLM 验收失败: ${errorMsg}`;
}

// ─── 错误持久反馈（写入 last_failed_feedback / errored outcome 的共享文本） ───

export function verificationTimeoutFeedback(timeoutMs: string | number, errorMsg: string): string {
  return `Acceptance verifier timed out after ${timeoutMs}ms. 资源 / 网络问题 / 重试可能修复。Error: ${errorMsg}`;
}

export function verificationCrashedFeedback(errorMsg: string): string {
  return `Acceptance verification crashed (system bug). Error: ${errorMsg}. 修代码后再 retry。`;
}
