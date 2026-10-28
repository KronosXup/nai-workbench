import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "client");
const packageRequire = createRequire(path.join(clientRoot, "package.json"));
const ts = packageRequire("typescript");
const cache = new Map();

function actualModule(name) {
  if (cache.has(name)) return cache.get(name);
  const exports = {};
  cache.set(name, exports);
  const source = fs.readFileSync(path.join(clientRoot, "src", `${name}.ts`), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function("exports", "require", compiled)(exports, id =>
    id.startsWith("./") ? actualModule(id.slice(2)) : packageRequire(id));
  return exports;
}

const { directorSourceIssue, readDirectorDraft, directorTask } = actualModule("director");
const source = { data: "eA==", width: 1024, height: 1024, name: "fixture.png" };

assert.equal(directorSourceIssue(source), undefined, "ordinary director image is accepted");
assert.equal(directorSourceIssue({ ...source, width: 2048, height: 1536 }), undefined,
  "the exact 3,145,728-pixel limit is accepted");
assert.match(directorSourceIssue({ ...source, width: 9000, height: 100 }), /长边不超过 8192/,
  "long-edge limit is enforced even when total pixels fit");
assert.match(directorSourceIssue({ ...source, width: 32, height: 2048 }), /短边至少 64/,
  "short-edge limit is enforced even when total pixels fit");
assert.match(directorSourceIssue({ ...source, width: 2049, height: 1536 }), /总像素不超过 3145728/,
  "pixel-area limit is enforced independently");
assert.equal(directorSourceIssue({ ...source, width: 8192, height: 384 }), undefined,
  "the exact long-edge and pixel-area limits are accepted");
assert.match(directorSourceIssue({ ...source, width: 0, height: 64 }), /图片尺寸无效/,
  "non-positive dimensions are rejected");

console.log("Director source dimension checks passed.");

const legacyDirector = {tool: 'declutter-keep-bubbles', source, prompt: 'retained note'};
const migratedDirector = readDirectorDraft(legacyDirector);
assert.equal(migratedDirector.tool, 'declutter');
assert.deepEqual(migratedDirector.source, source);
assert.equal(migratedDirector.prompt, 'retained note');
assert.equal(directorTask(migratedDirector).parameters.req_type, 'declutter');
assert.equal(legacyDirector.tool, 'declutter-keep-bubbles', 'migration does not mutate old history');
console.log('Legacy director tool restores as standard Declutter without losing source or prompt.');

const workspaceText = fs.readFileSync(path.join(clientRoot, 'src', 'DirectorWorkspace.tsx'), 'utf8');
const workspace = ts.createSourceFile('DirectorWorkspace.tsx', workspaceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let quoteEffect, submitFunction;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(workspace) === 'useEffect'
      && node.arguments[0]?.getText(workspace).includes('p.api.request<Quote>')) quoteEffect = node;
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'submit') submitFunction = node;
  ts.forEachChild(node, visit);
}
visit(workspace);
assert.ok(quoteEffect && submitFunction);
const dependencies = new Function('p', 'state', 'issue', 'quoteRefresh',
  `return ${quoteEffect.arguments[1].getText(workspace)}`);
const state = readDirectorDraft({ source, tool: 'emotion', prompt: 'first', emotion: 'neutral', defry: 0 });
const latest = { ...state, prompt: 'latest instructions', emotion: 'happy', defry: 5 };
const requests = [], displayed = [], errors = [];
const p = { api: { request: (path, task, method, signal) => new Promise(resolve => {
  requests.push({ path, task, signal, resolve });
}) } };
const initialDependencies = dependencies(p, state, undefined, 0);
assert.deepEqual(dependencies(p, latest, undefined, 0), initialDependencies,
  'prompt, emotion and defry changes preserve the current quote');
for (const changed of [{ ...state, tool: 'bg-removal' },
  { ...state, source: { ...source, data: 'eQ==' } },
  { ...state, source: { ...source, width: 832, height: 1216 } }]) {
  assert.notDeepEqual(dependencies(p, changed, undefined, 0), initialDependencies,
    'source or tool changes require a new quote');
}
assert.notDeepEqual(dependencies({ api: {} }, state, undefined, 0), initialDependencies);
assert.notDeepEqual(dependencies(p, state, 'Unavailable operation', 0), initialDependencies);
assert.notDeepEqual(dependencies(p, state, undefined, 1), initialDependencies);
let fireTimer;
const quoteVersion = { current: 0 };
const effectCode = ts.transpileModule(`const effect = ${quoteEffect.arguments[0].getText(workspace)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const bindEffect = new Function('p', 'state', 'issue', 'quoteVersion', 'setQuote', 'setQuoteError',
  'directorTask', 'quoteFailure', 'window', effectCode + '\nreturn effect;');
const cleanup = bindEffect(p, latest, undefined, quoteVersion, value => displayed.push(value),
  error => errors.push(error), directorTask, error => error,
  { setTimeout: callback => { fireTimer = callback; return 1; }, clearTimeout: () => {} })();
fireTimer();
assert.equal(requests.length, 1);
assert.equal(requests[0].task.prompt, '');
assert.equal(requests[0].task.parameters.emotion, 'neutral');
assert.equal(requests[0].task.parameters.defry, 0);
cleanup();
assert.equal(requests[0].signal.aborted, true, 'a superseded Director quote is aborted');
const quote = { source: 'gate', cost_limit: { anlas: 20, v5: 0 }, encoding_cost_limit: { anlas: 2, v5: 0 } };
requests[0].resolve(quote);
await Promise.resolve(); await Promise.resolve();
assert.deepEqual(displayed, [null], 'a late aborted response cannot restore a stale quote');
assert.deepEqual(errors, [null]);
let submitted;
const submitCode = ts.transpileModule(submitFunction.getText(workspace), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const submit = new Function('p', 'state', 'quote', 'currentIssue', 'quoteError', 'matchingPending',
  'directorTask', 'withQuote', submitCode + '\nreturn submit;')(
  { onSubmit: task => { submitted = task; } }, latest, quote, () => undefined, null, false,
  directorTask, actualModule('quote').withQuote);
submit();
assert.equal(submitted.prompt, latest.prompt);
assert.equal(submitted.parameters.emotion, latest.emotion);
assert.equal(submitted.parameters.defry, latest.defry);
assert.deepEqual(submitted.cost_limit, quote.cost_limit);
console.log('Director quote dependencies, cancellation and current submission parameters passed.');
