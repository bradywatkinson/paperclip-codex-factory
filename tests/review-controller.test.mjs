import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DeliveryArtifactStore } from '../lib/delivery-artifacts.mjs';
import { inspectGitHubDelivery } from '../lib/github-delivery.mjs';
import { ReviewPipeline } from '../lib/review-pipeline.mjs';
import { ReviewRoleBindings, buildReviewPlan } from '../lib/review-onboarding.mjs';
import test from 'node:test';
import { startReviewPipeline, runReviewControllerOnce, reviewStatus, setReviewPaused, resolveReviewQueuedProfile } from '../lib/review-controller.mjs';
import { runFactoryControllerOnce } from '../lib/factory-controller.mjs';
import { reviewFixture } from './fixtures/review-runtime.mjs';

async function started(t) { const f = reviewFixture(t); await f.bootstrap(); await f.makeObservation(); const start = await startReviewPipeline({ registry: f.registry, scheduler: f.scheduler, repository: f.repository, observationPath: f.observationPath, patchPath: f.patchPath, approveDispatch: true, testCheckNames: ['unit'], run: f.run }); f.pipelineId = start.pipeline.pipelineId; f.once = () => runReviewControllerOnce({ registry: f.registry, scheduler: f.scheduler, run: f.run }); f.jobs = () => { const p = f.pipeline(); try { return p.listJobs({ pipelineId: f.pipelineId }); } finally { p.close(); } }; return f; }

