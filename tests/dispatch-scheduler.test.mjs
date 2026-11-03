import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { DispatchScheduler, SCHEDULER_FILENAME } from '../lib/dispatch-scheduler.mjs';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const OTHER_COMPANY = '22222222-2222-4222-8222-222222222222';
const OWNER = '33333333-3333-4333-8333-333333333333';
const OTHER_OWNER = '44444444-4444-4444-8444-444444444444';
const NOW = '2026-11-03T12:00:00.000Z';
const later = milliseconds => new Date(Date.parse(NOW) + milliseconds).toISOString();
const cloud = index => 'task_e_' + String(index).padStart(32, '0');
function identity(patch = {}) { return { executionId: randomUUID(), companyId: COMPANY, paperclipIssueId: randomUUID(), attempt: 1, repository: 'fixture/a', createdAt: NOW, paperclipRunId: OWNER, ...patch }; }
function fixture(t, limits = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-scheduler-'));
  const scheduler = new DispatchScheduler({ directory, limits: { maxGlobalActive: 2, maxRepositoryActive: 1, maxAttempts: 3, minDispatchIntervalMs: 0, ...limits } });
  scheduler.registerRepository({ repository: 'fixture/a', maxActive: 1, maxAttempts: 3 });
  scheduler.registerRepository({ repository: 'fixture/b', maxActive: 1, maxAttempts: 3 });
  t.after(() => { scheduler.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, scheduler };
}
function complete(scheduler, original, { state = 'succeeded', id = cloud(1), now = NOW } = {}) {
  const current = scheduler.get(original.executionId);
  return scheduler.confirmTerminal(original.executionId, { expectedRevision: current.revision, evidence: { ...original, state, ...(id ? { cloudTaskId: id } : {}) }, now });
}
async function childClaim(directory, executionId, ownerId, { crash = false } = {}) {
  const moduleUrl = new URL('../lib/dispatch-scheduler.mjs', import.meta.url).href;
  const program = `import {DispatchScheduler} from ${JSON.stringify(moduleUrl)};
const scheduler=new DispatchScheduler({directory:${JSON.stringify(directory)}});
const result=scheduler.claim(${JSON.stringify(executionId)},{ownerId:${JSON.stringify(ownerId)},now:${JSON.stringify(NOW)}});
${crash ? "process.stdout.write(JSON.stringify(result)+'\\n',()=>process.kill(process.pid,'SIGKILL'));" : "console.log(JSON.stringify(result));scheduler.close();"}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
  return new Promise((resolve, reject) => {
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      try {
        assert.equal(crash ? signal : code, crash ? 'SIGKILL' : 0, stderr);
        resolve(JSON.parse(stdout));
      } catch (error) { reject(error); }
    });
  });
}

test('account settings persist and incoming requests cannot silently vary policy', t => {
  const { directory, scheduler } = fixture(t);
  const reopened = new DispatchScheduler({ directory });
  try {
    assert.deepEqual(reopened.settings().limits, scheduler.settings().limits);
    assert.throws(() => new DispatchScheduler({ directory, limits: { maxGlobalActive: 3 } }), { code: 'SCHEDULER_LIMITS_CHANGED' });
    const initial = scheduler.settings();
    const changed = scheduler.configureLimits({ expectedRevision: initial.revision, limits: { maxGlobalActive: 3, maxRepositoryActive: 2, maxAttempts: 4, minDispatchIntervalMs: 2000 }, now: NOW });
    assert.equal(changed.limits.maxGlobalActive, 3);
    assert.throws(() => reopened.configureLimits({ expectedRevision: initial.revision, limits: initial.limits }), { code: 'SCHEDULER_CONTROL_CONFLICT' });
    assert.equal(reopened.settings().limits.maxAttempts, 4);
  } finally { reopened.close(); }
});

test('repository ceilings are durable, explicit, and bounded by the account policy', t => {
  const { scheduler } = fixture(t);
  const original = scheduler.registerRepository({ repository: 'FIXTURE/A', maxActive: 1, maxAttempts: 3 });
  assert.equal(original.repository, 'fixture/a');
  assert.throws(() => scheduler.registerRepository({ repository: 'fixture/a', maxActive: 1, maxAttempts: 2 }), { code: 'SCHEDULER_REPOSITORY_LIMITS_CHANGED' });
  assert.throws(() => scheduler.registerRepository({ repository: 'fixture/c', maxActive: 2, maxAttempts: 3 }), { code: 'SCHEDULER_REPOSITORY_LIMIT_EXCEEDS_POLICY' });
  const changed = scheduler.configureRepository({ repository: 'fixture/a', expectedRevision: original.revision, maxActive: 1, maxAttempts: 2, now: NOW });
  assert.equal(changed.maxAttempts, 2);
  assert.throws(() => scheduler.configureRepository({ repository: 'fixture/a', expectedRevision: original.revision, maxActive: 1, maxAttempts: 3 }), { code: 'SCHEDULER_CONTROL_CONFLICT' });
});

test('canonical execution identity and immutable repository binding deduplicate across companies', t => {
  const { scheduler } = fixture(t);
  const first = identity();
  const queued = scheduler.enqueue(first);
  assert.deepEqual(scheduler.enqueue(first), queued);
  assert.throws(() => scheduler.enqueue({ ...first, repository: 'fixture/b' }), { code: 'SCHEDULER_BINDING_CHANGED' });
  assert.throws(() => scheduler.enqueue({ ...first, executionId: randomUUID() }), { code: 'SCHEDULER_IDENTITY_CONFLICT' });
  const otherCompany = scheduler.enqueue({ ...first, executionId: randomUUID(), companyId: OTHER_COMPANY });
  assert.equal(otherCompany.companyId, OTHER_COMPANY);
  assert.equal(scheduler.list().length, 2);
});

test('global slots cover distinct companies and admitted work never expires', t => {
  const { scheduler } = fixture(t, { maxGlobalActive: 1 });
  const a = scheduler.enqueue(identity()), b = scheduler.enqueue(identity({ repository: 'fixture/b', companyId: OTHER_COMPANY }));
  const admitted = scheduler.claim(a.executionId, { ownerId: OWNER, now: NOW });
  assert.equal(admitted.claimed, true);
  const blocked = scheduler.claim(b.executionId, { ownerId: OTHER_OWNER, now: later(365 * 86_400_000) });
  assert.equal(blocked.claimed, false); assert.equal(blocked.reason, 'GLOBAL_CAPACITY');
  assert.equal(scheduler.claim(a.executionId, { ownerId: OWNER, now: later(86_400_000) }).reason, 'ALREADY_ADMITTED');
  complete(scheduler, a, { state: 'failed', id: null, now: later(1000) });
  assert.equal(scheduler.claim(b.executionId, { ownerId: OTHER_OWNER, now: later(2000) }).claimed, true);
});

test('repository slots prevent over-admission while unrelated work can proceed', t => {
  const { scheduler } = fixture(t);
  const a = scheduler.enqueue(identity()), secondA = scheduler.enqueue(identity()), b = scheduler.enqueue(identity({ repository: 'fixture/b' }));
  scheduler.claim(a.executionId, { ownerId: OWNER, now: NOW });
  assert.equal(scheduler.claim(secondA.executionId, { ownerId: OTHER_OWNER, now: NOW }).claimed, false);
  assert.equal(scheduler.claim(b.executionId, { ownerId: OTHER_OWNER, now: NOW }).claimed, true);
  assert.equal(scheduler.snapshot({ now: NOW }).activeCount, 2);
});

test('FIFO within a repository and persisted round-robin prevent busy-repository starvation', t => {
  const { directory, scheduler } = fixture(t, { maxGlobalActive: 1 });
  const a1 = scheduler.enqueue(identity()), a2 = scheduler.enqueue(identity()), a3 = scheduler.enqueue(identity()), b = scheduler.enqueue(identity({ repository: 'fixture/b' }));
  assert.equal(scheduler.claim(a2.executionId, { ownerId: OWNER, now: NOW }).reason, 'FAIR_QUEUE_WAIT');
  assert.equal(scheduler.peekNext({ now: NOW }).record.executionId, a1.executionId);
  scheduler.claim(a1.executionId, { ownerId: OWNER, now: NOW }); complete(scheduler, a1);
  const next = new DispatchScheduler({ directory });
  try {
    assert.equal(next.peekNext({ now: NOW }).record.executionId, b.executionId);
    assert.equal(next.claim(a2.executionId, { ownerId: OWNER, now: NOW }).nextExecutionId, b.executionId);
    next.claim(b.executionId, { ownerId: OTHER_OWNER, now: NOW }); complete(next, b, { id: cloud(2) });
    assert.equal(next.peekNext({ now: NOW }).record.executionId, a2.executionId);
    next.claim(a2.executionId, { ownerId: OWNER, now: NOW }); complete(next, a2, { id: cloud(3) });
    assert.equal(next.peekNext({ now: NOW }).record.executionId, a3.executionId);
  } finally { next.close(); }
});

test('stale owners cannot alter a receipt and Cloud identity remains immutable and unique', t => {
  const { scheduler } = fixture(t);
  const a = scheduler.enqueue(identity()), b = scheduler.enqueue(identity({ repository: 'fixture/b' }));
  const admitted = scheduler.claim(a.executionId, { ownerId: OWNER, now: NOW }).record;
  const submitted = scheduler.markSubmitted(a.executionId, { token: admitted.token, expectedRevision: admitted.revision, cloudTaskId: cloud(1), now: NOW });
  assert.throws(() => scheduler.markUnknown(a.executionId, { token: admitted.token, expectedRevision: admitted.revision, now: NOW }), { code: 'SCHEDULER_STALE_OWNER' });
  assert.throws(() => scheduler.markUnknown(a.executionId, { token: randomUUID(), expectedRevision: submitted.revision, now: NOW }), { code: 'SCHEDULER_STALE_OWNER' });
  assert.throws(() => scheduler.markSubmitted(a.executionId, { token: submitted.token, expectedRevision: submitted.revision, cloudTaskId: cloud(2), now: NOW }), { code: 'SCHEDULER_CLOUD_ID_CHANGED' });
  const admittedB = scheduler.claim(b.executionId, { ownerId: OTHER_OWNER, now: NOW }).record;
  assert.throws(() => scheduler.markSubmitted(b.executionId, { token: admittedB.token, expectedRevision: admittedB.revision, cloudTaskId: cloud(1), now: NOW }), { code: 'SCHEDULER_CLOUD_ID_CONFLICT' });
  assert.equal(scheduler.get(a.executionId).cloudTaskId, cloud(1));
});

test('ambiguous and submitted states hold capacity indefinitely until exact terminal evidence', t => {
  const { scheduler } = fixture(t, { maxGlobalActive: 1 });
  const a = scheduler.enqueue(identity()), b = scheduler.enqueue(identity({ repository: 'fixture/b' }));
  const admitted = scheduler.claim(a.executionId, { ownerId: OWNER, now: NOW }).record;
  const unknown = scheduler.markUnknown(a.executionId, { token: admitted.token, expectedRevision: admitted.revision, now: NOW });
  assert.equal(scheduler.claim(b.executionId, { ownerId: OTHER_OWNER, now: later(86_400_000) }).reason, 'GLOBAL_CAPACITY');
  assert.throws(() => scheduler.confirmTerminal(a.executionId, { expectedRevision: unknown.revision, evidence: { ...a, state: 'unknown' }, now: NOW }), { code: 'SCHEDULER_TERMINAL_PROOF_REQUIRED' });
  assert.throws(() => scheduler.confirmTerminal(a.executionId, { expectedRevision: unknown.revision, evidence: { ...a, state: 'succeeded' }, now: NOW }), { code: 'SCHEDULER_TERMINAL_PROOF_REQUIRED' });
  assert.throws(() => scheduler.confirmTerminal(a.executionId, { expectedRevision: unknown.revision, evidence: { ...a, companyId: OTHER_COMPANY, state: 'failed' }, now: NOW }), { code: 'SCHEDULER_BINDING_CHANGED' });
  const observed = scheduler.markSubmitted(a.executionId, { token: unknown.token, expectedRevision: unknown.revision, cloudTaskId: cloud(1), now: later(1000) });
  assert.throws(() => scheduler.confirmTerminal(a.executionId, { expectedRevision: observed.revision, evidence: { ...a, state: 'succeeded', cloudTaskId: cloud(2) }, now: NOW }), { code: 'SCHEDULER_CLOUD_ID_CHANGED' });
  complete(scheduler, a, { now: later(2000) });
  assert.equal(scheduler.claim(b.executionId, { ownerId: OTHER_OWNER, now: later(3000) }).claimed, true);
});

test('known receipts survive local ambiguity and sanitized diagnostics do not retain raw text', t => {
  const { scheduler } = fixture(t);
  const a = scheduler.enqueue(identity()), admitted = scheduler.claim(a.executionId, { ownerId: OWNER, now: NOW }).record;
  const unknown = scheduler.markUnknown(a.executionId, { token: admitted.token, expectedRevision: admitted.revision, cloudTaskId: cloud(1), reasonCode: 'TOKEN_SECRET_FIXTURE', now: NOW });
  assert.equal(unknown.cloudTaskId, cloud(1)); assert.equal(unknown.reasonCode, 'UNCLASSIFIED_ERROR');
  const output = JSON.stringify({ snapshot: scheduler.snapshot({ now: NOW }), events: scheduler.events() });
  assert.equal(output.includes('TOKEN_SECRET_FIXTURE'), false);
  assert.equal(output.includes(admitted.token), false);
  assert.equal(output.includes('"token"'), false);
});

test('account and repository pauses preserve work and admission resumes without changing attempts', t => {
  const { scheduler } = fixture(t);
  const a = scheduler.enqueue(identity()), b = scheduler.enqueue(identity({ repository: 'fixture/b' }));
  scheduler.setPaused(true, { repository: 'fixture/a', now: NOW });
  assert.equal(scheduler.peekNext({ now: NOW }).record.executionId, b.executionId);
  scheduler.setPaused(true, { now: NOW });
  assert.equal(scheduler.claim(b.executionId, { ownerId: OWNER, now: NOW }).reason, 'ACCOUNT_PAUSED');
  scheduler.setPaused(false, { now: NOW });
  assert.equal(scheduler.claim(b.executionId, { ownerId: OWNER, now: NOW }).claimed, true);
  scheduler.setPaused(false, { repository: 'fixture/a', now: NOW });
  assert.equal(scheduler.claim(a.executionId, { ownerId: OTHER_OWNER, now: NOW }).claimed, true);
  assert.equal(scheduler.get(a.executionId).attempt, 1);
});

test('shared provider cooldown and dispatch spacing persist across database handles', t => {
  const { scheduler, directory } = fixture(t, { minDispatchIntervalMs: 1000 });
  const a = scheduler.enqueue(identity()), b = scheduler.enqueue(identity({ repository: 'fixture/b' }));
  scheduler.claim(a.executionId, { ownerId: OWNER, now: NOW });
  const second = new DispatchScheduler({ directory });
  try {
    assert.equal(second.claim(b.executionId, { ownerId: OTHER_OWNER, now: NOW }).reason, 'PROVIDER_RATE_LIMIT');
    scheduler.deferProviderRequests({ now: NOW, delayMs: 60_000 });
    second.deferProviderRequests({ now: NOW, delayMs: 1000 });
    const blocked = second.claim(b.executionId, { ownerId: OTHER_OWNER, now: later(2000) });
    assert.equal(blocked.reason, 'PROVIDER_COOLDOWN'); assert.equal(blocked.retryAt, later(60_000));
    second.setPaused(false, { now: NOW });
    assert.equal(second.settings().cooldownUntil, later(60_000));
    assert.equal(second.claim(b.executionId, { ownerId: OTHER_OWNER, now: later(60_000) }).claimed, true);
  } finally { second.close(); }
});

test('lowering explicit limits retains existing slots and blocks new admission', t => {
  const { scheduler } = fixture(t);
  const a = scheduler.enqueue(identity()), b = scheduler.enqueue(identity({ repository: 'fixture/b' }));
  scheduler.claim(a.executionId, { ownerId: OWNER, now: NOW });
  scheduler.configureLimits({ expectedRevision: scheduler.settings().revision, limits: { maxGlobalActive: 1, maxRepositoryActive: 1, maxAttempts: 3, minDispatchIntervalMs: 0 }, now: NOW });
  assert.equal(scheduler.claim(b.executionId, { ownerId: OTHER_OWNER, now: NOW }).reason, 'GLOBAL_CAPACITY');
  assert.equal(scheduler.get(a.executionId).state, 'admitted');
});

test('new attempts require a terminal predecessor and obey durable retry ceilings', t => {
  const { scheduler } = fixture(t);
  const a = scheduler.enqueue(identity()), second = { ...a, executionId: randomUUID(), attempt: 2 };
  assert.throws(() => scheduler.enqueue(second), { code: 'SCHEDULER_ATTEMPT_REQUIRES_TERMINAL' });
  scheduler.cancelQueued(a.executionId, { expectedRevision: a.revision, now: NOW });
  const queued = scheduler.enqueue(second);
  assert.equal(queued.attempt, 2);
  assert.throws(() => scheduler.enqueue({ ...second, executionId: randomUUID(), attempt: 4 }), { code: 'SCHEDULER_ATTEMPT_LIMIT' });
  const admitted = scheduler.claim(queued.executionId, { ownerId: OWNER, now: NOW }).record;
  assert.throws(() => scheduler.cancelQueued(queued.executionId, { expectedRevision: admitted.revision, now: NOW }), { code: 'SCHEDULER_QUEUED_CANCEL_CONFLICT' });
});

test('lowering retry ceilings cannot let an ineligible retry starve fresh work in the same repository', t => {
  const { scheduler } = fixture(t);
  const first = scheduler.enqueue(identity());
  complete(scheduler, first, { state: 'failed', id: null });
  const retry = scheduler.enqueue({ ...first, executionId: randomUUID(), attempt: 2 });
  const fresh = scheduler.enqueue(identity());
  scheduler.configureLimits({ expectedRevision: scheduler.settings().revision, limits: { maxGlobalActive: 2, maxRepositoryActive: 1, maxAttempts: 1, minDispatchIntervalMs: 0 } });
  assert.equal(scheduler.peekNext().record.executionId, fresh.executionId);
  assert.equal(scheduler.claim(fresh.executionId, { ownerId: OWNER }).claimed, true);
  assert.equal(scheduler.get(retry.executionId).state, 'queued');
});

test('a durable held head cannot block fresh work in the same or another repository', t => {
  const { scheduler, directory } = fixture(t);
  const bad = scheduler.enqueue(identity()), same = scheduler.enqueue(identity()), other = scheduler.enqueue(identity({ repository: 'fixture/b' }));
  const held = scheduler.holdQueued(bad.executionId, { expectedRevision: bad.revision, reasonCode: 'TASK_TERMINAL', now: NOW });
  assert.equal(held.state, 'held'); assert.equal(scheduler.claim(bad.executionId, { ownerId: OWNER }).reason, 'EXECUTION_HELD');
  const reopened = new DispatchScheduler({ directory });
  try {
    assert.equal(reopened.get(bad.executionId).reasonCode, 'TASK_TERMINAL');
    assert.equal(reopened.peekNext().record.executionId, same.executionId);
    assert.equal(reopened.claim(same.executionId, { ownerId: OWNER }).claimed, true);
    assert.equal(reopened.peekNext().record.executionId, other.executionId);
    assert.equal(reopened.claim(other.executionId, { ownerId: OTHER_OWNER }).claimed, true);
    const snapshot = reopened.snapshot();
    assert.equal(snapshot.counts.held, 1); assert.equal(snapshot.attentionDepth, 1); assert.equal(snapshot.activeCount, 2);
  } finally { reopened.close(); }
});

test('held work resumes only by explicit revision-checked action with the original identity', t => {
  const { scheduler } = fixture(t);
  const initial = scheduler.enqueue(identity());
  const held = scheduler.holdQueued(initial.executionId, { expectedRevision: initial.revision, reasonCode: 'WAKE_OUTCOME_UNKNOWN', now: NOW });
  scheduler.adoptJournalExecution({ ...initial, state: 'queued' });
  assert.equal(scheduler.get(initial.executionId).state, 'held');
  assert.throws(() => scheduler.resumeHeld(initial.executionId, { expectedRevision: initial.revision }), { code: 'SCHEDULER_HOLD_CONFLICT' });
  const resumed = scheduler.resumeHeld(initial.executionId, { expectedRevision: held.revision, now: later(1000) });
  for (const field of ['executionId', 'companyId', 'paperclipIssueId', 'attempt', 'repository']) assert.equal(resumed[field], initial[field]);
  assert.equal(resumed.state, 'queued'); assert.equal(resumed.reasonCode, 'OPERATOR_RESUMED');
  assert.equal(scheduler.claim(resumed.executionId, { ownerId: OWNER }).claimed, true);
});

test('holding queued work never holds or releases an already admitted submission', t => {
  const { scheduler } = fixture(t);
  const initial = scheduler.enqueue(identity()), admitted = scheduler.claim(initial.executionId, { ownerId: OWNER }).record;
  assert.throws(() => scheduler.holdQueued(initial.executionId, { expectedRevision: admitted.revision, reasonCode: 'CONFIG_CHANGED' }), { code: 'SCHEDULER_HOLD_CONFLICT' });
  assert.equal(scheduler.snapshot().activeCount, 1);
});

test('preexisting journal work is adopted conservatively even above configured account limits', t => {
  const { scheduler } = fixture(t, { maxGlobalActive: 1 });
  const first = identity({ state: 'running', cloudTaskId: cloud(1), updatedAt: later(1000), dispatchedAt: later(1000) });
  const second = identity({ state: 'unknown', repository: 'fixture/b', companyId: OTHER_COMPANY, updatedAt: later(2000) });
  const adopted = scheduler.adoptJournalExecution(first, { now: later(5000) });
  assert.equal(adopted.createdAt, NOW); assert.equal(adopted.admittedAt, later(1000));
  assert.deepEqual(scheduler.adoptJournalExecution(first, { now: later(6000) }), adopted);
  scheduler.adoptJournalExecution(second, { now: later(5000) });
  assert.equal(scheduler.snapshot({ now: later(5000) }).activeCount, 2);
  const queued = scheduler.enqueue(identity());
  assert.equal(scheduler.claim(queued.executionId, { ownerId: OWNER, now: later(5000) }).reason, 'GLOBAL_CAPACITY');
  scheduler.adoptJournalExecution({ ...first, state: 'succeeded', updatedAt: later(7000) });
  assert.equal(scheduler.get(first.executionId).state, 'succeeded');
  scheduler.adoptJournalExecution({ ...first, state: 'running' });
  assert.equal(scheduler.get(first.executionId).state, 'succeeded');
});

test('adoption attaches known receipts without reassigning a submitting owner', t => {
  const { scheduler } = fixture(t);
  const a = scheduler.enqueue(identity()), admitted = scheduler.claim(a.executionId, { ownerId: OWNER, now: NOW }).record;
  const adopted = scheduler.adoptJournalExecution({ ...a, state: 'running', cloudTaskId: cloud(1), paperclipRunId: OTHER_OWNER, updatedAt: later(1000) });
  assert.equal(adopted.ownerId, OWNER); assert.equal(adopted.token, admitted.token); assert.equal(adopted.cloudTaskId, cloud(1));
  assert.throws(() => scheduler.adoptJournalExecution({ ...a, state: 'running', cloudTaskId: cloud(2) }), { code: 'SCHEDULER_CLOUD_ID_CHANGED' });
});

test('two competing database handles recheck capacity instead of trusting an earlier queue snapshot', t => {
  const { scheduler, directory } = fixture(t, { maxGlobalActive: 1 });
  const a = scheduler.enqueue(identity()), b = scheduler.enqueue(identity({ repository: 'fixture/b' }));
  const other = new DispatchScheduler({ directory });
  try {
    assert.equal(other.peekNext({ now: NOW }).record.executionId, a.executionId);
    scheduler.claim(a.executionId, { ownerId: OWNER, now: NOW });
    assert.equal(other.claim(b.executionId, { ownerId: OTHER_OWNER, now: NOW }).reason, 'GLOBAL_CAPACITY');
    assert.equal(other.claim(a.executionId, { ownerId: OTHER_OWNER, now: NOW }).reason, 'ALREADY_ADMITTED');
  } finally { other.close(); }
});

test('separate competing processes cannot exceed one global slot', async t => {
  const { scheduler, directory } = fixture(t, { maxGlobalActive: 1 });
  const a = scheduler.enqueue(identity()), b = scheduler.enqueue(identity({ repository: 'fixture/b', companyId: OTHER_COMPANY }));
  const results = await Promise.all([childClaim(directory, a.executionId, OWNER), childClaim(directory, b.executionId, OTHER_OWNER)]);
  assert.equal(results.filter(result => result.claimed).length, 1);
  assert.equal(scheduler.snapshot({ now: NOW }).activeCount, 1);
});

test('SIGKILL after durable admission retains the same slot and never grants another submission', async t => {
  const { scheduler, directory } = fixture(t, { maxGlobalActive: 1 });
  const a = scheduler.enqueue(identity()), b = scheduler.enqueue(identity({ repository: 'fixture/b' }));
  const result = await childClaim(directory, a.executionId, OWNER, { crash: true });
  const restarted = new DispatchScheduler({ directory });
  try {
    assert.equal(restarted.get(a.executionId).token, result.record.token);
    assert.equal(restarted.claim(a.executionId, { ownerId: OTHER_OWNER, now: later(86_400_000) }).reason, 'ALREADY_ADMITTED');
    assert.equal(restarted.claim(b.executionId, { ownerId: OTHER_OWNER, now: later(86_400_000) }).reason, 'GLOBAL_CAPACITY');
  } finally { restarted.close(); }
});

test('status reports bounded queue/activity/durations and terminal rates without ownership tokens', t => {
  const { scheduler } = fixture(t);
  const a = scheduler.enqueue(identity()), b = scheduler.enqueue(identity({ repository: 'fixture/b' }));
  const admitted = scheduler.claim(a.executionId, { ownerId: OWNER, now: later(1000) }).record;
  scheduler.markSubmitted(a.executionId, { token: admitted.token, expectedRevision: admitted.revision, cloudTaskId: cloud(1), now: later(2000) });
  const snapshot = scheduler.snapshot({ now: later(5000), limit: 1 });
  assert.equal(snapshot.queueDepth, 1); assert.equal(snapshot.activeCount, 1); assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.executions[0].durationMs, 4000); assert.equal(snapshot.executions[0].ageMs, 5000);
  assert.deepEqual(snapshot.knownCloudTaskIds, [cloud(1)]); assert.equal(snapshot.successRate, null);
  assert.equal(JSON.stringify(snapshot).includes(admitted.token), false);
  complete(scheduler, a, { now: later(6000) }); scheduler.cancelQueued(b.executionId, { expectedRevision: b.revision, now: later(6000) });
  assert.equal(scheduler.snapshot({ now: later(7000) }).successRate, 0.5);
});

test('storage rejects symlink files/directories and unsupported SQLite applications', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-scheduler-storage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const actual = path.join(directory, 'actual'); fs.mkdirSync(actual);
  const link = path.join(directory, 'linked'); fs.symlinkSync(actual, link);
  assert.throws(() => new DispatchScheduler({ directory: link }), { code: 'SCHEDULER_UNSAFE_STORAGE' });
  fs.writeFileSync(path.join(directory, 'file'), 'not sqlite');
  fs.symlinkSync(path.join(directory, 'file'), path.join(actual, SCHEDULER_FILENAME));
  assert.throws(() => new DispatchScheduler({ directory: actual }), { code: 'SCHEDULER_UNSAFE_STORAGE' });
  fs.unlinkSync(path.join(actual, SCHEDULER_FILENAME));
  const db = new DatabaseSync(path.join(actual, SCHEDULER_FILENAME));
  db.exec('CREATE TABLE unrelated (id INTEGER); PRAGMA user_version=7;'); db.close();
  assert.throws(() => new DispatchScheduler({ directory: actual }), { code: 'SCHEDULER_MIGRATION_REQUIRED' });
});

test('invalid controls and missing repositories fail without admitting anything', t => {
  const { scheduler } = fixture(t);
  assert.throws(() => scheduler.enqueue(identity({ repository: 'fixture/missing' })), { code: 'SCHEDULER_REPOSITORY_NOT_REGISTERED' });
  assert.throws(() => scheduler.setPaused('yes'), { code: 'SCHEDULER_INVALID_PAUSE' });
  assert.throws(() => scheduler.deferProviderRequests({ now: NOW, delayMs: -1 }), { code: 'SCHEDULER_INVALID_COOLDOWN' });
  assert.throws(() => scheduler.configureLimits({ expectedRevision: 0 }), { code: 'SCHEDULER_INVALID_LIMITS' });
  assert.equal(scheduler.snapshot({ now: NOW }).activeCount, 0);
});
