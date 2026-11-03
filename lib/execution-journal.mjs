import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const JOURNAL_FILENAME = 'executions.sqlite';
export const JOURNAL_APPLICATION_ID = 0x46434a31;
export const JOURNAL_SCHEMA_VERSION = 4;
export const JOURNAL_MIGRATIONS = [
  `CREATE TABLE executions (
    id TEXT PRIMARY KEY, company_id TEXT NOT NULL, issue_id TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK(attempt > 0), paperclip_run_id TEXT NOT NULL,
    project_id TEXT NOT NULL, workspace_id TEXT, repository TEXT NOT NULL,
    environment_id TEXT NOT NULL, branch TEXT NOT NULL, mode TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','dispatching','running','succeeded','failed','cancelled','unknown')),
    cloud_task_id TEXT UNIQUE, emitted_url TEXT, task_url TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, dispatched_at TEXT, error_code TEXT,
    UNIQUE(company_id,issue_id,attempt)
  );`,
  `ALTER TABLE executions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
   CREATE UNIQUE INDEX one_active_execution ON executions(company_id,issue_id)
     WHERE state IN ('queued','dispatching','running','unknown');
   CREATE TABLE execution_events (
     id INTEGER PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES executions(id),
     from_state TEXT, to_state TEXT NOT NULL, revision INTEGER NOT NULL,
     run_id TEXT, error_code TEXT, at TEXT NOT NULL
   );
   CREATE TABLE execution_runs (
     execution_id TEXT NOT NULL REFERENCES executions(id), run_id TEXT NOT NULL,
     first_seen_at TEXT NOT NULL, PRIMARY KEY(execution_id,run_id)
   );
   CREATE TABLE legacy_imports (
     source_path TEXT PRIMARY KEY, source_sha256 TEXT NOT NULL,
     execution_id TEXT NOT NULL REFERENCES executions(id), imported_at TEXT NOT NULL
   );
   INSERT INTO execution_events(execution_id,from_state,to_state,revision,run_id,error_code,at)
     SELECT id,NULL,state,0,paperclip_run_id,error_code,updated_at FROM executions;
   INSERT INTO execution_runs SELECT id,paperclip_run_id,created_at FROM executions;`,
  `UPDATE execution_events SET at=(SELECT MIN(imported_at) FROM legacy_imports WHERE execution_id=execution_events.execution_id)
     WHERE revision=0 AND from_state IS NULL AND to_state IN ('running','unknown')
       AND execution_id IN (SELECT execution_id FROM legacy_imports)
       AND at=(SELECT created_at FROM executions WHERE id=execution_events.execution_id);
   UPDATE executions SET updated_at=(SELECT MIN(imported_at) FROM legacy_imports WHERE execution_id=executions.id)
     WHERE revision=0 AND state IN ('running','unknown') AND updated_at=created_at
       AND id IN (SELECT execution_id FROM legacy_imports);`,
  `CREATE TABLE execution_polling (
     execution_id TEXT PRIMARY KEY REFERENCES executions(id), next_poll_at TEXT NOT NULL,
     error_count INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_owner TEXT, lease_expires_at TEXT,
     cloud_updated_at TEXT
   );
   CREATE TABLE cloud_observations (
     id INTEGER PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES executions(id),
     observed_at TEXT NOT NULL, cloud_updated_at TEXT, status TEXT, error_code TEXT,
     summary_json TEXT, next_poll_at TEXT NOT NULL, error_count INTEGER NOT NULL
   );
   CREATE TABLE reconciliation_outbox (
     id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES executions(id),
     kind TEXT NOT NULL DEFAULT 'ready_for_review', mode TEXT NOT NULL,
     body TEXT NOT NULL, target TEXT NOT NULL, expected_agent_id TEXT,
     state TEXT NOT NULL DEFAULT 'pending', next_attempt_at TEXT NOT NULL,
     lease_token TEXT, lease_owner TEXT, lease_expires_at TEXT,
     error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
     UNIQUE(execution_id,kind)
   );
   CREATE TABLE provider_request_limits (company_id TEXT PRIMARY KEY, next_request_at TEXT NOT NULL);`,
];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const STATES = new Set(['queued', 'dispatching', 'running', 'succeeded', 'failed', 'cancelled', 'unknown']);
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const GRAPH = {
  queued: ['dispatching', 'failed', 'cancelled', 'unknown'], dispatching: ['running', 'unknown'],
  running: ['succeeded', 'failed', 'cancelled', 'unknown'], unknown: ['running', 'succeeded', 'failed', 'cancelled'],
  succeeded: [], failed: [], cancelled: [],
};
const SAFE_ERRORS = new Set(['DISPATCH_OUTCOME_UNKNOWN', 'INVALID_DISPATCH_RECEIPT', 'PAPERCLIP_REQUEST_REJECTED', 'PAPERCLIP_UNAVAILABLE', 'INVALID_PAPERCLIP_RESPONSE', 'DISPATCH_RECORDING_FAILED', 'INTERRUPTED_DISPATCH', 'LEGACY_UNKNOWN', 'CODEX_PREFLIGHT_FAILED', 'UNSUPPORTED_CODEX_VERSION', 'CHATGPT_LOGIN_REQUIRED', 'CHECKOUT_CONFLICT', 'OPERATOR_VERIFIED_FAILED', 'OPERATOR_VERIFIED_CANCELLED', 'UNCLASSIFIED_ERROR']);
export class JournalError extends Error {
  constructor(code) { const safe = code.startsWith('JOURNAL_') ? code : 'JOURNAL_' + code; super(safe); this.name = 'JournalError'; this.code = safe; }
}
function reject(code) { throw new JournalError(code); }
function uuid(value) { if (typeof value !== 'string' || !UUID.test(value)) reject('INVALID_JOURNAL_IDENTIFIER'); return value; }
function attemptNumber(value = 1) { if (!Number.isInteger(value) || value < 1 || value > 100) reject('INVALID_JOURNAL_ATTEMPT'); return value; }
const now = () => new Date().toISOString();
const safeCode = code => SAFE_ERRORS.has(code) ? code : 'UNCLASSIFIED_ERROR';
export const RECONCILIATION_ERRORS = new Set(['CLOUD_CLI_FAILED', 'CLOUD_CLI_TIMEOUT', 'CLOUD_SCHEMA_DRIFT', 'CLOUD_TASK_MISSING', 'CLOUD_UNRECOGNIZED_STATUS', 'CLOUD_STALE_OBSERVATION', 'CLOUD_AUTH_REQUIRED', 'CLOUD_VERSION_UNSUPPORTED', 'CLOUD_COMMAND_UNAVAILABLE', 'CLOUD_ENVIRONMENT_MISMATCH', 'CLOUD_URL_MISMATCH', 'CLOUD_PAGE_LIMIT', 'CLOUD_CURSOR_LOOP', 'CLOUD_OUTPUT_LIMIT', 'CLOUD_TASK_DUPLICATE', 'CLOUD_USAGE_LIMIT', 'PROVIDER_RATE_LIMIT', 'OPERATOR_RESUMED_POLLING', 'PAPERCLIP_READ_FAILED', 'PAPERCLIP_DISPATCH_ACTIVE', 'PAPERCLIP_WRITE_UNKNOWN', 'PAPERCLIP_SCOPE_CHANGED', 'PAPERCLIP_ALREADY_TERMINAL', 'PAPERCLIP_ALREADY_REVIEW', 'PAPERCLIP_ASSIGNEE_CHANGED', 'PAPERCLIP_BINDING_CHANGED', 'INVALID_PAPERCLIP_RESPONSE', 'PAPERCLIP_UNAVAILABLE', 'UNCLASSIFIED_ERROR']);
const reconciliationCode = value => RECONCILIATION_ERRORS.has(value) ? value : 'UNCLASSIFIED_ERROR';
function boundedInteger(value, minimum, maximum, code) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) reject(code);
  return value;
}
function boundedSchedule(value, at) {
  const result = timestamp(value);
  if (result < at || Date.parse(result) - Date.parse(at) > 86400000) reject('INVALID_RECONCILIATION_SCHEDULE');
  return result;
}
function leaseOptions(options) {
  return { ownerId: uuid(options.ownerId), at: timestamp(options.now), leaseMs: boundedInteger(options.leaseMs, 1000, 600000, 'INVALID_RECONCILIATION_LEASE') };
}
export function reconciliationHandoffBody(record) {
  uuid(record.executionId); receipt(record);
  return `Codex Cloud is ready for review.\n\nCloud task: ${record.taskUrl}\n\nCloud completion does not verify acceptance criteria. Final assistant output and PR metadata are unavailable from the supported CLI.\n\n<!-- factory-cloud-review:${record.executionId} -->`;
}
function pollingPlain(row) {
  return row ? { nextPollAt: row.next_poll_at, errorCount: row.error_count, cloudUpdatedAt: row.cloud_updated_at, ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}) } : null;
}
function handoffPlain(row) {
  return row ? { id: row.id, executionId: row.execution_id, kind: row.kind, mode: row.mode, body: row.body, target: row.target, expectedAgentId: row.expected_agent_id, state: row.state, nextAttemptAt: row.next_attempt_at, errorCode: row.error_code, createdAt: row.created_at, updatedAt: row.updated_at, ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}) } : null;
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT[0-9:.]+(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) reject('INVALID_JOURNAL_TIMESTAMP');
  return new Date(value).toISOString();
}
function identity(input, companyId) {
  if (!input || input.companyId !== companyId) reject('JOURNAL_COMPANY_MISMATCH');
  const record = { companyId, paperclipIssueId: uuid(input.paperclipIssueId), paperclipRunId: uuid(input.paperclipRunId), projectId: uuid(input.projectId), attempt: attemptNumber(input.attempt ?? 1) };
  if (input.workspaceId !== undefined && input.workspaceId !== null) record.workspaceId = uuid(input.workspaceId);
  if (typeof input.repository !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(input.repository)) reject('INVALID_JOURNAL_REPOSITORY');
  if (typeof input.environmentId !== 'string' || !/^[a-f0-9]{32}$/.test(input.environmentId)) reject('INVALID_JOURNAL_ENVIRONMENT');
  if (typeof input.branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(input.branch) || /\.\.|\/\/|\/$|\.$|\.lock(?:\/|$)|\/\./.test(input.branch)) reject('INVALID_JOURNAL_BRANCH');
  if (!['read_only', 'code_change'].includes(input.mode)) reject('INVALID_JOURNAL_MODE');
  return { ...record, repository: input.repository, environmentId: input.environmentId, branch: input.branch, mode: input.mode };
}
function receipt(input) {
  if (!input || !/^task_e_[a-f0-9]{32}$/.test(input.cloudTaskId ?? '')) reject('INVALID_JOURNAL_RECEIPT');
  if (input.emittedUrl !== 'https://chatgpt.com/codex/tasks/' + input.cloudTaskId && input.emittedUrl !== 'https://chatgpt.com/remote/' + input.cloudTaskId) reject('INVALID_JOURNAL_RECEIPT');
  if (input.taskUrl !== 'https://chatgpt.com/remote/' + input.cloudTaskId) reject('INVALID_JOURNAL_RECEIPT');
  return { cloudTaskId: input.cloudTaskId, emittedUrl: input.emittedUrl, taskUrl: input.taskUrl };
}
function plain(row) {
  if (!row) return null;
  return { schemaVersion: JOURNAL_SCHEMA_VERSION, executionId: row.id, companyId: row.company_id, paperclipIssueId: row.issue_id, paperclipRunId: row.paperclip_run_id, projectId: row.project_id, ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}), repository: row.repository, environmentId: row.environment_id, branch: row.branch, mode: row.mode, attempt: row.attempt, state: row.state, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, ...(row.cloud_task_id ? { cloudTaskId: row.cloud_task_id, emittedUrl: row.emitted_url, taskUrl: row.task_url } : {}), ...(row.dispatched_at ? { dispatchedAt: row.dispatched_at } : {}), ...(row.error_code ? { errorCode: row.error_code } : {}) };
}
function retryBusy(fn) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try { return fn(); }
    catch (error) {
      const busy = [5, 6].includes(Number(error.errcode) & 255) || ['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(error.code);
      if (!busy || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}
function syncDirectory(directory) {
  const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export class ExecutionJournal {
  constructor({ directory, companyId }) {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 24 || (major === 24 && minor < 15) || major === 25) reject('UNSUPPORTED_JOURNAL_RUNTIME');
    uuid(companyId);
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) reject('INVALID_JOURNAL_DIRECTORY');
    directory = path.resolve(directory);
    this.directory = directory; this.companyId = companyId; this.filename = path.join(directory, JOURNAL_FILENAME);
    const firstCreated = fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    // Persist every new directory entry, not only files in the leaf directory.
    if (firstCreated) {
      for (let cursor = directory;; cursor = path.dirname(cursor)) {
        syncDirectory(cursor); syncDirectory(path.dirname(cursor));
        if (cursor === firstCreated) break;
      }
    }
    let fd; try { fd = fs.openSync(this.filename, 'wx', 0o600); fs.fsyncSync(fd); fs.closeSync(fd); syncDirectory(directory); }
    catch (error) { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } if (error.code !== 'EEXIST') reject('JOURNAL_OPEN_FAILED'); }
    fs.chmodSync(this.filename, 0o600);
    try {
      this.db = new DatabaseSync(this.filename, { timeout: 5000 });
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON;');
      this.transaction(() => {
        // Read all metadata under one writer lock; do not mix migration snapshots.
        const current = this.db.prepare('PRAGMA user_version').get().user_version;
        const app = this.db.prepare('PRAGMA application_id').get().application_id;
        if (current > JOURNAL_SCHEMA_VERSION || (app !== 0 && app !== JOURNAL_APPLICATION_ID) || (current > 0 && app !== JOURNAL_APPLICATION_ID)) reject('JOURNAL_SCHEMA_UNSUPPORTED');
        if (current === 0 && this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length) reject('JOURNAL_SCHEMA_UNSUPPORTED');
        for (let n = current; n < JOURNAL_SCHEMA_VERSION; n++) { this.db.exec(JOURNAL_MIGRATIONS[n]); this.db.exec('PRAGMA user_version=' + (n + 1)); }
        this.db.exec('PRAGMA application_id=' + JOURNAL_APPLICATION_ID);
      });
      retryBusy(() => {
        const mode = this.db.prepare('PRAGMA journal_mode=WAL').get().journal_mode;
        if (mode !== 'wal') throw Object.assign(new Error(), { errcode: 5 });
      });
    } catch (error) { try { this.db?.close(); } catch {} throw error instanceof JournalError ? error : new JournalError('JOURNAL_OPEN_FAILED'); }
  }
  close() { this.db?.close(); }
  transaction(fn) {
    try { retryBusy(() => this.db.exec('BEGIN IMMEDIATE')); } catch { throw new JournalError('TRANSACTION_UNAVAILABLE'); }
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error instanceof JournalError ? error : new JournalError('JOURNAL_WRITE_FAILED'); }
  }
  get(issueId, attempt = 1) { uuid(issueId); attemptNumber(attempt); return plain(this.db.prepare('SELECT * FROM executions WHERE company_id=? AND issue_id=? AND attempt=?').get(this.companyId, issueId, attempt)); }
  list() { return this.db.prepare('SELECT * FROM executions WHERE company_id=? ORDER BY created_at,id').all(this.companyId).map(plain); }
  listNonterminal() { return this.list().filter(record => !TERMINAL.has(record.state)); }
  events(issueId, attempt = 1) {
    const record = this.get(issueId, attempt); if (!record) return [];
    return this.db.prepare('SELECT * FROM execution_events WHERE execution_id=? ORDER BY id').all(record.executionId).map(row => ({ ...row }));
  }
  runs(issueId, attempt = 1) {
    const record = this.get(issueId, attempt); if (!record) return [];
    return this.db.prepare('SELECT run_id,first_seen_at FROM execution_runs WHERE execution_id=? ORDER BY first_seen_at,run_id').all(record.executionId).map(row => ({ paperclipRunId: row.run_id, firstSeenAt: row.first_seen_at }));
  }
  observeRun(issueId, runId, attempt = 1) {
    uuid(runId); const record = this.get(issueId, attempt); if (!record) reject('EXECUTION_NOT_FOUND');
    this.db.prepare('INSERT OR IGNORE INTO execution_runs VALUES(?,?,?)').run(record.executionId, runId, now()); return record;
  }
  checkBinding(record, expected) {
    if (['companyId', 'paperclipIssueId', 'projectId', 'workspaceId', 'repository', 'environmentId', 'branch', 'mode', 'attempt'].some(key => record[key] !== expected[key])) reject('JOURNAL_BINDING_MISMATCH');
  }
  insert(data, state, options = {}) {
    const at = options.createdAt ?? now(); const updatedAt = options.updatedAt ?? at; const accepted = options.receipt ?? {};
    const executionId = options.executionId ?? randomUUID();
    this.db.prepare('INSERT INTO executions(id,company_id,issue_id,attempt,paperclip_run_id,project_id,workspace_id,repository,environment_id,branch,mode,state,cloud_task_id,emitted_url,task_url,created_at,updated_at,dispatched_at,error_code,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)').run(executionId, data.companyId, data.paperclipIssueId, data.attempt, data.paperclipRunId, data.projectId, data.workspaceId ?? null, data.repository, data.environmentId, data.branch, data.mode, state, accepted.cloudTaskId ?? null, accepted.emittedUrl ?? null, accepted.taskUrl ?? null, at, updatedAt, options.dispatchedAt ?? null, options.errorCode ?? null);
    this.db.prepare('INSERT INTO execution_runs VALUES(?,?,?)').run(executionId, data.paperclipRunId, at);
    this.db.prepare('INSERT INTO execution_events(execution_id,from_state,to_state,revision,run_id,error_code,at) VALUES(?,NULL,?,0,?,?,?)').run(executionId, state, data.paperclipRunId, options.errorCode ?? null, updatedAt);
    return this.get(data.paperclipIssueId, data.attempt);
  }
  queue(input) {
    const data = identity(input, this.companyId);
    return this.transaction(() => {
      const existing = this.get(data.paperclipIssueId, data.attempt);
      if (existing) { this.checkBinding(existing, data); this.observeRun(data.paperclipIssueId, data.paperclipRunId, data.attempt); return existing; }
      const previous = this.db.prepare('SELECT attempt,state FROM executions WHERE company_id=? AND issue_id=? ORDER BY attempt').all(this.companyId, data.paperclipIssueId);
      if (data.attempt !== previous.length + 1 || previous.some(record => !TERMINAL.has(record.state))) reject('ATTEMPT_REQUIRES_RECONCILIATION');
      return this.insert(data, 'queued');
    });
  }
  ensureFence(record) {
    const file = path.join(this.directory, record.paperclipIssueId + '.json');
    const fence = { schemaVersion: 1, status: 'dispatching', companyId: record.companyId, paperclipIssueId: record.paperclipIssueId, paperclipRunId: record.paperclipRunId, projectId: record.projectId, ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}), repository: record.repository, environmentId: record.environmentId, branch: record.branch, mode: record.mode, createdAt: record.createdAt, journalExecutionId: record.executionId };
    let fd;
    try { fd = fs.openSync(file, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(fence) + '\n'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; syncDirectory(this.directory); }
    catch (error) {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
      if (error.code !== 'EEXIST') reject('JOURNAL_FENCE_FAILED');
      const snapshot = this.legacySnapshot(record.paperclipIssueId);
      if (snapshot.raw.journalExecutionId) {
        const owner = plain(this.db.prepare('SELECT * FROM executions WHERE id=?').get(snapshot.raw.journalExecutionId));
        if (owner && owner.companyId === record.companyId && owner.paperclipIssueId === record.paperclipIssueId) {
          this.checkBinding(owner, snapshot.data); return;
        }
      }
      const imported = this.db.prepare('SELECT * FROM legacy_imports WHERE source_path=?').get(file);
      if (!imported || imported.source_sha256 !== snapshot.hash) reject('LEGACY_GUARD_REQUIRES_MIGRATION');
    }
  }
  update(record, toState, { runId = record.paperclipRunId, errorCode = null, accepted, dispatchedAt } = {}) {
    const at = now();
    if (accepted && record.cloudTaskId && record.cloudTaskId !== accepted.cloudTaskId) reject('CLOUD_RECEIPT_MISMATCH');
    const updated = this.db.prepare('UPDATE executions SET state=?,paperclip_run_id=?,cloud_task_id=?,emitted_url=?,task_url=?,updated_at=?,dispatched_at=?,error_code=?,revision=revision+1 WHERE id=? AND revision=? AND state=?').run(toState, runId, accepted?.cloudTaskId ?? record.cloudTaskId ?? null, accepted?.emittedUrl ?? record.emittedUrl ?? null, accepted?.taskUrl ?? record.taskUrl ?? null, at, dispatchedAt ?? record.dispatchedAt ?? null, errorCode, record.executionId, record.revision, record.state);
    if (Number(updated.changes) !== 1) reject('STALE_EXECUTION_TRANSITION');
    this.db.prepare('INSERT INTO execution_events(execution_id,from_state,to_state,revision,run_id,error_code,at) VALUES(?,?,?,?,?,?,?)').run(record.executionId, record.state, toState, record.revision + 1, runId, errorCode, at);
    this.observeRun(record.paperclipIssueId, runId, record.attempt);
    return this.get(record.paperclipIssueId, record.attempt);
  }
  claim(issueId, runId, attempt = 1) {
    uuid(runId); const before = this.get(issueId, attempt); if (!before) reject('EXECUTION_NOT_FOUND');
    this.ensureFence(before); // Durable old-writer fence precedes the transactional Cloud-dispatch claim.
    return this.transaction(() => {
      const record = this.get(issueId, attempt);
      this.observeRun(issueId, runId, attempt);
      if (record.state !== 'queued') return { claimed: false, record };
      return { claimed: true, record: this.update(record, 'dispatching', { runId }) };
    });
  }
  accept(issueId, runId, input, attempt = 1) {
    const accepted = receipt(input); uuid(runId);
    return this.transaction(() => {
      const record = this.get(issueId, attempt); if (!record) reject('EXECUTION_NOT_FOUND');
      if (record.paperclipRunId !== runId) reject('EXECUTION_OWNER_MISMATCH');
      if (record.state === 'running') { if (record.cloudTaskId !== accepted.cloudTaskId) reject('CLOUD_RECEIPT_MISMATCH'); return record; }
      if (!['dispatching', 'unknown'].includes(record.state)) reject('INVALID_EXECUTION_TRANSITION');
      return this.update(record, 'running', { accepted, dispatchedAt: now() });
    });
  }
  markUnknown(issueId, runId, errorCode, input, attempt = 1) {
    uuid(runId); const accepted = input?.cloudTaskId ? receipt(input) : undefined;
    return this.transaction(() => {
      const record = this.get(issueId, attempt); if (!record) reject('EXECUTION_NOT_FOUND');
      if (record.paperclipRunId !== runId) reject('EXECUTION_OWNER_MISMATCH');
      if (TERMINAL.has(record.state)) reject('INVALID_EXECUTION_TRANSITION');
      return this.update(record, 'unknown', { errorCode: safeCode(errorCode), accepted });
    });
  }
  recoverInterrupted(issueId, attempt = 1) {
    return this.transaction(() => {
      const record = this.get(issueId, attempt); if (!record) reject('EXECUTION_NOT_FOUND');
      return record.state === 'dispatching' ? this.update(record, 'unknown', { errorCode: 'INTERRUPTED_DISPATCH' }) : record;
    });
  }
  transition(issueId, { attempt = 1, expectedState, expectedRevision, toState, errorCode, receipt: input }) {
    if (!STATES.has(toState) || !STATES.has(expectedState) || !Number.isInteger(expectedRevision)) reject('INVALID_EXECUTION_TRANSITION');
    const accepted = input ? receipt(input) : undefined;
    return this.transaction(() => {
      const record = this.get(issueId, attempt); if (!record) reject('EXECUTION_NOT_FOUND');
      if (record.state !== expectedState || record.revision !== expectedRevision) reject('STALE_EXECUTION_TRANSITION');
      if (!GRAPH[record.state].includes(toState)) reject('INVALID_EXECUTION_TRANSITION');
      if (toState === 'running' && !accepted && !record.cloudTaskId) reject('INVALID_JOURNAL_RECEIPT');
      if (toState === 'dispatching') reject('USE_DISPATCH_CLAIM');
      return this.update(record, toState, { accepted, errorCode: errorCode ? safeCode(errorCode) : null });
    });
  }
  executionById(executionId) {
    uuid(executionId);
    return plain(this.db.prepare('SELECT * FROM executions WHERE company_id=? AND id=?').get(this.companyId, executionId));
  }
  getExecution(executionId) { return this.executionById(executionId); }
  polling(executionId) {
    if (!this.executionById(executionId)) return null;
    return pollingPlain(this.db.prepare('SELECT * FROM execution_polling WHERE execution_id=?').get(executionId));
  }
  observations(executionId) {
    if (!this.executionById(executionId)) return [];
    const record = this.executionById(executionId);
    return this.db.prepare('SELECT * FROM cloud_observations WHERE execution_id=? ORDER BY id').all(executionId).map(row => ({ id: row.id, cloudTaskId: record.cloudTaskId, observedAt: row.observed_at, cloudUpdatedAt: row.cloud_updated_at, status: row.status, errorCode: row.error_code, summary: row.summary_json ? JSON.parse(row.summary_json) : null, nextPollAt: row.next_poll_at, errorCount: row.error_count }));
  }
  listPollable({ now: value, limit = 100, maxErrorCount = 1001 }) {
    const at = timestamp(value); boundedInteger(limit, 1, 1000, 'INVALID_RECONCILIATION_LIMIT');
    boundedInteger(maxErrorCount, 1, 1001, 'INVALID_RECONCILIATION_ERROR_COUNT');
    return this.db.prepare(`SELECT e.* FROM executions e LEFT JOIN execution_polling p ON p.execution_id=e.id
      WHERE e.company_id=? AND e.state IN ('running','unknown') AND e.cloud_task_id IS NOT NULL
        AND COALESCE(p.error_count,0)<?
        AND (p.next_poll_at IS NULL OR p.next_poll_at<=?) AND (p.lease_expires_at IS NULL OR p.lease_expires_at<=?)
      ORDER BY COALESCE(p.next_poll_at,e.created_at),e.id LIMIT ?`).all(this.companyId, maxErrorCount, at, at, limit).map(plain);
  }
  claimPoll(executionId, options) {
    uuid(executionId); const { ownerId, at, leaseMs } = leaseOptions(options);
    const maxErrorCount = boundedInteger(options.maxErrorCount ?? 1001, 1, 1001, 'INVALID_RECONCILIATION_ERROR_COUNT');
    return this.transaction(() => {
      const record = this.executionById(executionId);
      if (!record || !['running', 'unknown'].includes(record.state) || !record.cloudTaskId) return null;
      const poll = this.db.prepare('SELECT * FROM execution_polling WHERE execution_id=?').get(executionId);
      if (poll && (poll.error_count >= maxErrorCount || poll.next_poll_at > at || poll.lease_expires_at > at)) return null;
      const token = randomUUID(), expiresAt = new Date(Date.parse(at) + leaseMs).toISOString();
      this.db.prepare(`INSERT INTO execution_polling(execution_id,next_poll_at,error_count,lease_token,lease_owner,lease_expires_at)
        VALUES(?,?,0,?,?,?) ON CONFLICT(execution_id) DO UPDATE SET lease_token=excluded.lease_token,lease_owner=excluded.lease_owner,lease_expires_at=excluded.lease_expires_at`).run(executionId, at, token, ownerId, expiresAt);
      return { record, token, expiresAt };
    });
  }
  recordObservation({ executionId, token, expectedRevision, now: value, observation, nextPollAt, errorCount = 0, toState, handoff }) {
    uuid(executionId); uuid(token); const at = timestamp(value), next = boundedSchedule(nextPollAt, at);
    boundedInteger(expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'INVALID_EXECUTION_REVISION');
    boundedInteger(errorCount, 0, 1000, 'INVALID_RECONCILIATION_ERROR_COUNT');
    if (!observation || !['pending', 'ready', null, undefined].includes(observation.status)) reject('INVALID_CLOUD_OBSERVATION');
    const status = observation.status ?? null;
    if ((!status && !observation.errorCode) || (status && observation.errorCode)) reject('INVALID_CLOUD_OBSERVATION');
    const errorCode = observation.errorCode ? reconciliationCode(observation.errorCode) : null;
    const observedAt = timestamp(observation.observedAt ?? at);
    if (observedAt > at) reject('INVALID_CLOUD_OBSERVATION');
    const cloudUpdatedAt = status && observation.cloudUpdatedAt ? timestamp(observation.cloudUpdatedAt) : null;
    let summary = null;
    if (status && observation.summary !== undefined && observation.summary !== null) {
      summary = {};
      for (const key of ['filesChanged', 'linesAdded', 'linesRemoved']) summary[key] = boundedInteger(observation.summary[key], 0, 1000000000, 'INVALID_CLOUD_SUMMARY');
    }
    if (toState !== undefined && !((status === 'ready' && toState === 'succeeded') || (status === 'pending' && toState === 'running'))) reject('INVALID_RECONCILIATION_TRANSITION');
    if (handoff && (status !== 'ready' || toState !== 'succeeded')) reject('INVALID_RECONCILIATION_HANDOFF');
    return this.transaction(() => {
      let record = this.executionById(executionId);
      const poll = this.db.prepare('SELECT * FROM execution_polling WHERE execution_id=?').get(executionId);
      if (!record || !poll || poll.lease_token !== token || !poll.lease_expires_at || poll.lease_expires_at <= at) reject('STALE_POLL_LEASE');
      if (observation.cloudTaskId !== record.cloudTaskId) reject('CLOUD_RECEIPT_MISMATCH');
      if (record.revision !== expectedRevision || !['running', 'unknown'].includes(record.state)) reject('STALE_EXECUTION_TRANSITION');
      const stale = Boolean(poll.cloud_updated_at && cloudUpdatedAt && cloudUpdatedAt < poll.cloud_updated_at);
      const finalCode = stale ? 'CLOUD_STALE_OBSERVATION' : errorCode;
      this.db.prepare('INSERT INTO cloud_observations(execution_id,observed_at,cloud_updated_at,status,error_code,summary_json,next_poll_at,error_count) VALUES(?,?,?,?,?,?,?,?)').run(executionId, observedAt, cloudUpdatedAt, stale ? null : status, finalCode, stale ? null : summary ? JSON.stringify(summary) : null, next, errorCount);
      this.db.prepare('UPDATE execution_polling SET next_poll_at=?,error_count=?,cloud_updated_at=?,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL WHERE execution_id=?').run(next, errorCount, stale ? poll.cloud_updated_at : cloudUpdatedAt ?? poll.cloud_updated_at, executionId);
      if (!stale && toState && toState !== record.state) record = this.update(record, toState);
      let outbox = null;
      if (!stale && handoff) {
        if (!['notify', 'status'].includes(handoff.mode) || handoff.target !== 'in_review') reject('INVALID_RECONCILIATION_HANDOFF');
        const body = reconciliationHandoffBody(record);
        if (handoff.body !== undefined && handoff.body !== body) reject('INVALID_RECONCILIATION_HANDOFF');
        const expectedAgentId = handoff.expectedAgentId ? uuid(handoff.expectedAgentId) : null;
        this.db.prepare(`INSERT INTO reconciliation_outbox(id,execution_id,mode,body,target,expected_agent_id,next_attempt_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(execution_id,kind) DO NOTHING`).run(randomUUID(), executionId, handoff.mode, body, 'in_review', expectedAgentId, at, at, at);
        outbox = handoffPlain(this.db.prepare('SELECT * FROM reconciliation_outbox WHERE execution_id=?').get(executionId));
      }
      return { record, stale, handoff: outbox };
    });
  }
  handoffs(executionId) {
    if (!this.executionById(executionId)) return [];
    return this.db.prepare('SELECT * FROM reconciliation_outbox WHERE execution_id=? ORDER BY created_at,id').all(executionId).map(handoffPlain);
  }
  pendingHandoffs({ now: value, limit = 100 }) {
    const at = timestamp(value); boundedInteger(limit, 1, 1000, 'INVALID_RECONCILIATION_LIMIT');
    return this.db.prepare(`SELECT o.* FROM reconciliation_outbox o JOIN executions e ON e.id=o.execution_id WHERE e.company_id=?
      AND o.state IN ('pending','leased','sending','unknown') AND o.next_attempt_at<=? AND (o.lease_expires_at IS NULL OR o.lease_expires_at<=?)
      ORDER BY o.next_attempt_at,o.id LIMIT ?`).all(this.companyId, at, at, limit).map(handoffPlain);
  }
  claimHandoff(id, options) {
    uuid(id); const { ownerId, at, leaseMs } = leaseOptions(options);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT o.* FROM reconciliation_outbox o JOIN executions e ON e.id=o.execution_id WHERE o.id=? AND e.company_id=?').get(id, this.companyId);
      if (!row || !['pending', 'leased', 'sending', 'unknown'].includes(row.state) || row.next_attempt_at > at || row.lease_expires_at > at) return null;
      const phase = ['sending', 'unknown'].includes(row.state) ? row.state : 'leased';
      const token = randomUUID(), expiresAt = new Date(Date.parse(at) + leaseMs).toISOString();
      this.db.prepare('UPDATE reconciliation_outbox SET state=?,lease_token=?,lease_owner=?,lease_expires_at=?,updated_at=? WHERE id=?').run(phase, token, ownerId, expiresAt, at, id);
      return { record: handoffPlain(this.db.prepare('SELECT * FROM reconciliation_outbox WHERE id=?').get(id)), execution: this.executionById(row.execution_id), token, phase, expiresAt };
    });
  }
  markHandoffSending(id, token, value) {
    uuid(id); uuid(token); const at = timestamp(value);
    return this.transaction(() => {
      const changed = this.db.prepare(`UPDATE reconciliation_outbox SET state='sending',updated_at=? WHERE id=? AND lease_token=? AND lease_expires_at>? AND state='leased'
        AND execution_id IN (SELECT id FROM executions WHERE company_id=?)`).run(at, id, token, at, this.companyId);
      if (Number(changed.changes) !== 1) reject('STALE_HANDOFF_LEASE');
      return handoffPlain(this.db.prepare('SELECT * FROM reconciliation_outbox WHERE id=?').get(id));
    });
  }
  finishHandoff(id, { token, now: value, state, errorCode, nextAttemptAt }) {
    uuid(id); uuid(token); const at = timestamp(value);
    if (!['delivered', 'skipped', 'unknown', 'pending'].includes(state)) reject('INVALID_HANDOFF_STATE');
    const next = nextAttemptAt ? boundedSchedule(nextAttemptAt, at) : at;
    return this.transaction(() => {
      const row = this.db.prepare('SELECT o.* FROM reconciliation_outbox o JOIN executions e ON e.id=o.execution_id WHERE o.id=? AND e.company_id=?').get(id, this.companyId);
      if (!row || row.lease_token !== token || !row.lease_expires_at || row.lease_expires_at <= at) reject('STALE_HANDOFF_LEASE');
      // Once a write may have started, only a read-confirmed resolution is safe.
      if (['sending', 'unknown'].includes(row.state) && state === 'pending') reject('AMBIGUOUS_HANDOFF_REQUIRES_RECONCILIATION');
      this.db.prepare('UPDATE reconciliation_outbox SET state=?,error_code=?,next_attempt_at=?,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?').run(state, errorCode ? reconciliationCode(errorCode) : null, next, at, id);
      return handoffPlain(this.db.prepare('SELECT * FROM reconciliation_outbox WHERE id=?').get(id));
    });
  }
  reserveProviderRequest({ now: value, minIntervalMs = 1000 }) {
    const at = timestamp(value); boundedInteger(minIntervalMs, 1000, 3600000, 'INVALID_PROVIDER_RATE_LIMIT');
    return this.transaction(() => {
      const row = this.db.prepare('SELECT next_request_at FROM provider_request_limits WHERE company_id=?').get(this.companyId);
      if (row && row.next_request_at > at) return { allowed: false, retryAt: row.next_request_at };
      const retryAt = new Date(Date.parse(at) + minIntervalMs).toISOString();
      this.db.prepare('INSERT INTO provider_request_limits VALUES(?,?) ON CONFLICT(company_id) DO UPDATE SET next_request_at=excluded.next_request_at').run(this.companyId, retryAt);
      return { allowed: true, retryAt };
    });
  }
  providerRequestLimit() {
    const row = this.db.prepare('SELECT next_request_at FROM provider_request_limits WHERE company_id=?').get(this.companyId);
    return row ? { retryAt: row.next_request_at } : null;
  }
  deferProviderRequests({ now: value, delayMs }) {
    const at = timestamp(value); boundedInteger(delayMs, 1000, 86400000, 'INVALID_PROVIDER_COOLDOWN');
    const proposed = new Date(Date.parse(at) + delayMs).toISOString();
    return this.transaction(() => {
      const current = this.providerRequestLimit();
      const retryAt = current && current.retryAt > proposed ? current.retryAt : proposed;
      this.db.prepare('INSERT INTO provider_request_limits VALUES(?,?) ON CONFLICT(company_id) DO UPDATE SET next_request_at=excluded.next_request_at').run(this.companyId, retryAt);
      return { retryAt };
    });
  }
  resumePolling(executionId, { now: value }) {
    uuid(executionId); const at = timestamp(value);
    return this.transaction(() => {
      const record = this.executionById(executionId);
      if (!record) reject('EXECUTION_NOT_FOUND');
      if (!['running', 'unknown'].includes(record.state) || !record.cloudTaskId) reject('POLL_RESUME_NOT_ALLOWED');
      receipt(record);
      const poll = this.db.prepare('SELECT * FROM execution_polling WHERE execution_id=?').get(executionId);
      if (poll?.lease_expires_at > at) reject('ACTIVE_POLL_LEASE');
      // This is an operator reset of read-only polling, never a dispatch retry.
      // Preserve the remote timestamp watermark and all execution/receipt data.
      this.db.prepare(`INSERT INTO execution_polling(execution_id,next_poll_at,error_count) VALUES(?,?,0)
        ON CONFLICT(execution_id) DO UPDATE SET next_poll_at=excluded.next_poll_at,error_count=0,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL`).run(executionId, at);
      this.db.prepare('INSERT INTO cloud_observations(execution_id,observed_at,cloud_updated_at,status,error_code,summary_json,next_poll_at,error_count) VALUES(?,?,NULL,NULL,?,NULL,?,0)').run(executionId, at, 'OPERATOR_RESUMED_POLLING', at);
      return { record, polling: this.polling(executionId) };
    });
  }
  legacySnapshot(issueId) {
    uuid(issueId); const file = path.join(this.directory, issueId + '.json'); let source;
    try { source = fs.readFileSync(file); } catch (error) { if (error.code === 'ENOENT') return null; reject('LEGACY_GUARD_UNREADABLE'); }
    let raw; try { raw = JSON.parse(source.toString('utf8')); } catch { reject('INVALID_LEGACY_GUARD'); }
    if (raw.schemaVersion !== 1 || raw.paperclipIssueId !== issueId || !['dispatching', 'dispatched', 'unknown'].includes(raw.status)) reject('INVALID_LEGACY_GUARD');
    const data = identity({ ...raw, attempt: 1 }, this.companyId);
    const accepted = raw.cloudTaskId ? receipt(raw) : undefined;
    if (raw.status === 'dispatched' && !accepted) reject('INVALID_LEGACY_GUARD');
    if (raw.journalExecutionId !== undefined) uuid(raw.journalExecutionId);
    const createdAt = timestamp(raw.createdAt);
    const dispatchedAt = raw.dispatchedAt ? timestamp(raw.dispatchedAt) : null;
    return { file, raw, data, accepted, createdAt, dispatchedAt, hash: createHash('sha256').update(source).digest('hex') };
  }
  importSnapshot(snapshot) {
    if (!snapshot) return null;
    const { file, raw, data, accepted, createdAt, dispatchedAt, hash } = snapshot;
    const existing = this.get(data.paperclipIssueId, 1);
    if (raw.journalExecutionId && existing?.executionId === raw.journalExecutionId) return existing;
    const imported = this.db.prepare('SELECT * FROM legacy_imports WHERE source_path=?').get(file);
    if (imported) {
      if (imported.source_sha256 !== hash) reject('LEGACY_GUARD_CHANGED');
      if (!existing || existing.executionId !== imported.execution_id) reject('LEGACY_IMPORT_MISMATCH');
      this.checkBinding(existing, data); return existing;
    }
    const state = raw.status === 'dispatched' ? 'running' : 'unknown';
    let record;
    if (existing) {
      // An old writer may win the file fence after the new journal queued intent.
      // Only an unclaimed queued row can be reconciled from that original guard.
      this.checkBinding(existing, data);
      if (existing.state !== 'queued' || existing.cloudTaskId) reject('LEGACY_GUARD_REQUIRES_MIGRATION');
      record = this.update(existing, state, { runId: data.paperclipRunId, accepted, dispatchedAt, errorCode: state === 'unknown' ? safeCode(raw.errorCode ?? 'LEGACY_UNKNOWN') : null });
    } else record = this.insert(data, state, { ...(raw.journalExecutionId ? { executionId: raw.journalExecutionId } : {}), receipt: accepted, createdAt, updatedAt: now(), dispatchedAt, ...(state === 'unknown' ? { errorCode: safeCode(raw.errorCode ?? 'LEGACY_UNKNOWN') } : {}) });
    this.db.prepare('INSERT INTO legacy_imports VALUES(?,?,?,?)').run(file, hash, record.executionId, record.updatedAt);
    return record;
  }
  importLegacyGuard(issueId) {
    const snapshot = this.legacySnapshot(issueId);
    return snapshot ? this.transaction(() => this.importSnapshot(snapshot)) : null;
  }
  importLegacyGuards() {
    const snapshots = fs.readdirSync(this.directory).filter(name => UUID.test(name.replace(/\.json$/, '')) && name.endsWith('.json')).map(name => this.legacySnapshot(name.slice(0, -5)));
    return this.transaction(() => snapshots.map(snapshot => this.importSnapshot(snapshot)));
  }
}