test('explicit seed freshly validates actual journal-backed delivery and is idempotent without dispatch', async t => {
  const f = reviewFixture(t); await f.bootstrap(); await f.makeObservation();
  const args = { registry: f.registry, scheduler: f.scheduler, repository: f.repository, observationPath: f.observationPath, patchPath: f.patchPath, testCheckNames: ['unit'], run: f.run };
  await assert.rejects(startReviewPipeline(args), { code: 'REVIEW_DISPATCH_APPROVAL_REQUIRED' });
  const first = await startReviewPipeline({ ...args, approveDispatch: true }), again = await startReviewPipeline({ ...args, approveDispatch: true });
  assert.equal(first.pipeline.pipelineId, again.pipeline.pipelineId); assert.equal(again.created, false); assert.equal(f.issues.size, 1); assert.equal(f.calls.some(row => row.args[0] === 'cloud' && row.args[1] === 'exec'), false);
  f.checkState = 'failure'; await assert.rejects(startReviewPipeline({ ...args, approveDispatch: true }), { code: 'CI_FAILED' });
});
test('actual controller creates a scoped new child and secondary workspace then fenced prequeue wake', async t => {
  const f = await started(t), before = f.registry.getOperation(f.repository), result = await f.once(), job = f.jobs()[0];
  assert.equal(result.needsAttention.length, 0, JSON.stringify(result)); assert.equal(job.state, 'task_bound'); assert.equal(job.wake.state, 'delivered');
  assert.equal(f.issues.get(job.taskId).parentId, f.sourceIssueId); assert.equal(f.issues.get(f.sourceIssueId).status, 'blocked');
  const secondary = f.workspaces.get(job.checkout.workspaceId); assert.equal(secondary.isPrimary, false); assert.equal(f.workspaces.get(f.workspaceId).isPrimary, true);
  const repeated = await f.once(); assert.ok(repeated.needsAttention.some(row => row.code === 'REVIEW_WAKE_ALREADY_DELIVERED'));
  assert.equal(f.calls.filter(row => row.args[0] === 'issue' && row.args[1] === 'child:create').length, 1); assert.equal(f.calls.filter(row => row.args[0] === 'agent' && row.args[1] === 'wake').length, 1); assert.deepEqual(f.registry.getOperation(f.repository), before);
});
test('real dispatch, journal READY and strict Cloud evidence drive reviewer to QA to native human-only approval', async t => {
  const f = await started(t); await f.once(); let review = f.jobs()[0]; await f.dispatch(review); review = f.jobs()[0]; f.finish(review);
  let result = await f.once(); assert.equal(result.needsAttention.length, 0, JSON.stringify(result)); assert.equal(f.jobs().at(-1).role, 'qa');
  await f.once(); let qa = f.jobs().at(-1); assert.equal(qa.state, 'task_bound'); await f.dispatch(qa); qa = f.jobs().at(-1); f.finish(qa);
  result = await f.once(); assert.equal(result.needsAttention.length, 0, JSON.stringify(result));
  const status = reviewStatus({ registry: f.registry, repository: f.repository }); assert.equal(status.pipelines[0].state, 'human_approval_pending');
  const card = f.interactions.find(row => row.idempotencyKey?.startsWith('factory-reviewed:')); assert.equal(card.resolverPolicy, 'human_only'); assert.equal(card.continuationPolicy, 'none'); assert.equal(card.issueId, f.sourceIssueId); assert.equal(card.payload.allowDeclineReason, true);
  assert.equal(f.issues.get(f.sourceIssueId).status, 'blocked'); assert.equal(status.pipelines[0].jobs.every(job => job.state === 'result_recorded'), true);
});
test('operator pause and account pause retain observations but create no model assignments or wakes', async t => {
  const f = await started(t); f.scheduler.setPaused(true); assert.equal((await f.once()).createdTasks.length, 0); assert.equal(f.issues.size, 1);
  f.scheduler.setPaused(false); setReviewPaused({ registry: f.registry, repository: f.repository, pipelineId: f.pipelineId, paused: true }); assert.equal((await f.once()).createdTasks.length, 0);
  setReviewPaused({ registry: f.registry, repository: f.repository, pipelineId: f.pipelineId, paused: false }); await f.once(); let job = f.jobs()[0]; await f.dispatch(job); job = f.jobs()[0]; f.finish(job); f.scheduler.setPaused(true);
  const collected = await f.once(); assert.equal(collected.collectedArtifacts.length, 1); assert.equal(f.jobs().at(-1).role, 'qa'); assert.equal(f.jobs().at(-1).state, 'planned');
});
test('accepted-but-unknown child creation recovers by exact actor/parent/marker reads and never repeats POST', async t => {
  const f = await started(t); f.createTaskUnknown = true; const first = await f.once(); assert.ok(first.needsAttention.some(row => row.code === 'REVIEW_TASK_CREATION_UNKNOWN'));
  f.createTaskUnknown = false; await f.once(); assert.equal(f.jobs()[0].state, 'task_bound'); assert.equal(f.calls.filter(row => row.args[0] === 'issue' && row.args[1] === 'child:create').length, 1);
});
test('unknown wake and malformed role artifacts stay attention without blind retry or QA creation', async t => {
  const f = await started(t); f.wakeUnknown = true; await f.once(); await f.once(); assert.equal(f.calls.filter(row => row.args[0] === 'agent' && row.args[1] === 'wake').length, 1);
  let job = f.jobs()[0]; await f.dispatch(job); job = f.jobs()[0]; f.finish(job); f.cloudDiffs.set(job.cloudTaskId, 'not a complete artifact diff\n');
  await f.once(); assert.equal(f.jobs()[0].state, 'needs_attention'); assert.equal(f.jobs().length, 1);
});
test('trusted queue resolver and normal account controller wake the role agent without holding a main-profile mismatch', async t => {
  const f = await started(t); await f.once(); f.scheduler.setPaused(true); const job = f.jobs()[0]; const queued = await f.dispatch(job); assert.equal(queued.status, 'queued_for_capacity');
  const record = f.journal.getExecution(queued.executionId), profile = resolveReviewQueuedProfile({ registry: f.registry, repository: f.repository, record }); assert.equal(profile.agentId, job.agentId); assert.equal(profile.config.branch, job.checkout.branch);
  f.scheduler.setPaused(false); const result = await runFactoryControllerOnce({ registry: f.registry, scheduler: f.scheduler, run: f.run, sleep: async () => {} });
  assert.equal(result.woken.length, 1, JSON.stringify(result)); assert.equal(f.scheduler.get(record.executionId).state, 'queued'); assert.equal(result.needsAttention.some(row => row.code === 'FACTORY_QUEUED_TASK_REASSIGNED'), false);
});
test('blocking review creates one bounded repair job, which waits for actual published delivery', async t => {
  const f = await started(t); await f.once(); let job = f.jobs()[0]; await f.dispatch(job); job = f.jobs()[0]; f.finish(job, 'changes_requested'); await f.once();
  assert.equal(f.jobs().at(-1).role, 'implementer'); await f.once(); let repair = f.jobs().at(-1); assert.equal(repair.state, 'task_bound'); await f.dispatch(repair); repair = f.jobs().at(-1);
  const current = f.journal.getExecution(repair.executionId); f.journal.transition(repair.taskId, { expectedState: 'running', expectedRevision: current.revision, toState: 'succeeded' }); f.scheduler.adoptJournalExecution(f.journal.getExecution(repair.executionId));
  const result = await f.once(); assert.ok(result.needsAttention.some(row => row.code === 'REVIEW_REPAIR_AWAITS_PUBLICATION')); assert.equal(f.jobs().length, 2); assert.equal(f.jobs().at(-1).state, 'repair_delivery_pending');
});

