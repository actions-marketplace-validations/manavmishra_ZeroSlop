// Manual, read-only access probe. Never print tokens or stargazer identities.
import assert from 'node:assert/strict';

async function main() {
const token = process.env.GITHUB_TOKEN;
assert.ok(token, 'A repository-scoped token is required');
const signal = AbortSignal.timeout(90000);
let complete = false;
const ids = new Set();
for (let page = 1; page <= 100; page++) {
  const response = await fetch(`https://api.github.com/repos/manavmishra/ZeroSlop/stargazers?per_page=100&page=${page}`, {
    signal, redirect: 'error', headers: { authorization: `Bearer ${token}`,
      accept: 'application/vnd.github.star+json', 'x-github-api-version': '2022-11-28',
      'user-agent': 'zero-slop-repository-access-check' },
  });
  if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error(`Timestamped star access returned HTTP ${response.status}`); }
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

main().catch(() => {
  console.error('Repository star access check failed; timestamped counts remain unverified.');
  process.exitCode = 1;
});
