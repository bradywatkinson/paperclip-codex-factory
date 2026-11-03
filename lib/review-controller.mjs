import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ReviewPipeline } from './review-pipeline.mjs';
import { ExecutionJournal, JOURNAL_FILENAME } from './execution-journal.mjs';
import { DeliveryArtifactStore } from './delivery-artifacts.mjs';
import { inspectGitHubDelivery, inspectRepairGitHubDelivery } from './github-delivery.mjs';
import { configurationHash } from './repository-registry.mjs';
import { renderReviewJobPrompt } from './review-dispatch.mjs';
import { validateProjectConfig } from './cloud-dispatch.mjs';
import { buildReviewPlan, ReviewRoleBindings, reviewCommands, verifyReviewRole, roleSpec, reviewFail, reviewSafeCode } from './review-onboarding.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TERMINAL = ['succeeded', 'failed', 'cancelled', 'timed_out'];
const roleKey = role => role === 'implementer' ? 'repair' : role;
const summarize = pipeline => ({ pipelineId: pipeline.pipelineId, state: pipeline.state, repairs: pipeline.repairs, handoffs: pipeline.handoffs, reasonCode: pipeline.reasonCode, headSha: pipeline.source.delivery.association.expectedHeadSha, humanStatusUnchanged: true });
function existing(filename, maximum = 2_000_000) {
  let stat; try { stat = fs.lstatSync(filename); } catch { reviewFail('REVIEW_FILE_MISSING'); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) reviewFail('REVIEW_FILE_UNSAFE'); return stat;
}
function boundSource(execution, association) {
  if (!execution || execution.state !== 'succeeded' || ['executionId', 'companyId', 'paperclipIssueId', 'paperclipRunId', 'projectId', 'attempt', 'repository', 'environmentId'].some(key => execution[key] !== association[key]) || execution.cloudTaskId !== association.cloudTaskId || execution.taskUrl !== association.cloudTaskUrl || execution.branch !== association.requestedBranch || execution.mode !== 'code_change') reviewFail('REVIEW_SOURCE_EXECUTION_CHANGED');
}
function taskMatches(task, job, parentId, actor) {
  const payload = job.taskPayload;
  return task?.parentId === parentId && task.createdByUserId === actor && !task.createdByAgentId && !task.assigneeUserId && ['companyId', 'projectId', 'assigneeAgentId', 'title', 'description'].every(key => task[key] === payload[key]) && (task.projectWorkspaceId ?? null) === payload.projectWorkspaceId;
}
async function board(pc, companyId) {
  const value = await pc(['whoami']);
  if (typeof value?.userId !== 'string' || !value.userId || value.userId.length > 200 || /[\u0000-\u001f\u007f]/.test(value.userId) || !Array.isArray(value.companyIds) || !value.companyIds.includes(companyId)) reviewFail('REVIEW_BOARD_SIGN_IN_REQUIRED');
  return value.userId;
}
async function parentTask(pc, plan, pipeline, approvedTask) {
  const id = pipeline.initialSource.delivery.association.paperclipIssueId, issue = await pc(['issue', 'get', id]);
  if (issue?.id !== id || issue.companyId !== plan.companyId || issue.projectId !== plan.projectId || ['done', 'cancelled'].includes(issue.status) || approvedTask && ['id', 'companyId', 'projectId', 'title', 'description'].some(key => issue[key] !== approvedTask[key])) reviewFail('REVIEW_PARENT_SCOPE_CHANGED'); return issue;
}
async function freshObservation({ plan, pipeline, execution, previous, headSha, run, env, now, store }) {
  const source = pipeline.source, a = source.delivery.association;
  const options = { repositoryConfig: plan.registration.config, expectedHeadSha: headSha ?? a.expectedHeadSha, pullRequest: { repository: a.repository, number: a.pullRequestNumber }, runtime: plan.main.runtime, run, env, now, capturePatch: value => store.capturePatch(value) };
  const result = previous ? await inspectRepairGitHubDelivery({ ...options, previousDeliveryObservation: previous, repairExecution: execution, captureDelta: value => store.captureDelta(value) })
    : await inspectGitHubDelivery({ ...options, execution, expectedBaseSha: a.expectedBaseSha });
  if (result.status !== 'ready_for_independent_review' || result.provenance?.verified !== true) reviewFail(result.reasons?.[0] ?? 'REVIEW_DELIVERY_UNVERIFIED');
  const written = store.recordObservation({ result, context: { configHash: plan.registration.configHash, policyHash: plan.registration.policyHash, journalSchemaVersion: 4, executionRevision: execution.revision } });
  return JSON.parse(fs.readFileSync(written.observationPath, 'utf8'));
}
/** Seed only after explicit batch authorization and fresh actual GitHub/Cloud inspection. */
export async function startReviewPipeline({ registry, scheduler, repository, observationPath, patchPath, approveDispatch = false, testCheckNames = [], maxRepairs = 2, maxHandoffs = 8, run, env, now = () => new Date().toISOString() } = {}) {
  if (!approveDispatch) reviewFail('REVIEW_DISPATCH_APPROVAL_REQUIRED');
  if (!Array.isArray(testCheckNames) || !testCheckNames.length) reviewFail('REVIEW_TEST_CHECK_REQUIRED');
  const plan = buildReviewPlan({ registry, repository });
  if (!scheduler || path.resolve(scheduler.directory) !== path.resolve(plan.main.schedulerDirectory)) reviewFail('REVIEW_ACCOUNT_BINDING_CHANGED');
  existing(observationPath); existing(patchPath, 1_000_000); existing(path.join(plan.main.journalDirectory, JOURNAL_FILENAME), Number.MAX_SAFE_INTEGER);
  const input = JSON.parse(fs.readFileSync(observationPath, 'utf8')), patch = fs.readFileSync(patchPath, 'utf8'), association = input.delivery?.association;
  if (!association || input.patchArtifact?.sha256 !== input.delivery.patch?.sha256 || input.context?.configHash !== plan.registration.configHash || input.context?.policyHash !== plan.registration.policyHash || association.companyId !== plan.companyId || association.projectId !== plan.projectId || association.repository !== plan.registration.repository) reviewFail('REVIEW_SOURCE_ARTIFACT_CHANGED');
  const bindings = new ReviewRoleBindings({ directory: plan.directory }), commands = reviewCommands(plan, run, env);
  let pipeline, journal;
  try {
    for (const role of ['reviewer', 'qa', 'repair']) await verifyReviewRole({ plan, store: bindings, role, pc: commands.pc });
    const actor = await board(commands.pc, plan.companyId);
    const originalTask = await commands.pc(['issue', 'get', association.paperclipIssueId]);
    if (originalTask?.id !== association.paperclipIssueId || originalTask.companyId !== plan.companyId || originalTask.projectId !== plan.projectId || ['done', 'cancelled'].includes(originalTask.status) || typeof originalTask.title !== 'string' || !originalTask.title.trim() || Buffer.byteLength(originalTask.title) > 500 || typeof originalTask.description !== 'string' || !originalTask.description.trim() || Buffer.byteLength(originalTask.description) > 24000) reviewFail('REVIEW_SOURCE_TASK_CHANGED');
    const sourceTask = Object.fromEntries(['id', 'companyId', 'projectId', 'title', 'description'].map(key => [key, originalTask[key]]));
    journal = new ExecutionJournal({ directory: plan.main.journalDirectory, companyId: plan.companyId });
    const execution = journal.getExecution(association.executionId); boundSource(execution, association);
    const artifacts = new DeliveryArtifactStore({ directory: path.join(plan.directory, 'observations') });
    const fresh = await freshObservation({ plan, pipeline: { source: input }, execution, run, env, now, store: artifacts });
    if (fresh.delivery.patch.sha256 !== input.delivery.patch.sha256 || configurationHash(fresh.delivery.association) !== configurationHash(association)) reviewFail('REVIEW_SOURCE_ARTIFACT_CHANGED');
    pipeline = new ReviewPipeline({ directory: plan.pipelineDirectory });
    const seeded = pipeline.seed({ observation: fresh, patch, registration: plan.registration, implementationAgentId: plan.implementationAgentId, testCheckNames, maxRepairs, maxHandoffs, now: now() });
    const key = 'activation:' + seeded.pipeline.pipelineId, activation = bindings.begin(key, { approvedDispatch: true, boardUserId: actor, sourceConfigHash: plan.registration.configHash, policyHash: plan.registration.policyHash, sourceTask }, 'active');
    if (!activation.created && (!activation.record.data.approvedDispatch || activation.record.data.sourceConfigHash !== plan.registration.configHash || activation.record.data.policyHash !== plan.registration.policyHash || !isDeepStrictEqual(activation.record.data.sourceTask, sourceTask))) reviewFail('REVIEW_ACTIVATION_CHANGED');
    return { status: 'started', pipeline: summarize(seeded.pipeline), created: seeded.created, automaticBatchApproved: true, schedulerPaused: Boolean(scheduler?.settings().paused), evidenceVerified: false };
  } finally { pipeline?.close(); journal?.close(); bindings.close(); }
}
export function reviewStatus({ registry, repository }) {
  const plan = buildReviewPlan({ registry, repository });
  if (!fs.existsSync(path.join(plan.directory, 'role-bindings.sqlite'))) return { status: 'not_bootstrapped', roles: [], pipelines: [] };
  const store = new ReviewRoleBindings({ directory: plan.directory }); let pipeline;
  try {
    const roles = store.list().filter(row => row.key.startsWith('role:')).map(row => ({ role: row.key.slice(5), state: row.state, agentId: row.data.agentId ?? null }));
    const pipelines = fs.existsSync(path.join(plan.pipelineDirectory, 'review-pipeline.sqlite')) ? (pipeline = new ReviewPipeline({ directory: plan.pipelineDirectory })).list().map(row => ({ ...summarize(row), activation: store.get('activation:' + row.pipelineId)?.state ?? 'unapproved', jobs: pipeline.listJobs({ pipelineId: row.pipelineId }).map(job => ({ jobId: job.jobId, role: job.role, state: job.state, taskId: job.taskId, executionId: job.executionId, cloudTaskId: job.cloudTaskId, reasonCode: job.reasonCode })) })) : [];
    return { status: roles.some(row => row.state !== 'configured') || pipelines.some(row => ['needs_attention', 'escalated'].includes(row.state)) ? 'needs_attention' : 'configured', roles, pipelines, humanStatusUnchanged: true };
  } finally { pipeline?.close(); store.close(); }
}
export function setReviewPaused({ registry, repository, pipelineId, paused }) {
  const plan = buildReviewPlan({ registry, repository }), store = new ReviewRoleBindings({ directory: plan.directory });
  try {
    const record = store.get('activation:' + pipelineId); if (!record?.data.approvedDispatch) reviewFail('REVIEW_PIPELINE_NOT_APPROVED');
    if (record.state !== (paused ? 'paused' : 'active')) store.update(record, paused ? 'paused' : 'active', record.data);
    return { status: paused ? 'paused' : 'resumed', pipelineId, ambiguousWritesRetained: true };
  } finally { store.close(); }
}
async function checkoutForJob({ plan, pipeline, job, store, pc, gh }) {
  const a = job.source.delivery.association, root = `repos/${a.repository}`, project = await pc(['project', 'get', plan.projectId]);
  if (project?.id !== plan.projectId || project.companyId !== plan.companyId) reviewFail('REVIEW_PROJECT_SCOPE_CHANGED');
  let branch, expectedSha, mode;
  if (job.role === 'reviewer') { branch = plan.registration.config.defaultBranch; expectedSha = a.expectedBaseSha; mode = 'provided_patch_on_base'; }
  else {
    const pr = await gh(root + '/pulls/' + a.pullRequestNumber);
    if (pr?.number !== a.pullRequestNumber || pr.state !== 'open' || pr.draft || pr.head?.repo?.full_name?.toLowerCase() !== a.repository || pr.base?.repo?.full_name?.toLowerCase() !== a.repository || pr.base?.sha !== a.expectedBaseSha || pr.head?.sha !== a.expectedHeadSha || typeof pr.head.ref !== 'string') reviewFail('REVIEW_PR_HEAD_CHANGED');
    branch = pr.head.ref; expectedSha = a.expectedHeadSha; mode = 'exact_head';
  }
  const branchObservation = await gh(root + '/branches/' + encodeURIComponent(branch));
  if (branchObservation?.name !== branch || branchObservation.commit?.sha !== expectedSha) reviewFail('REVIEW_BRANCH_CHECKOUT_UNVERIFIED');
  const marker = { pipelineId: pipeline.pipelineId, jobId: job.jobId, repository: a.repository, sourceObservationId: job.source.observationId };
  const payload = { name: 'Factory ' + job.role + ': ' + job.jobId, sourceType: 'git_repo', repoUrl: 'https://github.com/' + a.repository, repoRef: branch, defaultRef: branch, isPrimary: false, metadata: { factoryReviewJob: marker } };
  const key = 'workspace:' + job.jobId, claimed = store.begin(key, { payload, marker }, 'planned'); let intent = claimed.record;
  if (!isDeepStrictEqual(intent.data.payload, payload)) reviewFail('REVIEW_CHECKOUT_INTENT_CHANGED');
  const rows = await pc(['project-workspace', 'list', plan.projectId]); if (!Array.isArray(rows)) reviewFail('REVIEW_INVALID_RESPONSE');
  const candidates = rows.filter(row => isDeepStrictEqual(row.metadata?.factoryReviewJob, marker)); if (candidates.length > 1) reviewFail('REVIEW_DUPLICATE_WORKSPACES');
  let workspace = intent.data.workspaceId ? rows.find(row => row.id === intent.data.workspaceId) : candidates[0];
  if (intent.data.workspaceId && !workspace) reviewFail('REVIEW_CHECKOUT_WORKSPACE_CHANGED');
  if (!workspace) {
    if (intent.state !== 'planned') reviewFail('REVIEW_WORKSPACE_CREATION_UNKNOWN');
    intent = store.update(intent, 'sending', intent.data);
    try { workspace = await pc(['project-workspace', 'create', plan.projectId, '--payload-json', JSON.stringify(payload)]); } catch { reviewFail('REVIEW_WORKSPACE_CREATION_UNKNOWN'); }
  }
  if (!UUID.test(workspace?.id ?? '') || workspace.companyId !== plan.companyId || workspace.projectId !== plan.projectId || !['sourceType', 'repoUrl', 'repoRef', 'defaultRef', 'isPrimary'].every(key => workspace[key] === payload[key]) || workspace.setupCommand || workspace.cleanupCommand || !isDeepStrictEqual(workspace.metadata?.factoryReviewJob, marker)) reviewFail('REVIEW_CHECKOUT_WORKSPACE_CHANGED');
  if (!intent.data.workspaceId) intent = store.update(intent, 'configured', { ...intent.data, workspaceId: workspace.id });
  return { mode, expectedSha, branch, workspaceId: workspace.id, branchObservation: { name: branchObservation.name, commit: { sha: branchObservation.commit.sha } } };
}
async function createOrRecoverTask({ plan, pipeline, job, store, commands }) {
  const current = pipeline.get(job.pipelineId), parent = await parentTask(commands.pc, plan, current, store.get('activation:' + current.pipelineId)?.data.sourceTask);
  if (job.state === 'planned') {
    const role = await verifyReviewRole({ plan, store, role: roleKey(job.role), pc: commands.pc }), checkout = await checkoutForJob({ plan, pipeline: current, job, store, ...commands }), actor = await board(commands.pc, plan.companyId);
    const findings = pipeline.listJobs({ pipelineId: job.pipelineId }).filter(row => row.result?.report && ['changes_requested', 'failed'].includes(row.result.report.outcome)).at(-1)?.result?.report;
    const payload = { companyId: plan.companyId, projectId: plan.projectId, assigneeAgentId: role.agentId, projectWorkspaceId: checkout.workspaceId, title: 'Factory ' + job.role + ': PR #' + job.source.delivery.association.pullRequestNumber, description: job.marker + '\nInspect the exact approved source and report bounded evidence.\n' + JSON.stringify({ repository: job.source.delivery.association.repository, baseSha: job.source.delivery.association.expectedBaseSha, headSha: job.source.delivery.association.expectedHeadSha, pullRequest: job.source.delivery.association.pullRequestUrl, approvedTask: store.get('activation:' + job.pipelineId)?.data.sourceTask, ...(findings ? { repairEvidence: findings } : {}) }), status: 'todo' };
    if (Buffer.byteLength(payload.description) > 24000) reviewFail('REVIEW_TASK_PAYLOAD_TOO_LARGE');
    renderReviewJobPrompt({ job: { ...job, checkout }, task: { ...payload, id: '00000000-0000-4000-8000-000000000000' }, config: role.spec.config, patch: pipeline.sourcePatch(job.jobId) });
    const claim = store.begin('task:' + job.jobId, { actorUserId: actor, parentId: parent.id, payloadHash: configurationHash(payload) }, 'sending');
    if (!claim.created) reviewFail('REVIEW_TASK_CREATION_UNKNOWN');
    job = pipeline.claimTaskCreation(job.jobId, { expectedRevision: job.revision, agentId: role.agentId, payload, checkout });
    let task;
    try { task = await commands.pc(['issue', 'child:create', parent.id, '--payload-json', JSON.stringify({ ...payload, blockParentUntilDone: false })]); }
    catch { job = pipeline.markTaskUnknown(job.jobId, { expectedRevision: job.revision, token: job.token }); reviewFail('REVIEW_TASK_CREATION_UNKNOWN'); }
    if (!taskMatches(task, job, parent.id, actor)) { pipeline.markTaskUnknown(job.jobId, { expectedRevision: job.revision, token: job.token }); reviewFail('REVIEW_TASK_CREATION_UNKNOWN'); }
    return pipeline.bindTask(job.jobId, { expectedRevision: job.revision, token: job.token, task });
  }
  const intent = store.get('task:' + job.jobId);
  if (!intent || intent.data.parentId !== parent.id) reviewFail('REVIEW_TASK_INTENT_MISSING');
  const rows = await commands.pc(['issue', 'list', '--company-id', plan.companyId, '--project-id', plan.projectId]); if (!Array.isArray(rows)) reviewFail('REVIEW_INVALID_RESPONSE');
  const candidates = rows.filter(row => taskMatches(row, job, parent.id, intent.data.actorUserId));
  if (candidates.length !== 1) reviewFail('REVIEW_TASK_CREATION_UNKNOWN');
  const task = await commands.pc(['issue', 'get', candidates[0].id]); if (!taskMatches(task, job, parent.id, intent.data.actorUserId)) reviewFail('REVIEW_TASK_CREATION_UNKNOWN');
  return pipeline.bindTask(job.jobId, { expectedRevision: job.revision, token: job.token, task });
}
async function wakePrequeue({ plan, pipeline, job, store, commands }) {
  if (job.executionId) return false;
  if (job.wake) { reviewFail(job.wake.state === 'delivered' ? 'REVIEW_WAKE_ALREADY_DELIVERED' : 'REVIEW_WAKE_OUTCOME_UNKNOWN'); }
  const role = await verifyReviewRole({ plan, store, role: roleKey(job.role), pc: commands.pc }), issue = await commands.pc(['issue', 'get', job.taskId]);
  if (pipeline.resolveTaskBinding(job.jobId, { task: issue, agentId: role.agentId }).status !== 'bound' || issue.assigneeUserId) reviewFail('REVIEW_TASK_SCOPE_CHANGED');
  const liveRuns = await commands.pc(['issue', 'live-runs', job.taskId]); if (!Array.isArray(liveRuns)) reviewFail('REVIEW_INVALID_RESPONSE'); if (liveRuns.length) return false;
  const ownerRun = issue.executionRunId ? await commands.pc(['run', 'get', issue.executionRunId]) : undefined;
  if (ownerRun && !TERMINAL.includes(ownerRun.status)) return false;
  job = pipeline.claimWake(job.jobId, { expectedRevision: job.revision, issue, liveRuns, ownerRun });
  try {
    const wake = await commands.pc(['agent', 'wake', role.agentId, '--payload', JSON.stringify({ issueId: job.taskId, factoryReviewJobId: job.jobId }), '--idempotency-key', 'factory-review:' + job.jobId]);
    pipeline.bindWake(job.jobId, { expectedRevision: job.revision, token: job.wake.token, run: wake }); return true;
  } catch { const latest = pipeline.getJob(job.jobId); if (latest.wake?.state === 'sending') pipeline.markWakeUnknown(job.jobId, { expectedRevision: latest.revision, token: latest.wake.token }); reviewFail('REVIEW_WAKE_OUTCOME_UNKNOWN'); }
}
async function approval({ plan, pipeline, current, journal, commands, run, env, now, store }) {
  const issue = await parentTask(commands.pc, plan, current, store.get('activation:' + current.pipelineId)?.data.sourceTask), actor = await board(commands.pc, plan.companyId);
  if (['approval_sending', 'approval_unknown'].includes(current.state)) {
    const rows = await commands.pc(['issue', 'interactions', issue.id]); if (!Array.isArray(rows)) reviewFail('REVIEW_INVALID_RESPONSE');
    const candidates = rows.filter(row => row.idempotencyKey === current.approval.payload.idempotencyKey);
    if (candidates.length !== 1) reviewFail('REVIEW_APPROVAL_OUTCOME_UNKNOWN');
    return pipeline.bindApproval(current.pipelineId, { expectedRevision: current.revision, token: current.approval.token, interaction: candidates[0], now: now() });
  }
  const a = current.source.delivery.association, execution = journal.getExecution(a.executionId); boundSource(execution, a);
  const repair = pipeline.listJobs({ pipelineId: current.pipelineId }).find(job => job.role === 'implementer' && job.executionId === execution.executionId);
  const fresh = await freshObservation({ plan, pipeline: current, execution, previous: repair?.source, run, env, now, store: new DeliveryArtifactStore({ directory: path.join(plan.directory, 'observations') }) });
  const key = 'factory-reviewed:' + current.pipelineId + ':' + a.expectedHeadSha;
  const payload = { kind: 'request_confirmation', idempotencyKey: key, continuationPolicy: 'none', resolverPolicy: 'human_only', payload: { version: 1, prompt: 'Review the verified factory delivery for human approval.', allowDeclineReason: true, detailsMarkdown: 'Independent review and QA reports have been collected. Required CI and configured test checks were freshly inspected for commit `' + a.expectedHeadSha + '`. Human approval does not merge or deploy.', target: { type: 'custom', key, href: a.pullRequestUrl } } };
  current = pipeline.claimApproval(current.pipelineId, { expectedRevision: current.revision, observation: fresh, boardUserId: actor, payload, now: now() });
  try { const interaction = await commands.pc(['issue', 'interaction:create', issue.id, '--payload-json', JSON.stringify(payload)]); return pipeline.bindApproval(current.pipelineId, { expectedRevision: current.revision, token: current.approval.token, interaction, now: now() }); }
  catch { const latest = pipeline.get(current.pipelineId); if (latest.state === 'approval_sending') pipeline.markApprovalUnknown(current.pipelineId, { expectedRevision: latest.revision, token: latest.approval.token, now: now() }); reviewFail('REVIEW_APPROVAL_OUTCOME_UNKNOWN'); }
}
function rotateAfter(rows, previous, key = value => value) {
  const index = rows.findIndex(value => key(value) === previous);
  return index < 0 ? rows : [...rows.slice(index + 1), ...rows.slice(0, index + 1)];
}
/** Observe a durable fair batch even while paused; assignments/wakes stay gated. */
export async function runReviewControllerOnce({ registry, scheduler, repository, run, env, now = () => new Date().toISOString(), shouldStop = () => false, maxPipelines = 10, maxJobs = 50, allowedRepositories } = {}) {
  if (!Number.isInteger(maxPipelines) || maxPipelines < 1 || maxPipelines > 100 || !Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 100) reviewFail('REVIEW_CONTROLLER_INVALID_LIMIT');
  const result = { status: 'idle', pipelines: [], createdTasks: [], collectedArtifacts: [], wakes: [], needsAttention: [], processedPipelines: 0, deferredPipelines: 0 };
  const registrations = repository ? [registry.get(repository)].filter(Boolean) : registry.list(), candidates = [];
  // Scan local state before selecting. No provider calls occur during inventory.
  for (const registration of registrations) {
    if (allowedRepositories && !allowedRepositories.includes(registration.repository)) continue;
    if (shouldStop()) break;
    let store, pipeline;
    try {
      const plan = buildReviewPlan({ registry, repository: registration.repository });
      if (path.resolve(plan.main.schedulerDirectory) !== path.resolve(scheduler.directory)) reviewFail('REVIEW_ACCOUNT_BINDING_CHANGED');
      if (!fs.existsSync(path.join(plan.directory, 'role-bindings.sqlite')) || !fs.existsSync(path.join(plan.pipelineDirectory, 'review-pipeline.sqlite'))) continue;
      store = new ReviewRoleBindings({ directory: plan.directory }); pipeline = new ReviewPipeline({ directory: plan.pipelineDirectory });
      const approved = pipeline.list().filter(row => store.get('activation:' + row.pipelineId)?.data.approvedDispatch);
      const active = approved.filter(row => !['human_approval_pending', 'escalated', 'needs_attention'].includes(row.state));
      for (const finished of approved.filter(row => !active.includes(row))) result.pipelines.push({ ...summarize(finished), activation: store.get('activation:' + finished.pipelineId).state });
      if (!active.length) continue;
      const cursor = store.get('controller:pipeline-cursor');
      if (cursor && (cursor.state !== 'ready' || cursor.data.pipelineId !== null && !UUID.test(cursor.data.pipelineId ?? ''))) reviewFail('REVIEW_CURSOR_INVALID');
      candidates.push({ plan, cursor, repository: registration.repository, pipelineIds: rotateAfter(active.map(row => row.pipelineId), cursor?.data.pipelineId) });
      result.deferredPipelines += active.length;
    } catch (error) { result.needsAttention.push({ repository: registration.repository, code: reviewSafeCode(error) }); }
    finally { pipeline?.close(); store?.close(); }
  }
  const selected = new Map();
  if (candidates.length && !shouldStop()) {
    let account;
    try {
      account = new ReviewRoleBindings({ directory: path.join(scheduler.directory, 'review-controller') });
      const cursor = account.begin('controller:repository-cursor', { repository: null }, 'ready').record;
      if (cursor.state !== 'ready' || cursor.data.repository !== null && typeof cursor.data.repository !== 'string') reviewFail('REVIEW_CURSOR_INVALID');
      const ordered = rotateAfter(candidates, cursor.data.repository, value => value.repository);
      let count = 0, lastRepository = null;
      for (let round = 0; count < maxPipelines; round++) {
        let progress = false;
        for (const item of ordered) {
          const id = item.pipelineIds[round]; if (!id) continue;
          const rows = selected.get(item.repository) ?? []; rows.push(id); selected.set(item.repository, rows);
          count++; progress = true; lastRepository = item.repository;
          if (count === maxPipelines) break;
        }
        if (!progress) break;
      }
      // CAS fences competing selection passes; a crash can defer work by one
      // rotation but cannot monopolize a row or authorize a repeated write.
      account.update(cursor, 'ready', { repository: lastRepository });
    } catch (error) { selected.clear(); result.needsAttention.push({ code: reviewSafeCode(error) }); }
    finally { account?.close(); }
  }
  for (const candidate of candidates) {
    const ids = selected.get(candidate.repository); if (!ids?.length || shouldStop()) continue;
    const { plan } = candidate, registration = plan.registration;
    let store, pipeline, journal;
    try {
      store = new ReviewRoleBindings({ directory: plan.directory }); pipeline = new ReviewPipeline({ directory: plan.pipelineDirectory });
      let cursor = store.get('controller:pipeline-cursor');
      if (!isDeepStrictEqual(cursor, candidate.cursor)) reviewFail('REVIEW_INTENT_STALE');
      if (!cursor) { const claim = store.begin('controller:pipeline-cursor', { pipelineId: null }, 'ready'); if (!claim.created) reviewFail('REVIEW_INTENT_STALE'); cursor = claim.record; }
      existing(path.join(plan.main.journalDirectory, JOURNAL_FILENAME), Number.MAX_SAFE_INTEGER); journal = new ExecutionJournal({ directory: plan.main.journalDirectory, companyId: plan.companyId });
      const commands = reviewCommands(plan, run, env, shouldStop);
      for (const pipelineId of ids) {
        if (shouldStop()) break;
        let current = pipeline.get(pipelineId);
        try {
          if (!current) reviewFail('REVIEW_PIPELINE_MISSING');
          if (cursor.state !== 'ready' || cursor.data.pipelineId !== null && !UUID.test(cursor.data.pipelineId ?? '')) reviewFail('REVIEW_CURSOR_INVALID');
          cursor = store.update(cursor, 'ready', { pipelineId });
          result.processedPipelines++; result.deferredPipelines--;
          const activation = store.get('activation:' + current.pipelineId);
          if (!activation?.data.approvedDispatch || !activation.data.sourceTask || activation.data.sourceConfigHash !== plan.registration.configHash || activation.data.policyHash !== plan.registration.policyHash) reviewFail('REVIEW_ACTIVATION_CHANGED');
          const jobs = pipeline.listJobs({ pipelineId: current.pipelineId }).filter(job => !['result_recorded', 'needs_attention'].includes(job.state)); if (jobs.length > maxJobs) reviewFail('REVIEW_JOB_LIMIT');
          for (let job of jobs) {
            if (shouldStop()) break;
            try {
              if (job.state === 'task_bound' && !job.executionId) {
                const queued = journal.get(job.taskId, 1);
                if (queued) {
                  if (queued.state !== 'queued' || queued.cloudTaskId) reviewFail('REVIEW_UNBOUND_EXECUTION_UNVERIFIED');
                  const owner = await commands.pc(['run', 'get', queued.paperclipRunId]);
                  if (owner?.id !== queued.paperclipRunId || owner.agentId !== job.agentId || owner.companyId !== plan.companyId || owner.contextSnapshot?.issueId !== job.taskId) reviewFail('REVIEW_UNBOUND_EXECUTION_UNVERIFIED');
                  try { job = pipeline.bindExecution(job.jobId, { expectedRevision: job.revision, execution: queued, now: now() }); }
                  catch (error) { const currentJob = pipeline.getJob(job.jobId); if (currentJob.executionId !== queued.executionId) throw error; job = currentJob; }
                }
              }
              if (job.executionId && !['result_recorded', 'needs_attention'].includes(job.state)) {
                const execution = journal.getExecution(job.executionId); if (!execution) reviewFail('REVIEW_EXECUTION_MISSING');
                if (!isDeepStrictEqual(execution, job.execution)) job = pipeline.observeExecution(job.jobId, { expectedRevision: job.revision, execution, now: now() });
              }
              if (job.state === 'artifact_pending') {
                if ((await commands.codex(['--version'])).trim() !== 'codex-cli 0.166.0') reviewFail('REVIEW_CODEX_VERSION_CHANGED');
                const diff = await commands.codex(['cloud', 'diff', job.cloudTaskId, '--attempt', '1']);
                const accepted = pipeline.acceptArtifact(job.jobId, { expectedRevision: job.revision, patch: diff, now: now() }); result.collectedArtifacts.push({ jobId: job.jobId, status: accepted.job.state, evidenceVerified: false }); job = accepted.job;
              }
              if (job.state === 'repair_delivery_pending') {
                const a = job.source.delivery.association, pr = await commands.gh(`repos/${a.repository}/pulls/${a.pullRequestNumber}`);
                if (pr.head?.sha === a.expectedHeadSha) reviewFail('REVIEW_REPAIR_AWAITS_PUBLICATION');
                const fresh = await freshObservation({ plan, pipeline: pipeline.get(current.pipelineId), execution: journal.getExecution(job.executionId), previous: job.source, headSha: pr.head?.sha, run, env, now, store: new DeliveryArtifactStore({ directory: path.join(plan.directory, 'observations') }) });
                const patchFile = fresh.patchArtifact?.path; existing(patchFile, 1_000_000);
                pipeline.acceptRepairDelivery(current.pipelineId, { expectedRevision: pipeline.get(current.pipelineId).revision, jobId: job.jobId, observation: fresh, patch: fs.readFileSync(patchFile, 'utf8'), now: now() });
              }
              const paused = activation.state !== 'active' || scheduler.settings().paused;
              if ((!paused || job.state !== 'planned') && ['planned', 'task_sending', 'task_unknown'].includes(job.state)) { const recovered = job.state !== 'planned'; job = await createOrRecoverTask({ plan, pipeline, job, store, commands }); result.createdTasks.push({ jobId: job.jobId, taskId: job.taskId, recovered }); }
              if (!paused && job.state === 'task_bound' && !job.executionId) { if (await wakePrequeue({ plan, pipeline, job, store, commands })) result.wakes.push({ jobId: job.jobId, taskId: job.taskId }); }
            } catch (error) { result.needsAttention.push({ repository: registration.repository, pipelineId: current.pipelineId, jobId: job.jobId, code: reviewSafeCode(error) }); }
          }
          current = pipeline.get(current.pipelineId);
          if (['gates_pending', 'approval_sending', 'approval_unknown'].includes(current.state)) {
            try { current = await approval({ plan, pipeline, current, journal, commands, run, env, now, store }); }
            catch (error) { result.needsAttention.push({ pipelineId: current.pipelineId, code: reviewSafeCode(error) }); }
          }
        } catch (error) { result.needsAttention.push({ repository: registration.repository, pipelineId, code: reviewSafeCode(error) }); }
        current = pipeline.get(pipelineId);
        if (current) result.pipelines.push({ ...summarize(current), activation: store.get('activation:' + pipelineId)?.state ?? 'unapproved' });
      }
    } catch (error) { result.needsAttention.push({ repository: registration.repository, code: reviewSafeCode(error) }); }
    finally { journal?.close(); pipeline?.close(); store?.close(); }
  }
  result.status = result.needsAttention.length || result.pipelines.some(row => ['needs_attention', 'escalated'].includes(row.state)) ? 'needs_attention' : result.deferredPipelines || result.pipelines.some(row => !['human_approval_pending', 'escalated', 'needs_attention'].includes(row.state)) ? 'running' : 'idle'; return result;
}
/** Trusted local resolver used by the account queue wake outbox, never task strings. */
export function resolveReviewQueuedProfile({ registry, repository, record }) {
  const plan = buildReviewPlan({ registry, repository });
  if (!fs.existsSync(path.join(plan.directory, 'role-bindings.sqlite')) || !fs.existsSync(path.join(plan.pipelineDirectory, 'review-pipeline.sqlite'))) return null;
  const store = new ReviewRoleBindings({ directory: plan.directory }), pipeline = new ReviewPipeline({ directory: plan.pipelineDirectory });
  try {
    const jobs = pipeline.listJobs().filter(job => job.executionId === record.executionId); if (!jobs.length) return null; if (jobs.length !== 1) reviewFail('REVIEW_EXECUTION_BINDING_CHANGED');
    const job = jobs[0], activation = store.get('activation:' + job.pipelineId), binding = store.get('role:' + roleKey(job.role));
    if (activation?.state === 'paused') reviewFail('REVIEW_PIPELINE_PAUSED');
    if (!activation?.data.approvedDispatch || activation.state !== 'active' || activation.data.sourceConfigHash !== plan.registration.configHash || activation.data.policyHash !== plan.registration.policyHash || binding?.state !== 'configured' || binding.data.agentId !== job.agentId || job.taskId !== record.paperclipIssueId || job.checkout?.workspaceId !== record.workspaceId || job.checkout?.branch !== record.branch || !job.execution || ['companyId', 'paperclipIssueId', 'projectId', 'workspaceId', 'repository', 'environmentId', 'branch', 'mode', 'attempt'].some(key => job.execution[key] !== record[key]) || job.source.context.configHash !== plan.registration.configHash || job.source.context.policyHash !== plan.registration.policyHash) reviewFail('REVIEW_QUEUED_BINDING_CHANGED');
    const spec = roleSpec(plan, roleKey(job.role), binding.data.bindingId); existing(spec.configPath, 128000);
    if (!isDeepStrictEqual(validateProjectConfig(JSON.parse(fs.readFileSync(spec.configPath))), spec.config)) reviewFail('REVIEW_ROLE_BINDING_CHANGED');
    const config = validateProjectConfig({ ...spec.config, workspaceId: job.checkout.workspaceId, branch: job.checkout.branch, factoryConfig: { ...spec.config.factoryConfig, defaultBranch: job.checkout.branch } });
    return { config, agentId: job.agentId, adapterConfig: spec.adapterConfig, heartbeat: spec.runtimeConfig.heartbeat, metadataKey: 'factoryReview', metadata: spec.marker, parentConstraint: activation.data.sourceTask, validateTask: task => { const projection = { companyId: task.companyId, projectId: task.projectId, assigneeAgentId: task.assigneeAgentId, projectWorkspaceId: task.projectWorkspaceId ?? null, title: task.title, description: task.description }; if (task.id !== job.taskId || task.assigneeUserId || !isDeepStrictEqual(projection, job.taskPayload)) reviewFail('REVIEW_TASK_SCOPE_CHANGED'); } };
  } finally { pipeline.close(); store.close(); }
}
