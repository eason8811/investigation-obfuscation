#!/usr/bin/env node
/**
 * Conservative, inspectable readability passes for Webcrack output.
 * Nothing from the analyzed SDK is executed by this script.
 *
 * Usage:
 * node tools/readable-babel.mjs --input deobfus/01-webcrack.js \
 *   --output deobfus/12-babel-readable.js --report deobfus/12-babel-report.json
 *
 * Optional, REVIEW FIRST:
 *   --allow-init-file tools/approved-init-constants.json
 *   --trust-single-write
 */
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {parse} from '@babel/parser';
import traverse from '@babel/traverse';
import generate from '@babel/generator';
import * as t from '@babel/types';
import vm from 'node:vm';

// Self-contained edition: the dispatcher-specializer is bundled below.
/**
 * Conservative call-site specialization for opcode dispatch functions.
 *
 * For example:
 *   function d(op, value) {
 *     if (op === 1) return value === null;
 *     if (op === 2) return value.length;
 *   }
 *   d(1, item)  ->  item === null
 *
 * Nothing from the SDK is imported or invoked here. VM mode evaluates ONLY
 * primitive opcode selectors and their branch-guard constants, never a
 * dispatcher's return expression (which may depend on lr/cr/g or the DOM).
 */

function primitive(value) {
    return value === null || typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value));
}

function readLiteral(path) {
    if (!path?.node || !path.isPure()) return {known: false};
    const result = path.evaluate();
    return result.confident && primitive(result.value)
        ? {known: true, value: result.value}
        : {known: false};
}

function makeOpcodeResolver({mode, t, generate}) {
    const literalCache = new WeakMap();
    const codeCache = new Map();
    const initializerAssumptions = new Set();
    let vmSelectorHits = 0;
    let vmGuardHits = 0;
    let vmUniqueEvaluations = 0;

    // Build a *closed* expression from the SDK's actual constant initializers.
    // No call/member/new/eval/accessor is accepted, so evaluating a dispatcher
    // opcode cannot accidentally execute the SDK or lr()/cr()/g().
    function expand(path, seen, depth) {
        if (!path?.node || depth > 20) return null;
        if (path.isNumericLiteral() || path.isStringLiteral() ||
            path.isBooleanLiteral() || path.isNullLiteral()) return t.cloneNode(path.node);
        if (path.isIdentifier()) {
            const binding = path.scope.getBinding(path.node.name);
            if (!binding || !binding.constant || !binding.path.isVariableDeclarator()) return null;
            if (seen.has(binding)) return null;
            const init = binding.path.get('init');
            if (!init?.node) return null;
            if ((path.node.start ?? Infinity) < (binding.path.node.start ?? -Infinity)) {
                initializerAssumptions.add(binding.identifier.name);
            }
            seen.add(binding);
            const value = expand(init, seen, depth + 1);
            seen.delete(binding);
            return value;
        }
        if (path.isUnaryExpression() && ['+', '-', '!', '~', 'void', 'typeof'].includes(path.node.operator)) {
            const operand = expand(path.get('argument'), seen, depth + 1);
            return operand ? t.unaryExpression(path.node.operator, operand, true) : null;
        }
        if (path.isBinaryExpression() && !['in', 'instanceof'].includes(path.node.operator)) {
            const left = expand(path.get('left'), seen, depth + 1);
            const right = expand(path.get('right'), seen, depth + 1);
            return left && right ? t.binaryExpression(path.node.operator, left, right) : null;
        }
        if (path.isLogicalExpression()) {
            const left = expand(path.get('left'), seen, depth + 1);
            const right = expand(path.get('right'), seen, depth + 1);
            return left && right ? t.logicalExpression(path.node.operator, left, right) : null;
        }
        if (path.isConditionalExpression()) {
            const test = expand(path.get('test'), seen, depth + 1);
            const consequent = expand(path.get('consequent'), seen, depth + 1);
            const alternate = expand(path.get('alternate'), seen, depth + 1);
            return test && consequent && alternate
                ? t.conditionalExpression(test, consequent, alternate) : null;
        }
        return null;
    }

    function resolve(path, category) {
        if (!path?.node || !path.isPure()) return {known: false};
        if (literalCache.has(path.node)) {
            const cached = literalCache.get(path.node);
            if (cached.viaVM) {
                if (category === 'selector') vmSelectorHits++;
                else vmGuardHits++;
            }
            return cached;
        }
        let result = readLiteral(path);
        if (!result.known && mode === 'vm') {
            const expr = expand(path, new Set(), 0);
            if (expr) {
                const code = '(' + generate(expr).code + ')';
                if (codeCache.has(code)) {
                    result = codeCache.get(code);
                } else {
                    try {
                        const value = vm.runInNewContext(code, Object.create(null), {
                            timeout: 50,
                            contextCodeGeneration: {strings: false, wasm: false}
                        });
                        result = primitive(value)
                            ? {known: true, value, viaVM: true}
                            : {known: false};
                    } catch {
                        result = {known: false};
                    }
                    codeCache.set(code, result);
                    vmUniqueEvaluations++;
                }
            }
        }
        literalCache.set(path.node, result);
        if (result.viaVM) {
            if (category === 'selector') vmSelectorHits++;
            else vmGuardHits++;
        }
        return result;
    }

    return {
        resolve,
        info: () => ({
            vmOpcodeSelectorsResolved: vmSelectorHits,
            vmOpcodeGuardsResolved: vmGuardHits,
            vmOpcodeUniqueEvaluations: vmUniqueEvaluations,
            vmInitializerAssumptions: [...initializerAssumptions].sort()
        })
    };
}

