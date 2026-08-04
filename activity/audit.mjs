/**
 * Scope-aware check for undefined identifiers, using a real JS parser.
 *
 * Catches exactly the class of bug that broke the Activity twice now: an edit
 * removes a function while leaving its callers in place. A regex cannot do this
 * without drowning in false positives from class methods, template literals and
 * comments.
 */
import { readFileSync } from 'node:fs';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const GLOBALS = new Set([
  'console','JSON','Math','Date','Promise','Set','Map','Object','Array','Number','String',
  'Boolean','Error','RegExp','Symbol','parseInt','parseFloat','isNaN','isFinite',
  'setTimeout','setInterval','clearTimeout','clearInterval','fetch','URL','URLSearchParams',
  'window','document','performance','requestAnimationFrame','cancelAnimationFrame',
  'Float32Array','Uint8Array','Int16Array','ArrayBuffer','Buffer','process','undefined',
  'NaN','Infinity','globalThis','structuredClone','TextEncoder','TextDecoder','WebSocket',
  'HTMLElement','Image','Audio','navigator','location','history','localStorage','alert',
  'BigInt','Intl','WeakMap','WeakSet','Proxy','Reflect','queueMicrotask','AbortController',
  'encodeURIComponent','decodeURIComponent','encodeURI','decodeURI','FileReader','Blob',
  'ResizeObserver','IntersectionObserver','MutationObserver','CustomEvent','Event',
  'OffscreenCanvas','ImageData','Path2D',
]);

let problems = 0;

for (const file of process.argv.slice(2)) {
  const source = readFileSync(file, 'utf8');
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });

  const declared = new Set(GLOBALS);
  const used = new Map();

  // Collect every binding introduced anywhere in the module.
  walk.full(ast, (node) => {
    if (node.type === 'FunctionDeclaration' && node.id) declared.add(node.id.name);
    if (node.type === 'ClassDeclaration' && node.id) declared.add(node.id.name);
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') {
      declared.add(node.id.name);
    }
    if (node.type === 'ImportSpecifier') declared.add(node.local.name);
    if (node.type === 'ImportDefaultSpecifier') declared.add(node.local.name);
    if (node.type === 'ImportNamespaceSpecifier') declared.add(node.local.name);
    // Parameters and destructuring targets.
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression'
        || node.type === 'ArrowFunctionExpression' || node.type === 'MethodDefinition') {
      const fn = node.type === 'MethodDefinition' ? node.value : node;
      for (const param of fn.params ?? []) {
        walk.full(param, (p) => { if (p.type === 'Identifier') declared.add(p.name); });
      }
    }
    if (node.type === 'ObjectPattern' || node.type === 'ArrayPattern') {
      walk.full(node, (p) => { if (p.type === 'Identifier') declared.add(p.name); });
    }
    if (node.type === 'CatchClause' && node.param) {
      walk.full(node.param, (p) => { if (p.type === 'Identifier') declared.add(p.name); });
    }
  });

  // Record identifiers actually referenced as values, ignoring property access,
  // property keys and labels.
  walk.ancestor(ast, {
    Identifier(node, _state, ancestors) {
      const parent = ancestors[ancestors.length - 2];
      if (!parent) return;
      if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
      if (parent.type === 'Property' && parent.key === node && !parent.computed) return;
      if (parent.type === 'MethodDefinition' && parent.key === node) return;
      if (parent.type === 'PropertyDefinition' && parent.key === node) return;
      if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement'
          || parent.type === 'ContinueStatement') return;
      used.set(node.name, node.loc?.start?.line ?? 0);
    },
  });

  const missing = [...used.keys()].filter((name) => !declared.has(name));
  if (missing.length) {
    console.log(`${file}:`);
    for (const name of missing) console.log(`  UNDEFINED: ${name}`);
    problems += missing.length;
  }
}

console.log(problems === 0
  ? 'all identifiers resolve in every module'
  : `${problems} undefined identifier(s)`);
process.exit(problems === 0 ? 0 : 1);
