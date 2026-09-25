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

test('the validation workflow runs the star-access regression suite', async () => {
  const workflow = await readFile(new URL('../.github/workflows/validate.yml', import.meta.url), 'utf8');
  assert.equal(workflow.split('\n').filter(line => line === '          node --test growth/check-star-access.test.mjs').length, 1);
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
      const response = responses.shift();
      return typeof response === 'function' ? response() : response;
    },
  });
  await new vm.Script(source, { filename: 'check-star-access.mjs' }).runInContext(context);
  return { calls, stdout, stderr, exitCode: process.exitCode };
}

function failed(result, expected = {}) {
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.stdout, []);
  assert.equal(result.stderr.length, 2);
  assert.equal(result.stderr[0], 'Repository star access check failed; timestamped counts remain unverified.');
  const diagnostic = JSON.parse(result.stderr[1]);
  assert.deepEqual(diagnostic, {
    event: 'repository_star_access_failed', status: null,
    category: 'validation_failed', acceptedPermissions: null, ...expected,
  });
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

test('403 exposes its status and allowlisted permission alternatives without reading its body', async () => {
  let cancelled = false;
  const headerReads = [];
  const response = { ok: false, status: 403,
    headers: { get: name => { headerReads.push(name); return 'metadata=read; contents=write'; } },
    body: { cancel: async () => { cancelled = true; }, getReader: () => { throw new Error(privateValue); } },
  };
  failed(await run([response]), { status: 403, category: 'forbidden', acceptedPermissions: 'metadata=read; contents=write' });
  assert.equal(cancelled, true);
  assert.deepEqual(headerReads, ['x-accepted-github-permissions']);
});

test('malformed JSON cannot leak a private response excerpt', async () => {
  failed(await run([new Response(`{"secret":"${privateValue}",`)]), { category: 'invalid_json' });
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
  failed(result, { category: 'missing_token' });
  assert.equal(result.calls.length, 0);
});

test('permission diagnostics preserve AND versus OR without admitting arbitrary header text', async () => {
  const response = permissions => ({ ok: false, status: 403, headers: { get: () => permissions }, body: null });
  failed(await run([response(' metadata=read,contents=write ; contents=read ')]), {
    status: 403, category: 'forbidden', acceptedPermissions: 'metadata=read, contents=write; contents=read',
  });
  for (const value of [privateValue, `metadata=read; ${privateValue}`, 'metadata=read,unknown=write', 'metadata=read;', 'metadata=read\ncontents=write', 'metadata=read,metadata=read', ' '.repeat(257) + 'metadata=read']) {
    failed(await run([response(value)]), { status: 403, category: 'forbidden' });
  }
});

for (const [status, category] of [[401, 'authentication_failed'], [429, 'rate_limited'], [503, 'upstream_error'], [404, 'http_error']]) {
  test(`HTTP ${status} gets a safe category without inventing a permission cause`, async () => {
    failed(await run([new Response(privateValue, { status })]), { status, category });
  });
}

test('network and timeout errors cannot publish messages or attacker-provided diagnostic fields', async () => {
  failed(await run([() => { throw new Error(privateValue); }]), { category: 'probe_failed' });
  failed(await run([() => { throw { message: privateValue, status: 200, category: privateValue, acceptedPermissions: privateValue }; }]), { category: 'probe_failed' });
  const timeout = new Error(privateValue);
  timeout.name = 'TimeoutError';
  failed(await run([() => { throw timeout; }]), { category: 'timeout_or_abort' });
  const hostile = Object.defineProperty({}, 'name', { get() { throw new Error(privateValue); } });
  failed(await run([() => { throw hostile; }]), { category: 'probe_failed' });
});

test('hostile header access and cancellation cannot hide a safe HTTP status or leak a message', async () => {
  failed(await run([{
    ok: false, status: 403,
    headers: { get() { throw new Error(privateValue); } },
    body: { cancel() { throw new Error(privateValue); } },
  }]), { status: 403, category: 'forbidden' });
  for (const status of [privateValue, NaN, 99, 600, 403.5]) {
    failed(await run([{ ok: false, status, headers: { get: () => null }, body: null }]), { category: 'http_error' });
  }
});

test('oversized response validation never prints its body', async () => {
  failed(await run([new Response(privateValue.repeat(20000))]));
});
