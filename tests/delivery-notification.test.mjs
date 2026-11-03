import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ExecutionJournal } from '../lib/execution-journal.mjs';
import { DeliveryArtifactStore } from '../lib/delivery-artifacts.mjs';
import { summarizeDeliveryPatch } from '../lib/github-delivery.mjs';
import { validateFactoryPolicy, validateRepositoryConfig } from '../lib/repository-config.mjs';
import { configurationHash } from '../lib/repository-registry.mjs';
import { DeliveryNotificationOutbox, renderDeliveryNotification, notifyDeliveryFromPaperclip } from '../lib/delivery-notification.mjs';

const NOW = '2030-01-01T00:00:00.000Z', BASE = 'a'.repeat(40), HEAD = 'b'.repeat(40);
const PATCH = 'diff --git a/value b/value\nnew file mode 100644\nindex 0000000..1234567\n--- /dev/null\n+++ b/value\n@@ -0,0 +1 @@\n+value\n';
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-delivery-notification-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const companyId = randomUUID(), projectId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), agentId = randomUUID(), workspaceId = randomUUID();
  const policy = validateFactoryPolicy(), config = validateRepositoryConfig({ schemaVersion: 1, repository: 'fixture/project', cloud: { environmentId: 'd'.repeat(32) }, commands: { test: { argv: ['node', '--test'] } }, delivery: { requiredChecks: ['unit'] } }, { policy });
  const registration = { repository: config.repository, config, policy, configHash: configurationHash(config), policyHash: configurationHash(policy) };
  const journal = new ExecutionJournal({ directory: path.join(directory, 'journal'), companyId });
  journal.queue({ companyId, projectId, paperclipIssueId: issueId, paperclipRunId: runId, workspaceId, repository: config.repository, environmentId: config.cloud.environmentId, branch: 'main', mode: 'code_change' }); journal.claim(issueId, runId);
  const cloudTaskId = 'task_e_' + 'c'.repeat(32), taskUrl = 'https://chatgpt.com/remote/' + cloudTaskId;
  const accepted = journal.accept(issueId, runId, { cloudTaskId, taskUrl, emittedUrl: taskUrl });
  const execution = journal.transition(issueId, { expectedState: 'running', expectedRevision: accepted.revision, toState: 'succeeded' }); journal.close();
  const summary = summarizeDeliveryPatch(PATCH), result = { schemaVersion: 1, status: 'ready_for_independent_review', association: { executionId: execution.executionId, companyId, projectId, paperclipIssueId: issueId, paperclipRunId: runId, attempt: 1, repository: config.repository, environmentId: config.cloud.environmentId, requestedBranch: 'main', expectedBaseSha: BASE, expectedHeadSha: HEAD, cloudTaskId, cloudTaskUrl: taskUrl, pullRequestNumber: 7, pullRequestUrl: 'https://github.com/fixture/project/pull/7' }, provenance: { comparison: 'exact_complete_text_diff', verified: true, baseSha: BASE, headSha: HEAD, mergeBaseSha: BASE, cloudPatchSha256: summary.sha256, githubPatchSha256: summary.sha256 }, patch: summary, checks: { state: 'passed', required: [{ name: 'unit', state: 'passed', observations: [{ id: 1, source: 'check_run', name: 'unit', state: 'passed', url: 'https://github.com/fixture/project/actions/runs/1' }] }] }, reasons: [], observedAt: NOW };
  const store = new DeliveryArtifactStore({ directory: path.join(directory, 'artifacts') }); store.capturePatch({ patch: PATCH, summary, association: result.association });
  const written = store.recordObservation({ result, context: { configHash: registration.configHash, policyHash: registration.policyHash, journalSchemaVersion: 4, executionRevision: execution.revision } });
  const observation = JSON.parse(fs.readFileSync(written.observationPath));
  const state = { identity: { userId: 'local-board', companyIds: [companyId] }, owner: { id: runId, companyId, agentId, status: 'succeeded', contextSnapshot: { issueId } }, issue: { id: issueId, companyId, projectId, assigneeAgentId: agentId, assigneeUserId: null, status: 'blocked' }, project: { id: projectId, companyId, workspaces: [{ id: workspaceId, companyId, projectId, repoUrl: 'https://github.com/fixture/project', repoRef: 'main' }] }, cards: [], calls: [], send: 'success' };
  const output = value => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
  const run = async (command, args, options) => {
    assert.equal(command, '/fixture/paperclip'); assert.equal(args.at(-1), '--json');
    assert.equal(args[args.indexOf('--api-base') + 1], 'http://127.0.0.1:8100');
    assert.equal(options.env.PAPERCLIP_API_KEY, undefined); assert.equal(options.env.OPENAI_API_KEY, undefined);
    assert.equal(options.timeoutMs, 15000); assert.equal(options.maxOutputBytes, 1_000_000);
    state.calls.push(args);
    if (args[0] === 'whoami') return output(state.identity);
    if (args[0] === 'run') return output(state.owner);
    if (args[0] === 'project') return output(state.project);
    if (args[1] === 'get') return output(state.issue);
    if (args[1] === 'interactions') return output(state.cards);
    assert.equal(args[1], 'interaction:create'); assert.equal(args[2], issueId);
    const payload = JSON.parse(args[args.indexOf('--payload-json') + 1]);
    if (state.send === 'absent') return { code: 1, stdout: '', stderr: 'PRIVATE_PROVIDER_DIAGNOSTIC' };
    const card = { id: randomUUID(), companyId, issueId, createdByUserId: state.identity.userId, createdByAgentId: null, ...payload, payload: { target: { href: payload.payload.target.href, key: payload.payload.target.key, type: 'custom' }, detailsMarkdown: payload.payload.detailsMarkdown, allowDeclineReason: payload.payload.allowDeclineReason, prompt: payload.payload.prompt, version: payload.payload.version } };
    state.cards.push(card);
    if (state.send === 'accepted_unknown') throw new Error('PRIVATE_PROVIDER_DIAGNOSTIC');
    if (state.send === 'wrong_actor') card.createdByUserId = 'another-board';
    return output(card);
  };
  const options = { observation, execution, registration, directory: path.join(directory, 'outbox'), runtime: { paperclipCommand: '/fixture/paperclip', apiBase: 'http://127.0.0.1:8100' }, run, now: () => NOW, env: { HOME: '/fixture', PAPERCLIP_API_KEY: 'PRIVATE_BEARER', OPENAI_API_KEY: 'PRIVATE_PROVIDER_KEY' } };
  return { directory, execution, registration, observation, state, options, invoke: overrides => notifyDeliveryFromPaperclip({ ...options, ...overrides }) };
}

