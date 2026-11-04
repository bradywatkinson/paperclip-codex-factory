import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DispatchScheduler } from '../lib/dispatch-scheduler.mjs';

const REPOSITORY = 'fixture/a', OTHER = 'fixture/b';
const OLD = 'a'.repeat(64), NEXT = 'b'.repeat(64), LAST = 'c'.repeat(64);
const NOW = '2026-11-03T12:00:00.000Z';
const OWNER = '33333333-3333-4333-8333-333333333333';
function identity(repository = REPOSITORY) { return { executionId: randomUUID(), companyId: randomUUID(), paperclipIssueId: randomUUID(), attempt: 1, repository, createdAt: NOW }; }
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-scheduler-fence-'));
  const scheduler = new DispatchScheduler({ directory, limits: { minDispatchIntervalMs: 0 } });
  for (const repository of [REPOSITORY, OTHER]) scheduler.registerRepository({ repository, maxActive: 1, maxAttempts: 3 });
  t.after(() => { scheduler.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const intent = { repository: REPOSITORY, updateId: randomUUID(), previousHash: OLD, nextHash: NEXT };
  return { directory, scheduler, intent };
}
function rejects(fn, code) { assert.throws(fn, { code: 'SCHEDULER_' + code }); }

test('legacy stores gain the additive fence table without changing history or controls', t => {
  const { directory, scheduler, intent } = fixture(t), terminal = scheduler.enqueue(identity());
  scheduler.confirmTerminal(terminal.executionId, { expectedRevision: terminal.revision, evidence: { ...terminal, state: 'cancelled' }, now: NOW });
  scheduler.setPaused(true, { now: NOW });
  const settings = scheduler.settings(), repositories = scheduler.repositories(), executions = scheduler.list(), events = scheduler.events();
  scheduler.db.exec('DROP TABLE scheduler_configuration_fences; PRAGMA user_version=1;');
  const reopened = new DispatchScheduler({ directory });
  try {
    assert.equal(reopened.configurationFence(REPOSITORY), null);
    assert.equal(reopened.assertConfiguration(REPOSITORY), undefined);
    reopened.beginConfigurationUpdate(intent);
    reopened.finishConfigurationUpdate(intent);
    assert.deepEqual(reopened.settings(), settings);
    assert.deepEqual(reopened.repositories(), repositories);
    assert.deepEqual(reopened.list(), executions);
    assert.deepEqual(reopened.events(), events);
    assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version, 2);
  } finally { reopened.close(); }
});

test('updates require account pause and reject every nonterminal state, including held work', async t => {
  for (const state of ['queued', 'held', 'admitted', 'submitted', 'unknown']) await t.test(state, t => {
    const { scheduler, intent } = fixture(t);
    rejects(() => scheduler.beginConfigurationUpdate(intent), 'CONFIGURATION_UPDATE_REQUIRES_PAUSE');
    const row = scheduler.enqueue(identity());
    if (state === 'held') scheduler.holdQueued(row.executionId, { expectedRevision: row.revision, reasonCode: 'CONFIG_CHANGED', now: NOW });
    else if (state !== 'queued') {
      const admitted = scheduler.claim(row.executionId, { ownerId: OWNER, now: NOW }).record;
      if (state === 'submitted') scheduler.markSubmitted(row.executionId, { token: admitted.token, expectedRevision: admitted.revision, cloudTaskId: 'task_e_' + '1'.repeat(32), now: NOW });
      if (state === 'unknown') scheduler.markUnknown(row.executionId, { token: admitted.token, expectedRevision: admitted.revision, now: NOW });
    }
    scheduler.setPaused(true, { now: NOW });
    rejects(() => scheduler.beginConfigurationUpdate(intent), 'CONFIGURATION_UPDATE_REQUIRES_IDLE');
    assert.equal(scheduler.configurationFence(REPOSITORY), null);
  });
});

