import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { configurationHash, validateConfigurationUpdate } from './repository-registry.mjs';
import { buildOnboardingPlan, buildRegisteredDispatchConfig, inspectRepository } from './repository-onboarding.mjs';
import { DispatchScheduler, SCHEDULER_FILENAME } from './dispatch-scheduler.mjs';
import { inventoryJournalRoot } from './scheduler-inventory.mjs';
import { ReviewRoleBindings, roleSpec, reviewCommands } from './review-onboarding.mjs';
import { ReviewPipeline } from './review-pipeline.mjs';

export class ConfigurationUpdateError extends Error { constructor(code) { super(code); this.name = 'ConfigurationUpdateError'; this.code = code; } }
const fail = code => { throw new ConfigurationUpdateError(code); };
const same = isDeepStrictEqual;
const bytes = value => JSON.stringify(value, null, 2) + '\n';
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const ROLES = ['reviewer', 'qa', 'repair'];
function fileText(filename) {
  let stat;
  try { stat = fs.lstatSync(filename); } catch { fail('CONFIGURATION_UPDATE_FILE_CHANGED'); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128000) fail('CONFIGURATION_UPDATE_FILE_CHANGED');
  return fs.readFileSync(filename, 'utf8');
}
function safeParents(filename, privateDir) {
  filename = path.resolve(filename); privateDir = path.resolve(privateDir);
  const relative = path.relative(privateDir, filename);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('CONFIGURATION_UPDATE_PATH_CHANGED');
  for (let directory = path.dirname(filename);; directory = path.dirname(directory)) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('CONFIGURATION_UPDATE_PATH_CHANGED');
    if (directory === privateDir) break;
  }
}
function replaceFile(file, updateId, privateDir) {
  safeParents(file.path, privateDir);
  const current = fileText(file.path), oldText = bytes(file.previous), newText = bytes(file.next);
  const syncDestination = () => {
    fs.chmodSync(file.path, 0o600);
    const target = fs.openSync(file.path, 'r'); try { fs.fsyncSync(target); } finally { fs.closeSync(target); }
    const parent = fs.openSync(path.dirname(file.path), 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  };
  // A previous process may have renamed successfully and died before dir sync.
  if (current === newText) { syncDestination(); return; }
  if (current !== oldText) fail('CONFIGURATION_UPDATE_FILE_CHANGED');
  const directory = path.dirname(file.path), temporary = path.join(directory, '.configuration-update-' + updateId + '-' + randomUUID() + '.tmp');
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(fd, newText); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    const fresh = fileText(file.path);
    if (fresh !== oldText && fresh !== newText) fail('CONFIGURATION_UPDATE_FILE_CHANGED');
    if (fresh !== newText) fs.renameSync(temporary, file.path);
    syncDestination();
  } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
function reviewPlan(registration, operation, main) {
  const directory = path.join(path.dirname(main.dispatchConfigPath), 'review');
  return { registration, operation, main, directory, pipelineDirectory: path.join(directory, 'pipeline'), companyId: main.companyId,
    projectId: operation.data.projectId, implementationAgentId: operation.data.agentId,
    baseConfig: buildRegisteredDispatchConfig({ registration, companyId: main.companyId, projectId: operation.data.projectId, workspaceId: operation.data.workspaceId, plan: main }) };
}
function assertReviewIdle(plan, expectedRoles) {
  const rolesFile = path.join(plan.directory, 'role-bindings.sqlite'), pipelineFile = path.join(plan.pipelineDirectory, 'review-pipeline.sqlite');
  let store, pipeline;
  try {
    const jobs = new Map(), pipelines = new Map();
    if (fs.existsSync(pipelineFile)) {
      verifyDatabase(pipelineFile, 0x46525031, [1], ['pipelines', 'jobs']);
      pipeline = new ReviewPipeline({ directory: plan.pipelineDirectory });
      for (const row of pipeline.list()) {
        if (!['human_approval_pending', 'escalated', 'needs_attention'].includes(row.state)) fail('CONFIGURATION_UPDATE_REVIEW_NOT_IDLE');
        pipelines.set(row.pipelineId, row);
        for (const job of pipeline.listJobs({ pipelineId: row.pipelineId })) {
          if (job.state !== 'result_recorded') fail('CONFIGURATION_UPDATE_REVIEW_NOT_IDLE');
          jobs.set(job.jobId, job);
        }
      }
    }
    if (!fs.existsSync(rolesFile)) {
      if (expectedRoles?.length || pipelines.size) fail('CONFIGURATION_UPDATE_REVIEW_CHANGED');
      return [];
    }
    verifyDatabase(rolesFile, 0x46524231, [1], ['intents']); store = new ReviewRoleBindings({ directory: plan.directory });
    const records = store.list(), roles = records.filter(row => row.key.startsWith('role:'));
    for (const record of records) {
      if (record.key.startsWith('role:')) {
        if (!ROLES.includes(record.key.slice(5)) || record.state !== 'configured' || !record.data.agentId) fail('CONFIGURATION_UPDATE_REVIEW_NOT_IDLE');
      } else if (record.key === 'controller:pipeline-cursor') {
        if (record.state !== 'ready') fail('CONFIGURATION_UPDATE_REVIEW_NOT_IDLE');
      } else if (record.key.startsWith('activation:')) {
        if (!pipelines.has(record.key.slice(11))) fail('CONFIGURATION_UPDATE_REVIEW_NOT_IDLE');
      } else if (record.key.startsWith('task:')) {
        if (!jobs.get(record.key.slice(5))?.taskId) fail('CONFIGURATION_UPDATE_REVIEW_NOT_IDLE');
      } else if (record.key.startsWith('workspace:')) {
        if (!jobs.has(record.key.slice(10)) || record.state !== 'configured' || !record.data.workspaceId) fail('CONFIGURATION_UPDATE_REVIEW_NOT_IDLE');
      } else fail('CONFIGURATION_UPDATE_REVIEW_NOT_IDLE');
    }
    if (expectedRoles) for (const expected of expectedRoles) {
      const actual = roles.find(row => row.key === expected.previous.key);
      if (!same(actual, expected.previous) && !same(actual, expected.next)) fail('CONFIGURATION_UPDATE_REVIEW_CHANGED');
    }
    if (expectedRoles && roles.length !== expectedRoles.length) fail('CONFIGURATION_UPDATE_REVIEW_CHANGED');
    return roles;
  } finally { pipeline?.close(); store?.close(); }
}
function verifyDatabase(filename, applicationId, versions, requiredTables) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) fail('CONFIGURATION_UPDATE_STORAGE_INVALID');
  let db;
  try {
    db = new DatabaseSync(filename, { readOnly: true }); db.exec('PRAGMA query_only=ON; BEGIN;');
    if (db.prepare('PRAGMA application_id').get().application_id !== applicationId || !versions.includes(db.prepare('PRAGMA user_version').get().user_version)) fail('CONFIGURATION_UPDATE_STORAGE_INVALID');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
    if (requiredTables.some(table => !tables.includes(table)) || db.prepare('PRAGMA quick_check').all().some(row => row.quick_check !== 'ok') || db.prepare('PRAGMA foreign_key_check').all().length) fail('CONFIGURATION_UPDATE_STORAGE_INVALID');
    db.exec('COMMIT');
  } catch { fail('CONFIGURATION_UPDATE_STORAGE_INVALID'); }
  finally { db?.close(); }
}
function assertLocalIdle(payload, scheduler) {
  if (!scheduler.settings().paused) fail('CONFIGURATION_UPDATE_REQUIRES_PAUSE');
  const repository = payload.previousRegistration.repository;
  if (scheduler.list().some(row => row.repository === repository && !TERMINAL.has(row.state))) fail('CONFIGURATION_UPDATE_EXECUTIONS_NOT_IDLE');
  const records = [];
  // Reuse the strict journal inventory without adopting or rewriting any row.
  inventoryJournalRoot({ directory: payload.previousOperation.data.plan.journalRootDirectory, scheduler: {
    repositories: () => scheduler.repositories(), settings: () => scheduler.settings(), registerRepository: () => {}, adoptJournalExecution: record => records.push(record),
  } });
  if (records.some(row => row.repository.toLowerCase() === repository && !TERMINAL.has(row.state))) fail('CONFIGURATION_UPDATE_EXECUTIONS_NOT_IDLE');
  assertReviewIdle(payload.previousReviewPlan, payload.roles);
  for (const file of payload.files) {
    safeParents(file.path, payload.previousOperation.data.plan.runtime.privateDir);
    const current = fileText(file.path);
    if (current !== bytes(file.previous) && current !== bytes(file.next)) fail('CONFIGURATION_UPDATE_FILE_CHANGED');
  }
}
function assertNewProjections(payload) {
  for (const file of payload.files) if (fileText(file.path) !== bytes(file.next)) fail('CONFIGURATION_UPDATE_FILE_CHANGED');
  if (payload.roles.length) {
    const store = new ReviewRoleBindings({ directory: payload.previousReviewPlan.directory });
    try { for (const role of payload.roles) if (!same(store.get(role.next.key), role.next)) fail('CONFIGURATION_UPDATE_REVIEW_CHANGED'); }
    finally { store.close(); }
  }
}
function makePayload(registration, operation, config, sourcePath) {
  if (operation?.state !== 'configured' || operation.data.pending || !operation.data.configurationWritten) fail('CONFIGURATION_UPDATE_NOT_CONFIGURED');
  const previous = operation.data.plan;
  if (!same(previous, buildOnboardingPlan({ registration, companyId: operation.data.companyId, runtime: previous?.runtime })) || operation.data.planHash !== configurationHash(previous)) fail('CONFIGURATION_UPDATE_PLAN_CHANGED');
  const nextRegistration = { ...registration, config, configHash: configurationHash(config), sourcePath };
  const next = buildOnboardingPlan({ registration: nextRegistration, companyId: operation.data.companyId, runtime: previous.runtime });
  const previousReviewPlan = reviewPlan(registration, operation, previous), nextReviewPlan = reviewPlan(nextRegistration, operation, next);
  const files = [
    { path: previous.dispatchConfigPath, previous: previousReviewPlan.baseConfig, next: nextReviewPlan.baseConfig },
    { path: previous.taskContractPath, previous: previous.taskContract, next: next.taskContract },
  ], roles = [];
  for (const record of assertReviewIdle(previousReviewPlan)) {
    const role = record.key.slice(5), oldSpec = roleSpec(previousReviewPlan, role, record.data.bindingId), newSpec = roleSpec(nextReviewPlan, role, record.data.bindingId);
    if (record.data.sourceOperationId !== operation.data.operationId || record.data.configHash !== configurationHash(oldSpec.config) || !same(oldSpec.adapterConfig, newSpec.adapterConfig)) fail('CONFIGURATION_UPDATE_REVIEW_CHANGED');
    files.push({ path: oldSpec.configPath, previous: oldSpec.config, next: newSpec.config });
    roles.push({ previous: record, next: { ...record, revision: record.revision + 1, data: { ...record.data, configHash: configurationHash(newSpec.config) } } });
  }
  for (const file of files) {
    safeParents(file.path, previous.runtime.privateDir);
    if (fileText(file.path) !== bytes(file.previous)) fail('CONFIGURATION_UPDATE_FILE_CHANGED');
  }
  for (const role of ROLES) if (!roles.some(row => row.previous.key === 'role:' + role) && fs.existsSync(path.join(previousReviewPlan.directory, role + '.json'))) fail('CONFIGURATION_UPDATE_REVIEW_CHANGED');
  // Plans are bounded data, not live registry/store handles.
  return { previousRegistration: registration, registration: nextRegistration, previousOperation: operation,
    operationData: { ...operation.data, plan: next, planHash: configurationHash(next) }, previousReviewPlan, files, roles };
}
async function assertNativeIdle(payload, run, env) {
  const plan = payload.previousReviewPlan, { pc } = reviewCommands(plan, run, env), operation = payload.previousOperation;
  const marker = { registrationId: operation.data.operationId, repository: plan.registration.repository };
  const project = await pc(['project', 'get', plan.projectId]);
  if (project?.id !== plan.projectId || project.companyId !== plan.companyId || project.archivedAt || project.name !== plan.main.project.name || project.description !== 'factory-onboarding-v1:' + marker.registrationId + ':' + marker.repository) fail('CONFIGURATION_UPDATE_NATIVE_BINDING_CHANGED');
  const workspaces = await pc(['project-workspace', 'list', plan.projectId]);
  if (!Array.isArray(workspaces)) fail('CONFIGURATION_UPDATE_NATIVE_BINDING_CHANGED');
  const workspace = workspaces.find(row => row.id === operation.data.workspaceId);
  if (!workspace || workspace.companyId !== plan.companyId || workspace.projectId !== plan.projectId || !same(workspace.metadata?.factory, marker) || !Object.entries(plan.main.workspace).every(([key, value]) => workspace[key] === value) || workspace.setupCommand || workspace.cleanupCommand) fail('CONFIGURATION_UPDATE_NATIVE_BINDING_CHANGED');
  const heartbeat = { enabled: false, intervalSec: 0, wakeOnDemand: true, maxConcurrentRuns: 1 };
  const agents = [{ id: operation.data.agentId, markerKey: 'factory', marker,
    adapterConfig: { command: plan.main.runtime.nodeCommand, args: [path.join(plan.main.runtime.factoryRoot, 'scripts/cloud-dispatch.mjs'), '--config', plan.main.dispatchConfigPath], cwd: plan.main.runtime.factoryRoot, timeoutSec: 180, graceSec: 10 } }];
  for (const role of payload.roles) {
    const spec = roleSpec(plan, role.previous.key.slice(5), role.previous.data.bindingId);
    agents.push({ id: role.previous.data.agentId, markerKey: 'factoryReview', marker: spec.marker, adapterConfig: spec.adapterConfig });
  }
  for (const expected of agents) {
    const agent = await pc(['agent', 'get', expected.id]), projection = await pc(['agent', 'configuration', expected.id]);
    if (agent?.id !== expected.id || agent.companyId !== plan.companyId || agent.adapterType !== 'process' || agent.status !== 'idle' || !same(agent.metadata?.[expected.markerKey], expected.marker) || projection?.id !== expected.id || projection.companyId !== plan.companyId || projection.adapterType !== 'process' || projection.status !== 'idle' || !same(projection.adapterConfig, expected.adapterConfig) || !same(projection.runtimeConfig?.heartbeat, heartbeat)) fail('CONFIGURATION_UPDATE_NATIVE_NOT_IDLE');
    const runs = await pc(['run', 'list', '--company-id', plan.companyId, '--agent-id', expected.id, '--limit', '100']);
    if (!Array.isArray(runs) || runs.length >= 100 || runs.some(row => row.companyId !== plan.companyId || row.agentId !== expected.id || !['succeeded', 'failed', 'cancelled', 'timed_out'].includes(row.status))) fail('CONFIGURATION_UPDATE_NATIVE_NOT_IDLE');
  }
}