function conditionValue(path, selectorBinding, selectorValue, resolve) {
    if (path.isBooleanLiteral()) return path.node.value;
    if (path.isUnaryExpression({operator: '!'})) {
        const child = conditionValue(path.get('argument'), selectorBinding, selectorValue, resolve);
        return child === null ? null : !child;
    }
    if (path.isLogicalExpression()) {
        const left = conditionValue(path.get('left'), selectorBinding, selectorValue, resolve);
        if (left === null) return null;
        if (path.node.operator === '&&') {
            return left ? conditionValue(path.get('right'), selectorBinding, selectorValue, resolve) : false;
        }
        if (path.node.operator === '||') {
            return left ? true : conditionValue(path.get('right'), selectorBinding, selectorValue, resolve);
        }
        return null;
    }
    if (!path.isBinaryExpression() ||
        !['===', '!=='].includes(path.node.operator)) return null;
    const left = path.get('left');
    const right = path.get('right');
    const selectorLeft = left.isIdentifier() &&
        left.scope.getBinding(left.node.name) === selectorBinding;
    const selectorRight = right.isIdentifier() &&
        right.scope.getBinding(right.node.name) === selectorBinding;
    if (selectorLeft === selectorRight) return null;
    const other = resolve(selectorLeft ? right : left, 'guard');
    if (!other.known) return null;
    const equal = selectorValue === other.value;
    return path.node.operator === '===' ? equal : !equal;
}

const UNKNOWN = Symbol('unknown');
const FALLTHROUGH = Symbol('fallthrough');

function branchResult(path, selectorBinding, selectorValue, resolve) {
    if (path.isReturnStatement()) return path;
    if (path.isBlockStatement()) {
        return statementSequence(path.get('body'), selectorBinding, selectorValue, resolve);
    }
    if (path.isIfStatement()) {
        const result = conditionValue(path.get('test'), selectorBinding, selectorValue, resolve);
        if (result === null) return UNKNOWN;
        const next = result ? path.get('consequent') : path.get('alternate');
        return next?.node
            ? branchResult(next, selectorBinding, selectorValue, resolve)
            : FALLTHROUGH;
    }
    if (path.isSwitchStatement()) {
        const disc = path.get('discriminant');
        if (!disc.isIdentifier() ||
            disc.scope.getBinding(disc.node.name) !== selectorBinding) return UNKNOWN;
        const cases = path.get('cases');
        let selected = -1;
        let defaultCase = -1;
        for (let i = 0; i < cases.length; i++) {
            const test = cases[i].get('test');
            if (!test?.node) {
                defaultCase = i;
                continue;
            }
            // Reject dynamic case expressions: their evaluation could be observable.
            const value = resolve(test, 'guard');
            if (!value.known) return UNKNOWN;
            if (selected === -1 && value.value === selectorValue) selected = i;
        }
        if (selected === -1) selected = defaultCase;
        if (selected === -1) return FALLTHROUGH;
        for (let i = selected; i < cases.length; i++) {
            const result = statementSequence(cases[i].get('consequent'), selectorBinding, selectorValue, resolve);
            if (result !== FALLTHROUGH) return result;
        }
        return FALLTHROUGH;
    }
    if (path.isEmptyStatement()) return FALLTHROUGH;
    // Uninitialized declarations and function declarations are inert here.
    if (path.isFunctionDeclaration()) return FALLTHROUGH;
    if (path.isVariableDeclaration() &&
        path.node.declarations.every(d => d.init === null)) return FALLTHROUGH;
    return UNKNOWN;
}

