import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { cloudEnvironment, runCommand } from './cloud-dispatch.mjs';
import { JOURNAL_SCHEMA_VERSION } from './execution-journal.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{40}$/, HASH = /^[a-f0-9]{64}$/;
const APP = 0x46444e31;
export class DeliveryNotificationError extends Error { constructor(code) { super(code); this.name = 'DeliveryNotificationError'; this.code = code; } }
const fail = code => { throw new DeliveryNotificationError(code); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const syncDirectory = directory => { const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };
const escape = text => String(text).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[\\`*_{}\[\]()<>#!|~]/g, '\\$&');
function safeLink(input) {
  let url; try { url = new URL(input); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || /[\u0000-\u0020\u007f\\()<>]/.test(input)) return null;
  return url.href;
}
function correction(code) {
  if (code === 'CI_PENDING') return 'Wait for the required checks at this exact head, then inspect again.';
  if (code === 'CI_FAILED') return 'Open the failing check, repair its cause, and publish a new reviewed head.';
  if (/CI_REQUIREMENTS_UNCONFIGURED/.test(code)) return 'Configure required CI checks before requesting independent review.';
  if (/CI_|CHECK|STATUS/.test(code)) return 'Restore access to the required checks and inspect this exact head again.';
  if (/PULL_REQUEST_NOT_PROVIDED/.test(code)) return 'Publish the patch manually and inspect the exact PR number and head.';
  if (/PATCH|PROVENANCE|HEAD|BASE|ANCESTR|PREVIOUS|BRANCH/.test(code)) return 'Verify the published branch, immutable base/head, and complete patch; inspect again without resubmitting Cloud work.';
  return 'Restore the original execution and delivery prerequisites, then inspect again; do not submit another Cloud job.';
}
function validateObservation(observation, execution, registration) {
  const a = observation?.delivery?.association, context = observation?.context;
  if (observation?.schemaVersion !== 1 || !UUID.test(observation.observationId ?? '') || context?.journalSchemaVersion !== JOURNAL_SCHEMA_VERSION || context.executionRevision !== execution?.revision || !HASH.test(context.configHash ?? '') || !HASH.test(context.policyHash ?? '') || execution?.state !== 'succeeded' || execution.mode !== 'code_change' || !a || ['executionId', 'companyId', 'paperclipIssueId', 'paperclipRunId', 'projectId'].some(key => !UUID.test(execution[key] ?? '') || a[key] !== execution[key]) || ['repository', 'environmentId', 'attempt'].some(key => a[key] !== execution[key]) || a.requestedBranch !== execution.branch || a.cloudTaskId !== execution.cloudTaskId || !/^task_e_[a-f0-9]{32}$/.test(a.cloudTaskId ?? '') || a.cloudTaskUrl !== 'https://chatgpt.com/remote/' + a.cloudTaskId || execution.taskUrl !== a.cloudTaskUrl) fail('DELIVERY_NOTIFICATION_EXECUTION_CHANGED');
  if (registration && (registration.repository !== a.repository || registration.configHash !== context.configHash || registration.policyHash !== context.policyHash || registration.config?.cloud?.environmentId !== a.environmentId)) fail('DELIVERY_NOTIFICATION_REGISTRATION_CHANGED');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(a.repository) || !SHA.test(a.expectedBaseSha ?? '') || a.expectedHeadSha !== undefined && !SHA.test(a.expectedHeadSha) || !Array.isArray(observation.delivery.reasons) || !Array.isArray(observation.delivery.checks?.required) || observation.delivery.checks.required.length > 50) fail('DELIVERY_NOTIFICATION_INVALID_OBSERVATION');
  return a;
}

/** Informational projection only. No model report or status string can grant approval. */
export function renderDeliveryNotification({ observation, execution, registration }) {
  const a = validateObservation(observation, execution, registration), delivery = observation.delivery, p = delivery.provenance;
  const rows = [...delivery.checks.required];
  for (const name of registration?.config?.delivery?.requiredChecks ?? []) if (!rows.some(row => row.name === name)) rows.push({ name, state: 'unverified', observations: [] });
  const checks = rows.map(row => {
    if (typeof row.name !== 'string' || !row.name.trim() || Buffer.byteLength(row.name) > 200) fail('DELIVERY_NOTIFICATION_INVALID_OBSERVATION');
    return { name: row.name, state: ['passed', 'failed', 'pending', 'missing', 'unverified'].includes(row.state) ? row.state : 'unverified', links: [...new Set((row.observations ?? []).map(item => safeLink(item.url)).filter(Boolean))].sort().slice(0, 5) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const verified = p?.verified === true && p.baseSha === a.expectedBaseSha && p.headSha === a.expectedHeadSha && p.mergeBaseSha === a.expectedBaseSha && HASH.test(delivery.patch?.sha256 ?? '') && p.githubPatchSha256 === delivery.patch.sha256 && (p.comparison === 'exact_complete_text_diff' && p.cloudPatchSha256 === delivery.patch.sha256 || p.comparison === 'exact_incremental_text_diff_with_full_pr' && p.fullPrPatchSha256 === delivery.patch.sha256 && p.incremental?.verified === true && p.incremental.newHeadSha === a.expectedHeadSha && p.incremental.cloudPatchSha256 === delivery.deltaPatch?.sha256 && p.incremental.githubDeltaPatchSha256 === delivery.deltaPatch?.sha256);
  const pr = Number.isSafeInteger(a.pullRequestNumber) && a.pullRequestNumber > 0 && a.pullRequestUrl === `https://github.com/${a.repository}/pull/${a.pullRequestNumber}` ? a.pullRequestUrl : null;
  const ready = delivery.status === 'ready_for_independent_review' && verified && pr && delivery.checks.state === 'passed' && checks.length > 0 && checks.every(row => row.state === 'passed');
  const reasons = [...new Set(delivery.reasons.filter(code => typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(code)))].sort().slice(0, 12);
  if (!ready && !reasons.length) reasons.push(!verified ? 'BASE_AND_HEAD_PROVENANCE_UNVERIFIED' : 'CI_UNVERIFIED');
  const status = ready ? 'ready_for_independent_review' : 'needs_attention';
  const ciState = ['passed', 'failed', 'pending', 'missing', 'unconfigured', 'unverified'].includes(delivery.checks.state) ? delivery.checks.state : 'unverified';
  const meaningful = { status, executionId: a.executionId, headSha: a.expectedHeadSha ?? null, baseSha: a.expectedBaseSha, cloudTaskId: a.cloudTaskId, pr: pr ?? null, verified: Boolean(verified && pr), ciState, checks, reasons };
  const digest = hash(meaningful), key = 'factory-delivery:' + a.executionId + ':' + (a.expectedHeadSha ?? 'unpublished') + ':' + digest;
  const details = [
    ready ? '**Ready for independent review.**' : '**Delivery needs attention.**',
    `Repository: ${escape(a.repository)}`, `[Open Cloud task](${a.cloudTaskUrl})`,
    pr ? `[${verified ? 'Verified PR' : 'Unverified PR candidate'} #${a.pullRequestNumber}](${pr})` : 'PR: not provided or unverified; publish the patch manually and supply its exact PR/head.',
    a.expectedHeadSha ? 'Observed head: `' + a.expectedHeadSha + '`' : 'Published head: unverified.',
    'Required CI: ' + ciState,
    ...checks.map(check => '- ' + escape(check.name) + ': ' + check.state + check.links.map((url, index) => ` [check ${index + 1}](${url})`).join('')),
    ...reasons.map(code => '- `' + code + '`: ' + correction(code)),
    'This card reports delivery evidence only. Independent review, QA, fresh application test evidence, and explicit human approval are still required. Acknowledging it does not approve, complete, merge, deploy, change task status, or wake an agent.',
  ].join('\n\n');
  // The native confirmation schema bounds this field independently of JSON bytes.
  if (details.length > 20_000) fail('DELIVERY_NOTIFICATION_TOO_LARGE');
  // Native custom target keys have a stricter bound than interaction idempotency keys.
  const targetKey = 'factory-delivery:' + digest;
  const payload = { kind: 'request_confirmation', idempotencyKey: key, continuationPolicy: 'none', resolverPolicy: 'human_only', payload: { version: 1, prompt: ready ? 'Delivery evidence is ready for independent review.' : 'Review delivery prerequisites that need attention.', allowDeclineReason: true, detailsMarkdown: details, target: { type: 'custom', key: targetKey, href: verified && pr ? pr : a.cloudTaskUrl } } };
  if (Buffer.byteLength(JSON.stringify(payload)) > 32_000) fail('DELIVERY_NOTIFICATION_TOO_LARGE');
  return { key, digest, status, payload };
}

/** One non-expiring native write intent. Ambiguous sends are recoverable by reads only. */
export class DeliveryNotificationOutbox {
  constructor({ directory }) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || /[\u0000-\u001f\u007f]/.test(directory)) fail('DELIVERY_NOTIFICATION_UNSAFE_STORAGE');
    this.directory = path.resolve(directory);
    const first = fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) fail('DELIVERY_NOTIFICATION_UNSAFE_STORAGE');
    fs.chmodSync(directory, 0o700);
    if (first) for (let cursor = directory;; cursor = path.dirname(cursor)) { syncDirectory(cursor); syncDirectory(path.dirname(cursor)); if (cursor === first) break; }
    const filename = path.join(directory, 'delivery-notifications.sqlite'); let fd;
    try { fd = fs.openSync(filename, 'wx', 0o600); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; syncDirectory(directory); } catch (error) { if (fd !== undefined) fs.closeSync(fd); if (error.code !== 'EEXIST') throw error; }
    if (!fs.lstatSync(filename).isFile() || fs.lstatSync(filename).isSymbolicLink()) fail('DELIVERY_NOTIFICATION_UNSAFE_STORAGE');
    fs.chmodSync(filename, 0o600); this.db = new DatabaseSync(filename);
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON;');
      this.transaction(() => {
        const version = this.db.prepare('PRAGMA user_version').get().user_version, app = this.db.prepare('PRAGMA application_id').get().application_id;
        if (version > 1 || app && app !== APP || version && app !== APP || !version && this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length) fail('DELIVERY_NOTIFICATION_MIGRATION_REQUIRED');
        this.db.exec(`CREATE TABLE IF NOT EXISTS notifications(key TEXT PRIMARY KEY,revision INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('sending','unknown','delivered')),token TEXT NOT NULL,binding TEXT NOT NULL,payload TEXT NOT NULL,interaction_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL); PRAGMA user_version=1; PRAGMA application_id=${APP};`);
      }); this.db.exec('PRAGMA journal_mode=WAL'); syncDirectory(directory);
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  transaction(action) { this.db.exec('BEGIN IMMEDIATE'); try { const result = action(); this.db.exec('COMMIT'); syncDirectory(this.directory); return result; } catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; } }
  get(key) { const row = this.db.prepare('SELECT * FROM notifications WHERE key=?').get(key); return row ? { key: row.key, revision: row.revision, state: row.state, token: row.token, binding: JSON.parse(row.binding), payload: JSON.parse(row.payload), interactionId: row.interaction_id } : null; }
  claim({ key, binding, payload, now }) {
    if (typeof key !== 'string' || key.length > 240 || payload?.idempotencyKey !== key || Buffer.byteLength(JSON.stringify(payload) ?? '') > 32_000 || Buffer.byteLength(JSON.stringify(binding) ?? '') > 8192 || !Number.isFinite(Date.parse(now))) fail('DELIVERY_NOTIFICATION_INVALID_INTENT');
    return this.transaction(() => {
      const old = this.get(key);
      if (old) { if (!isDeepStrictEqual(old.binding, binding) || !isDeepStrictEqual(old.payload, payload)) fail('DELIVERY_NOTIFICATION_BINDING_CHANGED'); return { created: false, record: old }; }
      this.db.prepare("INSERT INTO notifications VALUES(?,0,'sending',?,?,?,NULL,?,?)").run(key, randomUUID(), JSON.stringify(binding), JSON.stringify(payload), now, now);
      return { created: true, record: this.get(key) };
    });
  }
  update(record, { state, interactionId = null, now }) {
    if (!['unknown', 'delivered'].includes(state) || state === 'delivered' && !UUID.test(interactionId ?? '')) fail('DELIVERY_NOTIFICATION_INVALID_STATE');
    return this.transaction(() => {
      if (this.db.prepare("UPDATE notifications SET revision=revision+1,state=?,interaction_id=?,updated_at=? WHERE key=? AND revision=? AND token=? AND state IN ('sending','unknown')").run(state, interactionId, now, record.key, record.revision, record.token).changes !== 1) fail('DELIVERY_NOTIFICATION_STALE');
      return this.get(record.key);
    });
  }
}