/** Explicit strengthening of required checks. No native writes or Cloud jobs. */
export async function updateRepositoryConfiguration({ registry, repository, config: input, sourcePath, expectedConfigHash, dryRun = true, run, env = process.env, checkpoint = () => {} }) {
  if (!/^[a-f0-9]{64}$/.test(expectedConfigHash ?? '') || typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath) || /[\0\r\n]/.test(sourcePath)) fail('INVALID_CONFIGURATION_UPDATE');
  const current = registry.get(repository), latest = registry.getConfigurationUpdate(repository);
  if (!current) fail('REPOSITORY_NOT_REGISTERED');
  const recovering = latest?.previousHash === expectedConfigHash && latest.nextHash === configurationHash(validateConfigurationUpdate(latest.payload.previousRegistration, input));
  const previous = recovering ? latest.payload.previousRegistration : current;
  const config = validateConfigurationUpdate(previous, input), nextHash = configurationHash(config);
  if (latest?.state === 'prepared' && !recovering) fail('CONFIGURATION_UPDATE_CONFLICT');
  if (!recovering && current.configHash !== expectedConfigHash) fail('REGISTRY_CONFIG_CHANGED');
  if (!recovering && current.configHash === nextHash) {
    const operation = registry.getOperation(repository), schedulerDirectory = operation?.data?.plan?.schedulerDirectory;
    if (operation?.state === 'configuration_updating' || latest?.state === 'prepared') fail('CONFIGURATION_UPDATE_CONFLICT');
    if (schedulerDirectory && fs.existsSync(path.join(schedulerDirectory, SCHEDULER_FILENAME))) {
      verifyDatabase(path.join(schedulerDirectory, SCHEDULER_FILENAME), 0x46534348, [1, 2], ['scheduler_settings', 'scheduler_repositories', 'scheduler_executions', 'scheduler_events']);
      const scheduler = new DispatchScheduler({ directory: schedulerDirectory });
      try {
        const fence = scheduler.configurationFence(repository);
        if (fence && (fence.state !== 'ready' || fence.nextHash !== current.configHash)) fail('CONFIGURATION_UPDATE_CONFLICT');
      } finally { scheduler.close(); }
    }
    return { status: 'unchanged', repository: current.repository, configHash: current.configHash, cloudSubmissions: false, externalWrites: false };
  }
  if (recovering && (current.configHash !== expectedConfigHash && current.configHash !== nextHash || latest.payload.registration.sourcePath !== sourcePath)) fail('CONFIGURATION_UPDATE_CONFLICT');
  const payload = recovering ? latest.payload : makePayload(previous, registry.getOperation(repository), config, sourcePath);
  const schedulerDirectory = payload.previousOperation.data.plan.schedulerDirectory;
  if (!fs.existsSync(path.join(schedulerDirectory, SCHEDULER_FILENAME))) fail('CONFIGURATION_UPDATE_SCHEDULER_REQUIRED');
  verifyDatabase(path.join(schedulerDirectory, SCHEDULER_FILENAME), 0x46534348, [1, 2], ['scheduler_settings', 'scheduler_repositories', 'scheduler_executions', 'scheduler_events']);
  const scheduler = new DispatchScheduler({ directory: schedulerDirectory });
  try {
    assertLocalIdle(payload, scheduler);
    const validation = await inspectRepository({ registration: payload.registration, companyId: payload.previousReviewPlan.companyId, runtime: payload.previousReviewPlan.main.runtime, run, env });
    if (validation.status !== 'validated') return { status: 'needs_attention', code: 'CONFIGURATION_UPDATE_VALIDATION_FAILED', validation, cloudSubmissions: false, externalWrites: false };
    if (!recovering) payload.operationData.validation = validation;
    await assertNativeIdle(payload, run, env);
    const existing = scheduler.configurationFence(repository);
    if (existing?.state === 'updating' && (existing.previousHash !== expectedConfigHash || existing.nextHash !== nextHash)) fail('CONFIGURATION_UPDATE_CONFLICT');
    if (existing?.state === 'ready' && existing.nextHash !== current.configHash) fail('CONFIGURATION_UPDATE_CONFLICT');
    const updateId = recovering ? latest.updateId : existing?.state === 'updating' && existing.previousHash === expectedConfigHash && existing.nextHash === nextHash ? existing.updateId : randomUUID();
    const result = { repository: previous.repository, previousConfigHash: expectedConfigHash, configHash: nextHash, updateId,
      addedRequiredChecks: config.delivery.requiredChecks.filter(name => !previous.config.delivery.requiredChecks.includes(name)),
      preservedIds: { companyId: payload.previousReviewPlan.companyId, projectId: payload.previousOperation.data.projectId, workspaceId: payload.previousOperation.data.workspaceId, agentId: payload.previousOperation.data.agentId, reviewAgentIds: payload.roles.map(row => row.previous.data.agentId) },
      accountPaused: true, cloudSubmissions: false, externalWrites: false };
    if (dryRun) return { ...result, status: 'dry_run', recovering: Boolean(recovering || existing?.state === 'updating'), files: payload.files.map(file => file.path) };
    if (latest?.state === 'completed' && recovering && existing?.state === 'ready' && existing.updateId === updateId) {
      assertNewProjections(payload); return { ...result, status: 'already_updated' };
    }
    scheduler.beginConfigurationUpdate({ repository, updateId, previousHash: expectedConfigHash, nextHash });
    checkpoint('fenced');
    const update = registry.prepareConfigurationUpdate(repository, { updateId, expectedConfigHash, expectedOperationRevision: payload.previousOperation.revision, payload, assertQuiescent: () => assertLocalIdle(payload, scheduler) });
    checkpoint('prepared');
    assertLocalIdle(payload, scheduler);
    for (const [index, file] of payload.files.entries()) { replaceFile(file, updateId, payload.previousOperation.data.plan.runtime.privateDir); checkpoint('file:' + index); }
    if (payload.roles.length) {
      const store = new ReviewRoleBindings({ directory: payload.previousReviewPlan.directory });
      try { for (const role of payload.roles) {
        const actual = store.get(role.previous.key);
        if (same(actual, role.next)) continue;
        if (!same(actual, role.previous)) fail('CONFIGURATION_UPDATE_REVIEW_CHANGED');
        store.update(actual, role.next.state, role.next.data); checkpoint('role:' + role.previous.key.slice(5));
      } } finally { store.close(); }
    }
    assertLocalIdle(payload, scheduler);
    assertNewProjections(payload);
    await assertNativeIdle(payload, run, env);
    // New registration and configured plan become visible in one registry commit.
    registry.finishConfigurationUpdate(repository, { updateId: update.updateId, assertComplete: () => { assertLocalIdle(payload, scheduler); assertNewProjections(payload); } }); checkpoint('committed');
    scheduler.finishConfigurationUpdate({ repository, updateId, nextHash }); checkpoint('finished');
    return { ...result, status: 'updated' };
  } finally { scheduler.close(); }
}
