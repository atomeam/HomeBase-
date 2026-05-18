// Kraken Test Harness

const KRAKEN_URL = process.env.HOMEBASE_URL || 'http://localhost:3000';

const tests = [
  {
    name: 'missing_confirm',
    opts: { method: 'POST', body: { action: 'echo', params: { message: 'test' } } },
    expectStatus: 403
  },
  {
    name: 'wrong_confirm',
    opts: { method: 'POST', body: { action: 'echo', params: { message: 'test' } }, headers: { 'X-Operator-Confirm': 'no' } },
    expectStatus: 403
  },
  {
    name: 'unknown_action',
    opts: { method: 'POST', body: { action: 'fake', params: {} }, headers: { 'X-Operator-Confirm': 'yes' } },
    expectStatus: 403
  },
  {
    name: 'echo_success',
    opts: { method: 'POST', body: { action: 'echo', params: { message: 'hello' } }, headers: { 'X-Operator-Confirm': 'yes' } },
    expectStatus: 200
  },
];

async function runTest(test) {
  const opts = test.opts;
  const res = await fetch(`${KRAKEN_URL}/api/kraken/execute`, {
    method: opts.method,
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    body: JSON.stringify(opts.body),
  });
  const data = await res.json();
  const pass = res.status === test.expectStatus;
  console.log(`${pass ? '✅' : '❌'} ${test.name}: status=${res.status}, expect=${test.expectStatus}`);
  return pass;
}

async function main() {
  console.log('Kraken Test Harness\n');
  let passed = 0;
  for (const test of tests) {
    if (await runTest(test)) passed++;
  }
  console.log(`\n${passed}/${tests.length} passed`);
  process.exit(passed === tests.length ? 0 : 1);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
