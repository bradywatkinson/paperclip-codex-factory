import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const JOURNAL_FILENAME = 'executions.sqlite';
export const JOURNAL_APPLICATION_ID = 0x46434a31;
export const JOURNAL_SCHEMA_VERSION = 3;
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
