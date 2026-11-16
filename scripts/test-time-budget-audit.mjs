import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const TEST_CALLS = new Set(['it', 'test', 'describe', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll']);
const TIMER_CALLS = new Set(['setTimeout', 'setInterval']);
const TIME_FIELDS = new Set([
  'timeout', 'timeoutMs', 'retryDelayMs', 'resetTimeoutMs', 'cooldownMs', 'quotaDelayMs',
  'callDelayMs', 'streamDelayMs', 'idleTimeoutMs', 'probeIntervalMs', 'pollIntervalMs',
  'intervalMs', 'graceMs', 'confirmMs', 'staleMs', 'acquireTimeoutMs', 'pollMs',
  'deadlineAtMs', '__testSigkillGraceMs', '__testMinTimeoutMs', 'rejectAfterMs',
  'retryBaseDelayMs', 'toolTimeoutMs', 'hardTimeoutMs', 'migratedHardTimeoutMs',
]);
const DEADLINE_FIELDS = new Set(['deadlineAtMs', 'migratedDeadlineMs', 'bootDeadlineMs']);
const FIXTURE_MARKER = 'time-fixture:';

function callName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return '';
}

function propertyName(node) {
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) return node.name.text;
  return '';
}

function numericValue(node) {
  if (!ts.isNumericLiteral(node)) return undefined;
  return Number(node.text.replaceAll('_', ''));
}

function hasFixtureMarker(sourceFile, node) {
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line;
  const lines = sourceFile.text.split('\n');
  return lines.slice(Math.max(0, line - 1), line + 1).some(text => text.includes(FIXTURE_MARKER));
}

function hasNamedConstantOwner(node) {
  let current = node.parent;
  while (current && !ts.isVariableDeclaration(current)) current = current.parent;
  return current && ts.isIdentifier(current.name) && /^[A-Z][A-Z0-9_]+$/.test(current.name.text);
}

function dateNowOffset(node) {
  if (!ts.isBinaryExpression(node)) return undefined;
  if (node.operatorToken.kind !== ts.SyntaxKind.PlusToken && node.operatorToken.kind !== ts.SyntaxKind.MinusToken) return undefined;
  const left = node.left;
  const isNow = ts.isCallExpression(left)
    && ts.isPropertyAccessExpression(left.expression)
    && ts.isIdentifier(left.expression.expression)
    && left.expression.expression.text === 'Date'
    && left.expression.name.text === 'now';
  return isNow ? numericValue(node.right) : undefined;
}

/** Return direct numeric time budgets; explicit per-site fixtures remain visible through their marker. */
export function detectMagicTestTimeBudgets(source, file = 'fixture.ts') {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const violations = [];
  const add = (node, shape) => {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    violations.push({ file, line: position.line + 1, shape, text: node.getText(sourceFile) });
  };

  function visit(node) {
    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node);
      const value = numericValue(node.initializer);
      if (TIME_FIELDS.has(name) && value !== undefined && value > 1
        && !hasNamedConstantOwner(node) && !hasFixtureMarker(sourceFile, node)) {
        add(node, `time-field:${name}`);
      }
      const offset = dateNowOffset(node.initializer);
      if (DEADLINE_FIELDS.has(name) && offset !== undefined && offset > 1
        && !hasNamedConstantOwner(node) && !hasFixtureMarker(sourceFile, node)) {
        add(node, `deadline:${name}`);
      }
    }

    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = numericValue(node.initializer);
      if (TIME_FIELDS.has(node.name.text) && value !== undefined && value > 1) {
        add(node, `helper-default:${node.name.text}`);
      }
    }

    if (ts.isCallExpression(node)) {
      const name = callName(node.expression);
      const last = node.arguments.at(-1);
      if (TEST_CALLS.has(name) && last && numericValue(last) !== undefined) add(last, 'runner-timeout');
      if (TIMER_CALLS.has(name) && node.arguments[1] && numericValue(node.arguments[1]) !== undefined) {
        add(node.arguments[1], `timer:${name}`);
      }
      if (name === 'waitFor' && node.arguments[1] && numericValue(node.arguments[1]) !== undefined) {
        add(node.arguments[1], 'waitFor-budget');
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return violations;
}

export function scanTestTimeBudgets(repoRoot) {
  const violations = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:ts|tsx|js)$/.test(entry.name)) {
        violations.push(...detectMagicTestTimeBudgets(fs.readFileSync(full, 'utf8'), path.relative(repoRoot, full)));
      }
    }
  }
  walk(path.join(repoRoot, 'tests'));
  return violations;
}
