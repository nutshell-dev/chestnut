#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { supplementalSelection } from './test-diff-rules.mjs';

const CONFIG = '.config/vitest.config.ts';
const INTEGRATION_PROJECTS = new Set(['integration-process', 'integration-io']);
const MAX_FILE_ARGUMENT_CHARS = 24_000;

export class DiffVerificationError extends Error {}

function parseArgs(argv) {
  const options = {
    base: 'main',
    head: 'HEAD',
    mergeVerification: false,
    resolveMergeScope: false,
    hookKind: '0',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--config') {
      const value = argv[index + 1];
      if (value !== CONFIG) throw new DiffVerificationError(`--config must be ${CONFIG}`);
      index += 1;
    } else if (arg === '--base' || arg === '--head' || arg === '--hook-kind') {
      const value = argv[index + 1];
      if (!value) throw new DiffVerificationError(`${arg} requires a value`);
      if (arg === '--base') options.base = value;
      if (arg === '--head') options.head = value;
      if (arg === '--hook-kind') options.hookKind = value;
      index += 1;
    } else if (arg === '--merge-verification') {
      options.mergeVerification = true;
    } else if (arg === '--resolve-merge-scope') {
      options.resolveMergeScope = true;
    } else {
      throw new DiffVerificationError(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function runProcess(spawn, command, args, { cwd, env, allowFailure = false, buffer = false } = {}) {
  const result = spawn(command, args, {
    cwd,
    env,
    encoding: buffer ? 'buffer' : 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw new DiffVerificationError(`${command} failed: ${result.error.message}`);
  if (!allowFailure && result.status !== 0) {
    const detail = String(result.stderr || '').trim();
    throw new DiffVerificationError(`${command} ${args.join(' ')} exited ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function git(spawn, cwd, env, args, options = {}) {
  return runProcess(spawn, 'git', args, { cwd, env, ...options });
}

function resolveCommit(spawn, cwd, env, ref) {
  if (!ref || ref.startsWith('-')) throw new DiffVerificationError(`Invalid commit reference: ${ref}`);
  return git(spawn, cwd, env, ['rev-parse', '--verify', `${ref}^{commit}`]).stdout.trim();
}

export function parseNameStatus(output, source) {
  const fields = output.toString().split('\0');
  const changes = [];
  for (let index = 0; index < fields.length && fields[index]; index += 1) {
    const status = fields[index];
    if (/^[RC]/.test(status)) {
      const oldPath = fields[++index];
      const newPath = fields[++index];
      if (!oldPath || !newPath) throw new DiffVerificationError(`Malformed rename in ${source} name-status`);
      changes.push({ source, status, oldPath, newPath, paths: [oldPath, newPath] });
    } else {
      const file = fields[++index];
      if (!file) throw new DiffVerificationError(`Malformed path in ${source} name-status`);
      changes.push({ source, status, paths: [file] });
    }
  }
  return changes;
}

export function collectChangeInputs({ cwd, env = process.env, spawn = spawnSync, base, head }) {
  const committed = git(spawn, cwd, env, ['diff', '--name-status', '-z', `${base}...${head}`], { buffer: true }).stdout;
  const staged = git(spawn, cwd, env, ['diff', '--cached', '--name-status', '-z', head], { buffer: true }).stdout;
  const unstaged = git(spawn, cwd, env, ['diff', '--name-status', '-z'], { buffer: true }).stdout;
  const untrackedOutput = git(spawn, cwd, env, ['ls-files', '--others', '--exclude-standard', '-z'], { buffer: true }).stdout;
  const untracked = untrackedOutput.toString().split('\0').filter(Boolean)
    .map(file => ({ source: 'untracked', status: '??', paths: [file] }));
  const changes = [
    ...parseNameStatus(committed, 'committed'),
    ...parseNameStatus(staged, 'staged'),
    ...parseNameStatus(unstaged, 'unstaged'),
    ...untracked,
  ];
  return { changes, paths: [...new Set(changes.flatMap(change => change.paths))] };
}

export function mergeScope({
  before,
  after,
  hookKind,
  previousHead,
  firstParent,
  secondParent,
  trackedClean,
  untrackedClean,
  baseIsAncestor,
}) {
  if (hookKind === '1') {
    throw new DiffVerificationError('Merged tree verification unavailable: squash merge has no merged HEAD; run with an explicit base after committing');
  }
  if (!before || before === after || before !== previousHead) {
    throw new DiffVerificationError('Merged tree verification unavailable: ORIG_HEAD does not match the previous HEAD reflog entry');
  }
  if (!trackedClean || !untrackedClean) {
    throw new DiffVerificationError('Merged tree verification unavailable: merged tree has tracked or untracked changes');
  }
  if (secondParent && firstParent === before) return { base: before, head: after };
  // A fast-forward may land on a merge commit. In that case HEAD^1 is not the
  // pre-merge HEAD, so ancestry—not the number of parents at the new tip—proves scope.
  if (!baseIsAncestor) {
    throw new DiffVerificationError('Merged tree verification unavailable: merge first parent is not ORIG_HEAD and fast-forward ancestry is absent');
  }
  return { base: before, head: after };
}

export function resolveMergeScope({ cwd, hookKind = '0', env = process.env, spawn = spawnSync }) {
  if (hookKind === '1') {
    return mergeScope({ hookKind });
  }
  const after = resolveCommit(spawn, cwd, env, 'HEAD');
  const before = resolveCommit(spawn, cwd, env, 'ORIG_HEAD');
  const previousHead = resolveCommit(spawn, cwd, env, 'HEAD@{1}');
  const firstParent = resolveCommit(spawn, cwd, env, 'HEAD^1');
  const second = git(spawn, cwd, env, ['rev-parse', '--verify', 'HEAD^2^{commit}'], { allowFailure: true });
  const secondParent = second.status === 0 ? second.stdout.trim() : null;
  const tracked = git(spawn, cwd, env, ['status', '--porcelain=v1', '--untracked-files=no']).stdout;
  const untracked = git(spawn, cwd, env, ['ls-files', '--others', '--exclude-standard']).stdout;
  const ancestor = git(spawn, cwd, env, ['merge-base', '--is-ancestor', before, after], { allowFailure: true });
  if (ancestor.status !== 0 && ancestor.status !== 1) {
    throw new DiffVerificationError(`Cannot determine whether merge base ${before} is an ancestor of ${after}`);
  }
  return mergeScope({
    before,
    after,
    hookKind,
    previousHead,
    firstParent,
    secondParent,
    trackedClean: tracked.trim() === '',
    untrackedClean: untracked.trim() === '',
    baseIsAncestor: ancestor.status === 0,
  });
}

function readJson(file, label) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new DiffVerificationError(`Cannot parse ${label} JSON ${file}: ${error.message}`);
  }
  return parsed;
}

function relativeFile(cwd, file) {
  const absolute = path.resolve(cwd, file);
  const relative = path.relative(cwd, absolute).split(path.sep).join('/');
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new DiffVerificationError(`Selected test is outside the repository: ${file}`);
  }
  return relative;
}

function graphSelection(cwd, file) {
  const selected = readJson(file, 'Vitest list');
  if (!Array.isArray(selected)) throw new DiffVerificationError('Vitest list JSON must be an array');
  return selected.map(item => {
    if (!item || typeof item.file !== 'string' || typeof item.projectName !== 'string' || !item.projectName) {
      throw new DiffVerificationError('Every Vitest list entry must include file and projectName');
    }
    return { file: relativeFile(cwd, item.file), projectName: item.projectName, source: 'dependency-graph' };
  });
}

function laneArgumentLength(lane) {
  return (lane.files || []).reduce((total, file) => total + file.length + 1, 0);
}

export function planLanes(graph, rules) {
  const requiredFiles = [...new Set([...graph.map(item => item.file), ...rules.files])];
  if (rules.full) {
    return [{ kind: 'full', command: 'test:preflight', reason: 'explicit-wide-validation', requiredFiles, build: true }];
  }

  const lanes = [];
  const byProject = new Map();
  for (const item of graph) {
    if (rules.projects.includes(item.projectName)) continue;
    if (!byProject.has(item.projectName)) byProject.set(item.projectName, new Map());
    byProject.get(item.projectName).set(item.file, item);
  }
  for (const file of rules.files) {
    if (!byProject.has('fast')) byProject.set('fast', new Map());
    if (!byProject.get('fast').has(file)) {
      byProject.get('fast').set(file, { file, projectName: 'fast', source: 'explicit-rule' });
    }
  }
  for (const [projectName, files] of byProject) {
    const selected = [...files.values()];
    lanes.push({
      kind: 'files',
      projectName,
      files: selected.map(item => item.file),
      selection: selected,
      build: INTEGRATION_PROJECTS.has(projectName),
    });
  }
  for (const projectName of rules.projects) {
    lanes.push({ kind: 'project', projectName, files: [], selection: [{ projectName, source: 'explicit-rule' }] });
  }
  if (lanes.some(lane => laneArgumentLength(lane) > MAX_FILE_ARGUMENT_CHARS)) {
    return [{
      kind: 'full',
      command: 'test:preflight',
      reason: 'selection-arguments-too-long',
      requiredFiles,
      build: true,
    }];
  }
  return lanes;
}

function runBuild({ cwd, env, spawn }) {
  const result = runProcess(spawn, 'pnpm', ['run', 'build'], { cwd, env, allowFailure: true });
  return { command: 'pnpm run build', exitCode: result.status };
}

function summarizeReport(report) {
  const countFields = ['numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests', 'numTotalTests'];
  if (!report || countFields.some(field => !Number.isInteger(report[field]) || report[field] < 0)
    || !Array.isArray(report.testResults)
    || report.testResults.some(result => !result || typeof result.name !== 'string')) {
    throw new DiffVerificationError('Vitest reporter JSON has an invalid result schema');
  }
  return {
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    skipped: report.numPendingTests + report.numTodoTests,
    total: report.numTotalTests,
    success: report.success,
    files: report.testResults.map(result => result.name),
  };
}

function executeLane(lane, { cwd, env, spawn, tempDir, index }) {
  const outputFile = path.join(tempDir, `reporter-${index}.json`);
  let args;
  if (lane.kind === 'full') {
    args = ['run', 'test:preflight', '--', '--reporter=json', `--outputFile=${outputFile}`];
  } else {
    args = ['exec', 'vitest', 'run', '--config', CONFIG, `--project=${lane.projectName}`];
    if (lane.kind === 'files') args.push(...lane.files.map(file => `./${file}`));
    args.push('--reporter=json', `--outputFile=${outputFile}`);
  }
  const result = runProcess(spawn, 'pnpm', args, { cwd, env, allowFailure: true });
  const execution = {
    kind: lane.kind,
    projectName: lane.projectName,
    files: lane.files,
    command: ['pnpm', ...args],
    exitCode: result.status,
  };
  if (!fs.existsSync(outputFile)) {
    return { execution, outcome: 'failed', reason: 'Vitest JSON reporter did not create an output file' };
  }
  let report;
  try {
    report = readJson(outputFile, 'Vitest reporter');
  } catch (error) {
    return { execution, outcome: 'failed', reason: error.message };
  }
  try {
    execution.report = summarizeReport(report);
  } catch (error) {
    return { execution, outcome: 'failed', reason: error.message };
  }
  if (result.status !== 0 || report.success !== true || report.numFailedTests > 0) {
    return { execution, outcome: 'failed', reason: 'Selected tests failed' };
  }
  if (report.numTotalTests === 0 || report.numPassedTests === 0) {
    return { execution, outcome: 'unverified', reason: 'Selected lane executed zero tests' };
  }
  if (lane.kind === 'files' || lane.kind === 'full') {
    const expectedFiles = lane.kind === 'full' ? lane.requiredFiles : lane.files;
    const actual = new Set(report.testResults.map(item => relativeFile(cwd, item.name)));
    const missing = expectedFiles.filter(file => !actual.has(file));
    if (missing.length > 0) {
      return { execution, outcome: 'unverified', reason: `Reporter did not record selected files: ${missing.join(', ')}` };
    }
  }
  return { execution, outcome: 'passed' };
}

export function runDiff({
  base: baseRef = 'main',
  head: headRef = 'HEAD',
  mergeVerification = false,
  cwd = process.cwd(),
  env = process.env,
  spawn = spawnSync,
  tempRoot = os.tmpdir(),
} = {}) {
  const receipt = {
    outcome: 'unverified',
    baseRef,
    headRef,
    mergeVerification,
    changes: [],
    graphSelection: [],
    explicitRules: null,
    executions: [],
  };
  let tempDir;
  try {
    const base = resolveCommit(spawn, cwd, env, baseRef);
    const head = resolveCommit(spawn, cwd, env, headRef);
    const currentHead = resolveCommit(spawn, cwd, env, 'HEAD');
    receipt.base = base;
    receipt.head = head;
    if (head !== currentHead) {
      throw new DiffVerificationError(`Requested head ${head} is not the checked-out HEAD ${currentHead}`);
    }
    const ancestor = git(spawn, cwd, env, ['merge-base', '--is-ancestor', base, head], { allowFailure: true });
    if (ancestor.status !== 0) {
      throw new DiffVerificationError(`Base ${base} is not an ancestor of head ${head}`);
    }
    const inputs = collectChangeInputs({ cwd, env, spawn, base, head });
    receipt.changes = inputs.changes;
    if (mergeVerification && inputs.changes.some(change => change.source !== 'committed')) {
      throw new DiffVerificationError('Merge verification requires a clean tracked and untracked tree');
    }
    if (inputs.changes.length === 0) {
      receipt.outcome = 'no-changes';
      receipt.reason = 'No committed, staged, unstaged, or untracked changes in scope';
      return receipt;
    }

    tempDir = fs.mkdtempSync(path.join(tempRoot, 'chestnut-test-diff-'));
    const listFile = path.join(tempDir, 'selection.json');
    runProcess(spawn, 'pnpm', [
      'exec', 'vitest', 'list', '--config', CONFIG, `--changed=${base}`,
      '--filesOnly', `--json=${listFile}`,
    ], { cwd, env });
    const graph = graphSelection(cwd, listFile);
    const rules = supplementalSelection(inputs.paths);
    const lanes = planLanes(graph, rules);
    receipt.graphSelection = graph;
    receipt.explicitRules = rules;
    receipt.lanes = lanes;
    if (lanes.length === 0) {
      receipt.reason = 'Changes are non-empty but dependency graph and explicit rules selected no tests';
      return receipt;
    }
    if (lanes.some(lane => lane.reason === 'selection-arguments-too-long')) {
      receipt.reason = 'Selection exceeded the safe argument budget; using full preflight';
    }

    if (rules.build || lanes.some(lane => lane.build)) {
      receipt.build = runBuild({ cwd, env, spawn });
      if (receipt.build.exitCode !== 0) {
        receipt.outcome = 'failed';
        receipt.reason = 'Build failed; selected tests were not run';
        return receipt;
      }
    }
    for (let index = 0; index < lanes.length; index += 1) {
      const result = executeLane(lanes[index], { cwd, env, spawn, tempDir, index });
      receipt.executions.push(result);
      if (result.outcome !== 'passed') {
        receipt.outcome = result.outcome;
        receipt.reason = result.reason;
        return receipt;
      }
    }
    receipt.outcome = 'passed';
    receipt.reason = 'All selected lanes exited zero and their JSON receipts recorded executed tests';
    return receipt;
  } catch (error) {
    receipt.outcome = 'unverified';
    receipt.reason = error instanceof Error ? error.message : String(error);
    return receipt;
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.resolveMergeScope) {
      const scope = resolveMergeScope({ cwd: process.cwd(), hookKind: options.hookKind });
      console.log(`${scope.base} ${scope.head}`);
      return;
    }
    const receipt = runDiff(options);
    console.log(JSON.stringify(receipt, null, 2));
    if (receipt.outcome !== 'passed' && receipt.outcome !== 'no-changes') process.exitCode = 1;
  } catch (error) {
    console.error(`[test:diff] UNVERIFIED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
