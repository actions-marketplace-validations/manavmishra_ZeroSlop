import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const source = (await readFile(new URL('./check-star-access.mjs', import.meta.url), 'utf8'))
  .replace("import assert from 'node:assert/strict';", '');
const privateValue = 'PRIVATE_STARGAZER_OR_TOKEN_DO_NOT_LOG';
const row = (id = 1) => ({ user: { id, login: privateValue }, starred_at: '2026-09-12T01:00:00Z' });
const page = (rows, next = false) => new Response(JSON.stringify(rows), {
  headers: next ? { link: '<https://api.github.com/repos/manavmishra/ZeroSlop/stargazers?per_page=100&page=2>; rel="next"' } : {},
});

async function run(responses, token = privateValue) {
  const calls = [], stdout = [], stderr = [];
  const process = { env: token == null ? {} : { GITHUB_TOKEN: token }, exitCode: undefined };
  const context = vm.createContext({
    assert, process, AbortSignal, TextDecoder,
    console: { log: (...args) => stdout.push(args.join(' ')), error: (...args) => stderr.push(args.join(' ')) },
    fetch: async (url, options) => {
      calls.push({ url, options });
      assert.ok(responses.length, 'Unexpected extra request');
      return responses.shift();
    },
  });
  await new vm.Script(source, { filename: 'check-star-access.mjs' }).runInContext(context);
  return { calls, stdout, stderr, exitCode: process.exitCode };
}

function failed(result) {
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.stdout, []);
  assert.deepEqual(result.stderr, ['Repository star access check failed; timestamped counts remain unverified.']);
  assert.ok(![...result.stdout, ...result.stderr].join('\n').includes(privateValue));
}

test('reads successive pages with timestamps without publishing identities or counts', async () => {
  const result = await run([page([row(1)], true), page([row(2)])]);
  assert.equal(result.exitCode, undefined);
  assert.equal(result.calls.length, 2);
  assert.match(result.calls[0].url, /per_page=100&page=1$/);
  assert.match(result.calls[1].url, /per_page=100&page=2$/);
  for (const { options } of result.calls) {
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, `Bearer ${privateValue}`);
    assert.equal(options.headers.accept, 'application/vnd.github.star+json');
    assert.ok(options.signal instanceof AbortSignal);
  }
  assert.deepEqual(result.stderr, []);
  assert.equal(result.stdout.length, 1);
  assert.match(result.stdout[0], /read every available star page with valid timestamps/);
  assert.ok(!result.stdout[0].includes(privateValue));
});

test('403 cancels its body and emits only the generic failure', async () => {
  let cancelled = false;
  const response = { ok: false, status: 403, body: { cancel: async () => { cancelled = true; } } };
  failed(await run([response]));
  assert.equal(cancelled, true);
});

test('malformed JSON cannot leak a private response excerpt', async () => {
  failed(await run([new Response(`{"secret":"${privateValue}",`)]));
});

for (const [name, rows] of [
  ['non-array JSON', { secret: privateValue }],
  ['invalid timestamp', [{ ...row(), starred_at: privateValue }]],
  ['invalid user ID', [{ ...row(), user: { id: privateValue } }]],
  ['duplicate row', [row(), row()]],
  ['more than 100 rows', Array.from({ length: 101 }, (_, index) => row(index + 1))],
]) {
  test(`rejects ${name} without leaking response content`, async () => failed(await run([page(rows)])));
}

test('rejects duplicate IDs across pages', async () => {
  const result = await run([page([row()], true), page([row()])]);
  failed(result);
  assert.equal(result.calls.length, 2);
});

test('missing token fails before making a request', async () => {
  const result = await run([], null);
  failed(result);
  assert.equal(result.calls.length, 0);
});
