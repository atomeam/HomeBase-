// Loxa Routing Test Harness
// Run: node loxa-test.js

const ROUTE_URL = process.env.HOMEBASE_URL || 'http://localhost:3000';

const tests = [
  { name: 'telemetry-health', body: { request: 'health check' }, expect: 'telemetry' },
  { name: 'telemetry-incident', body: { request: 'show incidents' }, expect: 'telemetry' },
  { name: 'telemetry-correlation', body: { request: 'correlation export' }, expect: 'telemetry' },
  { name: 'lore-memory', body: { request: 'lore memory' }, expect: 'lore' },
  { name: 'lore-curator', body: { request: 'ask curator' }, expect: 'lore' },
  { name: 'kraken-run', body: { request: 'run command' }, expect: 'kraken' },
  { name: 'kraken-deploy', body: { request: 'deploy now' }, expect: 'kraken' },
  { name: 'unknown-empty', body: { request: 'xyz123' }, expect: 'unknown' },
];

async function runTest(test) {
  const res = await fetch(`${ROUTE_URL}/api/route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(test.body),
  });
  const data = await res.json();
  const pass = data.route === test.expect;
  console.log(`${pass ? '✅' : '❌'} ${test.name}: got=${data.route} expect=${test.expect} decision=${data.decision}`);
  return pass;
}

async function main() {
  console.log('Loxa Routing Test Harness\n');
  let passed = 0;
  for (const test of tests) {
    if (await runTest(test)) passed++;
  }
  console.log(`\n${passed}/${tests.length} tests passed`);
  process.exit(passed === tests.length ? 0 : 1);
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