test('a published verified repair delta starts a fresh full-patch review and re-verifies that repair at approval', async t => {
  const f = await started(t); await f.once(); let job = f.jobs()[0]; await f.dispatch(job); job = f.jobs()[0]; f.finish(job, 'changes_requested'); await f.once(); await f.once();
  let repair = f.jobs().at(-1); await f.dispatch(repair); repair = f.jobs().at(-1); const record = f.journal.getExecution(repair.executionId);
  f.journal.transition(repair.taskId, { expectedState: 'running', expectedRevision: record.revision, toState: 'succeeded' }); f.scheduler.adoptJournalExecution(f.journal.getExecution(repair.executionId));
  f.head = 'd'.repeat(40); f.fullPatch = f.fullPatch.replace('+new\n', '+repaired\n'); f.deltaPatch = 'diff --git a/value b/value\nindex 1234567..abcdef0 100644\n--- a/value\n+++ b/value\n@@ -1 +1 @@\n-new\n+repaired\n'; f.cloudDiffs.set(repair.cloudTaskId, f.deltaPatch);
  let result = await f.once(); assert.equal(result.needsAttention.length, 0, JSON.stringify(result)); assert.equal(f.jobs().at(-1).role, 'reviewer'); assert.equal(f.jobs().at(-1).round, 1);
  await f.once(); job = f.jobs().at(-1); await f.dispatch(job); job = f.jobs().at(-1); assert.equal(job.source.delivery.provenance.comparison, 'exact_incremental_text_diff_with_full_pr'); f.finish(job); await f.once(); await f.once();
  job = f.jobs().at(-1); assert.equal(job.role, 'qa'); await f.dispatch(job); job = f.jobs().at(-1); f.finish(job);
  result = await f.once(); assert.equal(result.needsAttention.length, 0, JSON.stringify(result));
  assert.equal(reviewStatus({ registry: f.registry, repository: f.repository }).pipelines[0].state, 'human_approval_pending');
  assert.ok(f.calls.filter(row => row.command === f.runtime.githubCommand && row.args.at(-1).includes('/compare/' + 'b'.repeat(40) + '...' + 'd'.repeat(40))).length >= 4);
});

test('a changed CI head gate before human approval remains blocked despite model clean/pass reports', async t => {
  const f = await started(t); await f.once(); let job = f.jobs()[0]; await f.dispatch(job); job = f.jobs()[0]; f.finish(job); await f.once(); await f.once(); job = f.jobs().at(-1); await f.dispatch(job); job = f.jobs().at(-1); f.finish(job); f.checkState = 'failure';
  const result = await f.once(); assert.ok(result.needsAttention.some(row => row.code === 'CI_FAILED')); assert.equal(f.interactions.some(row => row.idempotencyKey?.startsWith('factory-reviewed:')), false);
  assert.equal(reviewStatus({ registry: f.registry, repository: f.repository }).pipelines[0].state, 'gates_pending');
});

test('a crash after journal queue but before ledger binding is recovered from that exact real queued identity', async t => {
  const f = await started(t); await f.once(); const job = f.jobs()[0], runId = job.wake.runId;
  const record = f.journal.queue({ companyId: f.companyId, paperclipIssueId: job.taskId, paperclipRunId: runId, projectId: f.projectId, workspaceId: job.checkout.workspaceId, repository: f.repository, environmentId: f.registration.config.cloud.environmentId, branch: job.checkout.branch, mode: 'code_change' });
  f.scheduler.adoptJournalExecution(record); const result = await f.once();
  assert.equal(result.needsAttention.length, 0, JSON.stringify(result)); assert.equal(f.jobs()[0].executionId, record.executionId); assert.equal(f.jobs()[0].execution.state, 'queued');
  assert.equal(resolveReviewQueuedProfile({ registry: f.registry, repository: f.repository, record }).agentId, job.agentId);
});