function statementSequence(paths, selectorBinding, selectorValue, resolve) {
    for (const path of paths) {
        const result = branchResult(path, selectorBinding, selectorValue, resolve);
        if (result !== FALLTHROUGH) return result;
    }
    return FALLTHROUGH;
}

function simpleArgument(path) {
    if (!path?.node || path.isSpreadElement()) return false;
    if (path.isStringLiteral() || path.isNumericLiteral() ||
        path.isBooleanLiteral() || path.isNullLiteral()) return true;
    if (path.isIdentifier() && path.node.name !== 'arguments') {
        return !!path.scope.getBinding(path.node.name);
    }
    return false;
}

function specializeDispatchCalls(ast, {
    traverse, generate, t, mode = 'static', style = 'auto', maxCalls = 5000
}) {
    const opcodeResolver = makeOpcodeResolver({mode, t, generate});
    let remaining = maxCalls;
    let callsSpecialized = 0;
    let directCalls = 0;
    let helperCalls = 0;
    const matches = new Set();
    const helperRequests = new Map();

    traverse(ast, {
        CallExpression(callPath) {
            if (remaining <= 0) {
                callPath.skip();
                return;
            }
            const callee = callPath.get('callee');
            if (!callee.isIdentifier()) return;
            const fnBinding = callee.scope.getBinding(callee.node.name);
            if (!fnBinding || !fnBinding.constant || !fnBinding.path.isFunctionDeclaration()) return;
            const fnPath = fnBinding.path;
            if (callPath.findParent(parent => parent === fnPath)) return;
            const fn = fnPath.node;
            if (fn.async || fn.generator || fn.params.length < 2 ||
                !fn.params.every(p => t.isIdentifier(p)) ||
                fn.body.directives?.length) return;
            const body = fnPath.get('body.body');
            if (!body.length || !body.some(p => p.isIfStatement() || p.isSwitchStatement())) return;

            const selectorName = fn.params[0].name;
            const selectorBinding = fnPath.scope.getBinding(selectorName);
            if (!selectorBinding?.constant) return;

            const args = callPath.get('arguments');
            if (args.length < 1) return;
            const selector = opcodeResolver.resolve(args[0], 'selector');
            if (!selector.known) return;

            const selected = statementSequence(body, selectorBinding, selector.value, opcodeResolver.resolve);
            if (selected === UNKNOWN || selected === FALLTHROUGH) return;
            const returnPath = selected.get('argument');
            const returnNode = returnPath?.node ?? t.unaryExpression('void', t.numericLiteral(0));
            const parameterBindings = new Map(fn.params.map(p =>
                [p.name, fnPath.scope.getBinding(p.name)]));
            const counts = new Map(fn.params.map(p => [p.name, 0]));
            const free = [];
            let forbidden = false;

            const inspect = p => {
                const binding = p.scope.getBinding(p.node.name);
                if (p.node.name === 'arguments' || p.node.name === fn.id.name) {
                    forbidden = true;
                    return;
                }
                if (parameterBindings.has(p.node.name)) {
                    if (parameterBindings.get(p.node.name) !== binding) {
                        forbidden = true;
                        return;
                    }
                    counts.set(p.node.name, counts.get(p.node.name) + 1);
                } else {
                    free.push({name: p.node.name, binding});
                }
            };
            if (returnPath?.isReferencedIdentifier()) inspect(returnPath);
            returnPath?.traverse({
                Function(p) {
                    forbidden = true;
                    p.skip();
                },
                ThisExpression() {
                    forbidden = true;
                },
                Super() {
                    forbidden = true;
                },
                MetaProperty() {
                    forbidden = true;
                },
                AwaitExpression() {
                    forbidden = true;
                },
                YieldExpression() {
                    forbidden = true;
                },
                CallExpression(p) {
                    if (p.get('callee').isIdentifier({name: 'eval'})) forbidden = true;
                },
                ReferencedIdentifier: inspect
            });
            if (forbidden) return;

            const canInline = style !== 'helper' &&
                args.every(simpleArgument) &&
                [...counts.values()].every(n => n <= 1) &&
                free.every(ref => callPath.scope.getBinding(ref.name) === ref.binding);

            if (!canInline) {
                if (style === 'inline') return;
                // The specialized sibling helper keeps ALL arguments, in their
                // original order, so getters/calls/unused argument side effects
                // are still evaluated exactly once.
                if (free.some(ref => ref.binding?.scope === fnPath.scope)) return;
                let helpers = helperRequests.get(fnPath);
                if (!helpers) {
                    helpers = new Map();
                    helperRequests.set(fnPath, helpers);
                }
                const caseKey = JSON.stringify([typeof selector.value, selector.value]);
                let entry = helpers.get(caseKey);
                if (!entry) {
                    const label = String(selector.value).replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 18);
                    const id = fnPath.scope.generateUidIdentifier(`${fn.id.name}_case_${label}_branch`);
                    entry = {
                        id,
                        node: t.functionDeclaration(
                            t.cloneNode(id),
                            fn.params.map(p => t.cloneNode(p)),
                            t.blockStatement([t.returnStatement(t.cloneNode(returnNode, true))])
                        )
                    };
                    helpers.set(caseKey, entry);
                }
                callee.replaceWith(t.cloneNode(entry.id));
                callPath.skip();
                helperCalls++;
                callsSpecialized++;
                remaining--;
                matches.add(fn.id.name);
                return;
            }

            const replacements = new Map(fn.params.map((p, i) => [
                p.name,
                args[i]?.node ? t.cloneNode(args[i].node, true) :
                    t.unaryExpression('void', t.numericLiteral(0))
            ]));

            // Only clone into a temporary tree; never mutate the original function.
            const replacementFile = t.file(t.program([
                t.expressionStatement(t.cloneNode(returnNode, true))
            ]));
            const expression = replacementFile.program.body[0].expression;
            if (t.isIdentifier(expression) && replacements.has(expression.name)) {
                replacementFile.program.body[0].expression =
                    t.cloneNode(replacements.get(expression.name), true);
            } else {
                traverse(replacementFile, {
                    ReferencedIdentifier(p) {
                        const value = replacements.get(p.node.name);
                        if (!value) return;
                        if (p.parentPath.isObjectProperty() &&
                            p.parentPath.node.shorthand && p.key === 'value') {
                            p.parentPath.node.shorthand = false;
                        }
                        p.replaceWith(t.cloneNode(value, true));
                        p.skip();
                    }
                });
            }
            callPath.replaceWith(replacementFile.program.body[0].expression);
            callPath.skip();
            directCalls++;
            callsSpecialized++;
            remaining--;
            matches.add(fn.id.name);
        }
    });
    for (const [fnPath, helpers] of helperRequests) {
        fnPath.insertAfter([...helpers.values()].map(entry => entry.node));
    }
    // New helper declarations must become visible to the next Babel passes.
    if (helperRequests.size > 0) {
        traverse(ast, {
            Program(p) {
                p.scope.crawl();
                p.stop();
            }
        });
    }
    return {
        callsSpecialized,
        functionsMatched: [...matches].sort(),
        ...opcodeResolver.info(),
        directCalls,
        helperCalls,
        helpersCreated: [...helperRequests.values()]
            .reduce((sum, entries) => sum + entries.size, 0)
    };
}

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
const dispatchMode = argumentsMap.get('--dispatch-mode') ?? 'off';
if (!['off', 'static', 'vm'].includes(dispatchMode)) {
    throw new Error('--dispatch-mode must be off, static, or vm');
}
const dispatchStyle = argumentsMap.get('--dispatch-style') ?? 'auto';
if (!['auto', 'inline', 'helper'].includes(dispatchStyle)) {
    throw new Error('--dispatch-style must be auto, inline, or helper');
}
const maxDispatchCalls = Number(argumentsMap.get('--max-dispatch-calls') ?? 5000);
if (!Number.isSafeInteger(maxDispatchCalls) || maxDispatchCalls < 0) {
    throw new Error('--max-dispatch-calls must be a nonnegative integer');
}
const maxWrapperCalls = Number(argumentsMap.get('--max-wrapper-calls') ?? 5000);
if (!Number.isSafeInteger(maxWrapperCalls) || maxWrapperCalls < 0) {
    throw new Error('--max-wrapper-calls must be a nonnegative integer');
}
const raw = await readFile(input, 'utf8');
const started = performance.now();
const ast = parse(raw, {sourceType: 'unambiguous', allowReturnOutsideFunction: false});
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
    dispatchMode,
    dispatchStyle,
    dispatchCallsSpecialized: 0,
    dispatchDirectCalls: 0,
    dispatchHelperCalls: 0,
    dispatchHelpersCreated: 0,
    dispatchFunctionsMatched: [],
    vmOpcodeSelectorsResolved: 0,
    vmOpcodeGuardsResolved: 0,
    vmOpcodeUniqueEvaluations: 0,
    vmInitializerAssumptions: [],
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
        if (!writePath.isAssignmentExpression({operator: '='})) return;
        const left = writePath.get('left');
        if (!left.isIdentifier({name}) || left.scope.getBinding(name) !== binding) return;
        const rhs = evaluatedPrimitive(writePath.get('right'));
        if (!rhs) return;
        initCandidates.push({
            binding,
            name,
            rhs,
            rhsValue: writePath.get('right').evaluate().value,
            writePath,
            declaration: p
        });
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
                if (name === 'arguments' || name === fn.id.name) {
                    forbidden = true;
                    return;
                }
                if (counts.has(name)) counts.set(name, counts.get(name) + 1);
                else freeReferences.push({name, binding: p.scope.getBinding(name)});
            };
            if (returnPath.isReferencedIdentifier()) inspectIdentifier(returnPath);
            returnPath.traverse({
                Function(p) {
                    forbidden = true;
                    p.skip();
                },
                ThisExpression() {
                    forbidden = true;
                },
                Super() {
                    forbidden = true;
                },
                MetaProperty() {
                    forbidden = true;
                },
                AssignmentExpression() {
                    forbidden = true;
                },
                UpdateExpression() {
                    forbidden = true;
                },
                AwaitExpression() {
                    forbidden = true;
                },
                YieldExpression() {
                    forbidden = true;
                },
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
                        Function(p) {
                            p.skip();
                        },
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
if (dispatchMode !== 'off') {
    const detail = specializeDispatchCalls(ast, {
        traverse, generate, t, mode: dispatchMode, style: dispatchStyle, maxCalls: maxDispatchCalls
    });
    stats.dispatchCallsSpecialized = detail.callsSpecialized;
    stats.dispatchFunctionsMatched = detail.functionsMatched;
    stats.vmOpcodeSelectorsResolved = detail.vmOpcodeSelectorsResolved;
    stats.vmOpcodeGuardsResolved = detail.vmOpcodeGuardsResolved;
    stats.vmOpcodeUniqueEvaluations = detail.vmOpcodeUniqueEvaluations;
    stats.vmInitializerAssumptions = detail.vmInitializerAssumptions;
    stats.dispatchDirectCalls = detail.directCalls;
    stats.dispatchHelperCalls = detail.helperCalls;
    stats.dispatchHelpersCreated = detail.helpersCreated;
    if (dispatchMode === 'vm') {
        stats.warnings.push('VM mode evaluates ONLY the dispatch opcode and branch guard constants, NEVER branch return expressions. It runs isolated, primitive-only copies of initializer expressions; it does NOT run Castle SDK or provide a security boundary.');
        if (detail.vmInitializerAssumptions.length > 0) {
            stats.warnings.push('Experimental: constants declared after their textual reference were assumed initialized at invocation time. Verify runtime initialization order before trusting rewritten code.');
        }
    }
}
inlineTransparentWrappers();
normalizeMembers();
foldLiteralExpressions();

const generated = generate(ast, {comments: true, compact: false, jsescOption: {minimal: true}}, raw).code + '\n';
stats.outputBytes = Buffer.byteLength(generated);
stats.seconds = Number(((performance.now() - started) / 1000).toFixed(3));
await mkdir(path.dirname(output), {recursive: true});
await mkdir(path.dirname(reportPath), {recursive: true});
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
    dispatchMode: stats.dispatchMode,
    dispatchStyle: stats.dispatchStyle,
    dispatchCallsSpecialized: stats.dispatchCallsSpecialized,
    dispatchDirectCalls: stats.dispatchDirectCalls,
    dispatchHelperCalls: stats.dispatchHelperCalls,
    dispatchHelpersCreated: stats.dispatchHelpersCreated,
    dispatchFunctionsMatched: stats.dispatchFunctionsMatched,
    vmOpcodeSelectorsResolved: stats.vmOpcodeSelectorsResolved,
    vmOpcodeGuardsResolved: stats.vmOpcodeGuardsResolved,
    vmOpcodeUniqueEvaluations: stats.vmOpcodeUniqueEvaluations,
    vmInitializerAssumptions: stats.vmInitializerAssumptions,
    candidates: stats.initializerCandidates.length,
    seconds: stats.seconds,
    output,
    reportPath
}, null, 2));