test('a ready delivery creates an informational native card with PR/CI/Cloud links and no agent continuation', async t => {
  const f = fixture(t), output = await f.invoke(); assert.equal(output.status, 'notified'); assert.equal(output.humanApprovalEligible, false);
  const card = f.state.cards[0]; assert.equal(card.kind, 'request_confirmation'); assert.equal(card.resolverPolicy, 'human_only'); assert.equal(card.continuationPolicy, 'none'); assert.equal(card.addresseeAgentId, undefined);
  assert.ok(card.payload.target.key.length <= 120, 'native requestConfirmationCustomTargetSchema bounds custom keys to 120 characters');
  assert.match(card.payload.target.key, /^factory-delivery:[a-f0-9]{64}$/);
  assert.match(card.payload.detailsMarkdown, /Ready for independent review/); assert.match(card.payload.detailsMarkdown, /Verified PR/); assert.match(card.payload.detailsMarkdown, /actions\/runs\/1/); assert.match(card.payload.detailsMarkdown, /does not approve/);
  assert.equal(f.state.issue.status, 'blocked'); assert.equal(f.state.calls.some(args => args.includes('wake') || args.includes('update') || args.includes('comment')), false);
  assert.equal(fs.statSync(path.join(f.options.directory, 'delivery-notifications.sqlite')).mode & 0o777, 0o600);
});

test('fresh observation timestamps and UUIDs do not create duplicate cards for unchanged meaningful CI status', async t => {
  const f = fixture(t); await f.invoke();
  const observation = structuredClone(f.observation); observation.observationId = randomUUID(); observation.observedAt = observation.delivery.observedAt = '2030-01-01T00:00:01.000Z';
  assert.equal((await f.invoke({ observation, now: () => observation.observedAt })).status, 'already_notified'); assert.equal(f.state.cards.length, 1);
  observation.delivery.checks.state = 'failed'; observation.delivery.checks.required[0].state = 'failed'; observation.delivery.status = 'needs_attention'; observation.delivery.reasons = ['CI_FAILED'];
  assert.equal((await f.invoke({ observation, now: () => observation.observedAt })).status, 'notified'); assert.equal(f.state.cards.length, 2);
  assert.match(f.state.cards[1].payload.detailsMarkdown, /CI_FAILED/); assert.match(f.state.cards[1].payload.detailsMarkdown, /Open the failing check/);
});