test('approved acceptance criteria are preserved verbatim and parent scope edits stop assignment and direct role dispatch', async t => {
  const f = await started(t), source = f.issues.get(f.sourceIssueId), approved = source.description;
  await f.once(); const job = f.jobs()[0]; assert.ok(f.issues.get(job.taskId).description.includes(approved));
  source.description += '\nHuman changed the requested acceptance criteria.';
  await assert.rejects(f.dispatch(job), { code: 'REVIEW_PARENT_SCOPE_CHANGED' });
  assert.equal(f.calls.some(row => row.args[0] === 'cloud' && row.args[1] === 'exec'), false);
});

test('normal account queue holds deferred role work after approved parent criteria drift or human completion', async t => {
  for (const change of ['description', 'terminal']) await t.test(change, async child => {
    const f = await started(child); await f.once(); f.scheduler.setPaused(true); const job = f.jobs()[0], queued = await f.dispatch(job); assert.equal(queued.status, 'queued_for_capacity');
    const parent = f.issues.get(f.sourceIssueId); if (change === 'description') parent.description += '\nChanged acceptance criteria.'; else parent.status = 'done';
    f.scheduler.setPaused(false); const result = await runFactoryControllerOnce({ registry: f.registry, scheduler: f.scheduler, run: f.run, sleep: async () => {} });
    assert.equal(result.woken.length, 0, JSON.stringify(result)); assert.ok(result.needsAttention.some(row => row.code === 'REVIEW_PARENT_SCOPE_CHANGED')); assert.equal(f.scheduler.get(queued.executionId).state, 'held');
    assert.equal(f.calls.some(row => row.args[0] === 'cloud' && row.args[1] === 'exec'), false);
  });
});

async function secondApprovedPipeline(f) {
  const issueId = randomUUID(), runId = randomUUID(), original = f.issues.get(f.sourceIssueId), cloudTaskId = 'task_e_' + 'f'.repeat(32);
  f.issues.set(issueId, { ...original, id: issueId, title: original.title + ' second', executionRunId: runId });
  f.runs.set(runId, { id: runId, companyId: f.companyId, agentId: f.implementationAgentId, status: 'succeeded', contextSnapshot: { issueId } });
  f.journal.queue({ companyId: f.companyId, paperclipIssueId: issueId, paperclipRunId: runId, projectId: f.projectId, workspaceId: f.workspaceId, repository: f.repository, environmentId: f.registration.config.cloud.environmentId, branch: 'main', mode: 'code_change' }); f.journal.claim(issueId, runId);
  let execution = f.journal.accept(issueId, runId, { cloudTaskId, emittedUrl: 'https://chatgpt.com/remote/' + cloudTaskId, taskUrl: 'https://chatgpt.com/remote/' + cloudTaskId });
  execution = f.journal.transition(issueId, { expectedState: 'running', expectedRevision: execution.revision, toState: 'succeeded' }); f.cloudDiffs.set(cloudTaskId, f.fullPatch);
  const artifacts = new DeliveryArtifactStore({ directory: path.join(f.directory, 'second-delivery') });
  const result = await inspectGitHubDelivery({ execution, repositoryConfig: f.registration.config, expectedBaseSha: 'a'.repeat(40), expectedHeadSha: f.head, pullRequest: { repository: f.repository, number: 7 }, runtime: f.runtime, run: f.run, capturePatch: value => artifacts.capturePatch(value) });
  const written = artifacts.recordObservation({ result, context: { configHash: f.registration.configHash, policyHash: f.registration.policyHash, journalSchemaVersion: 4, executionRevision: execution.revision } });
  return startReviewPipeline({ registry: f.registry, scheduler: f.scheduler, repository: f.repository, observationPath: written.observationPath, patchPath: artifacts.patches.get(execution.executionId).patchPath, approveDispatch: true, testCheckNames: ['unit'], run: f.run });
}