function runtimeConfig(runtime) {
  if (typeof runtime?.paperclipCommand !== 'string' || !path.isAbsolute(runtime.paperclipCommand) || /[\u0000-\u001f\u007f]/.test(runtime.paperclipCommand)) fail('DELIVERY_NOTIFICATION_INVALID_COMMAND');
  let url; try { url = new URL(runtime.apiBase); } catch { fail('DELIVERY_NOTIFICATION_INVALID_ORIGIN'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('DELIVERY_NOTIFICATION_INVALID_ORIGIN');
  return { paperclipCommand: runtime.paperclipCommand, apiBase: url.origin };
}
function sameProject(project, execution) {
  if (project?.id !== execution.projectId || project.companyId !== execution.companyId) return false;
  const rows = Array.isArray(project.workspaces) ? project.workspaces : [];
  const workspace = execution.workspaceId ? rows.find(row => row.id === execution.workspaceId) : project.primaryWorkspace ?? rows.find(row => row.isPrimary) ?? (rows.length === 1 ? rows[0] : project.codebase);
  if (!workspace || workspace.companyId && workspace.companyId !== execution.companyId || workspace.projectId && workspace.projectId !== execution.projectId) return false;
  let repo = workspace.repoUrl?.match(/^git@github\.com:([^?#]+)$/)?.[1];
  if (!repo) { let url; try { url = new URL(workspace.repoUrl); } catch { return false; } if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash) return false; repo = url.pathname.slice(1); }
  const ref = workspace.repoRef ?? workspace.defaultRef;
  return repo.replace(/\/$/, '').replace(/\.git$/, '').toLowerCase() === execution.repository.toLowerCase() && (!ref || ref.replace(/^refs\/heads\//, '') === execution.branch);
}
export async function notifyDeliveryFromPaperclip({ observation, execution, registration, directory, runtime, run = runCommand, env = process.env, now = () => new Date().toISOString() }) {
  const a = validateObservation(observation, execution, registration), rendered = renderDeliveryNotification({ observation, execution, registration }), config = runtimeConfig(runtime), at = now();
  if (!registration || !Number.isFinite(Date.parse(at)) || !Number.isFinite(Date.parse(observation.observedAt)) || observation.delivery.observedAt !== observation.observedAt || Date.parse(at) < Date.parse(observation.observedAt) || Date.parse(at) - Date.parse(observation.observedAt) > 60_000) fail('DELIVERY_NOTIFICATION_STALE_OBSERVATION');
  const childEnv = { ...cloudEnvironment(env), PAPERCLIP_TELEMETRY_DISABLED: '1' };
  for (const key of ['PAPERCLIP_HOME', 'PAPERCLIP_INSTANCE_ID', 'PAPERCLIP_AUTH_STORE']) if (typeof env[key] === 'string') childEnv[key] = env[key];
  const pc = async args => {
    let result; try { result = await run(config.paperclipCommand, [...args, '--api-base', config.apiBase, '--json'], { env: childEnv, timeoutMs: 15000, maxOutputBytes: 1_000_000 }); } catch { fail('DELIVERY_NOTIFICATION_PAPERCLIP_UNAVAILABLE'); }
    if (result?.code !== 0 || result.timedOut || result.signal || result.outputExceeded || result.failedToStart || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > 1_000_000) fail('DELIVERY_NOTIFICATION_PAPERCLIP_UNAVAILABLE');
    try { return JSON.parse(result.stdout); } catch { fail('DELIVERY_NOTIFICATION_INVALID_RESPONSE'); }
  };
  const identity = await pc(['whoami']), actor = identity?.userId;
  if (typeof actor !== 'string' || !actor.trim() || Buffer.byteLength(actor) > 200 || /[\u0000-\u001f\u007f]/.test(actor) || !Array.isArray(identity.companyIds) || !identity.companyIds.includes(a.companyId)) fail('DELIVERY_NOTIFICATION_BOARD_SIGN_IN_REQUIRED');
  const owner = await pc(['run', 'get', a.paperclipRunId]);
  if (owner?.id !== a.paperclipRunId || owner.companyId !== a.companyId || !UUID.test(owner.agentId ?? '') || owner.contextSnapshot?.issueId !== a.paperclipIssueId) fail('DELIVERY_NOTIFICATION_RUN_CHANGED');
  const issue = await pc(['issue', 'get', a.paperclipIssueId]);
  const result = (status, code, interactionId) => ({ status, ...(code ? { code } : {}), ...(interactionId ? { interactionId } : {}), executionId: a.executionId, deliveryStatus: rendered.status, humanStatusUnchanged: true, humanApprovalEligible: false });
  if (issue?.id !== a.paperclipIssueId || issue.companyId !== a.companyId || issue.projectId !== a.projectId) return result('skipped', 'PAPERCLIP_SCOPE_CHANGED');
  if (['done', 'cancelled'].includes(issue.status)) return result('skipped', 'PAPERCLIP_ALREADY_TERMINAL');
  if (issue.assigneeAgentId !== owner.agentId || issue.assigneeUserId) return result('skipped', 'PAPERCLIP_ASSIGNEE_CHANGED');
  if (['queued', 'running'].includes(owner.status)) return result('deferred', 'PAPERCLIP_DISPATCH_ACTIVE');
  if (!['succeeded', 'failed', 'cancelled', 'timed_out'].includes(owner.status)) return result('skipped', 'PAPERCLIP_RUN_UNVERIFIED');
  if (!sameProject(await pc(['project', 'get', a.projectId]), execution)) return result('skipped', 'PAPERCLIP_BINDING_CHANGED');
  const outbox = new DeliveryNotificationOutbox({ directory });
  try {
    const claimed = outbox.claim({ key: rendered.key, binding: { companyId: a.companyId, issueId: a.paperclipIssueId, projectId: a.projectId, executionId: a.executionId, runId: a.paperclipRunId, agentId: owner.agentId, boardUserId: actor, apiBase: config.apiBase, configHash: registration.configHash, policyHash: registration.policyHash }, payload: rendered.payload, now: at });
    let record = claimed.record;
    if (record.state === 'delivered') return result('already_notified', undefined, record.interactionId);
    const confirmed = card => UUID.test(card?.id ?? '') && card.companyId === a.companyId && card.issueId === a.paperclipIssueId && card.createdByUserId === record.binding.boardUserId && !card.createdByAgentId && !card.addresseeAgentId && Object.entries(record.payload).every(([key, value]) => isDeepStrictEqual(card[key], value));
    try {
      let card;
      if (claimed.created) card = await pc(['issue', 'interaction:create', a.paperclipIssueId, '--payload-json', JSON.stringify(record.payload)]);
      else {
        const rows = await pc(['issue', 'interactions', a.paperclipIssueId]);
        if (!Array.isArray(rows) || rows.length > 1000) fail('DELIVERY_NOTIFICATION_INVALID_RESPONSE');
        const candidates = rows.filter(row => row.idempotencyKey === record.payload.idempotencyKey);
        if (candidates.length !== 1) fail('DELIVERY_NOTIFICATION_WRITE_UNKNOWN');
        card = candidates[0];
      }
      if (!confirmed(card)) fail('DELIVERY_NOTIFICATION_WRITE_UNKNOWN');
      record = outbox.update(record, { state: 'delivered', interactionId: card.id, now: at });
      return result('notified', undefined, record.interactionId);
    } catch {
      const latest = outbox.get(record.key);
      if (latest.state === 'delivered') return result('already_notified', undefined, latest.interactionId);
      try { outbox.update(latest, { state: 'unknown', now: at }); } catch { /* Original send intent remains non-expiring. */ }
      return result('notification_unknown', 'PAPERCLIP_WRITE_UNKNOWN');
    }
  } finally { outbox.close(); }
}
