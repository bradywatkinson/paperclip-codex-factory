import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ExecutionJournal, JOURNAL_FILENAME, JOURNAL_APPLICATION_ID, JOURNAL_MIGRATIONS, reconciliationHandoffBody } from '../lib/execution-journal.mjs';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const ISSUE = '22222222-2222-4222-8222-222222222222';
const RUN = '33333333-3333-4333-8333-333333333333';
const OWNER = '44444444-4444-4444-8444-444444444444';
const PROJECT = '55555555-5555-4555-8555-555555555555';
const OTHER = '66666666-6666-4666-8666-666666666666';
const CLOUD = 'task_e_0123456789abcdef0123456789abcdef';
const AT = '2026-11-02T20:00:00.000Z';
const later = milliseconds => new Date(Date.parse(AT) + milliseconds).toISOString();
const identity = { companyId: COMPANY, paperclipIssueId: ISSUE, paperclipRunId: RUN, projectId: PROJECT, repository: 'fixture/project', environmentId: 'a'.repeat(32), branch: 'main', mode: 'read_only' };
const receipt = { cloudTaskId: CLOUD, emittedUrl: 'https://chatgpt.com/codex/tasks/' + CLOUD, taskUrl: 'https://chatgpt.com/remote/' + CLOUD };
const moduleUrl = new URL('../lib/execution-journal.mjs', import.meta.url).href;
async function fixture(t, active = true) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-reconciliation-journal-'));
  const journal = new ExecutionJournal({ directory, companyId: COMPANY });
  t.after(async () => { journal.close(); await fs.rm(directory, { recursive: true, force: true }); });
  let record = journal.queue(identity);
  if (active) { journal.claim(ISSUE, RUN); record = journal.accept(ISSUE, RUN, receipt); }
  return { directory, journal, record };
}
const claim = (journal, record, at = AT) => journal.claimPoll(record.executionId, { ownerId: OWNER, now: at, leaseMs: 1000 });
function observe(journal, lease, patch = {}) {
  return journal.recordObservation({ executionId: lease.record.executionId, token: lease.token, expectedRevision: lease.record.revision, now: AT, nextPollAt: later(2000), errorCount: 0, observation: { cloudTaskId: CLOUD, status: 'pending', cloudUpdatedAt: AT, observedAt: AT }, ...patch });
}
function ready(journal, record) {
  return observe(journal, claim(journal, record), { toState: 'succeeded', observation: { cloudTaskId: CLOUD, status: 'ready', cloudUpdatedAt: AT, observedAt: AT }, handoff: { mode: 'notify', target: 'in_review', expectedAgentId: OWNER } });
}

test('poll eligibility excludes queued, dispatching and unknown submissions without receipts', async t => {
  const { journal, record } = await fixture(t, false);
  assert.deepEqual(journal.listPollable({ now: AT }), []);
  assert.equal(claim(journal, record), null);
  journal.claim(ISSUE, RUN);
  assert.deepEqual(journal.listPollable({ now: AT }), []);
  journal.recoverInterrupted(ISSUE);
  assert.deepEqual(journal.listPollable({ now: AT }), []);
  assert.equal(claim(journal, record), null);
  const known = journal.markUnknown(ISSUE, RUN, 'DISPATCH_RECORDING_FAILED', receipt);
  assert.equal(journal.listPollable({ now: AT })[0].executionId, known.executionId);
  const result = observe(journal, claim(journal, known), { toState: 'running' });
  assert.equal(result.record.state, 'running');
});

test('poll leases exclude competing handles, expire, and fence stale observers', async t => {
  const { journal, directory, record } = await fixture(t);
  const second = new ExecutionJournal({ directory, companyId: COMPANY });
  t.after(() => second.close());
  const first = claim(journal, record);
  assert.equal(claim(second, record), null);
  assert.deepEqual(second.listPollable({ now: AT }), []);
  const replacement = claim(second, record, later(1000));
  assert.ok(replacement);
  assert.notEqual(first.token, replacement.token);
  assert.throws(() => observe(journal, first, { now: later(1000) }), { code: 'JOURNAL_STALE_POLL_LEASE' });
  observe(second, replacement, { now: later(1000), nextPollAt: later(3000) });
  assert.deepEqual(journal.listPollable({ now: later(2999) }), []);
  assert.equal(journal.listPollable({ now: later(3000) }).length, 1);
});