test('two approved pipelines use a persisted one-item round robin despite an unknown first wake', async t => {
  const f = await started(t), second = await secondApprovedPipeline(f), invoke = () => runReviewControllerOnce({ registry: f.registry, scheduler: f.scheduler, run: f.run, maxPipelines: 1 });
  f.wakeUnknown = true; const first = await invoke();
  assert.equal(first.processedPipelines, 1); assert.equal(first.deferredPipelines, 1); assert.equal(first.createdTasks[0].jobId, f.jobs()[0].jobId); assert.ok(first.needsAttention.some(row => row.code === 'REVIEW_WAKE_OUTCOME_UNKNOWN'));
  // Reopen the actual durable store, rather than relying on a process cursor.
  const plan = buildReviewPlan({ registry: f.registry, repository: f.repository }), persisted = new ReviewRoleBindings({ directory: plan.directory });
  try { assert.equal(persisted.get('controller:pipeline-cursor').data.pipelineId, f.pipelineId); } finally { persisted.close(); }
  f.wakeUnknown = false; const next = await invoke();
  assert.equal(next.processedPipelines, 1); assert.equal(next.deferredPipelines, 1); assert.equal(next.pipelines[0].pipelineId, second.pipeline.pipelineId); assert.equal(next.createdTasks.length, 1);
  await invoke(); await invoke();
  assert.equal(f.calls.filter(row => row.args[0] === 'issue' && row.args[1] === 'child:create').length, 2); assert.equal(f.calls.filter(row => row.args[0] === 'agent' && row.args[1] === 'wake').length, 2);
  assert.equal(f.calls.some(row => row.args[0] === 'cloud' && row.args[1] === 'exec'), false);
});

test('a paused first pipeline does not freeze a later approved batch at a one-pipeline limit', async t => {
  const f = await started(t), second = await secondApprovedPipeline(f);
  setReviewPaused({ registry: f.registry, repository: f.repository, pipelineId: f.pipelineId, paused: true });
  const invoke = () => runReviewControllerOnce({ registry: f.registry, scheduler: f.scheduler, run: f.run, maxPipelines: 1 });
  const paused = await invoke(); assert.equal(paused.createdTasks.length, 0); assert.equal(paused.deferredPipelines, 1);
  const next = await invoke(); assert.equal(next.createdTasks.length, 1); assert.equal(next.pipelines[0].pipelineId, second.pipeline.pipelineId); assert.equal(next.processedPipelines, 1);
});

test('completed job history does not consume the active job budget for later QA and approval', async t => {
  const f = await started(t), invoke = () => runReviewControllerOnce({ registry: f.registry, scheduler: f.scheduler, run: f.run, maxJobs: 1 });
  await invoke(); let job = f.jobs()[0]; await f.dispatch(job); job = f.jobs()[0]; f.finish(job); await invoke();
  await invoke(); job = f.jobs().at(-1); assert.equal(job.role, 'qa'); assert.equal(job.state, 'task_bound'); await f.dispatch(job); job = f.jobs().at(-1); f.finish(job);
  const result = await invoke(); assert.equal(result.needsAttention.length, 0, JSON.stringify(result)); assert.equal(result.pipelines[0].state, 'human_approval_pending');
});

test('invalid batch limits reject before storage or provider work', async () => {
  for (const maxPipelines of [0, -1, 1.5, '1', Infinity, 101]) await assert.rejects(runReviewControllerOnce({ maxPipelines }), { code: 'REVIEW_CONTROLLER_INVALID_LIMIT' });
  await assert.rejects(runReviewControllerOnce({ maxJobs: 0 }), { code: 'REVIEW_CONTROLLER_INVALID_LIMIT' });
});