test('pending CI, missing PR and unverifiable candidate provenance cannot be projected as ready or approved', t => {
  const f = fixture(t), pending = structuredClone(f.observation); pending.delivery.checks.state = 'pending'; pending.delivery.checks.required[0].state = 'pending'; pending.delivery.reasons = ['CI_PENDING'];
  assert.equal(renderDeliveryNotification({ observation: pending, execution: f.execution }).status, 'needs_attention');
  const missing = structuredClone(f.observation); delete missing.delivery.association.pullRequestNumber; delete missing.delivery.association.pullRequestUrl; delete missing.delivery.association.expectedHeadSha; missing.delivery.provenance = { verified: false }; missing.delivery.status = 'patch_fallback'; missing.delivery.reasons = ['PULL_REQUEST_NOT_PROVIDED'];
  const fallback = renderDeliveryNotification({ observation: missing, execution: f.execution }); assert.equal(fallback.status, 'needs_attention'); assert.match(fallback.payload.payload.detailsMarkdown, /publish the patch manually/);
  missing.delivery.checks = { state: 'unverified', required: [] };
  assert.match(renderDeliveryNotification({ observation: missing, execution: f.execution, registration: f.registration }).payload.payload.detailsMarkdown, /unit: unverified/);
  const candidate = structuredClone(f.observation); candidate.delivery.provenance.verified = false;
  const rendered = renderDeliveryNotification({ observation: candidate, execution: f.execution }); assert.equal(rendered.status, 'needs_attention'); assert.match(rendered.payload.payload.detailsMarkdown, /Unverified PR candidate/); assert.doesNotMatch(rendered.payload.payload.detailsMarkdown, /Ready for independent review/);
});

test('UI projection escapes names and omits secret-bearing links, raw diagnostics, patches and private artifact paths', t => {
  const f = fixture(t), observation = structuredClone(f.observation), check = observation.delivery.checks.required[0];
  check.name = 'unit]\n[evil](https://example.invalid)'; check.observations.push(...['https://example.invalid/job?token=PRIVATE_TOKEN', 'https://user:PRIVATE_TOKEN@example.invalid/job', 'http://example.invalid', 'https://example.invalid/a)'].map(url => ({ url })));
  observation.delivery.reasons = ['PRIVATE_PROVIDER_DIAGNOSTIC\n/private/key', 'CI_PENDING']; observation.delivery.raw = 'PRIVATE_PROVIDER_DIAGNOSTIC';
  const text = renderDeliveryNotification({ observation, execution: f.execution }).payload.payload.detailsMarkdown;
  assert.match(text, /unit\\\]/); assert.doesNotMatch(text, /PRIVATE_TOKEN|PRIVATE_PROVIDER_DIAGNOSTIC|\/private\/key|export const|\.patch|observations\//);
});

test('48 configured 200-byte Markdown names cannot exceed the native details limit or create a send intent', async t => {
  const f = fixture(t), observation = structuredClone(f.observation);
  observation.delivery.checks.required = Array.from({ length: 48 }, (_, index) => ({ name: '*'.repeat(197) + String(index).padStart(3, '0'), state: 'passed', observations: [] }));
  assert.ok(observation.delivery.checks.required.every(row => Buffer.byteLength(row.name) === 200));
  assert.throws(() => renderDeliveryNotification({ observation, execution: f.execution }), { code: 'DELIVERY_NOTIFICATION_TOO_LARGE' });
  await assert.rejects(f.invoke({ observation }), { code: 'DELIVERY_NOTIFICATION_TOO_LARGE' });
  assert.equal(f.state.calls.length, 0);
  assert.equal(fs.existsSync(f.options.directory), false);
});

test('terminal, reassigned and changed project bindings skip without native mutation', async t => {
  for (const mutation of [f => { f.state.issue.status = 'done'; }, f => { f.state.issue.assigneeAgentId = randomUUID(); }, f => { f.state.issue.assigneeUserId = 'local-board'; }, f => { f.state.project.workspaces[0].repoRef = 'other'; }]) {
    const f = fixture(t); mutation(f); assert.equal((await f.invoke()).status, 'skipped'); assert.equal(f.state.cards.length, 0); assert.equal(f.state.calls.some(args => args[1] === 'interaction:create'), false);
  }
  const active = fixture(t); active.state.owner.status = 'running'; assert.equal((await active.invoke()).status, 'deferred'); assert.equal(active.state.cards.length, 0);
});