test('provider requests are rate limited atomically across handles and companies', async t => {
  const { journal, directory } = await fixture(t);
  const second = new ExecutionJournal({ directory, companyId: COMPANY });
  t.after(() => second.close());
  assert.deepEqual(journal.reserveProviderRequest({ now: AT, minIntervalMs: 2000 }), { allowed: true, retryAt: later(2000) });
  assert.deepEqual(second.reserveProviderRequest({ now: AT, minIntervalMs: 1000 }), { allowed: false, retryAt: later(2000) });
  assert.equal(second.reserveProviderRequest({ now: later(2000) }).allowed, true);
  assert.throws(() => journal.reserveProviderRequest({ now: later(4000), minIntervalMs: 999 }));
});

test('ready observation, terminal transition and review handoff commit together across reopen', async t => {
  const { journal, directory, record } = await fixture(t);
  const result = ready(journal, record);
  assert.equal(result.record.state, 'succeeded');
  assert.equal(result.record.revision, record.revision + 1);
  assert.equal(result.handoff.body, reconciliationHandoffBody(result.record));
  assert.ok(result.handoff.body.includes(record.executionId));
  assert.equal(journal.listNonterminal().length, 0);
  const reopened = new ExecutionJournal({ directory, companyId: COMPANY });
  try {
    assert.equal(reopened.pendingHandoffs({ now: AT }).length, 1);
    assert.equal(reopened.observations(record.executionId)[0].status, 'ready');
    assert.equal(reopened.handoffs(record.executionId)[0].id, result.handoff.id);
  } finally { reopened.close(); }
});

test('invalid handoff rolls back observation and execution completion atomically', async t => {
  const { journal, record } = await fixture(t);
  const lease = claim(journal, record);
  assert.throws(() => observe(journal, lease, { toState: 'succeeded', observation: { cloudTaskId: CLOUD, status: 'ready', observedAt: AT }, handoff: { mode: 'notify', target: 'in_review', body: 'Bearer pcp_secret' } }));
  assert.equal(journal.getExecution(record.executionId).state, 'running');
  assert.equal(journal.observations(record.executionId).length, 0);
  assert.equal(journal.handoffs(record.executionId).length, 0);
  assert.ok(journal.polling(record.executionId).leaseExpiresAt);
});

test('stale Cloud timestamps and operator terminal transitions never regress executions', async t => {
  const { journal, record } = await fixture(t);
  observe(journal, claim(journal, record));
  const lease = claim(journal, record, later(2000));
  const stale = observe(journal, lease, { now: later(2000), nextPollAt: later(4000), toState: 'succeeded', observation: { cloudTaskId: CLOUD, status: 'ready', observedAt: later(2000), cloudUpdatedAt: later(-1000) }, handoff: { mode: 'notify', target: 'in_review' } });
  assert.equal(stale.stale, true);
  assert.equal(stale.record.state, 'running');
  assert.equal(journal.handoffs(record.executionId).length, 0);
  assert.equal(journal.polling(record.executionId).cloudUpdatedAt, AT);
  const nextLease = claim(journal, record, later(4000));
  journal.transition(ISSUE, { expectedState: 'running', expectedRevision: record.revision, toState: 'cancelled', errorCode: 'OPERATOR_VERIFIED_CANCELLED' });
  assert.throws(() => observe(journal, nextLease, { now: later(4000), nextPollAt: later(6000) }), { code: 'JOURNAL_STALE_EXECUTION_TRANSITION' });
  assert.equal(journal.get(ISSUE).state, 'cancelled');
});

test('errors retain execution state, bound scheduling, and persist only safe evidence', async t => {
  const { journal, directory, record } = await fixture(t);
  const secret = 'Bearer pcp_board_RECONCILIATION_SECRET';
  const lease = claim(journal, record);
  const result = observe(journal, lease, { errorCount: 1, observation: { cloudTaskId: CLOUD, errorCode: secret, observedAt: AT, stdout: secret, title: secret, summary: null } });
  assert.equal(result.record.state, 'running');
  assert.equal(journal.observations(record.executionId)[0].errorCode, 'UNCLASSIFIED_ERROR');
  assert.equal(journal.polling(record.executionId).errorCount, 1);
  for (const name of await fs.readdir(directory)) if (name.startsWith(JOURNAL_FILENAME)) assert.equal((await fs.readFile(path.join(directory, name))).includes(Buffer.from(secret)), false);
  const next = claim(journal, record, later(2000));
  assert.throws(() => observe(journal, next, { now: later(2000), nextPollAt: later(86402001) }));
  assert.throws(() => observe(journal, next, { now: later(2000), nextPollAt: later(4000), errorCount: 1001 }));
});

