import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { runFactoryCli } from '../scripts/factory.mjs';
import { DispatchScheduler } from '../lib/dispatch-scheduler.mjs';

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-scheduler-cli-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
async function invoke(args, directory) {
  let stdout = '', stderr = '';
  const code = await runFactoryCli(['scheduler', ...args, '--directory', directory, '--json'], { stdout: value => { stdout += value; }, stderr: value => { stderr += value; } });
  return { code, result: JSON.parse(code === 0 ? stdout : stderr) };
}
test('operator pause and resume survive CLI restarts', async t => {
  const directory = await setup(t);
  assert.equal((await invoke(['pause'], directory)).code, 0);
  assert.equal((await invoke(['status'], directory)).result.snapshot.settings.paused, true);
  assert.equal((await invoke(['resume'], directory)).code, 0);
  assert.equal((await invoke(['status'], directory)).result.snapshot.settings.paused, false);
});
test('explicit policy reconfiguration requires the current revision', async t => {
  const directory = await setup(t), policy = path.join(directory, 'policy.yaml');
  await fs.writeFile(policy, 'schemaVersion: 1\nconcurrency:\n  maxGlobalActive: 1\n');
  const initial = await invoke(['status'], directory);
  const revision = initial.result.snapshot.settings.revision;
  const args = ['configure', '--policy', policy, '--expected-revision', String(revision)];
  assert.equal((await invoke(args, directory)).code, 0);
  const stale = await invoke(args, directory);
  assert.equal(stale.code, 1); assert.equal(stale.result.code, 'SCHEDULER_CONTROL_CONFLICT');
  assert.equal((await invoke(['status'], directory)).result.snapshot.settings.limits.maxGlobalActive, 1);
});
test('operator controls never release an ambiguous submission and snapshots omit capabilities', async t => {
  const directory = await setup(t), scheduler = new DispatchScheduler({ directory });
  const ID = '11111111-1111-4111-8111-111111111111';
  scheduler.registerRepository({ repository: 'example/project', maxActive: 1, maxAttempts: 3 });
  scheduler.enqueue({ executionId: ID, companyId: ID, paperclipIssueId: ID, attempt: 1, repository: 'example/project' });
  const admission = scheduler.claim(ID, { ownerId: ID });
  scheduler.markUnknown(ID, { token: admission.record.token, expectedRevision: admission.record.revision });
  scheduler.close();
  await invoke(['pause'], directory); await invoke(['resume'], directory);
  const status = await invoke(['status'], directory);
  assert.equal(status.result.snapshot.activeCount, 1);
  assert.equal(status.result.snapshot.counts.unknown, 1);
  assert.equal(JSON.stringify(status.result).includes(admission.record.token), false);
});
