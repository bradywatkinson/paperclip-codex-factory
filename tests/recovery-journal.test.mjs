import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ExecutionJournal } from '../lib/execution-journal.mjs';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const ISSUE = '22222222-2222-4222-8222-222222222222';
const RUN = '33333333-3333-4333-8333-333333333333';
const OWNER = '44444444-4444-4444-8444-444444444444';
const PROJECT = '55555555-5555-4555-8555-555555555555';
const OTHER_COMPANY = '66666666-6666-4666-8666-666666666666';
const CLOUD = 'task_e_0123456789abcdef0123456789abcdef';
const AT = '2030-01-02T00:00:00.000Z';
const later = milliseconds => new Date(Date.parse(AT) + milliseconds).toISOString();
const identity = { companyId: COMPANY, paperclipIssueId: ISSUE, paperclipRunId: RUN, projectId: PROJECT, repository: 'fixture/project', environmentId: 'a'.repeat(32), branch: 'main', mode: 'read_only' };
const receipt = { cloudTaskId: CLOUD, emittedUrl: 'https://chatgpt.com/codex/tasks/' + CLOUD, taskUrl: 'https://chatgpt.com/remote/' + CLOUD };
const moduleUrl = new URL('../lib/execution-journal.mjs', import.meta.url).href;
async function fixture(t, active = true) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-recovery-journal-'));
  const journal = new ExecutionJournal({ directory, companyId: COMPANY });
  t.after(async () => { journal.close(); await fs.rm(directory, { recursive: true, force: true }); });
  let record = journal.queue(identity);
  if (active) { journal.claim(ISSUE, RUN); record = journal.accept(ISSUE, RUN, receipt); }
  return { directory, journal, record };
}
function errorObservation(journal, record, { now = AT, errorCount = 8, nextPollAt = later(3600000), cloudUpdatedAt } = {}) {
  const lease = journal.claimPoll(record.executionId, { ownerId: OWNER, now, leaseMs: 1000 });
  return journal.recordObservation({ executionId: record.executionId, token: lease.token, expectedRevision: record.revision,
    now, nextPollAt, errorCount, observation: { cloudTaskId: CLOUD, errorCode: 'CLOUD_USAGE_LIMIT', cloudUpdatedAt } });
}

test('provider cooldown survives reopen, cannot be shortened, and is company scoped', async t => {
  const { journal, directory } = await fixture(t);
  assert.equal(journal.providerRequestLimit(), null);
  assert.deepEqual(journal.reserveProviderRequest({ now: AT }), { allowed: true, retryAt: later(1000) });
  assert.deepEqual(journal.deferProviderRequests({ now: AT, delayMs: 900000 }), { retryAt: later(900000) });
  assert.deepEqual(journal.deferProviderRequests({ now: later(1000), delayMs: 1000 }), { retryAt: later(900000) });
  const reopened = new ExecutionJournal({ directory, companyId: COMPANY });
  const other = new ExecutionJournal({ directory, companyId: OTHER_COMPANY });
  try {
    assert.deepEqual(reopened.providerRequestLimit(), { retryAt: later(900000) });
    assert.deepEqual(reopened.reserveProviderRequest({ now: later(10000) }), { allowed: false, retryAt: later(900000) });
    assert.equal(other.providerRequestLimit(), null);
    assert.equal(other.reserveProviderRequest({ now: AT }).allowed, true);
    assert.equal(reopened.reserveProviderRequest({ now: later(900000) }).allowed, true);
    assert.deepEqual(other.providerRequestLimit(), { retryAt: later(1000) });
  } finally { reopened.close(); other.close(); }
});

test('cooldown validation rejects unbounded delays without changing reservations', async t => {
  const { journal } = await fixture(t);
  for (const delayMs of [0, 999, 86400001, 1000.5, NaN, Infinity, '1000']) {
    assert.throws(() => journal.deferProviderRequests({ now: AT, delayMs }), { code: 'JOURNAL_INVALID_PROVIDER_COOLDOWN' });
    assert.equal(journal.providerRequestLimit(), null);
  }
  assert.deepEqual(journal.deferProviderRequests({ now: AT, delayMs: 86400000 }), { retryAt: later(86400000) });
});