test('expired unsent handoffs can retry but ambiguous writes can only be read-reconciled', async t => {
  const { journal, record } = await fixture(t);
  const outbox = ready(journal, record).handoff;
  const options = at => ({ ownerId: OWNER, now: at, leaseMs: 1000 });
  const first = journal.claimHandoff(outbox.id, options(AT));
  assert.equal(first.phase, 'leased');
  assert.equal(journal.claimHandoff(outbox.id, options(AT)), null);
  const retry = journal.claimHandoff(outbox.id, options(later(1000)));
  assert.equal(retry.phase, 'leased');
  assert.throws(() => journal.markHandoffSending(outbox.id, first.token, later(1000)));
  journal.markHandoffSending(outbox.id, retry.token, later(1000));
  const uncertain = journal.claimHandoff(outbox.id, options(later(2000)));
  assert.equal(uncertain.phase, 'sending');
  assert.throws(() => journal.markHandoffSending(outbox.id, uncertain.token, later(2000)));
  assert.throws(() => journal.finishHandoff(outbox.id, { token: uncertain.token, now: later(2000), state: 'pending' }));
  journal.finishHandoff(outbox.id, { token: uncertain.token, now: later(2000), state: 'unknown', errorCode: 'PAPERCLIP_WRITE_UNKNOWN', nextAttemptAt: later(4000) });
  assert.deepEqual(journal.pendingHandoffs({ now: later(3999) }), []);
  const check = journal.claimHandoff(outbox.id, options(later(4000)));
  assert.equal(check.phase, 'unknown');
  journal.finishHandoff(outbox.id, { token: check.token, now: later(4000), state: 'delivered' });
  assert.deepEqual(journal.pendingHandoffs({ now: later(5000) }), []);
  assert.equal(journal.handoffs(record.executionId)[0].state, 'delivered');
});

test('schema-three upgrade adds reconciliation tables without rewriting execution history', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-reconciliation-upgrade-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(directory, JOURNAL_FILENAME));
  for (const sql of JOURNAL_MIGRATIONS.slice(0, 3)) db.exec(sql);
  db.prepare(`INSERT INTO executions(id,company_id,issue_id,attempt,paperclip_run_id,project_id,repository,environment_id,branch,mode,state,cloud_task_id,emitted_url,task_url,created_at,updated_at,dispatched_at,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(OTHER, COMPANY, ISSUE, 1, RUN, PROJECT, identity.repository, identity.environmentId, 'main', 'read_only', 'running', CLOUD, receipt.emittedUrl, receipt.taskUrl, AT, AT, AT, 2);
  db.prepare('INSERT INTO execution_events(execution_id,from_state,to_state,revision,run_id,at) VALUES(?,?,?,?,?,?)').run(OTHER, 'dispatching', 'running', 2, RUN, AT);
  const before = { ...db.prepare('SELECT * FROM executions').get() };
  db.exec('PRAGMA application_id=' + JOURNAL_APPLICATION_ID + '; PRAGMA user_version=3;');
  db.close();
  const journal = new ExecutionJournal({ directory, companyId: COMPANY });
  try {
    assert.equal(journal.db.prepare('PRAGMA user_version').get().user_version, 4);
    assert.deepEqual({ ...journal.db.prepare('SELECT * FROM executions').get() }, before);
    assert.equal(journal.events(ISSUE).length, 1);
    assert.equal(journal.listPollable({ now: AT })[0].executionId, OTHER);
    assert.deepEqual(journal.pendingHandoffs({ now: AT }), []);
  }
  finally { journal.close(); }
});

test('actual competing poller processes obtain one poll lease and one provider reservation', async t => {
  const { directory, record } = await fixture(t);
  const source = `import {ExecutionJournal} from ${JSON.stringify(moduleUrl)};const[d,c,id,owner,at]=process.argv.slice(1);const j=new ExecutionJournal({directory:d,companyId:c});const lease=j.claimPoll(id,{ownerId:owner,now:at,leaseMs:60000});const rate=j.reserveProviderRequest({now:at,minIntervalMs:1000});j.close();console.log(JSON.stringify({claimed:!!lease,allowed:rate.allowed}));`;
  const run = owner => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, directory, COMPANY, record.executionId, owner, AT], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', value => stdout += value); child.stderr.on('data', value => stderr += value);
    child.once('error', reject); child.once('close', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
  const results = await Promise.all([run(OWNER), run(OTHER)]);
  assert.equal(results.filter(result => result.claimed).length, 1);
  assert.equal(results.filter(result => result.allowed).length, 1);
});
