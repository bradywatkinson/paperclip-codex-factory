import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { cloudEnvironment, runCommand, validateProjectConfig, buildPrompt } from './cloud-dispatch.mjs';
import { ExecutionJournal, JOURNAL_FILENAME } from './execution-journal.mjs';
import { recoverOnce } from './controller-recovery.mjs';
import { validateReconcileConfig } from './cloud-reconcile.mjs';
import { configurationHash } from './repository-registry.mjs';
import { inventoryJournalRoot } from './scheduler-inventory.mjs';
import { buildRegisteredDispatchConfig } from './repository-onboarding.mjs';
import { runReviewControllerOnce, resolveReviewQueuedProfile } from './review-controller.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);
const APPLICATION_ID = 0x46435731;
export class FactoryControllerError extends Error {
  constructor(code) { super(code); this.name = 'FactoryControllerError'; this.code = code; }
}
const fail = code => { throw new FactoryControllerError(code); };
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !/[\0\r\n]/.test(value);
const safeCode = error => typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(error.code) ? error.code : 'FACTORY_CONTROLLER_FAILED';
function existingFile(filename) {
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('FACTORY_CONTROLLER_UNSAFE_FILE');
  return stat;
}
class WakeJournal {
  constructor(directory) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('FACTORY_WAKE_STORAGE_UNSAFE');
    const filename = path.join(directory, 'controller-wakes.sqlite');
    try { const fd = fs.openSync(filename, 'wx', 0o600); fs.fsyncSync(fd); fs.closeSync(fd); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    existingFile(filename); fs.chmodSync(filename, 0o600);
    this.db = new DatabaseSync(filename);
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON;');
      const version = this.db.prepare('PRAGMA user_version').get().user_version, app = this.db.prepare('PRAGMA application_id').get().application_id;
      if (version > 1 || (app && app !== APPLICATION_ID) || (version && app !== APPLICATION_ID)) fail('FACTORY_WAKE_MIGRATION_REQUIRED');
      if (!version && this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length) fail('FACTORY_WAKE_MIGRATION_REQUIRED');
      this.db.exec(`CREATE TABLE IF NOT EXISTS wakes (
        execution_id TEXT NOT NULL, opportunity TEXT NOT NULL, company_id TEXT NOT NULL,
        issue_id TEXT NOT NULL, agent_id TEXT NOT NULL, state TEXT NOT NULL,
        run_id TEXT, created_at TEXT NOT NULL, PRIMARY KEY(execution_id,opportunity)
      ); PRAGMA user_version=1; PRAGMA application_id=${APPLICATION_ID};`);
      const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  prior(executionId) { return this.db.prepare('SELECT * FROM wakes WHERE execution_id=? ORDER BY rowid DESC LIMIT 1').get(executionId); }
  claim(record, opportunity, agentId, now) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.prior(record.executionId);
      if (prior && (prior.state !== 'delivered' || prior.opportunity === opportunity)) { this.db.exec('COMMIT'); return false; }
      this.db.prepare("INSERT INTO wakes VALUES(?,?,?,?,?,'sending',NULL,?)").run(record.executionId, opportunity, record.companyId, record.paperclipIssueId, agentId, now);
      this.db.exec('COMMIT'); return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  finish(executionId, opportunity, runId) {
    this.db.prepare('UPDATE wakes SET state=?,run_id=? WHERE execution_id=? AND opportunity=? AND state=\'sending\'').run(runId ? 'delivered' : 'unknown', runId ?? null, executionId, opportunity);
  }
}
function registrationPlan(registration, operation, scheduler) {
  const data = operation?.data, plan = data?.plan;
  if (!plan || operation.state !== 'configured' || plan.repository !== registration.repository || plan.configHash !== registration.configHash || data.planHash !== configurationHash(plan) || !UUID.test(data.operationId ?? '') || !UUID.test(plan.companyId ?? '') || ['projectId', 'workspaceId', 'agentId'].some(key => !UUID.test(data[key] ?? ''))) fail('FACTORY_REGISTRATION_NOT_CONFIGURED');
  for (const key of ['schedulerDirectory', 'journalDirectory', 'journalRootDirectory', 'dispatchConfigPath']) if (!absolute(plan[key])) fail('FACTORY_PLAN_PATH_INVALID');
  if (path.resolve(plan.schedulerDirectory) !== path.resolve(scheduler.directory) || path.dirname(plan.journalDirectory) !== plan.journalRootDirectory || path.basename(plan.journalDirectory) !== plan.companyId) fail('FACTORY_PLAN_BINDING_CHANGED');
  const config = validateReconcileConfig({ schemaVersion: 1, companyId: plan.companyId, stateDir: plan.journalDirectory, paperclipCommand: plan.runtime?.paperclipCommand, codexCommand: plan.runtime?.codexCommand, apiBase: plan.runtime?.apiBase });
  if (!absolute(plan.runtime?.nodeCommand) || !absolute(plan.runtime?.factoryRoot)) fail('FACTORY_PLAN_PATH_INVALID');
  return { registration, operation, plan, config };
}
function sameExecution(record, selected) {
  return record && ['executionId', 'companyId', 'paperclipIssueId', 'attempt', 'repository'].every(key => record[key] === selected[key]);
}
function dispatchConfig(entry, record) {
  existingFile(entry.plan.dispatchConfigPath);
  if (fs.statSync(entry.plan.dispatchConfigPath).size > 128_000) fail('FACTORY_DISPATCH_CONFIG_INVALID');
  let input; try { input = JSON.parse(fs.readFileSync(entry.plan.dispatchConfigPath, 'utf8')); } catch { fail('FACTORY_DISPATCH_CONFIG_INVALID'); }
  const config = validateProjectConfig(input), { registration, operation, plan } = entry;
  const expected = buildRegisteredDispatchConfig({ registration, companyId: plan.companyId, projectId: operation.data.projectId, workspaceId: operation.data.workspaceId, plan });
  if (!isDeepStrictEqual(config, expected) || config.attempt !== record.attempt) fail('FACTORY_DISPATCH_BINDING_CHANGED');
  if (['projectId', 'workspaceId', 'environmentId', 'branch', 'mode'].some(key => record[key] !== config[key])) fail('FACTORY_QUEUED_BINDING_CHANGED');
  return config;
}
function registerRepositoryLimits(registration, scheduler) {
  const configured = registration.config.concurrency;
  const prior = scheduler.repositories().find(row => row.repository === registration.repository);
  if (prior) {
    if (prior.maxActive > configured.maxActive || prior.maxAttempts > configured.maxAttempts) fail('SCHEDULER_REPOSITORY_POLICY_MISMATCH');
    return;
  }
  const limits = scheduler.settings().limits;
  scheduler.registerRepository({ repository: registration.repository,
    maxActive: Math.min(configured.maxActive, limits.maxGlobalActive, limits.maxRepositoryActive),
    maxAttempts: Math.min(configured.maxAttempts, limits.maxAttempts) });
}
function holdReason(code) {
  if (code === 'FACTORY_QUEUED_TASK_TERMINAL') return 'TASK_TERMINAL';
  if (code === 'FACTORY_QUEUED_TASK_BLOCKED') return 'TASK_BLOCKED';
  if (code === 'FACTORY_QUEUED_TASK_REASSIGNED') return 'TASK_REASSIGNED';
  if (['FACTORY_WAKE_OUTCOME_UNKNOWN', 'FACTORY_WAKE_ALREADY_REQUESTED', 'FACTORY_WAKE_RESPONSE_UNVERIFIED'].includes(code)) return 'WAKE_OUTCOME_UNKNOWN';
  if (['REVIEW_PIPELINE_PAUSED', 'FACTORY_OWNER_STILL_ACTIVE', 'FACTORY_QUEUED_RUN_ACTIVE', 'FACTORY_PAPERCLIP_READ_FAILED', 'FACTORY_PAPERCLIP_RESPONSE_INVALID', 'FACTORY_ADMISSION_OPPORTUNITY_CHANGED', 'FACTORY_CONTROLLER_STOPPED'].includes(code)) return null;
  return 'CONFIG_CHANGED';
}
function validateOwner(owner, record, agentId) {
  if (owner?.id !== record.paperclipRunId || owner.companyId !== record.companyId || owner.agentId !== agentId || owner.contextSnapshot?.issueId !== record.paperclipIssueId) fail('FACTORY_OWNER_SCOPE_CHANGED');
  if (!TERMINAL.has(owner.status)) fail('FACTORY_OWNER_STILL_ACTIVE');
}
function validateProject(project, issue, entry, config) {
  const data = { projectId: config.projectId, workspaceId: config.workspaceId };
  if (project?.id !== data.projectId || project.companyId !== entry.plan.companyId) fail('FACTORY_PROJECT_BINDING_CHANGED');
  const workspace = project.workspaces?.find(row => row.id === data.workspaceId);
  if (!workspace || workspace.companyId !== entry.plan.companyId || workspace.projectId !== data.projectId || (issue.projectWorkspaceId && issue.projectWorkspaceId !== workspace.id)) fail('FACTORY_PROJECT_BINDING_CHANGED');
  let repository;
  const ssh = typeof workspace.repoUrl === 'string' && workspace.repoUrl.match(/^git@github\.com:([^?#]+)$/);
  if (ssh) repository = ssh[1];
  else {
    let url; try { url = new URL(workspace.repoUrl); } catch { fail('FACTORY_PROJECT_BINDING_CHANGED'); }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) fail('FACTORY_PROJECT_BINDING_CHANGED');
    repository = url.pathname.slice(1);
  }
  const ref = workspace.repoRef ?? workspace.defaultRef;
  if (repository.replace(/\/$/, '').replace(/\.git$/, '').toLowerCase() !== config.repository.toLowerCase() || ref?.replace(/^refs\/heads\//, '') !== config.branch) fail('FACTORY_PROJECT_BINDING_CHANGED');
}

/** Recover registered companies and wake at most one verified fair queued task.
 * No direct Cloud submission and no task status write occur here. */
export async function runFactoryControllerOnce({ registry, scheduler, run = runCommand, env = process.env, now = () => new Date().toISOString(), sleep, shouldStop = () => false, maxCompanies = 10, maxRecords = 10 } = {}) {
  if (!Number.isInteger(maxCompanies) || maxCompanies < 1 || maxCompanies > 100 || !Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 100) fail('FACTORY_CONTROLLER_INVALID_LIMIT');
  const result = { status: 'idle', inventory: [], companies: [], woken: [], needsAttention: [] };
  const attention = (code, details = {}) => result.needsAttention.push({ code, ...details });
  const entries = [], groups = new Map(), journals = new Map(), conflictedCompanies = new Set();
  let wakes;
  try {
    for (const registration of registry.list()) {
      try {
        const entry = registrationPlan(registration, registry.getOperation(registration.repository), scheduler);
        registerRepositoryLimits(registration, scheduler);
        entries.push(entry);
        const key = entry.plan.companyId, existing = groups.get(key);
        if (existing && (!isDeepStrictEqual(existing.config, entry.config) || existing.plan.journalRootDirectory !== entry.plan.journalRootDirectory)) {
          conflictedCompanies.add(key); groups.delete(key); fail('FACTORY_COMPANY_RUNTIME_CONFLICT');
        }
        if (!conflictedCompanies.has(key)) groups.set(key, existing ?? entry);
      } catch (error) { attention(safeCode(error), { repository: registration.repository }); }
    }
    if (groups.size > maxCompanies) { attention('FACTORY_COMPANY_LIMIT'); result.status = 'needs_attention'; return result; }
    // Inventory every company directory, including old/unregistered dispatchers,
    // before any opportunity can wake work. Failure leaves admission closed.
    for (const directory of new Set(entries.map(entry => entry.plan.journalRootDirectory))) result.inventory.push(inventoryJournalRoot({ directory, scheduler }));
    for (const [companyId, entry] of groups) {
      if (shouldStop()) break;
      const filename = path.join(entry.plan.journalDirectory, JOURNAL_FILENAME);
      if (!fs.existsSync(filename)) continue;
      existingFile(filename);
      const journal = new ExecutionJournal({ directory: entry.plan.journalDirectory, companyId });
      journals.set(companyId, journal);
      const shared = scheduler.settings().cooldownUntil;
      if (shared && Date.parse(shared) > Date.parse(now())) journal.deferProviderRequests({ now: now(), delayMs: Math.min(86_400_000, Math.max(1000, Date.parse(shared) - Date.parse(now()))) });
      const recovered = await recoverOnce({ config: { ...entry.config, maxRecords }, journal, run, env, now, sleep, shouldStop });
      result.companies.push({ companyId, ...recovered });
      // Adoption is the only way this controller releases a slot: a terminal
      // journal record is required, never owner death or an observation timeout.
      for (const record of journal.list()) scheduler.adoptJournalExecution(record, { now: now() });
      const deadline = journal.providerRequestLimit()?.retryAt;
      if (deadline && Date.parse(deadline) - Date.parse(now()) > entry.config.requestGapMs && (!scheduler.settings().cooldownUntil || Date.parse(deadline) > Date.parse(scheduler.settings().cooldownUntil))) scheduler.deferProviderRequests({ now: now(), delayMs: Math.min(86_400_000, Math.max(1000, Date.parse(deadline) - Date.parse(now()))) });
    }
    for (const journal of journals.values()) {
      const shared = scheduler.settings().cooldownUntil;
      if (shared && Date.parse(shared) > Date.parse(now())) journal.deferProviderRequests({ now: now(), delayMs: Math.min(86_400_000, Math.max(1000, Date.parse(shared) - Date.parse(now()))) });
    }
    if (shouldStop()) { result.status = 'stopped'; return result; }
    result.reviews = await runReviewControllerOnce({ registry, scheduler, run, env, now, shouldStop, allowedRepositories: entries.filter(entry => !conflictedCompanies.has(entry.plan.companyId)).map(entry => entry.registration.repository) });
    for (const row of result.reviews.needsAttention) attention(row.code, row);
    const next = scheduler.peekNext({ now: now() });
    if (next.record) {
      const selected = next.record;
      try {
        const entry = entries.find(item => item.registration.repository === selected.repository && item.plan.companyId === selected.companyId && !conflictedCompanies.has(item.plan.companyId));
        if (!entry) fail('FACTORY_QUEUED_REGISTRATION_MISSING');
        const journal = journals.get(selected.companyId), record = journal?.getExecution(selected.executionId);
        if (!sameExecution(record, selected) || record.state !== 'queued' || record.cloudTaskId) fail('FACTORY_QUEUED_JOURNAL_CHANGED');
        const profile = resolveReviewQueuedProfile({ registry, repository: entry.registration.repository, record });
        const config = profile?.config ?? dispatchConfig(entry, record), agentId = profile?.agentId ?? entry.operation.data.agentId;
        const childEnv = { ...cloudEnvironment(env), PAPERCLIP_TELEMETRY_DISABLED: '1' };
        for (const key of ['PAPERCLIP_HOME', 'PAPERCLIP_INSTANCE_ID', 'PAPERCLIP_AUTH_STORE']) if (typeof env[key] === 'string') childEnv[key] = env[key];
        const pc = async args => {
          if (shouldStop()) fail('FACTORY_CONTROLLER_STOPPED');
          let response; try { response = await run(entry.config.paperclipCommand, [...args, '--api-base', entry.config.apiBase, '--json'], { env: childEnv, timeoutMs: entry.config.commandTimeoutMs, maxOutputBytes: entry.config.maxOutputBytes }); }
          catch { fail('FACTORY_PAPERCLIP_READ_FAILED'); }
          if (response?.code !== 0 || response.signal || response.timedOut || response.failedToStart || response.outputExceeded || typeof response.stdout !== 'string' || Buffer.byteLength(response.stdout) > entry.config.maxOutputBytes) fail('FACTORY_PAPERCLIP_READ_FAILED');
          try { return JSON.parse(response.stdout); } catch { fail('FACTORY_PAPERCLIP_RESPONSE_INVALID'); }
        };
        const issue = await pc(['issue', 'get', record.paperclipIssueId]);
        if (issue?.id !== record.paperclipIssueId || issue.companyId !== record.companyId || issue.projectId !== record.projectId) fail('FACTORY_QUEUED_ISSUE_CHANGED');
        if (issue.assigneeAgentId !== agentId || issue.assigneeUserId) fail('FACTORY_QUEUED_TASK_REASSIGNED');
        if (['done', 'cancelled'].includes(issue.status)) fail('FACTORY_QUEUED_TASK_TERMINAL');
        if (!['todo', 'in_progress'].includes(issue.status)) fail('FACTORY_QUEUED_TASK_BLOCKED');
        if (profile) {
          profile.validateTask(issue);
          const constraint = profile.parentConstraint;
          if (!constraint) fail('REVIEW_PARENT_SCOPE_CHANGED');
          const parent = await pc(['issue', 'get', constraint.id]);
          if (!parent || ['done', 'cancelled'].includes(parent.status) || ['id', 'companyId', 'projectId', 'title', 'description'].some(key => parent[key] !== constraint[key])) fail('REVIEW_PARENT_SCOPE_CHANGED');
        } else buildPrompt(issue, config);
        const owner = await pc(['run', 'get', record.paperclipRunId]); validateOwner(owner, record, agentId);
        const live = await pc(['issue', 'live-runs', record.paperclipIssueId]);
        if (!Array.isArray(live) || live.length) fail('FACTORY_QUEUED_RUN_ACTIVE');
        const currentAgent = await pc(['agent', 'get', agentId]);
        if (currentAgent?.id !== agentId || currentAgent.companyId !== record.companyId || !['idle', 'running'].includes(currentAgent.status) || currentAgent.adapterType !== 'process' || (profile ? !isDeepStrictEqual(currentAgent.metadata?.[profile.metadataKey], profile.metadata) : currentAgent.metadata?.factory?.registrationId !== entry.operation.data.operationId || currentAgent.metadata?.factory?.repository !== entry.registration.repository)) fail('FACTORY_AGENT_CONFIGURATION_CHANGED');
        const agent = await pc(['agent', 'configuration', agentId]);
        const adapter = profile?.adapterConfig ?? { command: entry.plan.runtime.nodeCommand, args: [path.join(entry.plan.runtime.factoryRoot, 'scripts/cloud-dispatch.mjs'), '--config', entry.plan.dispatchConfigPath], cwd: entry.plan.runtime.factoryRoot, timeoutSec: 180, graceSec: 10 };
        const heartbeat = profile?.heartbeat ?? { enabled: false, intervalSec: 0, wakeOnDemand: true, maxConcurrentRuns: 1 };
        if (agent?.id !== agentId || agent.companyId !== record.companyId || !['idle', 'running'].includes(agent.status) || agent.adapterType !== 'process' || !isDeepStrictEqual(agent.adapterConfig, adapter) || !isDeepStrictEqual(agent.runtimeConfig?.heartbeat, heartbeat)) fail('FACTORY_AGENT_CONFIGURATION_CHANGED');
        validateProject(await pc(['project', 'get', record.projectId]), issue, entry, config);
        wakes = new WakeJournal(scheduler.directory);
        const settings = scheduler.settings(), repositoryRevision = scheduler.repositories().find(row => row.repository === selected.repository)?.revision;
        const opportunity = `${selected.executionId}:${selected.revision}:${settings.serviceCounter}:${settings.revision}:${repositoryRevision}`;
        const prior = wakes.prior(selected.executionId);
        if (prior) {
          if (prior.state !== 'delivered') fail('FACTORY_WAKE_OUTCOME_UNKNOWN');
          if (prior.opportunity === opportunity) fail('FACTORY_WAKE_ALREADY_REQUESTED');
          const priorOwner = await pc(['run', 'get', prior.run_id]);
          validateOwner(priorOwner, { ...record, paperclipRunId: prior.run_id }, agentId);
        }
        const current = journal.getExecution(record.executionId), ready = scheduler.peekNext({ now: now() });
        if (!sameExecution(current, selected) || current.state !== 'queued' || !ready.record || ready.record.executionId !== selected.executionId || ready.record.revision !== selected.revision || scheduler.settings().revision !== settings.revision || scheduler.settings().serviceCounter !== settings.serviceCounter || scheduler.repositories().find(row => row.repository === selected.repository)?.revision !== repositoryRevision) fail('FACTORY_ADMISSION_OPPORTUNITY_CHANGED');
        if (!wakes.claim(record, opportunity, agentId, now())) fail('FACTORY_WAKE_ALREADY_REQUESTED');
        try {
          const wake = await pc(['agent', 'wake', agentId, '--payload', JSON.stringify({ issueId: record.paperclipIssueId, factoryExecutionId: record.executionId, factoryWakeKey: opportunity }), '--idempotency-key', 'factory-capacity:' + opportunity]);
          if (!UUID.test(wake?.id ?? '') || wake.companyId !== record.companyId || wake.agentId !== agentId || wake.contextSnapshot?.issueId !== record.paperclipIssueId) fail('FACTORY_WAKE_RESPONSE_UNVERIFIED');
          wakes.finish(record.executionId, opportunity, wake.id);
          result.woken.push({ executionId: record.executionId, companyId: record.companyId, paperclipIssueId: record.paperclipIssueId, runId: wake.id });
        } catch (error) { wakes.finish(record.executionId, opportunity, null); throw error; }
      } catch (error) {
        const code = safeCode(error); attention(code, { executionId: selected.executionId, repository: selected.repository });
        const uncertainWake = wakes?.prior(selected.executionId)?.state;
        const reasonCode = ['sending', 'unknown'].includes(uncertainWake) ? 'WAKE_OUTCOME_UNKNOWN' : holdReason(code);
        if (reasonCode) {
          const current = scheduler.get(selected.executionId);
          if (current?.state === 'queued' && current.revision === selected.revision) {
            try { scheduler.holdQueued(selected.executionId, { expectedRevision: selected.revision, reasonCode, now: now() }); }
            catch (holdError) { attention(safeCode(holdError), { executionId: selected.executionId }); }
          }
        }
      }
    }
    result.scheduler = scheduler.snapshot({ now: now(), limit: maxRecords });
    result.status = result.needsAttention.length || result.scheduler.attentionDepth || result.companies.some(item => item.reconciliation.unresolved || item.reconciliation.paused || item.recovery.needsAttention.some(row => row.reason !== 'queued_not_submitted')) ? 'needs_attention'
      : result.scheduler.settings.paused ? 'paused' : result.woken.length || result.scheduler.activeCount || result.scheduler.queueDepth ? 'running' : 'idle';
    return result;
  } catch (error) { attention(safeCode(error)); result.status = 'needs_attention'; return result; }
  finally { wakes?.close(); for (const journal of journals.values()) journal.close(); }
}
