import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ReviewPipeline } from '../lib/review-pipeline.mjs';
import { DeliveryArtifactStore } from '../lib/delivery-artifacts.mjs';
import { summarizeDeliveryPatch, inspectRepairGitHubDelivery } from '../lib/github-delivery.mjs';
import { configurationHash } from '../lib/repository-registry.mjs';
import { validateFactoryPolicy, validateRepositoryConfig } from '../lib/repository-config.mjs';
import { ExecutionJournal } from '../lib/execution-journal.mjs';
import { reviewArtifactPath } from '../lib/review-artifact.mjs';

const NOW = '2030-01-01T00:00:00.000Z', BASE = 'a'.repeat(40), HEAD = 'b'.repeat(40);
const COMPANY = randomUUID(), PROJECT = randomUUID(), IMPLEMENTER = randomUUID(), REVIEWER = randomUUID(), QA = randomUUID(), USER = randomUUID();
const PATCH = 'diff --git a/src/value.mjs b/src/value.mjs\nnew file mode 100644\nindex 0000000..1234567\n--- /dev/null\n+++ b/src/value.mjs\n@@ -0,0 +1 @@\n+export const value = 1;\n';
function fixture(t, seedOptions = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-review-pipeline-'));
  const pipeline = new ReviewPipeline({ directory: path.join(directory, 'pipeline') });
  const policy = validateFactoryPolicy(), config = validateRepositoryConfig({ schemaVersion: 1, repository: 'fixture/project', cloud: { environmentId: 'a'.repeat(32) }, commands: { test: { argv: ['node', '--test'] } }, delivery: { requiredChecks: ['unit'] } }, { policy });
  const registration = { repository: config.repository, config, policy, configHash: configurationHash(config), policyHash: configurationHash(policy) };
  let next = 1;
  const observe = ({ head = HEAD, executionId = randomUUID(), cloudTaskId = 'task_e_' + 'c'.repeat(32), issueId = randomUUID(), runId = randomUUID(), patch = PATCH, now = NOW } = {}) => {
    const summary = summarizeDeliveryPatch(patch);
    const result = { schemaVersion: 1, status: 'ready_for_independent_review', association: { executionId, companyId: COMPANY, paperclipIssueId: issueId, paperclipRunId: runId, projectId: PROJECT, attempt: 1, cloudTaskId, cloudTaskUrl: 'https://chatgpt.com/remote/' + cloudTaskId, repository: config.repository, environmentId: config.cloud.environmentId, requestedBranch: 'main', expectedBaseSha: BASE, expectedHeadSha: head, pullRequestNumber: 7, pullRequestUrl: 'https://github.com/fixture/project/pull/7' }, provenance: { verified: true, cloudPatchSha256: summary.sha256, githubPatchSha256: summary.sha256, baseSha: BASE, headSha: head, mergeBaseSha: BASE, comparison: 'exact_complete_text_diff' }, checks: { state: 'passed', required: [{ name: 'unit', state: 'passed', observations: [{ name: 'unit', state: 'passed', source: 'check_run', id: 23, status: 'completed', conclusion: 'success', url: 'https://github.com/fixture/project/actions/runs/23', appId: 15368 }] }] }, patch: summary, reasons: [], humanApprovalEligible: false, requiresFreshInspection: true, observedAt: now };
    const artifacts = new DeliveryArtifactStore({ directory: path.join(directory, 'delivery') });
    artifacts.capturePatch({ patch, summary, association: result.association });
    const written = artifacts.recordObservation({ result, context: { configHash: registration.configHash, policyHash: registration.policyHash, journalSchemaVersion: 4, executionRevision: 2 } });
    return JSON.parse(fs.readFileSync(written.observationPath, 'utf8'));
  };
  const source = observe();
  const seed = options => pipeline.seed({ observation: source, patch: PATCH, registration, implementationAgentId: IMPLEMENTER, testCheckNames: ['unit'], now: NOW, ...seedOptions, ...options });
  const start = (job, options = {}) => {
    const a = job.source.delivery.association, agentId = job.role === 'reviewer' ? REVIEWER : job.role === 'qa' ? QA : IMPLEMENTER;
    const mode = job.role === 'reviewer' ? 'provided_patch_on_base' : 'exact_head';
    const expectedSha = mode === 'provided_patch_on_base' ? a.expectedBaseSha : a.expectedHeadSha;
    const branch = mode === 'provided_patch_on_base' ? 'main' : 'feature/review-head', workspaceId = randomUUID();
    const checkout = { mode, expectedSha, branch, workspaceId, branchObservation: { name: branch, commit: { sha: expectedSha } } };
    const payload = { companyId: COMPANY, projectId: PROJECT, projectWorkspaceId: workspaceId, assigneeAgentId: agentId, title: 'Factory ' + job.role, description: job.marker + '\nReview the approved immutable source.', status: 'todo' };
    const pending = pipeline.claimTaskCreation(job.jobId, { expectedRevision: job.revision, agentId, payload, checkout, now: NOW, ...options });
    const task = { ...payload, id: randomUUID() };
    return { pending, task, payload, checkout, agentId };
  };
  const complete = job => {
    const { pending, task, checkout, agentId } = start(job);
    assert.equal(pipeline.resolveTaskBinding(job.jobId, { task, agentId }).status, 'binding_pending');
    const bound = pipeline.bindTask(job.jobId, { expectedRevision: pending.revision, token: pending.token, task, now: NOW });
    assert.equal(pipeline.resolveTaskBinding(job.jobId, { task, agentId }).status, 'bound');
    const journal = new ExecutionJournal({ directory: path.join(directory, 'journals', job.jobId), companyId: COMPANY });
    let execution, attached;
    try {
      execution = journal.queue({ companyId: COMPANY, paperclipIssueId: task.id, paperclipRunId: randomUUID(), projectId: PROJECT, workspaceId: checkout.workspaceId, repository: config.repository, environmentId: config.cloud.environmentId, branch: checkout.branch, mode: 'code_change' });
      attached = pipeline.bindExecution(job.jobId, { expectedRevision: bound.revision, execution, now: NOW });
      journal.claim(task.id, execution.paperclipRunId);
      const cloudTaskId = 'task_e_' + (next++).toString(16).padStart(32, '0');
      execution = journal.accept(task.id, execution.paperclipRunId, { cloudTaskId, emittedUrl: 'https://chatgpt.com/codex/tasks/' + cloudTaskId, taskUrl: 'https://chatgpt.com/remote/' + cloudTaskId });
      execution = journal.transition(task.id, { expectedState: 'running', expectedRevision: execution.revision, toState: 'succeeded' });
    } finally { journal.close(); }
    return pipeline.observeExecution(job.jobId, { expectedRevision: attached.revision, execution, now: NOW });
  };
  t.after(() => { pipeline.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, pipeline, registration, source, observe, seed, start, complete };
}
function artifact(job, overrides = {}) {
  const a = job.source.delivery.association;
  const binding = { pipelineId: job.pipelineId, jobId: job.jobId, roleExecutionId: job.executionId, sourceExecutionId: a.executionId, repository: a.repository, pullRequestNumber: a.pullRequestNumber, baseSha: a.expectedBaseSha, headSha: a.expectedHeadSha, sourcePatchSha256: job.source.delivery.patch.sha256 };
  const report = { schemaVersion: 1, templateVersion: 1, role: job.role, taskId: job.taskId, repository: a.repository, baseSha: a.expectedBaseSha, headSha: a.expectedHeadSha, summary: 'Independent observed outcome.', evidence: [{ kind: 'command', description: 'Focused acceptance test executed.', status: 'passed', command: ['node', '--test'], exitCode: 0 }], ...(job.role === 'reviewer' ? { outcome: 'clean', findings: [] } : { outcome: 'passed', checks: [{ criterion: 'Acceptance criteria checked.', status: 'passed', evidenceIndexes: [0] }] }), ...overrides };
  const content = JSON.stringify({ schemaVersion: 1, binding, report }, null, 2), lines = content.split('\n'), name = reviewArtifactPath(job.executionId);
  return [`diff --git a/${name} b/${name}`, 'new file mode 100644', 'index 0000000..1234567', '--- /dev/null', '+++ b/' + name, `@@ -0,0 +1,${lines.length} @@`, ...lines.map(line => '+' + line), ''].join('\n');
}
function finish(f, job, result) { const ready = f.complete(job); return f.pipeline.acceptArtifact(job.jobId, { expectedRevision: ready.revision, patch: artifact(ready, result), now: NOW }); }
function approval(f, pipeline) {
  const key = 'factory-reviewed:' + pipeline.pipelineId + ':' + pipeline.source.delivery.association.expectedHeadSha;
  return { expectedRevision: pipeline.revision, observation: pipeline.source, boardUserId: USER, now: NOW, payload: { kind: 'request_confirmation', idempotencyKey: key, continuationPolicy: 'none', resolverPolicy: 'human_only', payload: { version: 1, target: { type: 'custom', key, href: pipeline.source.delivery.association.pullRequestUrl } } } };
}

async function verifiedRepair(f, job, { head = 'd'.repeat(40) } = {}) {
  const full = PATCH.replace('value = 1', 'value = 2');
  const delta = 'diff --git a/src/value.mjs b/src/value.mjs\nindex 1234567..abcdef0 100644\n--- a/src/value.mjs\n+++ b/src/value.mjs\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n';
  const store = new DeliveryArtifactStore({ directory: path.join(f.directory, 'repair-delivery') });
  const output = value => ({ code: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
  const run = async (command, args) => {
    if (command === '/fixture/codex') {
      if (args[0] === '--version') return output('codex-cli 0.166.0\n');
      if (args[0] === 'login') return { code: 0, stdout: '', stderr: 'Logged in using ChatGPT' };
      return output(delta);
    }
    const resource = args.at(-1), wantsDiff = args.includes('Accept: application/vnd.github.diff');
    if (resource.includes('/compare/')) {
      const base = resource.includes('/' + HEAD + '...') ? HEAD : BASE;
      if (wantsDiff) return output(base === BASE ? full : delta);
      return output({ base_commit: { sha: base }, merge_base_commit: { sha: base }, status: 'ahead', ahead_by: 1, behind_by: 0, files: [{ filename: 'src/value.mjs', additions: 1, deletions: 1 }] });
    }
    if (resource.includes('/check-runs?')) return output({ total_count: 1, check_runs: [{ id: 1, name: 'unit', head_sha: head, status: 'completed', conclusion: 'success', html_url: 'https://github.com/fixture/project/actions/runs/1' }] });
    if (resource.includes('/status?')) return output({ sha: head, repository: { full_name: 'fixture/project' }, total_count: 0, statuses: [] });
    if (wantsDiff) return output(full);
    return output({ number: 7, html_url: 'https://github.com/fixture/project/pull/7', state: 'open', merged: false, draft: false, base: { ref: 'main', sha: BASE, repo: { full_name: 'fixture/project' } }, head: { ref: job.execution.branch, sha: head, repo: { full_name: 'fixture/project' } }, changed_files: 1, additions: 1, deletions: 0 });
  };
  const result = await inspectRepairGitHubDelivery({ previousDeliveryObservation: job.source, repairExecution: job.execution, repositoryConfig: f.registration.config, expectedHeadSha: head, runtime: { githubCommand: '/fixture/gh', codexCommand: '/fixture/codex' }, run, now: () => NOW, captureDelta: value => store.captureDelta(value), capturePatch: value => store.capturePatch(value) });
  assert.equal(result.status, 'ready_for_independent_review', result.reasons.join(','));
  const written = store.recordObservation({ result, context: { configHash: f.registration.configHash, policyHash: f.registration.policyHash, journalSchemaVersion: 4, executionRevision: job.execution.revision } });
  return { observation: JSON.parse(fs.readFileSync(written.observationPath)), patch: full };
}

test('actual delivery envelopes seed one durable independent review with immutable source patch', t => {
  const f = fixture(t), first = f.seed(), duplicate = f.seed();
  assert.equal(first.created, true); assert.equal(duplicate.created, false); assert.equal(first.job.jobId, duplicate.job.jobId);
  assert.equal(f.pipeline.sourcePatch(first.job.jobId), PATCH);
  const reopened = new ReviewPipeline({ directory: path.join(f.directory, 'pipeline') });
  try { assert.equal(reopened.getJob(first.job.jobId).role, 'reviewer'); assert.equal(reopened.get(first.pipeline.pipelineId).handoffs, 1); }
  finally { reopened.close(); }
});

test('seed rejects mismatched policy, stale observations, failed CI and changed patch bytes', t => {
  const f = fixture(t);
  assert.throws(() => f.seed({ registration: { ...f.registration, configHash: 'f'.repeat(64) } }), { code: 'REVIEW_PIPELINE_REGISTERED_POLICY_BINDING_CHANGED' });
  assert.throws(() => f.seed({ now: '2030-01-01T00:02:00.000Z' }), { code: 'REVIEW_PIPELINE_DELIVERY_OBSERVATION_STALE' });
  const failed = structuredClone(f.source); failed.delivery.checks.state = 'failed';
  assert.throws(() => f.seed({ observation: failed }), { code: 'REVIEW_PIPELINE_DELIVERY_GATES_UNVERIFIED' });
  assert.throws(() => f.seed({ patch: PATCH.replace('value = 1', 'value = 2') }), { code: 'REVIEW_PIPELINE_SOURCE_PATCH_CHANGED' });
  assert.throws(() => f.seed({ maxRepairs: 3 }), { code: 'REVIEW_PIPELINE_REGISTERED_POLICY_BINDING_CHANGED' });
});

test('native assigned-task creation is fenced before writing and unbound dispatch remains pending', t => {
  const f = fixture(t), { job } = f.seed(), created = f.start(job);
  assert.equal(f.pipeline.resolveTaskBinding(job.jobId, { task: created.task, agentId: created.agentId }).status, 'binding_pending');
  const second = new ReviewPipeline({ directory: path.join(f.directory, 'pipeline') });
  try {
    assert.throws(() => second.claimTaskCreation(job.jobId, { expectedRevision: job.revision, agentId: REVIEWER, payload: created.payload, checkout: created.checkout }), { code: 'REVIEW_PIPELINE_STALE_JOB' });
    const unknown = f.pipeline.markTaskUnknown(job.jobId, { expectedRevision: created.pending.revision, token: created.pending.token, now: NOW });
    assert.throws(() => second.claimTaskCreation(job.jobId, { expectedRevision: unknown.revision, agentId: REVIEWER, payload: created.payload, checkout: created.checkout }), { code: 'REVIEW_PIPELINE_TASK_CREATION_ALREADY_CLAIMED' });
    const bound = second.bindTask(job.jobId, { expectedRevision: unknown.revision, token: unknown.token, task: created.task, now: NOW });
    assert.equal(bound.taskId, created.task.id); assert.equal(f.pipeline.getJobByTask(created.task.id).jobId, job.jobId);
    assert.throws(() => f.pipeline.resolveTaskBinding(job.jobId, { task: { ...created.task, id: randomUUID() }, agentId: REVIEWER }), { code: 'REVIEW_PIPELINE_TASK_PAYLOAD_BINDING_CHANGED' });
  } finally { second.close(); }
});

test('role identity, approved checkout, task scope and actual execution binding cannot drift', t => {
  const f = fixture(t), { job } = f.seed();
  assert.throws(() => f.start(job, { agentId: IMPLEMENTER }), { code: 'REVIEW_PIPELINE_INDEPENDENT_AGENT_REQUIRED' });
  const pending = f.start(job);
  assert.throws(() => f.pipeline.bindTask(job.jobId, { expectedRevision: pending.pending.revision, token: pending.pending.token, task: { ...pending.task, projectId: randomUUID() } }), { code: 'REVIEW_PIPELINE_TASK_PAYLOAD_BINDING_CHANGED' });
  const bound = f.pipeline.bindTask(job.jobId, { expectedRevision: pending.pending.revision, token: pending.pending.token, task: pending.task, now: NOW });
  assert.throws(() => f.pipeline.bindExecution(job.jobId, { expectedRevision: bound.revision, execution: { state: 'queued', executionId: randomUUID(), paperclipRunId: randomUUID(), companyId: COMPANY, paperclipIssueId: randomUUID(), projectId: PROJECT, workspaceId: pending.checkout.workspaceId, repository: 'fixture/project', environmentId: 'a'.repeat(32), branch: 'main', mode: 'code_change', attempt: 1 } }), { code: 'REVIEW_PIPELINE_EXECUTION_BINDING_CHANGED' });
});

test('clean review creates QA and passing QA still cannot bypass fresh external test evidence', t => {
  const f = fixture(t), seeded = f.seed(), review = finish(f, seeded.job);
  assert.equal(review.pipeline.state, 'qa_pending'); assert.equal(review.nextJob.role, 'qa');
  assert.equal(review.job.result.report.evidenceVerified, false);
  const qa = finish(f, review.nextJob);
  assert.equal(qa.pipeline.state, 'gates_pending'); assert.equal(qa.nextJob, null);
  const changed = structuredClone(f.source); changed.delivery.association.expectedHeadSha = 'd'.repeat(40); changed.delivery.provenance.headSha = 'd'.repeat(40);
  assert.throws(() => f.pipeline.claimApproval(qa.pipeline.pipelineId, { ...approval(f, qa.pipeline), observation: changed }), { code: 'REVIEW_PIPELINE_APPROVAL_HEAD_CHANGED' });
  const sending = f.pipeline.claimApproval(qa.pipeline.pipelineId, approval(f, qa.pipeline));
  assert.equal(sending.state, 'approval_sending'); assert.equal(sending.approval.state, 'sending');
  const unknown = f.pipeline.markApprovalUnknown(sending.pipelineId, { expectedRevision: sending.revision, token: sending.approval.token, now: NOW });
  assert.throws(() => f.pipeline.claimApproval(unknown.pipelineId, approval(f, unknown)), { code: 'REVIEW_PIPELINE_APPROVAL_NOT_READY' });
  const interaction = { id: randomUUID(), companyId: COMPANY, issueId: f.source.delivery.association.paperclipIssueId, createdByUserId: USER, createdByAgentId: null, ...sending.approval.payload };
  const final = f.pipeline.bindApproval(unknown.pipelineId, { expectedRevision: unknown.revision, token: unknown.approval.token, interaction, now: NOW });
  assert.equal(final.state, 'human_approval_pending'); assert.equal(final.approval.interactionId, interaction.id);
});

test('native approval object key order does not change its strict payload and actor binding', t => {
  const f = fixture(t), seeded = f.seed(), review = finish(f, seeded.job), qa = finish(f, review.nextJob);
  const sending = f.pipeline.claimApproval(qa.pipeline.pipelineId, approval(f, qa.pipeline));
  const unknown = f.pipeline.markApprovalUnknown(sending.pipelineId, { expectedRevision: sending.revision, token: sending.approval.token, now: NOW });
  const requested = sending.approval.payload;
  const interaction = {
    id: randomUUID(), companyId: COMPANY, issueId: f.source.delivery.association.paperclipIssueId,
    createdByUserId: USER, createdByAgentId: null, ...requested,
    payload: { target: { href: requested.payload.target.href, key: requested.payload.target.key, type: requested.payload.target.type }, version: requested.payload.version },
  };
  const bind = (value, token = sending.approval.token) => f.pipeline.bindApproval(unknown.pipelineId, { expectedRevision: unknown.revision, token, interaction: value, now: NOW });
  for (const value of [
    { ...interaction, companyId: randomUUID() },
    { ...interaction, issueId: randomUUID() },
    { ...interaction, createdByUserId: randomUUID() },
    { ...interaction, createdByAgentId: REVIEWER },
    { ...interaction, payload: { ...interaction.payload, target: { ...interaction.payload.target, href: 'https://github.com/fixture/project/pull/8' } } },
    { ...interaction, payload: { ...interaction.payload, version: String(interaction.payload.version) } },
    { ...interaction, payload: { ...interaction.payload, extra: true } },
  ]) assert.throws(() => bind(value), { code: 'REVIEW_PIPELINE_APPROVAL_BINDING_CHANGED' });
  assert.throws(() => bind(interaction, randomUUID()), { code: 'REVIEW_PIPELINE_APPROVAL_BINDING_CHANGED' });
  assert.equal(f.pipeline.get(unknown.pipelineId).revision, unknown.revision);
  const delivered = bind(interaction);
  assert.equal(delivered.state, 'human_approval_pending');
  assert.equal(delivered.approval.interactionId, interaction.id);
});

test('no operator-pinned application test check means approval remains blocked despite model passes', t => {
  const f = fixture(t, { testCheckNames: [] }), seeded = f.seed(), review = finish(f, seeded.job), qa = finish(f, review.nextJob);
  assert.throws(() => f.pipeline.claimApproval(qa.pipeline.pipelineId, approval(f, qa.pipeline)), { code: 'REVIEW_PIPELINE_APPLICATION_TEST_EVIDENCE_REQUIRED' });
  assert.equal(f.pipeline.get(qa.pipeline.pipelineId).state, 'gates_pending');
});

test('blocking review creates one bounded repair task and requires actual incremental proof before a new full-patch review', async t => {
  const f = fixture(t), seeded = f.seed();
  const changes = finish(f, seeded.job, { outcome: 'changes_requested', findings: [{ id: 'R1', classification: 'blocking', path: 'src/value.mjs', line: 1, message: 'Return the required value.' }] });
  assert.equal(changes.pipeline.state, 'repair_pending_delivery'); assert.equal(changes.nextJob.role, 'implementer'); assert.equal(changes.pipeline.repairs, 1);
  const ready = f.complete(changes.nextJob);
  assert.equal(ready.state, 'repair_delivery_pending');
  const originalShape = f.observe({ head: 'd'.repeat(40), executionId: ready.executionId, cloudTaskId: ready.cloudTaskId, issueId: ready.taskId, runId: ready.execution.paperclipRunId, patch: PATCH.replace('value = 1', 'value = 2') });
  const args = { expectedRevision: f.pipeline.get(changes.pipeline.pipelineId).revision, jobId: ready.jobId, now: NOW };
  assert.throws(() => f.pipeline.acceptRepairDelivery(changes.pipeline.pipelineId, { ...args, observation: originalShape, patch: PATCH.replace('value = 1', 'value = 2') }), { code: 'REVIEW_PIPELINE_REPAIR_INCREMENTAL_PROVENANCE_REQUIRED' });
  const next = await verifiedRepair(f, ready);
  const wrongPrevious = structuredClone(next.observation);
  wrongPrevious.delivery.provenance.incremental.previousHeadSha = 'f'.repeat(40);
  wrongPrevious.delivery.provenance.incremental.mergeBaseSha = 'f'.repeat(40);
  assert.throws(() => f.pipeline.acceptRepairDelivery(changes.pipeline.pipelineId, { ...args, observation: wrongPrevious, patch: next.patch }), { code: 'REVIEW_PIPELINE_REPAIR_INCREMENTAL_PROVENANCE_REQUIRED' });
  const advanced = f.pipeline.acceptRepairDelivery(changes.pipeline.pipelineId, { ...args, observation: next.observation, patch: next.patch });
  assert.equal(advanced.pipeline.state, 'review_pending'); assert.equal(advanced.job.round, 1); assert.equal(advanced.job.role, 'reviewer');
  assert.equal(advanced.job.source.delivery.association.expectedHeadSha, 'd'.repeat(40));
  assert.equal(f.pipeline.sourcePatch(advanced.job.jobId), next.patch);
  assert.equal(advanced.job.source.delivery.association.requestedBranch, ready.execution.branch);
  assert.equal(advanced.job.source.delivery.association.deliveryBaseBranch, 'main');
  const reviewed = finish(f, advanced.job), qa = finish(f, reviewed.nextJob);
  const sending = f.pipeline.claimApproval(qa.pipeline.pipelineId, { ...approval(f, qa.pipeline), boardUserId: 'local-board' });
  assert.equal(sending.state, 'approval_sending');
  assert.equal(sending.approval.boardUserId, 'local-board');
});

test('repair and handoff exhaustion escalate without creating another Cloud job', t => {
  const finding = { outcome: 'changes_requested', findings: [{ id: 'R1', classification: 'blocking', message: 'Demonstrated correctness defect.' }] };
  const f = fixture(t, { maxRepairs: 0 }), seeded = f.seed(), result = finish(f, seeded.job, finding);
  assert.equal(result.pipeline.state, 'escalated'); assert.equal(result.nextJob, null); assert.equal(f.pipeline.listJobs().length, 1);
  const g = fixture(t, { maxHandoffs: 1 }), single = g.seed(), clean = finish(g, single.job);
  assert.equal(clean.pipeline.state, 'escalated'); assert.equal(clean.pipeline.reasonCode, 'HANDOFF_BUDGET_EXHAUSTED'); assert.equal(g.pipeline.listJobs().length, 1);
});

test('infrastructure and malformed artifacts remain attention rather than clean or automatically retried', t => {
  const f = fixture(t), seeded = f.seed();
  const unavailable = finish(f, seeded.job, { outcome: 'infrastructure_failure', findings: [{ id: 'infra', classification: 'infrastructure', message: 'The exact checkout was unavailable.' }] });
  assert.equal(unavailable.pipeline.state, 'needs_attention'); assert.equal(unavailable.nextJob, null);
  const g = fixture(t), seed = g.seed(), ready = g.complete(seed.job);
  const malformed = g.pipeline.acceptArtifact(seed.job.jobId, { expectedRevision: ready.revision, patch: 'untrusted provider error', now: NOW });
  assert.equal(malformed.pipeline.state, 'needs_attention'); assert.equal(malformed.job.reasonCode, 'ROLE_ARTIFACT_UNVERIFIED');
  assert.equal(g.pipeline.listJobs().length, 1);
});

test('model outcomes and stale collectors cannot create duplicate handoffs across SQLite handles', t => {
  const f = fixture(t), seeded = f.seed(), ready = f.complete(seeded.job), patch = artifact(ready);
  const other = new ReviewPipeline({ directory: path.join(f.directory, 'pipeline') });
  try {
    f.pipeline.acceptArtifact(ready.jobId, { expectedRevision: ready.revision, patch, now: NOW });
    assert.throws(() => other.acceptArtifact(ready.jobId, { expectedRevision: ready.revision, patch, now: NOW }), { code: 'REVIEW_PIPELINE_STALE_JOB' });
    assert.equal(other.listJobs().length, 2);
  } finally { other.close(); }
});

test('post-binding wake intent is durable and ambiguous native writes are never automatically repeated', t => {
  const f = fixture(t), seeded = f.seed(), created = f.start(seeded.job);
  const bound = f.pipeline.bindTask(seeded.job.jobId, { expectedRevision: created.pending.revision, token: created.pending.token, task: created.task, now: NOW });
  const pending = f.pipeline.claimWake(bound.jobId, { expectedRevision: bound.revision, issue: created.task, liveRuns: [], now: NOW });
  const other = new ReviewPipeline({ directory: path.join(f.directory, 'pipeline') });
  try {
    assert.equal(other.getJob(bound.jobId).wake.state, 'sending');
    const unknown = other.markWakeUnknown(bound.jobId, { expectedRevision: pending.revision, token: pending.wake.token, now: NOW });
    assert.throws(() => f.pipeline.claimWake(bound.jobId, { expectedRevision: unknown.revision, issue: created.task, liveRuns: [], now: NOW }), { code: 'REVIEW_PIPELINE_WAKE_ALREADY_CLAIMED' });
    const recovered = f.pipeline.bindWake(bound.jobId, { expectedRevision: unknown.revision, token: unknown.wake.token, run: { id: randomUUID(), companyId: COMPANY, agentId: REVIEWER, contextSnapshot: { issueId: created.task.id } }, now: NOW });
    assert.equal(recovered.wake.state, 'delivered');
  } finally { other.close(); }
});

test('the implementation Cloud receipt cannot be reused as an independent reviewer execution', t => {
  const f = fixture(t), seeded = f.seed(), ready = f.complete(seeded.job);
  assert.throws(() => f.pipeline.observeExecution(ready.jobId, { expectedRevision: ready.revision, execution: { ...ready.execution, cloudTaskId: f.source.delivery.association.cloudTaskId }, now: NOW }), { code: 'REVIEW_PIPELINE_INDEPENDENT_CLOUD_REQUIRED' });
});