test('competing cooldown writers preserve the longest durable provider deadline', async t => {
  const { journal, directory } = await fixture(t);
  const source = `import {ExecutionJournal} from ${JSON.stringify(moduleUrl)};const[d,c,at,ms]=process.argv.slice(1);const j=new ExecutionJournal({directory:d,companyId:c});const r=j.deferProviderRequests({now:at,delayMs:Number(ms)});j.close();console.log(JSON.stringify(r));`;
  const run = delayMs => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, directory, COMPANY, AT, String(delayMs)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    child.once('error', reject); child.once('close', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
  await Promise.all([run(1000), run(900000), run(10000)]);
  assert.deepEqual(journal.providerRequestLimit(), { retryAt: later(900000) });
});

test('operator resume resets only polling and records a safe audit while preserving cooldown and watermark', async t => {
  const { journal, directory, record } = await fixture(t);
  const first = journal.claimPoll(record.executionId, { ownerId: OWNER, now: AT, leaseMs: 1000 });
  journal.recordObservation({ executionId: record.executionId, token: first.token, expectedRevision: record.revision,
    now: AT, nextPollAt: later(1000), observation: { cloudTaskId: CLOUD, status: 'pending', cloudUpdatedAt: AT } });
  errorObservation(journal, record, { now: later(1000) });
  assert.equal(journal.observations(record.executionId).at(-1).errorCode, 'CLOUD_USAGE_LIMIT');
  journal.deferProviderRequests({ now: AT, delayMs: 900000 });
  const before = { record: journal.get(ISSUE), events: journal.events(ISSUE), runs: journal.runs(ISSUE), fence: await fs.readFile(path.join(directory, ISSUE + '.json')) };
  const resumed = journal.resumePolling(record.executionId, { now: later(2000) });
  assert.deepEqual(resumed.record, before.record);
  assert.deepEqual(resumed.polling, { nextPollAt: later(2000), errorCount: 0, cloudUpdatedAt: AT });
  assert.deepEqual(journal.events(ISSUE), before.events);
  assert.deepEqual(journal.runs(ISSUE), before.runs);
  assert.deepEqual(await fs.readFile(path.join(directory, ISSUE + '.json')), before.fence);
  assert.deepEqual(journal.providerRequestLimit(), { retryAt: later(900000) });
  assert.equal(journal.list().length, 1);
  assert.equal(journal.handoffs(record.executionId).length, 0);
  assert.deepEqual(journal.observations(record.executionId).at(-1), {
    id: 3, cloudTaskId: CLOUD, observedAt: later(2000), cloudUpdatedAt: null, status: null,
    errorCode: 'OPERATOR_RESUMED_POLLING', summary: null, nextPollAt: later(2000), errorCount: 0,
  });
  const reopened = new ExecutionJournal({ directory, companyId: COMPANY });
  try {
    assert.deepEqual(reopened.polling(record.executionId), resumed.polling);
    assert.deepEqual(reopened.get(ISSUE), before.record);
  } finally { reopened.close(); }
});

test('resume cannot steal an active poll lease, but an expired lease is safely invalidated', async t => {
  const { journal, record } = await fixture(t);
  const lease = journal.claimPoll(record.executionId, { ownerId: OWNER, now: AT, leaseMs: 1000 });
  const before = journal.polling(record.executionId);
  assert.throws(() => journal.resumePolling(record.executionId, { now: later(999) }), { code: 'JOURNAL_ACTIVE_POLL_LEASE' });
  assert.deepEqual(journal.polling(record.executionId), before);
  assert.equal(journal.observations(record.executionId).length, 0);
  assert.equal(journal.resumePolling(record.executionId, { now: later(1000) }).polling.leaseExpiresAt, undefined);
  assert.throws(() => journal.recordObservation({ executionId: record.executionId, token: lease.token, expectedRevision: record.revision,
    now: later(1000), nextPollAt: later(2000), observation: { cloudTaskId: CLOUD, status: 'ready' }, toState: 'succeeded', handoff: { mode: 'notify', target: 'in_review' } }), { code: 'JOURNAL_STALE_POLL_LEASE' });
  assert.deepEqual(journal.get(ISSUE), record);
});

test('resume rejects terminal, queued, dispatching, missing and unscoped executions', async t => {
  for (const state of ['queued', 'dispatching', 'succeeded', 'failed', 'cancelled']) {
    const { journal, record } = await fixture(t, !['queued', 'dispatching'].includes(state));
    if (state === 'dispatching') journal.claim(ISSUE, RUN);
    if (['succeeded', 'failed', 'cancelled'].includes(state)) journal.transition(ISSUE, { expectedState: 'running', expectedRevision: record.revision, toState: state });
    const before = journal.get(ISSUE);
    assert.throws(() => journal.resumePolling(record.executionId, { now: AT }), { code: 'JOURNAL_POLL_RESUME_NOT_ALLOWED' });
    assert.deepEqual(journal.get(ISSUE), before);
    assert.equal(journal.polling(record.executionId), null);
  }
  const { journal, directory, record } = await fixture(t);
  assert.throws(() => journal.resumePolling(OTHER_COMPANY, { now: AT }), { code: 'JOURNAL_EXECUTION_NOT_FOUND' });
  const other = new ExecutionJournal({ directory, companyId: OTHER_COMPANY });
  try { assert.throws(() => other.resumePolling(record.executionId, { now: AT }), { code: 'JOURNAL_EXECUTION_NOT_FOUND' }); }
  finally { other.close(); }
});

test('unknown submissions need a validated receipt before polling can resume', async t => {
  const { journal, record } = await fixture(t, false);
  journal.claim(ISSUE, RUN);
  journal.markUnknown(ISSUE, RUN, 'DISPATCH_OUTCOME_UNKNOWN');
  assert.throws(() => journal.resumePolling(record.executionId, { now: AT }), { code: 'JOURNAL_POLL_RESUME_NOT_ALLOWED' });
  const known = journal.markUnknown(ISSUE, RUN, 'DISPATCH_OUTCOME_UNKNOWN', receipt);
  const resumed = journal.resumePolling(record.executionId, { now: AT });
  assert.deepEqual(resumed.record, known);
  assert.equal(resumed.record.state, 'unknown');
  assert.equal(resumed.record.attempt, 1);
  assert.equal(journal.listPollable({ now: AT })[0].cloudTaskId, CLOUD);
});
