import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { DeliveryArtifactStore } from './delivery-artifacts.mjs';
import { summarizeDeliveryPatch } from './github-delivery.mjs';
import { parseRoleArtifactDiff } from './review-artifact.mjs';
import { JOURNAL_SCHEMA_VERSION } from './execution-journal.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{40}$/, HASH = /^[a-f0-9]{64}$/, CLOUD = /^task_e_[a-f0-9]{32}$/;
const APP = 0x46525031;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export class ReviewPipelineError extends Error {
  constructor(code) { super('REVIEW_PIPELINE_' + code); this.name = 'ReviewPipelineError'; this.code = 'REVIEW_PIPELINE_' + code; }
}
const fail = code => { throw new ReviewPipelineError(code); };
function uuid(value) { if (!UUID.test(value ?? '')) fail('INVALID_IDENTIFIER'); return value; }
function integer(value, min, max) { if (!Number.isInteger(value) || value < min || value > max) fail('INVALID_LIMIT'); return value; }
function timestamp(value = new Date().toISOString()) { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail('INVALID_TIMESTAMP'); return new Date(value).toISOString(); }
function copy(value, maximum = 2_000_000) { let text; try { text = JSON.stringify(value); } catch { fail('INVALID_DATA'); } if (!text || Buffer.byteLength(text) > maximum) fail('DATA_TOO_LARGE'); return JSON.parse(text); }
function text(value, maximum) { if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value) > maximum) fail('INVALID_DATA'); return value; }
function actor(value) { if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 200 || /[\u0000-\u001f\u007f]/.test(value)) fail('INVALID_BOARD_ACTOR'); return value; }
function syncDirectory(directory) { const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function observation(input, patch, at, maxAgeMs = 60_000) {
  const source = copy(input), delivery = source.delivery, a = delivery?.association, context = source.context;
  if (source.schemaVersion !== 1 || !UUID.test(source.observationId ?? '') || !HASH.test(context?.configHash ?? '') || !HASH.test(context?.policyHash ?? '') || context?.journalSchemaVersion !== JOURNAL_SCHEMA_VERSION || !Number.isInteger(context.executionRevision) || context.executionRevision < 0 || !a || ['executionId', 'companyId', 'paperclipIssueId', 'paperclipRunId', 'projectId'].some(key => !UUID.test(a[key] ?? '')) || !CLOUD.test(a.cloudTaskId ?? '') || a.cloudTaskUrl !== 'https://chatgpt.com/remote/' + a.cloudTaskId || !Number.isInteger(a.attempt) || a.attempt < 1 || a.attempt > 100) fail('INVALID_DELIVERY_OBSERVATION');
  if (typeof a.repository !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(a.repository) || !SHA.test(a.expectedBaseSha ?? '') || !SHA.test(a.expectedHeadSha ?? '') || !Number.isSafeInteger(a.pullRequestNumber) || a.pullRequestNumber < 1 || a.pullRequestUrl !== `https://github.com/${a.repository}/pull/${a.pullRequestNumber}` || !/^[a-f0-9]{32}$/.test(a.environmentId ?? '') || typeof a.requestedBranch !== 'string') fail('INVALID_DELIVERY_OBSERVATION');
  const p = delivery.provenance;
  if (delivery.status !== 'ready_for_independent_review' || p?.verified !== true || p.baseSha !== a.expectedBaseSha || p.headSha !== a.expectedHeadSha || p.mergeBaseSha !== a.expectedBaseSha || !HASH.test(delivery.patch?.sha256 ?? '') || p.githubPatchSha256 !== delivery.patch.sha256 || source.patchArtifact?.sha256 !== delivery.patch.sha256 || !path.isAbsolute(source.patchArtifact?.path ?? '') || delivery.checks?.state !== 'passed' || !Array.isArray(delivery.checks.required) || !delivery.checks.required.length || delivery.checks.required.some(row => row.state !== 'passed')) fail('DELIVERY_GATES_UNVERIFIED');
  if (p.comparison === 'exact_complete_text_diff') {
    if (p.cloudPatchSha256 !== delivery.patch.sha256) fail('DELIVERY_GATES_UNVERIFIED');
  } else if (p.comparison === 'exact_incremental_text_diff_with_full_pr') {
    const delta = p.incremental;
    if (p.fullPrPatchSha256 !== delivery.patch.sha256 || delta?.verified !== true || !SHA.test(delta.previousHeadSha ?? '') || delta.newHeadSha !== a.expectedHeadSha || delta.mergeBaseSha !== delta.previousHeadSha || !UUID.test(delta.previousObservationId ?? '') || !UUID.test(delta.previousExecutionId ?? '') || !HASH.test(delta.previousPatchSha256 ?? '') || !HASH.test(delta.cloudPatchSha256 ?? '') || delta.githubDeltaPatchSha256 !== delta.cloudPatchSha256 || delivery.deltaPatch?.sha256 !== delta.cloudPatchSha256 || source.deltaArtifact?.sha256 !== delta.cloudPatchSha256 || !path.isAbsolute(source.deltaArtifact?.path ?? '') || delta.deltaArtifact && (delta.deltaArtifact.sha256 !== source.deltaArtifact.sha256 || delta.deltaArtifact.path !== source.deltaArtifact.path)) fail('DELIVERY_GATES_UNVERIFIED');
  } else fail('DELIVERY_GATES_UNVERIFIED');
  const observedAt = timestamp(source.observedAt);
  if (delivery.observedAt !== observedAt || Date.parse(at) < Date.parse(observedAt) || Date.parse(at) - Date.parse(observedAt) > maxAgeMs) fail('DELIVERY_OBSERVATION_STALE');
  if (patch !== undefined) {
    const summary = summarizeDeliveryPatch(patch);
    if (summary.sha256 !== delivery.patch.sha256 || summary.bytes !== delivery.patch.bytes) fail('SOURCE_PATCH_CHANGED');
  }
  return source;
}
function taskProjection(task) {
  return { companyId: task.companyId, projectId: task.projectId, assigneeAgentId: task.assigneeAgentId, projectWorkspaceId: task.projectWorkspaceId ?? null, title: task.title, description: task.description };
}
function pipelinePlain(row) {
  return row ? { pipelineId: row.id, revision: row.revision, state: row.state, source: JSON.parse(row.source_json), initialSource: JSON.parse(row.initial_source_json), implementationAgentId: row.implementation_agent_id, maxRepairs: row.max_repairs, maxHandoffs: row.max_handoffs, repairs: row.repairs, handoffs: row.handoffs, testCheckNames: JSON.parse(row.test_checks_json), approval: row.approval_json ? JSON.parse(row.approval_json) : null, reasonCode: row.reason_code, createdAt: row.created_at, updatedAt: row.updated_at } : null;
}
function jobPlain(row) {
  return row ? { jobId: row.id, pipelineId: row.pipeline_id, revision: row.revision, role: row.role, round: row.round, state: row.state, marker: 'Factory review job: ' + row.id, agentId: row.agent_id, token: row.token, taskId: row.task_id, taskPayload: row.task_json ? JSON.parse(row.task_json) : null, checkout: row.checkout_json ? JSON.parse(row.checkout_json) : null, wake: row.wake_json ? JSON.parse(row.wake_json) : null, executionId: row.execution_id, cloudTaskId: row.cloud_task_id, execution: row.execution_json ? JSON.parse(row.execution_json) : null, source: JSON.parse(row.source_json), result: row.result_json ? JSON.parse(row.result_json) : null, reasonCode: row.reason_code, createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

/** Trusted controllers supply inspected delivery observations, never agent gate flags. */
export class ReviewPipeline {
  constructor({ directory }) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || /[\0\r\n]/.test(directory)) fail('INVALID_DIRECTORY');
    this.directory = path.resolve(directory);
    const first = fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(this.directory); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_STORAGE');
    fs.chmodSync(this.directory, 0o700);
    if (first) for (let cursor = this.directory;; cursor = path.dirname(cursor)) { syncDirectory(cursor); syncDirectory(path.dirname(cursor)); if (cursor === first) break; }
    const filename = path.join(this.directory, 'review-pipeline.sqlite');
    let fd; try { fd = fs.openSync(filename, 'wx', 0o600); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; syncDirectory(this.directory); }
    catch (error) { if (fd !== undefined) fs.closeSync(fd); if (error.code !== 'EEXIST') throw error; }
    if (!fs.lstatSync(filename).isFile() || fs.lstatSync(filename).isSymbolicLink()) fail('UNSAFE_STORAGE');
    fs.chmodSync(filename, 0o600);
    this.db = new DatabaseSync(filename, { timeout: 5000 });
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON;');
      this.transaction(() => {
        const version = this.db.prepare('PRAGMA user_version').get().user_version, app = this.db.prepare('PRAGMA application_id').get().application_id;
        if (version > 1 || app && app !== APP || version && app !== APP || !version && this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length) fail('MIGRATION_REQUIRED');
        this.db.exec(`CREATE TABLE IF NOT EXISTS pipelines (
          id TEXT PRIMARY KEY, seed_key TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL, state TEXT NOT NULL,
          source_json TEXT NOT NULL, initial_source_json TEXT NOT NULL, implementation_agent_id TEXT NOT NULL,
          max_repairs INTEGER NOT NULL, max_handoffs INTEGER NOT NULL, repairs INTEGER NOT NULL, handoffs INTEGER NOT NULL,
          test_checks_json TEXT NOT NULL, approval_json TEXT, reason_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        ); CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY, pipeline_id TEXT NOT NULL REFERENCES pipelines(id), revision INTEGER NOT NULL,
          role TEXT NOT NULL, round INTEGER NOT NULL, state TEXT NOT NULL, agent_id TEXT, token TEXT,
          task_id TEXT UNIQUE, task_json TEXT, checkout_json TEXT, wake_json TEXT, execution_id TEXT UNIQUE, cloud_task_id TEXT UNIQUE,
          execution_json TEXT, source_json TEXT NOT NULL, result_json TEXT, reason_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          UNIQUE(pipeline_id,round,role)
        ); PRAGMA user_version=1; PRAGMA application_id=${APP};`);
      });
      this.db.exec('PRAGMA journal_mode=WAL;'); syncDirectory(this.directory);
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  transaction(action) { this.db.exec('BEGIN IMMEDIATE'); try { const result = action(); this.db.exec('COMMIT'); return result; } catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error instanceof ReviewPipelineError ? error : new ReviewPipelineError('WRITE_FAILED'); } }
  get(id) { return pipelinePlain(this.db.prepare('SELECT * FROM pipelines WHERE id=?').get(uuid(id))); }
  list() { return this.db.prepare('SELECT * FROM pipelines ORDER BY created_at,rowid').all().map(pipelinePlain); }
  getJob(id) { return jobPlain(this.db.prepare('SELECT * FROM jobs WHERE id=?').get(uuid(id))); }
  getJobByTask(taskId) { return jobPlain(this.db.prepare('SELECT * FROM jobs WHERE task_id=?').get(uuid(taskId))); }
  listJobs({ pipelineId, states } = {}) {
    if (pipelineId) uuid(pipelineId);
    return this.db.prepare('SELECT * FROM jobs ORDER BY created_at,rowid').all().map(jobPlain).filter(job => (!pipelineId || job.pipelineId === pipelineId) && (!states || states.includes(job.state)));
  }
  #job(id, revision) { integer(revision, 0, Number.MAX_SAFE_INTEGER); const job = this.getJob(id); if (!job) fail('JOB_NOT_FOUND'); if (job.revision !== revision) fail('STALE_JOB'); return job; }
  #updateJob(job, fields, at) {
    const mapping = { state: 'state', agentId: 'agent_id', token: 'token', taskId: 'task_id', taskPayload: 'task_json', checkout: 'checkout_json', wake: 'wake_json', executionId: 'execution_id', cloudTaskId: 'cloud_task_id', execution: 'execution_json', result: 'result_json', reasonCode: 'reason_code' };
    const entries = Object.entries(fields);
    const values = entries.map(([key, value]) => ['taskPayload', 'checkout', 'wake', 'execution', 'result'].includes(key) && value !== null ? JSON.stringify(value) : value);
    const result = this.db.prepare(`UPDATE jobs SET revision=revision+1,updated_at=?,${entries.map(([key]) => mapping[key] + '=?').join(',')} WHERE id=? AND revision=?`).run(at, ...values, job.jobId, job.revision);
    if (result.changes !== 1) fail('STALE_JOB'); return this.getJob(job.jobId);
  }
  #updatePipeline(pipeline, fields, at) {
    const mapping = { state: 'state', source: 'source_json', repairs: 'repairs', handoffs: 'handoffs', approval: 'approval_json', reasonCode: 'reason_code' };
    const entries = Object.entries(fields), values = entries.map(([key, value]) => ['source', 'approval'].includes(key) && value !== null ? JSON.stringify(value) : value);
    const result = this.db.prepare(`UPDATE pipelines SET revision=revision+1,updated_at=?,${entries.map(([key]) => mapping[key] + '=?').join(',')} WHERE id=? AND revision=?`).run(at, ...values, pipeline.pipelineId, pipeline.revision);
    if (result.changes !== 1) fail('STALE_PIPELINE'); return this.get(pipeline.pipelineId);
  }
  #newJob(pipeline, role, round, at) {
    if (pipeline.handoffs >= pipeline.maxHandoffs) { this.#updatePipeline(pipeline, { state: 'escalated', reasonCode: 'HANDOFF_BUDGET_EXHAUSTED' }, at); return null; }
    const id = randomUUID();
    this.db.prepare("INSERT INTO jobs(id,pipeline_id,revision,role,round,state,source_json,created_at,updated_at) VALUES(?,?,0,?,?,'planned',?,?,?)").run(id, pipeline.pipelineId, role, round, JSON.stringify(pipeline.source), at, at);
    this.#updatePipeline(pipeline, { handoffs: pipeline.handoffs + 1 }, at); return this.getJob(id);
  }
  sourcePatch(jobId) {
    const job = this.getJob(jobId); if (!job) fail('JOB_NOT_FOUND');
    const filename = path.join(this.directory, 'source-artifacts', 'patches', job.source.delivery.patch.sha256 + '.patch');
    const stat = fs.lstatSync(filename); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_000_000) fail('SOURCE_PATCH_UNAVAILABLE');
    const patch = fs.readFileSync(filename, 'utf8'); if (hash(patch) !== job.source.delivery.patch.sha256) fail('SOURCE_PATCH_CHANGED'); return patch;
  }
  seed({ observation: input, patch, registration, implementationAgentId, maxRepairs = 2, maxHandoffs = 8, testCheckNames = [], now } = {}) {
    const at = timestamp(now), source = observation(input, patch, at); uuid(implementationAgentId); integer(maxRepairs, 0, 99); integer(maxHandoffs, 1, 100);
    if (!Array.isArray(testCheckNames) || new Set(testCheckNames).size !== testCheckNames.length || testCheckNames.length > 50 || testCheckNames.some(name => !source.delivery.checks.required.some(row => row.name === name))) fail('TEST_GATE_NOT_CONFIGURED');
    const a = source.delivery.association, key = hash([a.executionId, a.repository, a.pullRequestNumber, a.expectedBaseSha, a.expectedHeadSha, source.context.configHash, source.context.policyHash, source.delivery.patch.sha256]);
    if (!registration || registration.repository !== a.repository || registration.configHash !== source.context.configHash || registration.policyHash !== source.context.policyHash || registration.config?.cloud?.environmentId !== a.environmentId || registration.config?.defaultBranch !== (a.deliveryBaseBranch ?? a.requestedBranch) || JSON.stringify([...registration.config.delivery.requiredChecks].sort()) !== JSON.stringify(source.delivery.checks.required.map(row => row.name).sort()) || maxRepairs > Math.min(registration.config.concurrency.maxAttempts, registration.policy?.concurrency?.maxAttempts ?? 0) - 1) fail('REGISTERED_POLICY_BINDING_CHANGED');
    new DeliveryArtifactStore({ directory: path.join(this.directory, 'source-artifacts') }).capturePatch({ patch, summary: source.delivery.patch, association: a });
    return this.transaction(() => {
      const old = pipelinePlain(this.db.prepare('SELECT * FROM pipelines WHERE seed_key=?').get(key));
      if (old) { if (old.implementationAgentId !== implementationAgentId || old.maxRepairs !== maxRepairs || old.maxHandoffs !== maxHandoffs || JSON.stringify(old.testCheckNames) !== JSON.stringify(testCheckNames)) fail('SEED_POLICY_CHANGED'); return { created: false, pipeline: old, job: this.listJobs({ pipelineId: old.pipelineId })[0] }; }
      const id = randomUUID();
      this.db.prepare("INSERT INTO pipelines VALUES(?,?,0,'review_pending',?,?,?,?,?,0,0,?,NULL,NULL,?,?)").run(id, key, JSON.stringify(source), JSON.stringify(source), implementationAgentId, maxRepairs, maxHandoffs, JSON.stringify(testCheckNames), at, at);
      const job = this.#newJob(this.get(id), 'reviewer', 0, at); return { created: true, pipeline: this.get(id), job };
    });
  }
  claimTaskCreation(jobId, { expectedRevision, agentId, payload, checkout: checkoutInput, now } = {}) {
    const at = timestamp(now); uuid(agentId); const body = copy(payload, 32_000), checkout = copy(checkoutInput, 8_000);
    return this.transaction(() => {
      const job = this.#job(jobId, expectedRevision), pipeline = this.get(job.pipelineId), a = job.source.delivery.association;
      if (job.state !== 'planned') fail('TASK_CREATION_ALREADY_CLAIMED');
      if (job.role !== 'implementer' && (agentId === pipeline.implementationAgentId || this.listJobs({ pipelineId: job.pipelineId }).some(other => other.role !== job.role && other.role !== 'implementer' && other.agentId === agentId))) fail('INDEPENDENT_AGENT_REQUIRED');
      const expectedSha = job.role === 'reviewer' && checkout.mode === 'provided_patch_on_base' ? a.expectedBaseSha : a.expectedHeadSha;
      if (!['provided_patch_on_base', 'exact_head'].includes(checkout.mode) || job.role !== 'reviewer' && checkout.mode !== 'exact_head' || checkout.expectedSha !== expectedSha || typeof checkout.branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(checkout.branch) || /\.\.|\/\/|\/$|\.$|\.lock(?:\/|$)|\/\./.test(checkout.branch) || !UUID.test(checkout.workspaceId ?? '') || checkout.branchObservation?.name !== checkout.branch || checkout.branchObservation.commit?.sha !== checkout.expectedSha || body.projectWorkspaceId !== checkout.workspaceId) fail('CHECKOUT_BINDING_UNVERIFIED');
      text(body.title, 500); text(body.description, 24_000);
      if (body.companyId !== a.companyId || body.projectId !== a.projectId || body.assigneeAgentId !== agentId || body.assigneeUserId || body.status !== 'todo' || body.description.split('\n').filter(line => line === job.marker).length !== 1 || body.projectWorkspaceId !== undefined && !UUID.test(body.projectWorkspaceId)) fail('TASK_PAYLOAD_BINDING_CHANGED');
      return this.#updateJob(job, { state: 'task_sending', agentId, token: randomUUID(), taskPayload: taskProjection(body), checkout }, at);
    });
  }
  #ownedTask(job, token) { if (!['task_sending', 'task_unknown'].includes(job.state) || job.token !== token) fail('TASK_OWNER_CHANGED'); }
  bindTask(jobId, { expectedRevision, token, task, now } = {}) {
    const at = timestamp(now); uuid(task?.id);
    return this.transaction(() => {
      const job = this.#job(jobId, expectedRevision); this.#ownedTask(job, token);
      if (hash(taskProjection(task)) !== hash(job.taskPayload) || !['todo', 'in_progress'].includes(task.status)) fail('TASK_PAYLOAD_BINDING_CHANGED');
      return this.#updateJob(job, { state: 'task_bound', taskId: task.id }, at);
    });
  }
  markTaskUnknown(jobId, { expectedRevision, token, now } = {}) { const at = timestamp(now); return this.transaction(() => { const job = this.#job(jobId, expectedRevision); this.#ownedTask(job, token); return this.#updateJob(job, { state: 'task_unknown', reasonCode: 'TASK_CREATION_UNKNOWN' }, at); }); }
  resolveTaskBinding(jobId, { task, agentId } = {}) {
    const job = this.getJob(jobId); if (!job) fail('JOB_NOT_FOUND');
    if (job.agentId !== agentId || !job.taskPayload || hash(taskProjection(task)) !== hash(job.taskPayload)) fail('TASK_PAYLOAD_BINDING_CHANGED');
    if (!job.taskId) return { status: 'binding_pending', job };
    if (job.taskId !== task.id) fail('TASK_PAYLOAD_BINDING_CHANGED');
    return { status: 'bound', job };
  }
  claimWake(jobId, { expectedRevision, issue, liveRuns, ownerRun, now } = {}) {
    const at = timestamp(now);
    return this.transaction(() => {
      const job = this.#job(jobId, expectedRevision);
      if (job.state !== 'task_bound' || job.executionId || job.wake) fail('WAKE_ALREADY_CLAIMED');
      if (issue?.id !== job.taskId || hash(taskProjection(issue)) !== hash(job.taskPayload) || !['todo', 'in_progress'].includes(issue.status) || !Array.isArray(liveRuns) || liveRuns.length) fail('WAKE_SCOPE_CHANGED');
      if (issue.executionRunId && (!ownerRun || ownerRun.id !== issue.executionRunId)) fail('WAKE_OWNER_UNVERIFIED');
      if (ownerRun && (!UUID.test(ownerRun.id ?? '') || ownerRun.companyId !== issue.companyId || ownerRun.agentId !== job.agentId || ownerRun.contextSnapshot?.issueId !== job.taskId || !['succeeded', 'failed', 'cancelled', 'timed_out'].includes(ownerRun.status))) fail('WAKE_OWNER_UNVERIFIED');
      return this.#updateJob(job, { wake: { state: 'sending', token: randomUUID(), requestedAt: at } }, at);
    });
  }
  #wakeJob(job, token) { if (!['sending', 'unknown'].includes(job.wake?.state) || job.wake.token !== token) fail('WAKE_OWNER_CHANGED'); }
  bindWake(jobId, { expectedRevision, token, run, now } = {}) {
    const at = timestamp(now); uuid(run?.id);
    return this.transaction(() => {
      const job = this.#job(jobId, expectedRevision); this.#wakeJob(job, token);
      if (run.companyId !== job.source.delivery.association.companyId || run.agentId !== job.agentId || run.contextSnapshot?.issueId !== job.taskId) fail('WAKE_SCOPE_CHANGED');
      return this.#updateJob(job, { wake: { ...job.wake, state: 'delivered', runId: run.id } }, at);
    });
  }
  markWakeUnknown(jobId, { expectedRevision, token, now } = {}) {
    const at = timestamp(now);
    return this.transaction(() => { const job = this.#job(jobId, expectedRevision); this.#wakeJob(job, token); return this.#updateJob(job, { wake: { ...job.wake, state: 'unknown' }, reasonCode: 'WAKE_OUTCOME_UNKNOWN' }, at); });
  }
  #execution(job, execution) {
    const a = job.source.delivery.association;
    if (['executionId', 'paperclipRunId'].some(key => !UUID.test(execution?.[key] ?? '')) || !Number.isInteger(execution.revision) || execution.revision < 0 || execution.companyId !== a.companyId || execution.paperclipIssueId !== job.taskId || execution.projectId !== a.projectId || execution.workspaceId !== job.checkout?.workspaceId || execution.branch !== job.checkout?.branch || execution.mode !== 'code_change' || execution.repository?.toLowerCase() !== a.repository.toLowerCase() || execution.environmentId !== a.environmentId || !Number.isInteger(execution.attempt) || execution.attempt !== 1) fail('EXECUTION_BINDING_CHANGED');
    if (job.executionId && job.executionId !== execution.executionId) fail('EXECUTION_BINDING_CHANGED');
    if (execution.cloudTaskId && (!CLOUD.test(execution.cloudTaskId) || execution.cloudTaskId === job.source.delivery.association.cloudTaskId || execution.cloudTaskId === this.get(job.pipelineId).initialSource.delivery.association.cloudTaskId || job.cloudTaskId && execution.cloudTaskId !== job.cloudTaskId)) fail('INDEPENDENT_CLOUD_REQUIRED');
    if (execution.cloudTaskId && (execution.taskUrl !== 'https://chatgpt.com/remote/' + execution.cloudTaskId || !['https://chatgpt.com/codex/tasks/' + execution.cloudTaskId, 'https://chatgpt.com/remote/' + execution.cloudTaskId].includes(execution.emittedUrl))) fail('EXECUTION_BINDING_CHANGED');
  }
  bindExecution(jobId, { expectedRevision, execution, now } = {}) {
    const at = timestamp(now);
    return this.transaction(() => {
      const job = this.#job(jobId, expectedRevision); if (job.state !== 'task_bound' || execution?.state !== 'queued' || execution.cloudTaskId) fail('EXECUTION_NOT_QUEUED');
      this.#execution(job, execution); return this.#updateJob(job, { state: 'execution_bound', executionId: execution.executionId, execution: copy(execution) }, at);
    });
  }
  observeExecution(jobId, { expectedRevision, execution, now } = {}) {
    const at = timestamp(now);
    return this.transaction(() => {
      const job = this.#job(jobId, expectedRevision); if (!job.executionId || ['result_recorded', 'needs_attention'].includes(job.state)) fail('EXECUTION_STATE_CHANGED');
      this.#execution(job, execution);
      if (!['queued', 'dispatching', 'running', 'unknown', 'succeeded', 'failed', 'cancelled'].includes(execution.state) || ['running', 'succeeded'].includes(execution.state) && !execution.cloudTaskId || job.cloudTaskId && !execution.cloudTaskId) fail('EXECUTION_STATE_CHANGED');
      if (job.execution && (execution.revision < job.execution.revision || TERMINAL.has(job.execution.state) && execution.state !== job.execution.state)) fail('EXECUTION_STATE_CHANGED');
      if (execution.cloudTaskId && this.listJobs().some(other => other.jobId !== job.jobId && other.cloudTaskId === execution.cloudTaskId)) fail('INDEPENDENT_CLOUD_REQUIRED');
      const state = execution.state === 'succeeded' ? job.role === 'implementer' ? 'repair_delivery_pending' : 'artifact_pending' : ['failed', 'cancelled'].includes(execution.state) ? 'needs_attention' : 'execution_bound';
      const updated = this.#updateJob(job, { state, execution: copy(execution), cloudTaskId: execution.cloudTaskId ?? null }, at);
      if (state === 'needs_attention') this.#updatePipeline(this.get(job.pipelineId), { state: 'needs_attention', reasonCode: 'ROLE_EXECUTION_TERMINAL_WITHOUT_RESULT' }, at);
      return updated;
    });
  }
  #repair(pipeline, round, at) {
    if (pipeline.repairs >= pipeline.maxRepairs) { this.#updatePipeline(pipeline, { state: 'escalated', reasonCode: 'REPAIR_BUDGET_EXHAUSTED' }, at); return null; }
    const changed = this.#updatePipeline(pipeline, { state: 'repair_pending_delivery', repairs: pipeline.repairs + 1 }, at);
    return this.#newJob(changed, 'implementer', round, at);
  }
  acceptArtifact(jobId, { expectedRevision, patch, now } = {}) {
    const at = timestamp(now);
    return this.transaction(() => {
      const job = this.#job(jobId, expectedRevision), pipeline = this.get(job.pipelineId), a = job.source.delivery.association;
      if (job.state !== 'artifact_pending' || !['reviewer', 'qa'].includes(job.role) || job.execution?.state !== 'succeeded' || !job.cloudTaskId) fail('ARTIFACT_NOT_READY');
      let artifact;
      try { artifact = parseRoleArtifactDiff(patch, { role: job.role, executionId: job.executionId, taskId: job.taskId, expectedBinding: { pipelineId: job.pipelineId, jobId: job.jobId, roleExecutionId: job.executionId, sourceExecutionId: a.executionId, repository: a.repository, pullRequestNumber: a.pullRequestNumber, baseSha: a.expectedBaseSha, headSha: a.expectedHeadSha, sourcePatchSha256: job.source.delivery.patch.sha256 } }); }
      catch { this.#updateJob(job, { state: 'needs_attention', reasonCode: 'ROLE_ARTIFACT_UNVERIFIED' }, at); return { pipeline: this.#updatePipeline(pipeline, { state: 'needs_attention', reasonCode: 'ROLE_ARTIFACT_UNVERIFIED' }, at), job: this.getJob(jobId), nextJob: null }; }
      this.#updateJob(job, { state: 'result_recorded', result: copy(artifact) }, at);
      let nextJob = null;
      if (['infrastructure_failure', 'needs_attention'].includes(artifact.report.outcome)) this.#updatePipeline(pipeline, { state: 'needs_attention', reasonCode: 'ROLE_INFRASTRUCTURE_FAILURE' }, at);
      else if (artifact.report.outcome === 'changes_requested' || artifact.report.outcome === 'failed') nextJob = this.#repair(pipeline, job.round, at);
      else if (job.role === 'reviewer') { const changed = this.#updatePipeline(pipeline, { state: 'qa_pending' }, at); nextJob = this.#newJob(changed, 'qa', job.round, at); }
      else this.#updatePipeline(pipeline, { state: 'gates_pending' }, at);
      return { pipeline: this.get(job.pipelineId), job: this.getJob(jobId), nextJob };
    });
  }
  acceptRepairDelivery(pipelineId, { expectedRevision, jobId, observation: input, patch, now } = {}) {
    const at = timestamp(now), source = observation(input, patch, at);
    return this.transaction(() => {
      const pipeline = this.get(pipelineId), job = this.getJob(jobId); if (!pipeline || pipeline.revision !== expectedRevision) fail('STALE_PIPELINE');
      const previous = pipeline.source.delivery.association, next = source.delivery.association;
      if (!job || job.pipelineId !== pipelineId || job.role !== 'implementer' || job.state !== 'repair_delivery_pending' || pipeline.state !== 'repair_pending_delivery' || next.executionId !== job.executionId || next.cloudTaskId !== job.cloudTaskId || next.companyId !== job.execution.companyId || next.projectId !== job.execution.projectId || next.paperclipIssueId !== job.taskId || next.paperclipRunId !== job.execution.paperclipRunId || next.environmentId !== job.execution.environmentId || next.attempt !== job.execution.attempt || next.repository !== previous.repository || next.pullRequestNumber !== previous.pullRequestNumber || next.expectedBaseSha !== previous.expectedBaseSha || next.expectedHeadSha === previous.expectedHeadSha || source.context.configHash !== pipeline.source.context.configHash || source.context.policyHash !== pipeline.source.context.policyHash || JSON.stringify(source.delivery.checks.required.map(check => check.name).sort()) !== JSON.stringify(pipeline.source.delivery.checks.required.map(check => check.name).sort())) fail('REPAIR_DELIVERY_UNVERIFIED');
      const proof = source.delivery.provenance, delta = proof.incremental;
      if (proof.comparison !== 'exact_incremental_text_diff_with_full_pr' || delta.previousHeadSha !== previous.expectedHeadSha || delta.previousObservationId !== pipeline.source.observationId || delta.previousExecutionId !== previous.executionId || delta.previousPatchSha256 !== pipeline.source.delivery.patch.sha256 || next.requestedBranch !== job.checkout.branch || next.requestedBranch !== job.execution.branch || next.deliveryBaseBranch !== (previous.deliveryBaseBranch ?? previous.requestedBranch)) fail('REPAIR_INCREMENTAL_PROVENANCE_REQUIRED');
      new DeliveryArtifactStore({ directory: path.join(this.directory, 'source-artifacts') }).capturePatch({ patch, summary: source.delivery.patch, association: next });
      this.#updateJob(job, { state: 'result_recorded', result: { deliveryObservationId: source.observationId } }, at);
      const changed = this.#updatePipeline(pipeline, { source, state: 'review_pending' }, at), nextJob = this.#newJob(changed, 'reviewer', job.round + 1, at);
      return { pipeline: this.get(pipelineId), job: nextJob };
    });
  }
  claimApproval(pipelineId, { expectedRevision, observation: input, boardUserId, payload, now } = {}) {
    const at = timestamp(now), fresh = observation(input, undefined, at); actor(boardUserId); const body = copy(payload, 32_000);
    return this.transaction(() => {
      const pipeline = this.get(pipelineId); if (!pipeline || pipeline.revision !== expectedRevision) fail('STALE_PIPELINE');
      if (pipeline.state !== 'gates_pending' || pipeline.approval) fail('APPROVAL_NOT_READY');
      const a = pipeline.source.delivery.association, b = fresh.delivery.association;
      if (['executionId', 'cloudTaskId', 'companyId', 'projectId', 'paperclipIssueId', 'paperclipRunId', 'repository', 'requestedBranch', 'deliveryBaseBranch', 'pullRequestNumber', 'expectedBaseSha', 'expectedHeadSha'].some(key => a[key] !== b[key]) || fresh.delivery.patch.sha256 !== pipeline.source.delivery.patch.sha256 || fresh.context.configHash !== pipeline.source.context.configHash || fresh.context.policyHash !== pipeline.source.context.policyHash || JSON.stringify(fresh.delivery.checks.required.map(check => check.name).sort()) !== JSON.stringify(pipeline.source.delivery.checks.required.map(check => check.name).sort())) fail('APPROVAL_HEAD_CHANGED');
      const jobs = this.listJobs({ pipelineId }), round = Math.max(...jobs.map(job => job.round));
      if (!jobs.some(job => job.round === round && job.role === 'reviewer' && job.state === 'result_recorded' && job.result?.report?.outcome === 'clean') || !jobs.some(job => job.round === round && job.role === 'qa' && job.state === 'result_recorded' && job.result?.report?.outcome === 'passed')) fail('APPROVAL_REVIEW_UNVERIFIED');
      if (!pipeline.testCheckNames.length || pipeline.testCheckNames.some(name => !fresh.delivery.checks.required.some(check => check.name === name && check.state === 'passed' && check.observations?.length && check.observations.every(row => row.name === name && row.state === 'passed' && ['check_run', 'commit_status'].includes(row.source) && Number.isSafeInteger(row.id) && row.id > 0)))) fail('APPLICATION_TEST_EVIDENCE_REQUIRED');
      const key = 'factory-reviewed:' + pipelineId + ':' + a.expectedHeadSha;
      if (body.kind !== 'request_confirmation' || body.idempotencyKey !== key || body.continuationPolicy !== 'none' || body.resolverPolicy !== 'human_only' || body.addresseeAgentId || body.payload?.target?.type !== 'custom' || body.payload.target.key !== key) fail('APPROVAL_PAYLOAD_UNSAFE');
      return this.#updatePipeline(pipeline, { state: 'approval_sending', approval: { state: 'sending', token: randomUUID(), boardUserId, payload: body, freshObservationId: fresh.observationId } }, at);
    });
  }
  bindApproval(pipelineId, { expectedRevision, token, interaction, now } = {}) {
    const at = timestamp(now); uuid(interaction?.id);
    return this.transaction(() => {
      const pipeline = this.get(pipelineId); if (!pipeline || pipeline.revision !== expectedRevision) fail('STALE_PIPELINE');
      const approval = pipeline.approval, a = pipeline.initialSource.delivery.association;
      if (!['approval_sending', 'approval_unknown'].includes(pipeline.state) || approval?.token !== token || interaction.companyId !== a.companyId || interaction.issueId !== a.paperclipIssueId || interaction.createdByUserId !== approval.boardUserId || interaction.createdByAgentId || Object.entries(approval.payload).some(([key, value]) => !isDeepStrictEqual(interaction[key], value))) fail('APPROVAL_BINDING_CHANGED');
      return this.#updatePipeline(pipeline, { state: 'human_approval_pending', approval: { ...approval, state: 'delivered', interactionId: interaction.id } }, at);
    });
  }
  markApprovalUnknown(pipelineId, { expectedRevision, token, now } = {}) {
    const at = timestamp(now);
    return this.transaction(() => {
      const pipeline = this.get(pipelineId); if (!pipeline || pipeline.revision !== expectedRevision) fail('STALE_PIPELINE');
      if (!['approval_sending', 'approval_unknown'].includes(pipeline.state) || pipeline.approval?.token !== token) fail('APPROVAL_BINDING_CHANGED');
      return this.#updatePipeline(pipeline, { state: 'approval_unknown', approval: { ...pipeline.approval, state: 'unknown' }, reasonCode: 'APPROVAL_OUTCOME_UNKNOWN' }, at);
    });
  }
}
