import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ExecutionJournal } from '../lib/execution-journal.mjs';
import { recoverOnce } from '../lib/controller-recovery.mjs';

async function assertPrivateFixtureBytes(directory, forbidden) {
  const pending = [{ directory, depth: 0 }]; let entries = 0;
  while (pending.length) {
    const current = pending.pop(); assert.ok(current.depth <= 16, 'Fixture scan must remain bounded');
    for (const name of await fs.readdir(current.directory)) {
      assert.ok(++entries <= 1000, 'Fixture scan must remain bounded');
      const filename = path.join(current.directory, name), stat = await fs.lstat(filename);
      assert.equal(stat.isSymbolicLink(), false, 'Privacy fixture must not redirect its scan');
      if (stat.isDirectory()) pending.push({ directory: filename, depth: current.depth + 1 });
      else {
        assert.equal(stat.isFile(), true, 'Every non-directory fixture entry must be inspected');
        assert.equal((await fs.readFile(filename)).includes(Buffer.from(forbidden)), false);
      }
    }
  }
}

const uuid = n => { const hex = n.toString(16).padStart(32, '0'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`; };
const COMPANY = uuid(1), PROJECT = uuid(4), AGENT = uuid(5), WORKSPACE = uuid(6), USER = uuid(7), OWNER = uuid(8);
const NOW = '2030-01-02T00:00:00.000Z';
const later = ms => new Date(Date.parse(NOW) + ms).toISOString();
const RESULT = { code: 0, stdout: '', stderr: '', signal: null, timedOut: false, outputExceeded: false, failedToStart: false };
const json = value => ({ ...RESULT, stdout: JSON.stringify(value) });
function add(journal, { n = 1, state = 'running', cloud = true } = {}) {
  const identity = { companyId: COMPANY, paperclipIssueId: uuid(100 + n), paperclipRunId: uuid(200 + n), projectId: PROJECT, workspaceId: WORKSPACE, repository: 'fixture/project', environmentId: 'a'.repeat(32), branch: 'main', mode: 'read_only' };
  const cloudTaskId = 'task_e_' + n.toString(16).padStart(32, '0');
  const receipt = { cloudTaskId, emittedUrl: 'https://chatgpt.com/codex/tasks/' + cloudTaskId, taskUrl: 'https://chatgpt.com/remote/' + cloudTaskId };
  let record = journal.queue(identity);
  if (state === 'queued') return record;
  record = journal.claim(identity.paperclipIssueId, identity.paperclipRunId).record;
  if (state === 'dispatching') return record;
  if (state === 'unknown') return journal.markUnknown(identity.paperclipIssueId, identity.paperclipRunId, 'DISPATCH_OUTCOME_UNKNOWN', cloud ? receipt : undefined);
  return journal.accept(identity.paperclipIssueId, identity.paperclipRunId, receipt);
}
async function setup(t, configPatch = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-controller-recovery-'));
  const journal = new ExecutionJournal({ directory, companyId: COMPANY });
  t.after(async () => { journal.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { journal, config: { schemaVersion: 1, companyId: COMPANY, stateDir: directory, codexCommand: '/fixture/codex', paperclipCommand: '/fixture/paperclip', ...configPatch } };
}
function cli(journal, options = {}) {
  const calls = [], cards = [];
  const run = async (command, args, commandOptions) => {
    calls.push({ command, args, options: commandOptions });
    if (args[0] === '--version') return { ...RESULT, stdout: 'codex-cli 0.166.0\n' };
    if (args[0] === 'login') return { ...RESULT, stderr: 'Logged in using ChatGPT\n' };
    if (args[0] === 'cloud' && args[1] === 'list') {
      if (options.providerResult) return options.providerResult;
      return json({ tasks: journal.list().filter(r => r.cloudTaskId).map(r => ({ id: r.cloudTaskId, url: r.emittedUrl, status: options.remoteStatus ?? 'pending', updated_at: '2030-01-01T23:59:00Z', environment_id: null, summary: { files_changed: 0, lines_added: 0, lines_removed: 0 } })), cursor: null });
    }
    if (args[0] === 'whoami') return json({ userId: USER, companyIds: [COMPANY] });
    if (args[0] === 'run' && args[1] === 'get') {
      if (options.ownerUnavailable) return { ...RESULT, code: 1, stderr: 'INERT_PRIVATE_ERROR' };
      const record = journal.list().find(r => r.paperclipRunId === args[2]);
      const value = { id: record.paperclipRunId, companyId: COMPANY, agentId: AGENT, status: options.ownerStatus ?? 'succeeded', contextSnapshot: { issueId: record.paperclipIssueId }, ...options.ownerPatch };
      if (options.beforeOwnerReturn) await options.beforeOwnerReturn(record, value);
      return json(value);
    }
    if (args[0] === 'issue' && args[1] === 'get') {
      const record = journal.list().find(r => r.paperclipIssueId === args[2]);
      return json({ id: record.paperclipIssueId, companyId: COMPANY, projectId: PROJECT, projectWorkspaceId: WORKSPACE, assigneeAgentId: AGENT, status: 'blocked' });
    }
    if (args[0] === 'project' && args[1] === 'get') return json({ id: PROJECT, companyId: COMPANY, workspaces: [{ id: WORKSPACE, companyId: COMPANY, projectId: PROJECT, repoUrl: 'https://github.com/fixture/project.git', repoRef: 'main', isPrimary: true }] });
    if (args[0] === 'issue' && args[1] === 'interactions') return json(cards);
    if (args[0] === 'issue' && args[1] === 'interaction:create') {
      const payload = JSON.parse(args[args.indexOf('--payload-json') + 1]);
      const card = { ...payload, id: uuid(900), companyId: COMPANY, issueId: args[2], createdByUserId: USER, createdByAgentId: null };
      cards.push(card); return json(card);
    }
    throw new Error('Unexpected inert command: ' + JSON.stringify(args));
  };
  return { run, calls, cards };
}
function invoke(context, f, options = {}) {
  let at = Date.parse(options.at ?? NOW);
  return recoverOnce({ config: context.config, journal: context.journal, run: f.run, now: () => new Date(at).toISOString(), sleep: async ms => { at += ms; }, env: {}, ...options });
}
const providerCalls = f => f.calls.filter(c => c.args[0] === 'cloud');
const ownerCalls = f => f.calls.filter(c => c.args[0] === 'run');

test('startup classifies every queued and indeterminate no-ID submission without dispatching', async t => {
  const context = await setup(t, { maxRecords: 1 });
  const queued = add(context.journal, { n: 1, state: 'queued' });
  const unknown = add(context.journal, { n: 2, state: 'unknown', cloud: false });
  const f = cli(context.journal);
  const result = await invoke(context, f);
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.recovery.scanned, 2);
  const reasons = new Map(result.recovery.needsAttention.map(r => [r.executionId, r.reason]));
  assert.equal(reasons.get(queued.executionId), 'queued_not_submitted');
  assert.equal(reasons.get(unknown.executionId), 'submission_outcome_unknown');
  assert.equal(context.journal.getExecution(queued.executionId).state, 'queued');
  assert.equal(context.journal.getExecution(unknown.executionId).state, 'unknown');
  assert.equal(f.calls.length, 0);
});

for (const ownerStatus of ['succeeded', 'failed', 'cancelled', 'timed_out']) test('a confirmed ' + ownerStatus + ' dispatch owner leaves one unknown submission for investigation', async t => {
  const context = await setup(t), record = add(context.journal, { state: 'dispatching' }), f = cli(context.journal, { ownerStatus });
  const first = await invoke(context, f);
  assert.equal(first.recovery.interrupted, 1);
  const recovered = context.journal.getExecution(record.executionId);
  assert.equal(recovered.state, 'unknown');
  assert.equal(recovered.errorCode, 'INTERRUPTED_DISPATCH');
  assert.equal(first.recovery.needsAttention.find(r => r.executionId === record.executionId).reason, 'submission_outcome_unknown');
  const revision = recovered.revision;
  await invoke(context, f);
  assert.equal(context.journal.getExecution(record.executionId).revision, revision);
  assert.equal(ownerCalls(f).length, 1);
  assert.equal(providerCalls(f).length, 0);
});

for (const ownerStatus of ['queued', 'running']) test('an active ' + ownerStatus + ' dispatch owner is never stolen at startup', async t => {
  const context = await setup(t), record = add(context.journal, { state: 'dispatching' }), f = cli(context.journal, { ownerStatus });
  const result = await invoke(context, f);
  assert.equal(result.recovery.waiting, 1);
  assert.equal(result.recovery.interrupted, 0);
  assert.equal(result.status, 'recovering');
  assert.equal(context.journal.getExecution(record.executionId).state, 'dispatching');
  assert.equal(context.journal.getExecution(record.executionId).revision, record.revision);
});

test('an unavailable owner is visible without persisting raw CLI errors or changing the dispatch claim', async t => {
  const context = await setup(t), record = add(context.journal, { state: 'dispatching' }), f = cli(context.journal, { ownerUnavailable: true });
  const result = await invoke(context, f);
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.recovery.needsAttention.find(r => r.executionId === record.executionId).reason, 'owner_unavailable');
  assert.equal(context.journal.getExecution(record.executionId).state, 'dispatching');
  assert.equal(JSON.stringify(result).includes('INERT_PRIVATE_ERROR'), false);
});

for (const ownerPatch of [{ id: uuid(999) }, { companyId: uuid(999) }, { agentId: 'not-an-agent-id' }, { contextSnapshot: { issueId: uuid(999) } }]) test('an owner scope mismatch cannot recover an unrelated dispatch: ' + Object.keys(ownerPatch)[0], async t => {
  const context = await setup(t), record = add(context.journal, { state: 'dispatching' }), f = cli(context.journal, { ownerPatch });
  const result = await invoke(context, f);
  assert.equal(result.recovery.needsAttention.find(r => r.executionId === record.executionId).reason, 'owner_scope_mismatch');
  assert.equal(context.journal.getExecution(record.executionId).state, 'dispatching');
});

test('startup owner checks rotate so a waiting first dispatch cannot starve later claims', async t => {
  const context = await setup(t, { maxRecords: 1 });
  const first = add(context.journal, { n: 1, state: 'dispatching' }), second = add(context.journal, { n: 2, state: 'dispatching' });
  const f = cli(context.journal, { ownerStatus: 'running' });
  const initial = await invoke(context, f);
  assert.equal(initial.recovery.scanned, 2);
  assert.equal(initial.recovery.deferred, 1);
  await invoke(context, f, { recoveryCursor: initial.recoveryCursor });
  assert.deepEqual(new Set(ownerCalls(f).map(call => call.args[2])), new Set([first.paperclipRunId, second.paperclipRunId]));
});

test('owner verification cannot overwrite a concurrently advanced dispatch revision', async t => {
  const context = await setup(t), record = add(context.journal, { state: 'dispatching' });
  const f = cli(context.journal, { beforeOwnerReturn: current => {
    const cloudTaskId = 'task_e_' + 'f'.repeat(32);
    context.journal.accept(current.paperclipIssueId, current.paperclipRunId, { cloudTaskId, emittedUrl: 'https://chatgpt.com/codex/tasks/' + cloudTaskId, taskUrl: 'https://chatgpt.com/remote/' + cloudTaskId });
  } });
  await invoke(context, f);
  assert.equal(context.journal.getExecution(record.executionId).state, 'running');
  assert.equal(context.journal.getExecution(record.executionId).cloudTaskId, 'task_e_' + 'f'.repeat(32));
  assert.equal(context.journal.events(record.paperclipIssueId).some(event => event.to_state === 'unknown'), false);
});

test('startup resumes a known Cloud receipt to READY and sends exactly one review card', async t => {
  const context = await setup(t), record = add(context.journal), f = cli(context.journal, { remoteStatus: 'ready' });
  const result = await invoke(context, f);
  assert.equal(result.reconciliation.ready, 1);
  assert.equal(result.reconciliation.notified, 1);
  assert.equal(context.journal.getExecution(record.executionId).cloudTaskId, record.cloudTaskId);
  assert.equal(context.journal.getExecution(record.executionId).state, 'succeeded');
  assert.equal(f.cards.length, 1);
  await invoke(context, f, { at: later(60000) });
  assert.equal(f.cards.length, 1);
  assert.equal(providerCalls(f).length, 1);
  assert.equal(f.calls.some(call => call.args.includes('exec')), false);
});

test('startup preserves active poll leases and future schedules', async t => {
  const context = await setup(t), record = add(context.journal), f = cli(context.journal);
  const lease = context.journal.claimPoll(record.executionId, { ownerId: OWNER, now: NOW, leaseMs: 60000 });
  await invoke(context, f);
  assert.equal(providerCalls(f).length, 0);
  assert.equal(context.journal.polling(record.executionId).leaseExpiresAt, lease.expiresAt);
  context.journal.recordObservation({ executionId: record.executionId, token: lease.token, expectedRevision: record.revision, now: NOW, nextPollAt: later(300000), errorCount: 1, observation: { cloudTaskId: record.cloudTaskId, errorCode: 'CLOUD_CLI_FAILED' } });
  await invoke(context, f);
  assert.equal(providerCalls(f).length, 0);
  assert.equal(context.journal.polling(record.executionId).nextPollAt, later(300000));
});

test('an expired poll lease is safely reclaimed after restart without resubmission', async t => {
  const context = await setup(t), record = add(context.journal), f = cli(context.journal, { remoteStatus: 'ready' });
  context.journal.claimPoll(record.executionId, { ownerId: OWNER, now: NOW, leaseMs: 1000 });
  const result = await invoke(context, f, { at: later(1000) });
  assert.equal(result.reconciliation.ready, 1);
  assert.equal(context.journal.getExecution(record.executionId).cloudTaskId, record.cloudTaskId);
  assert.equal(f.calls.some(call => call.args.includes('exec')), false);
});

test('a persisted retry ceiling remains needs-attention without polling until explicitly resumed', async t => {
  const context = await setup(t, { maxPollErrors: 2 }), record = add(context.journal), f = cli(context.journal);
  const lease = context.journal.claimPoll(record.executionId, { ownerId: OWNER, now: NOW, leaseMs: 1000 });
  context.journal.recordObservation({ executionId: record.executionId, token: lease.token, expectedRevision: record.revision, now: NOW, nextPollAt: later(1000), errorCount: 2, observation: { cloudTaskId: record.cloudTaskId, errorCode: 'CLOUD_CLI_FAILED' } });
  const result = await invoke(context, f, { at: later(2000) });
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.recovery.needsAttention.find(r => r.executionId === record.executionId).reason, 'poll_retry_limit');
  assert.equal(providerCalls(f).length, 0);
  context.journal.resumePolling(record.executionId, { now: later(3000) });
  await invoke(context, f, { at: later(3000) });
  assert.equal(providerCalls(f).length, 1);
  assert.equal(context.journal.getExecution(record.executionId).cloudTaskId, record.cloudTaskId);
});

test('persisted company cooldown survives restart and does not block recovery or invoke the provider', async t => {
  const context = await setup(t), record = add(context.journal), f = cli(context.journal);
  context.journal.deferProviderRequests({ now: NOW, delayMs: 900000 });
  const result = await invoke(context, f);
  assert.equal(result.status, 'recovering');
  assert.equal(result.reconciliation.providerRetryAt, later(900000));
  assert.equal(providerCalls(f).length, 0);
  assert.equal(context.journal.getExecution(record.executionId).state, 'running');
  assert.equal(context.journal.providerRequestLimit().retryAt, later(900000));
});

test('synthetic quota failure defers the entire company without persisting raw stderr or hammering other executions', async t => {
  const context = await setup(t), first = add(context.journal, { n: 1 }), second = add(context.journal, { n: 2 });
  const secret = 'Bearer INERT_PRIVATE_QUOTA_DETAIL';
  const f = cli(context.journal, { providerResult: { ...RESULT, code: 1, stderr: 'HTTP 429 Too Many Requests: usage_limit_reached ' + secret } });
  const result = await invoke(context, f);
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.reconciliation.polled, 1);
  assert.equal(providerCalls(f).length, 1);
  const observations = [first, second].flatMap(record => context.journal.observations(record.executionId));
  assert.equal(observations.length, 1);
  assert.equal(observations[0].errorCode, 'CLOUD_USAGE_LIMIT');
  assert.equal(observations[0].errorCount, 1);
  const limit = context.journal.providerRequestLimit();
  assert.ok(limit.retryAt >= later(900000));
  assert.equal(result.reconciliation.providerRetryAt, limit.retryAt);
  const calls = f.calls.length;
  const restarted = await invoke(context, f, { at: later(60000) });
  assert.equal(restarted.status, 'recovering');
  assert.equal(f.calls.length, calls, 'A restart must respect durable company cooldown without another subprocess');
  for (const record of [first, second]) assert.equal(context.journal.getExecution(record.executionId).state, 'running');
  await assertPrivateFixtureBytes(context.journal.directory, secret);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('a company cooldown does not prevent delivery of an already durable READY handoff', async t => {
  const context = await setup(t), record = add(context.journal), f = cli(context.journal, { remoteStatus: 'ready', ownerStatus: 'running' });
  await invoke(context, f);
  assert.equal(context.journal.handoffs(record.executionId)[0].state, 'pending');
  context.journal.deferProviderRequests({ now: later(60000), delayMs: 900000 });
  const delivery = cli(context.journal);
  const result = await invoke(context, delivery, { at: later(60000) });
  assert.equal(result.reconciliation.notified, 1);
  assert.equal(delivery.cards.length, 1);
  assert.equal(providerCalls(delivery).length, 0);
  assert.equal(context.journal.handoffs(record.executionId)[0].state, 'delivered');
});

test('paused first records cannot starve later due known executions under a bounded batch', async t => {
  const context = await setup(t, { maxRecords: 1, maxPollErrors: 2 });
  const paused = add(context.journal, { n: 1 }), due = add(context.journal, { n: 2 });
  const lease = context.journal.claimPoll(paused.executionId, { ownerId: OWNER, now: NOW, leaseMs: 1000 });
  context.journal.recordObservation({ executionId: paused.executionId, token: lease.token, expectedRevision: paused.revision, now: NOW, nextPollAt: later(1000), errorCount: 2, observation: { cloudTaskId: paused.cloudTaskId, errorCode: 'CLOUD_CLI_FAILED' } });
  const f = cli(context.journal, { remoteStatus: 'ready' });
  const result = await invoke(context, f, { at: later(1000) });
  assert.equal(result.reconciliation.ready, 1);
  assert.equal(context.journal.getExecution(due.executionId).state, 'succeeded');
  assert.equal(context.journal.getExecution(paused.executionId).state, 'running');
  assert.equal(context.journal.polling(paused.executionId).errorCount, 2);
  assert.equal(result.recovery.needsAttention.find(row => row.executionId === paused.executionId).reason, 'poll_retry_limit');
});

test('a crashed uncertain notification remains needs-attention across later startup passes and is never resent', async t => {
  const context = await setup(t), record = add(context.journal), f = cli(context.journal);
  const lease = context.journal.claimPoll(record.executionId, { ownerId: OWNER, now: NOW, leaseMs: 1000 });
  const ready = context.journal.recordObservation({ executionId: record.executionId, token: lease.token, expectedRevision: record.revision, now: NOW, nextPollAt: later(30000), observation: { cloudTaskId: record.cloudTaskId, status: 'ready', cloudUpdatedAt: NOW }, toState: 'succeeded', handoff: { mode: 'notify', target: 'in_review' } });
  const send = context.journal.claimHandoff(ready.handoff.id, { ownerId: OWNER, now: NOW, leaseMs: 1000 });
  context.journal.markHandoffSending(ready.handoff.id, send.token, NOW);
  const recovered = await invoke(context, f, { at: later(2000) });
  assert.equal(recovered.status, 'needs_attention');
  assert.equal(recovered.recovery.needsAttention.find(row => row.executionId === record.executionId).reason, 'notification_outcome_unknown');
  assert.equal(context.journal.handoffs(record.executionId)[0].state, 'unknown');
  const calls = f.calls.length;
  const restarted = await invoke(context, f, { at: later(3000) });
  assert.equal(restarted.status, 'needs_attention', 'The unknown delivery must stay visible while its retry is deferred');
  assert.equal(f.calls.length, calls);
  assert.equal(f.cards.length, 0);
  assert.equal(providerCalls(f).length, 0);
});