test('an exact update resumes durably while competing intents and stale chains reject', t => {
  const { directory, scheduler, intent } = fixture(t);
  scheduler.setPaused(true, { now: NOW });
  const fence = scheduler.beginConfigurationUpdate(intent);
  assert.equal(fence.state, 'updating');
  const reopened = new DispatchScheduler({ directory });
  try {
    assert.deepEqual(reopened.beginConfigurationUpdate(intent), fence);
    rejects(() => reopened.beginConfigurationUpdate({ ...intent, updateId: randomUUID() }), 'CONFIGURATION_UPDATE_CONFLICT');
    rejects(() => reopened.beginConfigurationUpdate({ ...intent, nextHash: LAST }), 'CONFIGURATION_UPDATE_CONFLICT');
    rejects(() => reopened.finishConfigurationUpdate({ ...intent, updateId: randomUUID() }), 'CONFIGURATION_UPDATE_CONFLICT');
    rejects(() => reopened.finishConfigurationUpdate({ ...intent, nextHash: LAST }), 'CONFIGURATION_UPDATE_CONFLICT');
    const ready = reopened.finishConfigurationUpdate(intent);
    assert.deepEqual(scheduler.finishConfigurationUpdate(intent), ready);
    assert.deepEqual(scheduler.beginConfigurationUpdate(intent), ready);
    rejects(() => scheduler.beginConfigurationUpdate({ ...intent, updateId: randomUUID(), nextHash: LAST }), 'CONFIGURATION_UPDATE_CONFLICT');
    const next = { ...intent, updateId: randomUUID(), previousHash: NEXT, nextHash: LAST };
    assert.equal(scheduler.beginConfigurationUpdate(next).previousHash, NEXT);
    rejects(() => reopened.finishConfigurationUpdate(intent), 'CONFIGURATION_UPDATE_CONFLICT');
    scheduler.finishConfigurationUpdate(next);
    assert.equal(scheduler.settings().paused, true);
  } finally { reopened.close(); }
});

test('updating blocks enqueue and claim, even for pre-opened scheduler handles', t => {
  const { directory, scheduler, intent } = fixture(t), other = new DispatchScheduler({ directory });
  try {
    scheduler.setPaused(true, { now: NOW });
    scheduler.beginConfigurationUpdate(intent);
    for (const configHash of [undefined, OLD, NEXT]) {
      rejects(() => other.enqueue(identity(), { configHash }), 'CONFIGURATION_UPDATING');
      rejects(() => other.assertConfiguration(REPOSITORY, configHash), 'CONFIGURATION_UPDATING');
    }
    // Inventory is allowed to retain newly discovered real work; admission is
    // fenced even if account pause is separately lifted during recovery.
    const row = other.adoptJournalExecution({ ...identity(), state: 'queued', updatedAt: NOW }, { now: NOW });
    scheduler.setPaused(false, { now: NOW });
    rejects(() => other.claim(row.executionId, { ownerId: OWNER, now: NOW, configHash: NEXT }), 'CONFIGURATION_UPDATING');
    rejects(() => other.finishConfigurationUpdate(intent), 'CONFIGURATION_UPDATE_REQUIRES_PAUSE');
    assert.equal(other.get(row.executionId).state, 'queued');
    assert.equal(scheduler.configurationFence(REPOSITORY).state, 'updating');
    assert.equal(other.enqueue(identity(OTHER)).repository, OTHER);
  } finally { other.close(); }
});

test('ready fences reject missing, malformed, and stale hashes on every enqueue/claim path', t => {
  const { scheduler, intent } = fixture(t);
  scheduler.setPaused(true, { now: NOW }); scheduler.beginConfigurationUpdate(intent); scheduler.finishConfigurationUpdate(intent);
  for (const configHash of [undefined, null, OLD, 'B'.repeat(64), '', 'b'.repeat(63)]) {
    const code = configHash === undefined || configHash === null ? 'CONFIGURATION_HASH_REQUIRED' : configHash === OLD ? 'CONFIGURATION_CHANGED' : 'INVALID_CONFIGURATION_HASH';
    rejects(() => scheduler.assertConfiguration(REPOSITORY, configHash), code);
    rejects(() => scheduler.enqueue(identity(), { configHash }), code);
  }
  const row = scheduler.enqueue(identity(), { configHash: NEXT });
  rejects(() => scheduler.enqueue(row), 'CONFIGURATION_HASH_REQUIRED');
  assert.deepEqual(scheduler.enqueue(row, { configHash: NEXT }), row);
  for (const configHash of [undefined, OLD]) rejects(() => scheduler.claim(row.executionId, { ownerId: OWNER, now: NOW, configHash }), configHash ? 'CONFIGURATION_CHANGED' : 'CONFIGURATION_HASH_REQUIRED');
  assert.equal(scheduler.claim(row.executionId, { ownerId: OWNER, now: NOW, configHash: NEXT }).reason, 'ACCOUNT_PAUSED');
  scheduler.setPaused(false, { now: NOW });
  assert.equal(scheduler.claim(row.executionId, { ownerId: OWNER, now: NOW, configHash: NEXT }).claimed, true);
  rejects(() => scheduler.claim(row.executionId, { ownerId: OWNER, configHash: OLD }), 'CONFIGURATION_CHANGED');
});