test('unknown accepted create is recovered by reads using native-normalized payload order without another POST', async t => {
  const f = fixture(t); f.state.send = 'accepted_unknown'; assert.equal((await f.invoke()).status, 'notification_unknown');
  assert.equal((await f.invoke()).status, 'notified'); assert.equal(f.state.cards.length, 1); assert.equal(f.state.calls.filter(args => args[1] === 'interaction:create').length, 1);
});

test('an absent ambiguous write remains sticky across restarts and no amount of read recovery authorizes retry', async t => {
  const f = fixture(t); f.state.send = 'absent';
  for (let pass = 0; pass < 3; pass++) assert.equal((await f.invoke()).status, 'notification_unknown');
  assert.equal(f.state.calls.filter(args => args[1] === 'interaction:create').length, 1); assert.equal(f.state.cards.length, 0);
});

test('competing notifiers cannot resend while the first native create is still in flight', async t => {
  const f = fixture(t); let arrived, release;
  const beforePost = new Promise(resolve => { arrived = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const run = async (command, args, options) => {
    if (args[1] === 'interaction:create') {
      const payload = JSON.parse(args[args.indexOf('--payload-json') + 1]);
      const outbox = new DeliveryNotificationOutbox({ directory: f.options.directory });
      try { const record = outbox.get(payload.idempotencyKey); assert.equal(record.state, 'sending'); assert.ok(record.token); } finally { outbox.close(); }
      arrived(); await gate;
    }
    return f.options.run(command, args, options);
  };
  const first = f.invoke({ run }); await beforePost;
  try { assert.equal((await f.invoke()).status, 'notification_unknown'); } finally { release(); }
  assert.equal((await first).status, 'notification_unknown');
  assert.equal((await f.invoke()).status, 'notified');
  assert.equal(f.state.calls.filter(args => args[1] === 'interaction:create').length, 1);
});

test('recovery rejects wrong Board creator or changed native nested payload', async t => {
  const f = fixture(t); f.state.send = 'wrong_actor'; assert.equal((await f.invoke()).status, 'notification_unknown'); assert.equal((await f.invoke()).status, 'notification_unknown');
  f.state.cards[0].createdByUserId = 'local-board'; f.state.cards[0].payload.target.href = 'https://example.invalid/changed';
  assert.equal((await f.invoke()).status, 'notification_unknown'); assert.equal(f.state.calls.filter(args => args[1] === 'interaction:create').length, 1);
});

test('outbox claims and revisions fence concurrent SQLite handles and preserve non-expiring send intents', t => {
  const f = fixture(t), first = new DeliveryNotificationOutbox({ directory: f.options.directory }), second = new DeliveryNotificationOutbox({ directory: f.options.directory });
  try {
    const rendered = renderDeliveryNotification({ observation: f.observation, execution: f.execution }), args = { key: rendered.key, binding: { actor: 'local-board' }, payload: rendered.payload, now: NOW };
    const a = first.claim(args), b = second.claim(args); assert.equal(a.created, true); assert.equal(b.created, false); assert.equal(a.record.token, b.record.token);
    const unknown = second.update(b.record, { state: 'unknown', now: NOW }); assert.throws(() => first.update(a.record, { state: 'delivered', interactionId: randomUUID(), now: NOW }), { code: 'DELIVERY_NOTIFICATION_STALE' });
    assert.equal(first.claim(args).created, false); assert.equal(first.get(rendered.key).state, 'unknown');
    const delivered = first.update(unknown, { state: 'delivered', interactionId: randomUUID(), now: NOW }); assert.equal(second.get(rendered.key).interactionId, delivered.interactionId);
    assert.throws(() => second.claim({ ...args, binding: { actor: 'another-board' } }), { code: 'DELIVERY_NOTIFICATION_BINDING_CHANGED' });
  } finally { first.close(); second.close(); }
});

test('native identity, original run, actual journal and registration proof are required before any native write', async t => {
  const f = fixture(t), changed = structuredClone(f.observation); changed.context.configHash = 'f'.repeat(64);
  await assert.rejects(f.invoke({ observation: changed }), { code: 'DELIVERY_NOTIFICATION_REGISTRATION_CHANGED' }); assert.equal(f.state.calls.length, 0);
  f.state.owner.contextSnapshot.issueId = randomUUID(); await assert.rejects(f.invoke(), { code: 'DELIVERY_NOTIFICATION_RUN_CHANGED' });
  assert.equal(f.state.calls.some(args => args[1] === 'interaction:create'), false);
  await assert.rejects(f.invoke({ runtime: { ...f.options.runtime, apiBase: 'https://example.invalid' } }), { code: 'DELIVERY_NOTIFICATION_INVALID_ORIGIN' });
});
