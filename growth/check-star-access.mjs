// Manual, read-only access probe. Never print tokens or stargazer identities.
import assert from 'node:assert/strict';

// Keep the whole permission expression or none of it: commas mean AND and
// semicolons separate alternatives. Dropping an unknown term would mislead.
function acceptedPermissions(response) {
  try {
    const raw = response.headers?.get('x-accepted-github-permissions');
    if (typeof raw !== 'string' || raw.length > 256 || /[^\x20-\x7e\t]/.test(raw)) return null;
    const groups = raw.split(';');
    if (groups.length > 4) return null;
    const normalized = [];
    for (const group of groups) {
      const terms = group.split(',').map(term => term.trim());
      if (terms.length > 3 || new Set(terms).size !== terms.length
          || terms.some(term => !['metadata=read', 'contents=read', 'contents=write'].includes(term))) return null;
      normalized.push(terms.join(', '));
    }
    return normalized.join('; ');
  } catch { return null; }
}

class ProbeFailure extends Error {
  constructor(category, status = null, permissions = null) {
    super('repository_star_access_failed');
    this.category = category;
    this.status = status;
    this.permissions = permissions;
  }
}

function failureDiagnostic(error) {
  let category = 'probe_failed', status = null, permissions = null;
  try {
    if (error instanceof ProbeFailure) {
      category = error.category;
      status = error.status;
      permissions = error.permissions;
    } else if (error?.name === 'AssertionError') category = 'validation_failed';
    else if (error?.name === 'SyntaxError') category = 'invalid_json';
    else if (['TimeoutError', 'AbortError'].includes(error?.name)) category = 'timeout_or_abort';
  } catch { /* Never serialize an untrusted error or its properties. */ }
  return { event: 'repository_star_access_failed', status, category, acceptedPermissions: permissions };
}

async function main() {
const token = process.env.GITHUB_TOKEN;
if (!token) throw new ProbeFailure('missing_token');
const signal = AbortSignal.timeout(90000);
let complete = false;
const ids = new Set();
for (let page = 1; page <= 100; page++) {
  const response = await fetch(`https://api.github.com/repos/manavmishra/ZeroSlop/stargazers?per_page=100&page=${page}`, {
    signal, redirect: 'error', headers: { authorization: `Bearer ${token}`,
      accept: 'application/vnd.github.star+json', 'x-github-api-version': '2022-11-28',
      'user-agent': 'zero-slop-repository-access-check' },
  });
  if (!response.ok) {
    const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
    const category = status === 401 ? 'authentication_failed' : status === 403 ? 'forbidden'
      : status === 429 ? 'rate_limited' : status !== null && status >= 500 ? 'upstream_error' : 'http_error';
    const failure = new ProbeFailure(category, status, acceptedPermissions(response));
    try { void response.body?.cancel().catch(() => {}); } catch { /* Cancellation must not hide the safe HTTP diagnostic. */ }
    throw failure;
  }
  assert.ok(response.body);
  const reader = response.body.getReader();
  let bytes = 0, text = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      assert.ok(bytes <= 512 * 1024, 'Star page exceeds its size bound');
      text += decoder.decode(value, { stream: true });
    }
  } finally { void reader.cancel().catch(() => {}); }
  const rows = JSON.parse(text + decoder.decode());
  assert.ok(Array.isArray(rows) && rows.length <= 100);
  for (const row of rows) {
    assert.ok(Number.isSafeInteger(row?.user?.id) && Number.isFinite(Date.parse(row?.starred_at)));
    assert.ok(!ids.has(row.user.id), 'Star pages changed during inspection; do not infer a complete roster');
    ids.add(row.user.id);
  }
  if (!/;\s*rel="next"/.test(response.headers.get('link') || '')) { complete = true; break; }
}
assert.ok(complete, 'The bounded scan did not finish');
console.log('The repository-scoped token read every available star page with valid timestamps. No identities or counts were published.');
}

main().catch(error => {
  console.error('Repository star access check failed; timestamped counts remain unverified.');
  console.error(JSON.stringify(failureDiagnostic(error)));
  process.exitCode = 1;
});
