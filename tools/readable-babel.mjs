#!/usr/bin/env node
/**
 * Conservative, inspectable readability passes for Webcrack output.
 * Nothing from the analyzed SDK is executed by this script.
 *
 * Usage:
 * node tools/readable-babel.mjs --input deobfus/castle-webcrack.js \
 *   --output deobfus/12-babel-readable.js --report deobfus/12-babel-report.json
 *
 * Optional, REVIEW FIRST:
 *   --allow-init-file tools/approved-init-constants.json
 *   --trust-single-write
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import generate from '@babel/generator';
import * as t from '@babel/types';

const argumentsMap = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
  if (arg === '--trust-single-write') argumentsMap.set(arg, true);
  else argumentsMap.set(arg, process.argv[++i]);
}

const input = path.resolve(argumentsMap.get('--input') ?? 'deobfus/castle-webcrack.js');
const output = path.resolve(argumentsMap.get('--output') ?? 'deobfus/12-babel-readable.js');
const reportPath = path.resolve(argumentsMap.get('--report') ?? 'deobfus/12-babel-report.json');
if (input === output) throw new Error('Input and output must be different files.');
const maxWrapperCalls = Number(argumentsMap.get('--max-wrapper-calls') ?? 5000);
if (!Number.isSafeInteger(maxWrapperCalls) || maxWrapperCalls < 0) {
  throw new Error('--max-wrapper-calls must be a nonnegative integer');
}
const raw = await readFile(input, 'utf8');
const started = performance.now();
const ast = parse(raw, { sourceType: 'unambiguous', allowReturnOutsideFunction: false });
const stats = {
  input,
  output,
  inputBytes: Buffer.byteLength(raw),
  stableBindingsInlined: 0,
  stableBindingReferencesReplaced: 0,
  reviewedBindingsInlined: 0,
  reviewedBindingReferencesReplaced: 0,
  normalizedMembers: 0,
  foldedLiteralExpressions: 0,
  transparentCallsInlined: 0,
  initializerCandidates: [],
  warnings: []
};

// A primitive only. Avoid serializing functions, RegExp, objects, Infinity and NaN.
function literal(value) {
  if (value === null) return t.nullLiteral();
  if (typeof value === 'string') return t.stringLiteral(value);
  if (typeof value === 'boolean') return t.booleanLiteral(value);
  // Babel NumericLiteral cannot directly hold a negative number.
  if (typeof value === 'number' && Number.isFinite(value)) return t.valueToNode(value);
  return null;
}

function evaluatedPrimitive(expressionPath) {
  if (!expressionPath?.node) return null;
  // Path.evaluate performs Babel's static analysis; it does NOT execute JS in a VM.
  if (!expressionPath.isPure()) return null;
  const evaluation = expressionPath.evaluate();
  return evaluation.confident ? literal(evaluation.value) : null;
}

function currentFunctionName(nodePath) {
  const fn = nodePath.getFunctionParent();
  if (!fn) return '<top-level>';
  if (fn.node.id?.name) return fn.node.id.name;
  const p = fn.parentPath;
  if (p?.isVariableDeclarator() && t.isIdentifier(p.node.id)) return p.node.id.name;
  return '<anonymous>';
}

// Extract bindings with exactly one literal assignment, but don't apply them
// automatically: an initialization function may not have run at read time.
const initCandidates = [];
traverse(ast, {
  VariableDeclarator(p) {
    if (!t.isIdentifier(p.node.id) || p.node.init != null) return;
    const name = p.node.id.name;
    const binding = p.scope.getBinding(name);
    if (!binding || binding.path !== p || binding.constantViolations.length !== 1) return;
    const writePath = binding.constantViolations[0];
    if (!writePath.isAssignmentExpression({ operator: '=' })) return;
    const left = writePath.get('left');
    if (!left.isIdentifier({ name }) || left.scope.getBinding(name) !== binding) return;
    const rhs = evaluatedPrimitive(writePath.get('right'));
    if (!rhs) return;
    initCandidates.push({ binding, name, rhs, rhsValue: writePath.get('right').evaluate().value, writePath, declaration: p });
  }
});

for (const candidate of initCandidates) {
  stats.initializerCandidates.push({
    name: candidate.name,
    value: candidate.rhsValue,
    declarationLine: candidate.declaration.node.loc?.start.line,
    assignmentLine: candidate.writePath.node.loc?.start.line,
    writerFunction: currentFunctionName(candidate.writePath),
    referenceCount: candidate.binding.referencePaths.length,
    applied: false
  });
}

let approvedNames = new Set();
const approvalFile = argumentsMap.get('--allow-init-file');
if (approvalFile) {
  const data = JSON.parse(await readFile(path.resolve(approvalFile), 'utf8'));
  if (!Array.isArray(data.allow) || !data.allow.every(v => typeof v === 'string')) {
    throw new Error('Approval JSON must have {"allow": ["name", ...]}');
  }
  approvedNames = new Set(data.allow);
}
const trustAllSingleWrites = !!argumentsMap.get('--trust-single-write');
if (trustAllSingleWrites) {
  stats.warnings.push('Experimental: applied every syntactically single-write initializer; initialization order was NOT proven.');
}

// Apply only specifically approved single-write assignments (or experimental all).
for (let i = 0; i < initCandidates.length; i++) {
  const c = initCandidates[i];
  if (!(trustAllSingleWrites || approvedNames.has(c.name))) continue;
  let replacements = 0;
  for (const ref of [...c.binding.referencePaths]) {
    if (!ref.node || ref.removed) continue;
    if (ref.parentPath.isObjectProperty() && ref.parentPath.node.shorthand && ref.key === 'value') {
      ref.parentPath.node.shorthand = false;
    }
    ref.replaceWith(t.cloneNode(c.rhs));
    replacements++;
  }
  if (replacements) {
    stats.reviewedBindingsInlined++;
    stats.reviewedBindingReferencesReplaced += replacements;
    stats.initializerCandidates[i].applied = true;
  }
}

// Bindings with a literal initializer AND no writes after initialization.
// Only replace references located textually after the declaration. Do not
// remove the declaration (preserves initialization side effects / timing).
traverse(ast, {
  VariableDeclarator(p) {
    if (!t.isIdentifier(p.node.id) || !p.node.init) return;
    const binding = p.scope.getBinding(p.node.id.name);
    if (!binding || !binding.constant || binding.path !== p) return;
    const initializer = evaluatedPrimitive(p.get('init'));
    if (!initializer) return;
    let count = 0;
    for (const ref of [...binding.referencePaths]) {
      if (!ref.node || ref.removed) continue;
      // Skip early reads, including inside closures. An earlier function
      // declaration could be called before the initializer runs.
      if ((ref.node.start ?? 0) <= (p.node.start ?? 0)) continue;
      if (ref.parentPath.isObjectProperty() && ref.parentPath.node.shorthand && ref.key === 'value') {
        ref.parentPath.node.shorthand = false;
      }
      ref.replaceWith(t.cloneNode(initializer));
      count++;
    }
    if (count) {
      stats.stableBindingsInlined++;
      stats.stableBindingReferencesReplaced += count;
    }
  }
});

function normalizeMembers() {
  traverse(ast, {
    MemberExpression(p) {
      if (!p.node.computed || !t.isStringLiteral(p.node.property)) return;
      const prop = p.node.property.value;
      if (!t.isValidIdentifier(prop)) return;
      p.node.property = t.identifier(prop);
      p.node.computed = false;
      stats.normalizedMembers++;
    },
    OptionalMemberExpression(p) {
      if (!p.node.computed || !t.isStringLiteral(p.node.property)) return;
      const prop = p.node.property.value;
      if (!t.isValidIdentifier(prop)) return;
      p.node.property = t.identifier(prop);
      p.node.computed = false;
      stats.normalizedMembers++;
    }
  });
}

function foldLiteralExpressions() {
  traverse(ast, {
    BinaryExpression: {
      exit(p) {
        // Restrict to already-literal operands (avoids folding getters/calls).
        const left = p.node.left;
        const right = p.node.right;
        if (!(t.isStringLiteral(left) || t.isNumericLiteral(left) || t.isBooleanLiteral(left))) return;
        if (!(t.isStringLiteral(right) || t.isNumericLiteral(right) || t.isBooleanLiteral(right))) return;
        const result = evaluatedPrimitive(p);
        if (!result) return;
        p.replaceWith(result);
        stats.foldedLiteralExpressions++;
      }
    }
  });
}

function inlineTransparentWrappers() {
  let remaining = maxWrapperCalls;
  // One pass only; repeated whole-file traversals on 1.3 MB can get expensive.
  traverse(ast, {
    FunctionDeclaration(functionPath) {
      if (remaining <= 0) return;
      const fn = functionPath.node;
      if (!fn.id || fn.async || fn.generator || fn.body.body.length !== 1) return;
      const statement = fn.body.body[0];
      if (!t.isReturnStatement(statement) || !statement.argument) return;
      if (!fn.params.every(p => t.isIdentifier(p))) return;
      const parameters = fn.params.map(p => p.name);
      if (new Set(parameters).size !== parameters.length) return;
      const binding = functionPath.scope.getBinding(fn.id.name);
      if (!binding || !binding.constant) return;
      const returnPath = functionPath.get('body.body.0.argument');
      const counts = new Map(parameters.map(name => [name, 0]));
      const freeReferences = [];
      let forbidden = false;
      const inspectIdentifier = (p) => {
        const name = p.node.name;
        if (name === 'arguments' || name === fn.id.name) { forbidden = true; return; }
        if (counts.has(name)) counts.set(name, counts.get(name) + 1);
        else freeReferences.push({ name, binding: p.scope.getBinding(name) });
      };
      if (returnPath.isReferencedIdentifier()) inspectIdentifier(returnPath);
      returnPath.traverse({
        Function(p) { forbidden = true; p.skip(); },
        ThisExpression() { forbidden = true; },
        Super() { forbidden = true; },
        MetaProperty() { forbidden = true; },
        AssignmentExpression() { forbidden = true; },
        UpdateExpression() { forbidden = true; },
        AwaitExpression() { forbidden = true; },
        YieldExpression() { forbidden = true; },
        ReferencedIdentifier: inspectIdentifier
      });
      if (forbidden || [...counts.values()].some(count => count !== 1)) return;

      for (const referencePath of [...binding.referencePaths]) {
        if (remaining <= 0) break;
        if (!referencePath.node || referencePath.removed) continue;
        if (!referencePath.parentPath?.isCallExpression() || referencePath.key !== 'callee') continue;
        const callPath = referencePath.parentPath;
        if (callPath.node.arguments.length !== parameters.length) continue;
        if (callPath.findParent(p => p === functionPath)) continue;
        // Only literal or lexically bound identifier arguments. Avoid getters,
        // calls, spreads, and member accesses whose evaluation may be observable.
        if (!callPath.node.arguments.every(arg =>
          t.isStringLiteral(arg) || t.isNumericLiteral(arg) ||
          t.isBooleanLiteral(arg) || t.isNullLiteral(arg) ||
          (t.isIdentifier(arg) && !!callPath.scope.getBinding(arg.name))
        )) continue;
        if (freeReferences.some(ref => callPath.scope.getBinding(ref.name) !== ref.binding)) continue;
        const args = new Map(parameters.map((name, i) => [name, t.cloneNode(callPath.node.arguments[i], true)]));
        const replacement = t.cloneNode(statement.argument, true);
        callPath.replaceWith(replacement);
        if (callPath.isReferencedIdentifier() && args.has(callPath.node.name)) {
          callPath.replaceWith(t.cloneNode(args.get(callPath.node.name), true));
        } else {
          callPath.traverse({
            Function(p) { p.skip(); },
            ReferencedIdentifier(p) {
              const value = args.get(p.node.name);
              if (!value) return;
              if (p.parentPath.isObjectProperty() && p.parentPath.node.shorthand && p.key === 'value') {
                p.parentPath.node.shorthand = false;
              }
              p.replaceWith(t.cloneNode(value, true));
              // The replacement can itself be an identifier with the same
              // spelling as the parameter; don't recursively substitute it.
              p.skip();
            }
          });
        }
        stats.transparentCallsInlined++;
        remaining--;
      }
    }
  });
}

normalizeMembers();
foldLiteralExpressions();
inlineTransparentWrappers();
normalizeMembers();
foldLiteralExpressions();

const generated = generate(ast, { comments: true, compact: false, jsescOption: { minimal: true } }, raw).code + '\n';
stats.outputBytes = Buffer.byteLength(generated);
stats.seconds = Number(((performance.now() - started) / 1000).toFixed(3));
await mkdir(path.dirname(output), { recursive: true });
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(output, generated, 'utf8');
await writeFile(reportPath, JSON.stringify(stats, null, 2) + '\n', 'utf8');
console.log('[babel-readable]', JSON.stringify({
  inputBytes: stats.inputBytes,
  outputBytes: stats.outputBytes,
  stableReferences: stats.stableBindingReferencesReplaced,
  reviewedReferences: stats.reviewedBindingReferencesReplaced,
  normalizedMembers: stats.normalizedMembers,
  foldedExpressions: stats.foldedLiteralExpressions,
  wrappers: stats.transparentCallsInlined,
  candidates: stats.initializerCandidates.length,
  seconds: stats.seconds,
  output,
  reportPath
}, null, 2));