function startRegistryUpdate(f) {
  const operation = f.registry.getOperation(f.repository);
  f.registry.updateOperation(f.repository, { expectedRevision: operation.revision, state: 'configuration_updating', data: operation.data });
}
function readPipeline(f) {
  // Capture path before exercising the update, since new plans must now fail.
  return f.pipeline();
}
test('cutover after fresh source reads rejects seed and activation together', async t => {
  const f = reviewFixture(t); await f.bootstrap(); await f.makeObservation();
  const plan = buildReviewPlan({ registry: f.registry, repository: f.repository }), run = f.run;
  const guardedRun = async (command, args, options) => {
    const result = await run(command, args, options);
    if (command === f.runtime.githubCommand && args.at(-1).endsWith('/pulls/7')) startRegistryUpdate(f);
    return result;
  };
  await assert.rejects(startReviewPipeline({ registry: f.registry, scheduler: f.scheduler, repository: f.repository, observationPath: f.observationPath, patchPath: f.patchPath, approveDispatch: true, testCheckNames: ['unit'], run: guardedRun }), { code: 'REGISTRY_CONFIG_CHANGED' });
  const store = new ReviewRoleBindings({ directory: plan.directory });
  try { assert.equal(store.list().some(row => row.key.startsWith('activation:')), false); } finally { store.close(); }
  const pipeline = new ReviewPipeline({ directory: plan.pipelineDirectory });
  try { assert.equal(pipeline.list().length, 0); } finally { pipeline.close(); }
  assert.equal(f.calls.some(row => row.args[1] === 'child:create' || row.args[1] === 'wake'), false);
});
test('cutover before workspace sending preserves planned intent and sends no workspace or child', async t => {
  const f = await started(t), pipeline = readPipeline(f), run = f.run;
  t.after(() => pipeline.close());
  f.run = async (command, args, options) => {
    const result = await run(command, args, options);
    if (args[0] === 'project-workspace' && args[1] === 'list') startRegistryUpdate(f);
    return result;
  };
  const result = await f.once(); assert.ok(result.needsAttention.some(row => row.code === 'REGISTRY_CONFIG_CHANGED'), JSON.stringify(result));
  assert.equal(pipeline.listJobs()[0].state, 'planned');
  const store = new ReviewRoleBindings({ directory: path.dirname(pipeline.directory) });
  try { assert.equal(store.list().find(row => row.key.startsWith('workspace:')).state, 'planned'); assert.equal(store.list().some(row => row.key.startsWith('task:')), false); } finally { store.close(); }
  assert.equal(f.calls.some(row => row.args[0] === 'project-workspace' && row.args[1] === 'create' || row.args[1] === 'child:create'), false);
});
test('cutover after checkout reads fences task creation intent and actual task claim', async t => {
  const f = await started(t), pipeline = readPipeline(f), run = f.run;
  t.after(() => pipeline.close());
  f.run = async (command, args, options) => {
    const result = await run(command, args, options);
    if (args[0] === 'whoami') startRegistryUpdate(f);
    return result;
  };
  const result = await f.once(); assert.ok(result.needsAttention.some(row => row.code === 'REGISTRY_CONFIG_CHANGED'), JSON.stringify(result));
  assert.equal(pipeline.listJobs()[0].state, 'planned');
  const store = new ReviewRoleBindings({ directory: path.dirname(pipeline.directory) });
  try { assert.equal(store.list().some(row => row.key.startsWith('task:')), false); } finally { store.close(); }
  assert.equal(f.calls.some(row => row.args[1] === 'child:create'), false);
});
test('cutover after liveness reads fences wake intent and sends no wake', async t => {
  const f = await started(t), pipeline = readPipeline(f), run = f.run;
  t.after(() => pipeline.close());
  f.run = async (command, args, options) => {
    const result = await run(command, args, options);
    if (args[0] === 'issue' && args[1] === 'live-runs') startRegistryUpdate(f);
    return result;
  };
  const result = await f.once(); assert.ok(result.needsAttention.some(row => row.code === 'REGISTRY_CONFIG_CHANGED'), JSON.stringify(result));
  assert.equal(pipeline.listJobs()[0].state, 'task_bound'); assert.equal(pipeline.listJobs()[0].wake, null);
  assert.equal(f.calls.some(row => row.args[1] === 'wake'), false);
});

test('cutover after final CI reads fences human approval intent and notification', async t => {
  const f = await started(t); await f.once(); let job = f.jobs()[0]; await f.dispatch(job); job = f.jobs()[0]; f.finish(job); await f.once(); await f.once();
  job = f.jobs().at(-1); await f.dispatch(job); job = f.jobs().at(-1); f.finish(job);
  const pipeline = readPipeline(f), run = f.run; t.after(() => pipeline.close());
  f.run = async (command, args, options) => {
    const result = await run(command, args, options);
    if (command === f.runtime.githubCommand && args.at(-1).endsWith('/pulls/7')) startRegistryUpdate(f);
    return result;
  };
  const result = await f.once(); assert.ok(result.needsAttention.some(row => row.code === 'REGISTRY_CONFIG_CHANGED'), JSON.stringify(result));
  assert.equal(pipeline.get(f.pipelineId).approval, null); assert.equal(f.interactions.length, 0);
  assert.equal(f.calls.some(row => row.args[1] === 'interaction:create'), false);
});
