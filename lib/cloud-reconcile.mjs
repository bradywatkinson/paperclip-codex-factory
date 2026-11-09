import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { cloudEnvironment, runCommand } from './cloud-dispatch.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CLOUD_ID = /^task_e_[a-f0-9]{32}$/;
export class ReconcileError extends Error {
  constructor(code) { super(code); this.code = code; this.name = 'ReconcileError'; }
}
const fail = code => { throw new ReconcileError(code); };
export function validateReconcileConfig(input) {
  if (!input || input.schemaVersion !== 1 || !UUID.test(input.companyId ?? '')) fail('INVALID_RECONCILE_CONFIG');
  const c = { ...input };
  c.codexCommand ??= path.join(os.homedir(), '.local/bin/codex');
  c.paperclipCommand ??= path.join(os.homedir(), '.local/share/paperclip-factory/bin/paperclipai');
  for (const key of ['stateDir', 'codexCommand', 'paperclipCommand']) {
    if (typeof c[key] !== 'string' || !path.isAbsolute(c[key]) || /[\0\r\n]/.test(c[key])) fail('INVALID_RECONCILE_PATH');
  }
  let url;
  try { url = new URL(c.apiBase ?? 'http://127.0.0.1:8100'); } catch { fail('INVALID_API_ORIGIN'); }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('INVALID_API_ORIGIN');
  c.apiBase = url.origin;
  for (const [key, value, min, max] of [
    ['intervalMs', 30000, 15000, 3600000], ['maxRecords', 10, 1, 100], ['maxPages', 5, 1, 20],
    ['requestGapMs', 1000, 1000, 60000], ['commandTimeoutMs', 15000, 1000, 30000],
    ['leaseMs', 120000, 10000, 600000], ['maxOutputBytes', 256000, 1024, 1000000],
    ['maxPollErrors', 8, 1, 1000], ['usageLimitBackoffMs', 900000, 1000, 86400000],
  ]) {
    c[key] ??= value;
    if (!Number.isInteger(c[key]) || c[key] < min || c[key] > max) fail('INVALID_RECONCILE_LIMIT');
  }
  const workBudget = Math.max(c.maxPages * (c.commandTimeoutMs + c.requestGapMs), 5 * c.commandTimeoutMs) + c.requestGapMs;
  if (c.leaseMs <= workBudget) fail('RECONCILE_LEASE_TOO_SHORT');
  // There is deliberately no status-write mode: Paperclip has no status CAS.
  if (c.handoffMode !== undefined && c.handoffMode !== 'notify') fail('INVALID_HANDOFF_MODE');
  return Object.freeze(c);
}
export function parseCloudPage(stdout) {
  let page;
  try { page = JSON.parse(stdout); } catch { fail('CLOUD_SCHEMA_DRIFT'); }
  if (!page || !Array.isArray(page.tasks) || page.tasks.length > 20 || !(page.cursor === null || (typeof page.cursor === 'string' && page.cursor.length > 0 && page.cursor.length <= 4096))) fail('CLOUD_SCHEMA_DRIFT');
  for (const row of page.tasks) {
    if (!row || !CLOUD_ID.test(row.id ?? '')) fail('CLOUD_SCHEMA_DRIFT');
  }
  return page;
}
function observationFor(row, record) {
  if (row.environment_id !== null && row.environment_id !== record.environmentId) fail('CLOUD_ENVIRONMENT_MISMATCH');
  let url;
  try { url = new URL(row.url); } catch { fail('CLOUD_URL_MISMATCH'); }
  if (url.origin !== 'https://chatgpt.com' || url.username || url.password || url.search || url.hash || !['/codex/tasks/' + record.cloudTaskId, '/remote/' + record.cloudTaskId].includes(url.pathname)) fail('CLOUD_URL_MISMATCH');
  if (!['pending', 'ready'].includes(row.status)) fail('CLOUD_UNRECOGNIZED_STATUS');
  if (typeof row.updated_at !== 'string' || !/^\d{4}-\d\d-\d\dT[0-9:.]+Z$/.test(row.updated_at) || !Number.isFinite(Date.parse(row.updated_at))) fail('CLOUD_SCHEMA_DRIFT');
  const summary = {};
  for (const [key, source] of [['filesChanged', 'files_changed'], ['linesAdded', 'lines_added'], ['linesRemoved', 'lines_removed']]) {
    const n = row.summary?.[source];
    if (!Number.isInteger(n) || n < 0 || n > 1000000000) fail('CLOUD_SCHEMA_DRIFT');
    summary[key] = n;
  }
  return { cloudTaskId: record.cloudTaskId, status: row.status, cloudUpdatedAt: new Date(row.updated_at).toISOString(), summary };
}
function commandError(result, provider) {
  if (result?.timedOut || result?.signal) return provider ? 'CLOUD_CLI_TIMEOUT' : 'PAPERCLIP_READ_FAILED';
  if (result?.outputExceeded) return provider ? 'CLOUD_OUTPUT_LIMIT' : 'PAPERCLIP_READ_FAILED';
  if (result?.failedToStart) return provider ? 'CLOUD_COMMAND_UNAVAILABLE' : 'PAPERCLIP_READ_FAILED';
  // Experimental diagnostic classification only, never a remote task outcome.
  // Recorded CLI fixtures do not establish a stable quota-error schema.
  if (provider && result?.code !== 0 && /\b(?:usage_limit_reached|rate_limit_exceeded|insufficient_quota|too many requests)\b|\b(?:HTTP|status(?: code)?)[\s:=]+429\b|\b(?:you(?:'ve| have) hit|you have reached) your usage limit\b/i.test((result?.stderr ?? '') + '\n' + (result?.stdout ?? ''))) return 'CLOUD_USAGE_LIMIT';
  if (result?.code !== 0) return provider ? 'CLOUD_CLI_FAILED' : 'PAPERCLIP_READ_FAILED';
  return null;
}
const addTime = (at, ms) => new Date(Date.parse(at) + ms).toISOString();
const raced = error => ['JOURNAL_STALE_POLL_LEASE', 'JOURNAL_STALE_EXECUTION_TRANSITION', 'JOURNAL_STALE_HANDOFF_LEASE'].includes(error?.code);
function sameBinding(project, issue, record) {
  if (project?.id !== record.projectId || project.companyId !== record.companyId) return false;
  const ws = record.workspaceId
    ? project.workspaces?.find(w => w.id === record.workspaceId)
    : project.primaryWorkspace ?? project.workspaces?.find(w => w.isPrimary) ?? (project.workspaces?.length === 1 ? project.workspaces[0] : project.codebase);
  if (!ws || (ws.companyId && ws.companyId !== record.companyId) || (ws.projectId && ws.projectId !== record.projectId) || (issue.projectWorkspaceId && issue.projectWorkspaceId !== ws.id)) return false;
  let repo;
  const ssh = typeof ws.repoUrl === 'string' && ws.repoUrl.match(/^git@github\.com:([^?#]+)$/);
  if (ssh) repo = ssh[1];
  else {
    let url; try { url = new URL(ws.repoUrl); } catch { return false; }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) return false;
    repo = url.pathname.slice(1);
  }
  const ref = ws.repoRef ?? ws.defaultRef;
  return repo.replace(/\/$/, '').replace(/\.git$/, '').toLowerCase() === record.repository.toLowerCase() && (!ref || ref.replace(/^refs\/heads\//, '') === record.branch);
}
export function buildReviewInteraction(execution, body) {
  const key = 'factory-cloud-review:' + execution.executionId;
  return {
    kind: 'request_confirmation', idempotencyKey: key,
    continuationPolicy: 'none', resolverPolicy: 'human_only',
    title: 'Codex Cloud is ready for review',
    summary: 'Cloud completion does not verify acceptance criteria.',
    payload: {
      version: 1, prompt: 'Review the Cloud result and verify acceptance criteria.',
      detailsMarkdown: body, acceptLabel: 'Reviewed', rejectLabel: 'Needs follow-up',
      allowDeclineReason: true, supersedeOnUserComment: false,
      target: { type: 'custom', key, href: execution.taskUrl, label: 'Cloud task' },
    },
  };
}

export async function reconcileOnce({ config: input, journal, run = runCommand, now = () => new Date().toISOString(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), shouldStop = () => false, env = process.env }) {
  const config = validateReconcileConfig(input);
  if (journal.companyId !== config.companyId) fail('JOURNAL_COMPANY_MISMATCH');
  const ownerId = randomUUID();
  const result = { polled: 0, ready: 0, notified: 0, skipped: 0, unresolved: 0 };
  const paused = journal.listNonterminal().filter(record => record.cloudTaskId && (journal.polling(record.executionId)?.errorCount ?? 0) >= config.maxPollErrors).length;
  if (paused) result.paused = paused;
  const cooldown = () => {
    const limit = journal.providerRequestLimit();
    if (limit && Date.parse(limit.retryAt) - Date.parse(now()) > config.requestGapMs) {
      result.providerRetryAt = limit.retryAt; return true;
    }
    return false;
  };
  const usageCooldown = () => {
    result.providerRetryAt = journal.deferProviderRequests({ now: now(), delayMs: config.usageLimitBackoffMs }).retryAt;
  };
  const childEnv = cloudEnvironment(env);
  const pcEnv = { ...childEnv, PAPERCLIP_TELEMETRY_DISABLED: '1' };
  for (const key of ['PAPERCLIP_HOME', 'PAPERCLIP_INSTANCE_ID', 'PAPERCLIP_AUTH_STORE']) if (typeof env[key] === 'string') pcEnv[key] = env[key];
  const execute = async (command, args, provider = false) => {
    if (shouldStop()) fail('RECONCILIATION_STOPPED');
    let response;
    try { response = await run(command, args, { env: provider ? childEnv : pcEnv, timeoutMs: config.commandTimeoutMs, maxOutputBytes: config.maxOutputBytes }); }
    catch { fail(provider ? 'CLOUD_CLI_FAILED' : 'PAPERCLIP_READ_FAILED'); }
    const error = commandError(response, provider); if (error) fail(error);
    return response.stdout ?? '';
  };
  const pc = async args => {
    const stdout = await execute(config.paperclipCommand, [...args, '--api-base', config.apiBase, '--json']);
    try { return JSON.parse(stdout); } catch { fail('INVALID_PAPERCLIP_RESPONSE'); }
  };
  // Company-wide reservations protect multiple concurrent controller processes.
  const cloud = async (args, deadline) => {
    for (;;) {
      if (shouldStop()) fail('RECONCILIATION_STOPPED');
      if (deadline && Date.parse(now()) + config.commandTimeoutMs >= Date.parse(deadline)) fail('CLOUD_CLI_TIMEOUT');
      const reservation = journal.reserveProviderRequest({ now: now(), minIntervalMs: config.requestGapMs });
      if (reservation.allowed) break;
      if (Date.parse(reservation.retryAt) - Date.parse(now()) > config.requestGapMs) {
        result.providerRetryAt = reservation.retryAt; fail('PROVIDER_RATE_LIMIT');
      }
      if (deadline && Date.parse(reservation.retryAt) + config.commandTimeoutMs >= Date.parse(deadline)) fail('PROVIDER_RATE_LIMIT');
      await sleep(Math.max(1, Date.parse(reservation.retryAt) - Date.parse(now())));
    }
    if (deadline && Date.parse(now()) + config.commandTimeoutMs >= Date.parse(deadline)) fail('CLOUD_CLI_TIMEOUT');
    return execute(config.codexCommand, args, true);
  };
  const due = cooldown() ? [] : journal.listPollable({ now: now(), limit: config.maxRecords, maxErrorCount: config.maxPollErrors });
  let preflightError;
  if (due.length) {
    try {
      if (!(await cloud(['--version'])).split(/\r?\n/).includes('codex-cli 0.167.0')) fail('CLOUD_VERSION_UNSUPPORTED');
      // Codex login status writes its success line to stderr in some versions.
      let auth;
      for (;;) {
        if (shouldStop()) fail('RECONCILIATION_STOPPED');
        const gate = journal.reserveProviderRequest({ now: now(), minIntervalMs: config.requestGapMs });
        if (gate.allowed) break;
        if (Date.parse(gate.retryAt) - Date.parse(now()) > config.requestGapMs) {
          result.providerRetryAt = gate.retryAt; fail('PROVIDER_RATE_LIMIT');
        }
        await sleep(Math.max(1, Date.parse(gate.retryAt) - Date.parse(now())));
      }
      if (shouldStop()) fail('RECONCILIATION_STOPPED');
      try { auth = await run(config.codexCommand, ['login', 'status'], { env: childEnv, timeoutMs: config.commandTimeoutMs, maxOutputBytes: config.maxOutputBytes }); } catch { fail('CLOUD_AUTH_REQUIRED'); }
      const authError = commandError(auth, true); if (authError) fail(authError);
      if (!((auth.stdout ?? '') + '\n' + (auth.stderr ?? '')).split(/\r?\n/).includes('Logged in using ChatGPT')) fail('CLOUD_AUTH_REQUIRED');
    } catch (error) {
      preflightError = error.code ?? 'CLOUD_CLI_FAILED';
      if (preflightError === 'CLOUD_USAGE_LIMIT') usageCooldown();
    }
  }
  // Serial bounded work is intentional: one in-flight request, shared rate gate.
  for (const candidate of due) {
    if (shouldStop()) break;
    if (result.providerRetryAt && result.polled > 0) break;
    const lease = journal.claimPoll(candidate.executionId, { ownerId, now: now(), leaseMs: config.leaseMs, maxErrorCount: config.maxPollErrors });
    if (!lease) continue;
    const record = lease.record;
    let observation, errorCode = preflightError;
    try {
      if (errorCode) fail(errorCode);
      let cursor, row, exhausted = false;
      const cursors = new Set(), ids = new Set();
      for (let pageNo = 0; pageNo < config.maxPages; pageNo++) {
        // Never start another command after the poll lease has expired.
        if (Date.parse(now()) + config.commandTimeoutMs + config.requestGapMs >= Date.parse(lease.expiresAt)) fail('CLOUD_CLI_TIMEOUT');
        const page = parseCloudPage(await cloud(['cloud', 'list', '--env', record.environmentId, '--limit', '20', '--json', ...(cursor ? ['--cursor', cursor] : [])], lease.expiresAt));
        for (const task of page.tasks) {
          if (ids.has(task.id)) fail('CLOUD_TASK_DUPLICATE');
          ids.add(task.id);
          if (task.id === record.cloudTaskId) row = task;
        }
        if (row) break;
        if (page.cursor === null) { exhausted = true; break; }
        if (cursors.has(page.cursor)) fail('CLOUD_CURSOR_LOOP');
        cursors.add(page.cursor); cursor = page.cursor;
      }
      if (!row) fail(exhausted ? 'CLOUD_TASK_MISSING' : 'CLOUD_PAGE_LIMIT');
      observation = observationFor(row, record);
    } catch (error) {
      errorCode = error.code ?? 'CLOUD_CLI_FAILED';
      if (errorCode === 'CLOUD_USAGE_LIMIT') usageCooldown();
    }
    const at = now();
    const errorCount = observation ? 0 : Math.min(1000, (journal.polling(record.executionId)?.errorCount ?? 0) + (errorCode === 'PROVIDER_RATE_LIMIT' ? 0 : 1));
    const delay = observation ? config.intervalMs : Math.max(errorCode === 'CLOUD_USAGE_LIMIT' ? config.usageLimitBackoffMs : 0,
      errorCode === 'PROVIDER_RATE_LIMIT' && result.providerRetryAt ? Date.parse(result.providerRetryAt) - Date.parse(at) : 0,
      Math.min(3600000, config.intervalMs * 2 ** Math.min(errorCount, 10)));
    try {
      const saved = journal.recordObservation({ executionId: record.executionId, token: lease.token, expectedRevision: record.revision, now: at, nextPollAt: addTime(at, delay), errorCount,
        observation: observation ?? { cloudTaskId: record.cloudTaskId, errorCode },
        ...(observation ? { toState: observation.status === 'ready' ? 'succeeded' : 'running', ...(observation.status === 'ready' ? { handoff: { mode: 'notify', target: 'in_review' } } : {}) } : {}),
      });
      result.polled++;
      if (saved.stale || !observation) result.unresolved++;
      else if (observation.status === 'ready') result.ready++;
    } catch (error) { if (!raced(error)) throw error; result.unresolved++; }
  }
  let identity;
  for (const pending of journal.pendingHandoffs({ now: now(), limit: config.maxRecords })) {
    if (shouldStop()) break;
    const claim = journal.claimHandoff(pending.id, { ownerId, now: now(), leaseMs: config.leaseMs });
    if (!claim) continue;
    const { record: handoff, execution, token } = claim;
    const notification = buildReviewInteraction(execution, handoff.body);
    const confirmed = card => card?.companyId === config.companyId && card.issueId === execution.paperclipIssueId
      && card.createdByUserId === identity.userId && card.idempotencyKey === notification.idempotencyKey
      && UUID.test(card.id ?? '') && card.createdByAgentId === null
      && card.kind === notification.kind && card.continuationPolicy === 'none'
      && card.resolverPolicy === 'human_only' && isDeepStrictEqual(card.payload, notification.payload);
    let sending = claim.phase !== 'leased';
    const finish = (state, errorCode) => journal.finishHandoff(handoff.id, { token, now: now(), state, errorCode, nextAttemptAt: addTime(now(), config.intervalMs) });
    try {
      if (handoff.mode !== 'notify') fail('PAPERCLIP_SCOPE_CHANGED');
      identity ??= await pc(['whoami']);
      if (typeof identity.userId !== 'string' || !identity.userId || !Array.isArray(identity.companyIds) || !identity.companyIds.includes(config.companyId)) fail('PAPERCLIP_SCOPE_CHANGED');
      if (sending) {
        // Recovery is read-only. Missing data is not proof that no write occurred.
        const cards = await pc(['issue', 'interactions', execution.paperclipIssueId]);
        if (!Array.isArray(cards)) fail('INVALID_PAPERCLIP_RESPONSE');
        const found = cards.some(confirmed);
        finish(found ? 'delivered' : 'unknown', found ? undefined : 'PAPERCLIP_WRITE_UNKNOWN');
        result[found ? 'notified' : 'unresolved']++;
        continue;
      }
      const originalRun = await pc(['run', 'get', execution.paperclipRunId]);
      if (originalRun?.id !== execution.paperclipRunId || originalRun.companyId !== config.companyId || !UUID.test(originalRun.agentId ?? '') || originalRun.contextSnapshot?.issueId !== execution.paperclipIssueId) fail('PAPERCLIP_SCOPE_CHANGED');
      const issue = await pc(['issue', 'get', execution.paperclipIssueId]);
      if (issue?.id !== execution.paperclipIssueId || issue.companyId !== config.companyId || issue.projectId !== execution.projectId) { finish('skipped', 'PAPERCLIP_SCOPE_CHANGED'); result.skipped++; continue; }
      if (['done', 'cancelled'].includes(issue.status)) { finish('skipped', 'PAPERCLIP_ALREADY_TERMINAL'); result.skipped++; continue; }
      if (issue.assigneeAgentId !== originalRun.agentId || issue.assigneeUserId) { finish('skipped', 'PAPERCLIP_ASSIGNEE_CHANGED'); result.skipped++; continue; }
      // Receipt acceptance precedes the dispatcher's final blocked update. READY
      // can arrive during that handoff; retry delivery after the owner finishes.
      if (['queued', 'running'].includes(originalRun.status)) {
        finish('pending', 'PAPERCLIP_DISPATCH_ACTIVE'); result.unresolved++; continue;
      }
      if (issue.status !== 'blocked') { finish('skipped', issue.status === 'in_review' ? 'PAPERCLIP_ALREADY_REVIEW' : 'PAPERCLIP_SCOPE_CHANGED'); result.skipped++; continue; }
      const project = await pc(['project', 'get', execution.projectId]);
      if (!sameBinding(project, issue, execution)) { finish('skipped', 'PAPERCLIP_BINDING_CHANGED'); result.skipped++; continue; }
      // Persist send intent before crossing the process boundary. No automatic retry
      // can issue a second card, even if stdout or the controller is lost.
      // Board comments implicitly reopen tasks in this Paperclip version. A
      // custom human-only interaction atomically rejects closed issues and has
      // no status or agent-continuation effect.
      if (shouldStop()) break;
      journal.markHandoffSending(handoff.id, token, now()); sending = true;
      const card = await pc(['issue', 'interaction:create', execution.paperclipIssueId, '--payload-json', JSON.stringify(notification)]);
      if (!confirmed(card)) fail('PAPERCLIP_WRITE_UNKNOWN');
      finish('delivered'); result.notified++;
    } catch (error) {
      if (raced(error)) { result.unresolved++; continue; }
      try { finish(sending ? 'unknown' : 'pending', sending ? 'PAPERCLIP_WRITE_UNKNOWN' : error.code ?? 'PAPERCLIP_READ_FAILED'); }
      catch (finishError) { if (!raced(finishError)) throw finishError; }
      result.unresolved++;
    }
  }
  return result;
}