test('invalid identifiers and hashes cannot create or finalize a fence', t => {
  const { scheduler, intent } = fixture(t); scheduler.setPaused(true, { now: NOW });
  for (const hash of [undefined, '', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
    rejects(() => scheduler.beginConfigurationUpdate({ ...intent, previousHash: hash }), 'INVALID_CONFIGURATION_HASH');
    rejects(() => scheduler.beginConfigurationUpdate({ ...intent, nextHash: hash }), 'INVALID_CONFIGURATION_HASH');
    rejects(() => scheduler.finishConfigurationUpdate({ ...intent, nextHash: hash }), 'INVALID_CONFIGURATION_HASH');
  }
  rejects(() => scheduler.beginConfigurationUpdate({ ...intent, updateId: 'arbitrary' }), 'INVALID_IDENTIFIER');
  rejects(() => scheduler.beginConfigurationUpdate({ ...intent, repository: 'fixture/missing' }), 'REPOSITORY_NOT_REGISTERED');
  assert.equal(scheduler.configurationFence(REPOSITORY), null);
});

function competingChild(directory, program) {
  const moduleUrl = new URL('../lib/dispatch-scheduler.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {DispatchScheduler} from ${JSON.stringify(moduleUrl)};
const scheduler=new DispatchScheduler({directory:${JSON.stringify(directory)}});
process.stdout.write('ready\\n');process.stdin.once('data',()=>{try{${program};console.log(JSON.stringify({ok:true}));}catch(error){console.log(JSON.stringify({code:error.code}));}finally{scheduler.close();}});`], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', readyResolve;
  const ready = new Promise(resolve => { readyResolve = resolve; });
  child.stdout.on('data', bytes => { stdout += bytes; if (stdout.startsWith('ready\n')) readyResolve(); });
  child.stderr.on('data', bytes => { stderr += bytes; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timeout); try { assert.equal(code, 0, stderr); resolve(JSON.parse(stdout.trim().split('\n').at(-1))); } catch (error) { reject(error); } });
  });
  return { child, ready, done };
}

test('concurrent enqueue and update cannot both succeed across processes', async t => {
  const { directory, scheduler, intent } = fixture(t);
  scheduler.setPaused(true, { now: NOW });
  const row = identity();
  const update = competingChild(directory, `scheduler.beginConfigurationUpdate(${JSON.stringify(intent)})`);
  const enqueue = competingChild(directory, `scheduler.enqueue(${JSON.stringify(row)},{configHash:${JSON.stringify(OLD)}})`);
  await Promise.all([update.ready, enqueue.ready]);
  update.child.stdin.end('go'); enqueue.child.stdin.end('go');
  const results = await Promise.all([update.done, enqueue.done]);
  assert.equal(results.filter(result => result.ok).length, 1);
  if (results[0].ok) {
    assert.equal(results[1].code, 'SCHEDULER_CONFIGURATION_UPDATING');
    assert.equal(scheduler.get(row.executionId), null);
  } else {
    assert.equal(results[0].code, 'SCHEDULER_CONFIGURATION_UPDATE_REQUIRES_IDLE');
    assert.equal(scheduler.configurationFence(REPOSITORY), null);
    assert.equal(scheduler.get(row.executionId).state, 'queued');
  }
});
