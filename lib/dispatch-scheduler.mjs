import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const SCHEDULER_FILENAME = 'dispatch-scheduler.sqlite';
const APPLICATION_ID = 0x46534348;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CLOUD_ID = /^task_e_[a-f0-9]{32}$/;
const CONFIG_HASH = /^[a-f0-9]{64}$/;
const ACTIVE = new Set(['admitted', 'submitted', 'unknown']);
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const HOLD_REASONS = new Set(['TASK_BLOCKED', 'TASK_TERMINAL', 'TASK_REASSIGNED', 'CONFIG_CHANGED', 'WAKE_OUTCOME_UNKNOWN']);
const REASONS = new Set(['QUEUED', 'ADMITTED', 'SUBMITTED', 'SUBMISSION_UNKNOWN', 'IMPORTED_JOURNAL', 'TERMINAL_JOURNAL', 'OPERATOR_CANCELLED', 'OPERATOR_PAUSED', 'OPERATOR_RESUMED', 'USAGE_LIMIT', 'AUTH_REQUIRED', 'PROVIDER_COOLDOWN', 'CONTROL_RECONFIGURED', 'UNCLASSIFIED_ERROR', ...HOLD_REASONS]);
export const DEFAULT_SCHEDULER_LIMITS = Object.freeze({ maxGlobalActive: 2, maxRepositoryActive: 1, maxAttempts: 3, minDispatchIntervalMs: 1000 });
export class SchedulerError extends Error {
  constructor(code) { super('SCHEDULER_' + code); this.name = 'SchedulerError'; this.code = 'SCHEDULER_' + code; }
}
const fail = code => { throw new SchedulerError(code); };
function uuid(value) { if (typeof value !== 'string' || !UUID.test(value)) fail('INVALID_IDENTIFIER'); return value.toLowerCase(); }
function integer(value, min, max, code = 'INVALID_LIMITS') { if (!Number.isInteger(value) || value < min || value > max) fail(code); return value; }
function timestamp(value = Date.now()) {
  const at = typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) ? Date.parse(value) : value;
  if (!Number.isSafeInteger(at) || at < 0 || at > 8_640_000_000_000_000) fail('INVALID_TIMESTAMP');
  return at;
}
const iso = value => value === null || value === undefined ? null : new Date(value).toISOString();
const reason = value => REASONS.has(value) ? value : 'UNCLASSIFIED_ERROR';
function repository(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) || value.endsWith('.git') || value.split('/').some(part => ['.', '..'].includes(part))) fail('INVALID_REPOSITORY');
  return value.toLowerCase();
}
function cloudId(value) { if (typeof value !== 'string' || !CLOUD_ID.test(value)) fail('INVALID_CLOUD_ID'); return value; }
function configurationHash(value) { if (typeof value !== 'string' || !CONFIG_HASH.test(value)) fail('INVALID_CONFIGURATION_HASH'); return value; }
function limits(input = DEFAULT_SCHEDULER_LIMITS) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !Object.hasOwn(DEFAULT_SCHEDULER_LIMITS, key))) fail('INVALID_LIMITS');
  const result = { ...DEFAULT_SCHEDULER_LIMITS, ...input };
  integer(result.maxGlobalActive, 1, 100); integer(result.maxRepositoryActive, 1, result.maxGlobalActive);
  integer(result.maxAttempts, 1, 100); integer(result.minDispatchIntervalMs, 0, 3_600_000);
  return result;
}
function identity(value) {
  if (!value || typeof value !== 'object') fail('INVALID_IDENTITY');
  return {
    executionId: uuid(value.executionId), companyId: uuid(value.companyId), paperclipIssueId: uuid(value.paperclipIssueId),
    attempt: integer(value.attempt, 1, 100, 'INVALID_ATTEMPT'), repository: repository(value.repository),
  };
}
function sameBinding(record, expected) {
  if (['executionId', 'companyId', 'paperclipIssueId', 'attempt', 'repository'].some(key => record[key] !== expected[key])) fail('BINDING_CHANGED');
}
function plain(row) {
  return row ? {
    executionId: row.execution_id, companyId: row.company_id, paperclipIssueId: row.issue_id, attempt: row.attempt, repository: row.repository,
    state: row.state, revision: row.revision, sequence: row.sequence, ownerId: row.owner_id, token: row.token,
    cloudTaskId: row.cloud_task_id, createdAt: iso(row.created_at), admittedAt: iso(row.admitted_at), updatedAt: iso(row.updated_at), terminalAt: iso(row.terminal_at), reasonCode: row.reason_code,
  } : null;
}
function repositoryPlain(row, settings) {
  return row ? {
    repository: row.repository, revision: row.revision, maxActive: row.max_active, maxAttempts: row.max_attempts, paused: row.paused === 1,
    effectiveMaxActive: Math.min(row.max_active, settings.limits.maxGlobalActive, settings.limits.maxRepositoryActive),
    effectiveMaxAttempts: Math.min(row.max_attempts, settings.limits.maxAttempts), lastServed: row.last_served,
  } : null;
}
function syncDirectory(directory) { const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
function retryBusy(fn) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try { return fn(); }
    catch (error) {
      if (![5, 6].includes(Number(error.errcode) & 255) || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

/** Durable account-wide admission. No leases expire and no method submits work. */
export class DispatchScheduler {
  constructor({ directory, limits: requestedLimits } = {}) {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 24 || (major === 24 && minor < 15) || major === 25) fail('UNSUPPORTED_RUNTIME');
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || /[\0\r\n]/.test(directory)) fail('INVALID_DIRECTORY');
    const requested = requestedLimits === undefined ? undefined : limits(requestedLimits);
    this.directory = path.resolve(directory); this.filename = path.join(this.directory, SCHEDULER_FILENAME);
    try {
      const firstCreated = fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      if (!fs.lstatSync(this.directory).isDirectory() || fs.lstatSync(this.directory).isSymbolicLink()) fail('UNSAFE_STORAGE');
      fs.chmodSync(this.directory, 0o700);
      if (firstCreated) for (let cursor = this.directory;; cursor = path.dirname(cursor)) { syncDirectory(cursor); syncDirectory(path.dirname(cursor)); if (cursor === firstCreated) break; }
      let fd;
      try { fd = fs.openSync(this.filename, 'wx', 0o600); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; syncDirectory(this.directory); }
      catch (error) { if (fd !== undefined) fs.closeSync(fd); if (error.code !== 'EEXIST') throw error; }
      for (const filename of [this.filename, this.filename + '-wal', this.filename + '-shm']) {
        if (!fs.existsSync(filename)) { try { if (fs.lstatSync(filename).isSymbolicLink()) fail('UNSAFE_STORAGE'); } catch (error) { if (error.code !== 'ENOENT') throw error; } continue; }
        const stat = fs.lstatSync(filename); if (!stat.isFile() || stat.isSymbolicLink()) fail('UNSAFE_STORAGE');
      }
      fs.chmodSync(this.filename, 0o600);
      this.db = new DatabaseSync(this.filename, { timeout: 5000 });
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON;');
      this.transaction(() => {
        const version = this.db.prepare('PRAGMA user_version').get().user_version, app = this.db.prepare('PRAGMA application_id').get().application_id;
        if (version > 2 || (app !== 0 && app !== APPLICATION_ID) || (version > 0 && app !== APPLICATION_ID)) fail('MIGRATION_REQUIRED');
        if (version === 0 && this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length) fail('MIGRATION_REQUIRED');
        // Older development stores cannot retain holds. Version 2 also fences
        // configuration authority so pre-fence clients reject reopening it.
        if (version > 0 && !this.db.prepare("SELECT sql FROM sqlite_master WHERE name='scheduler_executions' AND type='table'").get()?.sql.includes("'held'")) fail('MIGRATION_REQUIRED');
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS scheduler_settings (
            id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, global_limit INTEGER NOT NULL,
            repository_limit INTEGER NOT NULL, attempt_limit INTEGER NOT NULL, min_interval_ms INTEGER NOT NULL,
            paused INTEGER NOT NULL, cooldown_until INTEGER NOT NULL, next_dispatch_at INTEGER NOT NULL, service_counter INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS scheduler_repositories (
            repository TEXT PRIMARY KEY, revision INTEGER NOT NULL, max_active INTEGER NOT NULL,
            max_attempts INTEGER NOT NULL, paused INTEGER NOT NULL, last_served INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS scheduler_executions (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT, execution_id TEXT NOT NULL UNIQUE,
            company_id TEXT NOT NULL, issue_id TEXT NOT NULL, attempt INTEGER NOT NULL,
            repository TEXT NOT NULL REFERENCES scheduler_repositories(repository),
            state TEXT NOT NULL CHECK(state IN ('queued','held','admitted','submitted','unknown','succeeded','failed','cancelled')),
            revision INTEGER NOT NULL, owner_id TEXT, token TEXT, cloud_task_id TEXT UNIQUE,
            created_at INTEGER NOT NULL, admitted_at INTEGER, updated_at INTEGER NOT NULL, terminal_at INTEGER, reason_code TEXT NOT NULL,
            UNIQUE(company_id,issue_id,attempt)
          );
          CREATE INDEX IF NOT EXISTS scheduler_queue ON scheduler_executions(state,repository,sequence);
          CREATE TABLE IF NOT EXISTS scheduler_events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT, execution_id TEXT, repository TEXT, kind TEXT NOT NULL, reason_code TEXT NOT NULL, at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS scheduler_configuration_fences (
            repository TEXT PRIMARY KEY REFERENCES scheduler_repositories(repository),
            update_id TEXT NOT NULL, previous_hash TEXT NOT NULL, next_hash TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('updating','ready'))
          );
          PRAGMA user_version=2;
          PRAGMA application_id=${APPLICATION_ID};
        `);
        const prior = this.settings();
        if (prior) { if (requested && JSON.stringify(prior.limits) !== JSON.stringify(requested)) fail('LIMITS_CHANGED'); }
        else { const selected = requested ?? limits(); this.db.prepare('INSERT INTO scheduler_settings VALUES(1,0,?,?,?,?,0,0,0,0)').run(selected.maxGlobalActive, selected.maxRepositoryActive, selected.maxAttempts, selected.minDispatchIntervalMs); }
      });
      retryBusy(() => { if (this.db.prepare('PRAGMA journal_mode=WAL').get().journal_mode !== 'wal') throw Object.assign(new Error(), { errcode: 5 }); });
      syncDirectory(this.directory);
    } catch (error) { try { this.db?.close(); } catch {} throw error instanceof SchedulerError ? error : new SchedulerError('OPEN_FAILED'); }
  }
  close() { this.db?.close(); }
  transaction(action) {
    try { retryBusy(() => this.db.exec('BEGIN IMMEDIATE')); } catch { fail('TRANSACTION_UNAVAILABLE'); }
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error instanceof SchedulerError ? error : new SchedulerError('WRITE_FAILED'); }
  }
  settings() {
    const row = this.db.prepare('SELECT * FROM scheduler_settings WHERE id=1').get();
    return row ? { revision: row.revision, limits: { maxGlobalActive: row.global_limit, maxRepositoryActive: row.repository_limit, maxAttempts: row.attempt_limit, minDispatchIntervalMs: row.min_interval_ms }, paused: row.paused === 1, cooldownUntil: iso(row.cooldown_until || null), nextDispatchAt: iso(row.next_dispatch_at || null), serviceCounter: row.service_counter } : null;
  }
  #event(kind, reasonCode, at, record) { this.db.prepare('INSERT INTO scheduler_events(execution_id,repository,kind,reason_code,at) VALUES(?,?,?,?,?)').run(record?.executionId ?? null, record?.repository ?? null, kind, reason(reasonCode), at); }
  configureLimits({ expectedRevision, limits: input, now } = {}) {
    if (input === undefined) fail('INVALID_LIMITS');
    const selected = limits(input), at = timestamp(now); integer(expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'INVALID_REVISION');
    return this.transaction(() => {
      const result = this.db.prepare('UPDATE scheduler_settings SET revision=revision+1,global_limit=?,repository_limit=?,attempt_limit=?,min_interval_ms=? WHERE id=1 AND revision=?').run(selected.maxGlobalActive, selected.maxRepositoryActive, selected.maxAttempts, selected.minDispatchIntervalMs, expectedRevision);
      if (result.changes !== 1) fail('CONTROL_CONFLICT');
      this.#event('limits_changed', 'CONTROL_RECONFIGURED', at); return this.settings();
    });
  }
  repositories() { const settings = this.settings(); return this.db.prepare('SELECT * FROM scheduler_repositories ORDER BY repository').all().map(row => repositoryPlain(row, settings)); }
  configurationFence(name) {
    const row = this.db.prepare('SELECT * FROM scheduler_configuration_fences WHERE repository=?').get(repository(name));
    return row ? { repository: row.repository, updateId: row.update_id, previousHash: row.previous_hash, nextHash: row.next_hash, state: row.state } : null;
  }
  beginConfigurationUpdate({ repository: name, updateId, previousHash, nextHash } = {}) {
    const key = repository(name), id = uuid(updateId), previous = configurationHash(previousHash), next = configurationHash(nextHash);
    return this.transaction(() => {
      if (!this.settings().paused) fail('CONFIGURATION_UPDATE_REQUIRES_PAUSE');
      if (!this.#repository(key)) fail('REPOSITORY_NOT_REGISTERED');
      if (this.db.prepare("SELECT 1 FROM scheduler_executions WHERE repository=? AND state NOT IN ('succeeded','failed','cancelled') LIMIT 1").get(key)) fail('CONFIGURATION_UPDATE_REQUIRES_IDLE');
      const prior = this.configurationFence(key);
      if (prior?.updateId === id) {
        if (prior.previousHash !== previous || prior.nextHash !== next) fail('CONFIGURATION_UPDATE_CONFLICT');
        return prior;
      }
      if (prior && (prior.state !== 'ready' || prior.nextHash !== previous)) fail('CONFIGURATION_UPDATE_CONFLICT');
      this.db.prepare(`INSERT INTO scheduler_configuration_fences VALUES(?,?,?,?,'updating')
        ON CONFLICT(repository) DO UPDATE SET update_id=excluded.update_id,previous_hash=excluded.previous_hash,next_hash=excluded.next_hash,state='updating'`).run(key, id, previous, next);
      return this.configurationFence(key);
    });
  }
  finishConfigurationUpdate({ repository: name, updateId, nextHash } = {}) {
    const key = repository(name), id = uuid(updateId), next = configurationHash(nextHash);
    return this.transaction(() => {
      if (!this.settings().paused) fail('CONFIGURATION_UPDATE_REQUIRES_PAUSE');
      const prior = this.configurationFence(key);
      if (!prior || prior.updateId !== id || prior.nextHash !== next) fail('CONFIGURATION_UPDATE_CONFLICT');
      if (prior.state === 'updating') this.db.prepare("UPDATE scheduler_configuration_fences SET state='ready' WHERE repository=?").run(key);
      return this.configurationFence(key);
    });
  }
  assertConfiguration(name, configHash) {
    const fence = this.configurationFence(name);
    // Legacy repositories have no pinned scheduler contract. Once fenced, even
    // callers using an older CLI must present the current complete hash.
    if (!fence) return;
    if (fence.state === 'updating') fail('CONFIGURATION_UPDATING');
    if (configHash === undefined || configHash === null) fail('CONFIGURATION_HASH_REQUIRED');
    if (configurationHash(configHash) !== fence.nextHash) fail('CONFIGURATION_CHANGED');
  }
  #repository(key) { return repositoryPlain(this.db.prepare('SELECT * FROM scheduler_repositories WHERE repository=?').get(key), this.settings()); }
  registerRepository(input) {
    const key = repository(input?.repository), maxActive = integer(input?.maxActive, 1, 100), maxAttempts = integer(input?.maxAttempts, 1, 100);
    return this.transaction(() => {
      const settings = this.settings();
      if (maxActive > settings.limits.maxRepositoryActive || maxActive > settings.limits.maxGlobalActive || maxAttempts > settings.limits.maxAttempts) fail('REPOSITORY_LIMIT_EXCEEDS_POLICY');
      const prior = this.#repository(key);
      if (prior) { if (prior.maxActive !== maxActive || prior.maxAttempts !== maxAttempts) fail('REPOSITORY_LIMITS_CHANGED'); return prior; }
      this.db.prepare('INSERT INTO scheduler_repositories VALUES(?,0,?,?,0,0)').run(key, maxActive, maxAttempts); return this.#repository(key);
    });
  }
  configureRepository({ repository: name, expectedRevision, maxActive, maxAttempts, now } = {}) {
    const key = repository(name), at = timestamp(now); integer(expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'INVALID_REVISION'); integer(maxActive, 1, 100); integer(maxAttempts, 1, 100);
    return this.transaction(() => {
      const settings = this.settings();
      if (maxActive > settings.limits.maxRepositoryActive || maxActive > settings.limits.maxGlobalActive || maxAttempts > settings.limits.maxAttempts) fail('REPOSITORY_LIMIT_EXCEEDS_POLICY');
      const result = this.db.prepare('UPDATE scheduler_repositories SET revision=revision+1,max_active=?,max_attempts=? WHERE repository=? AND revision=?').run(maxActive, maxAttempts, key, expectedRevision);
      if (result.changes !== 1) fail('CONTROL_CONFLICT');
      this.#event('repository_limits_changed', 'CONTROL_RECONFIGURED', at, { repository: key }); return this.#repository(key);
    });
  }
  get(executionId) { return plain(this.db.prepare('SELECT * FROM scheduler_executions WHERE execution_id=?').get(uuid(executionId))); }
  list() { return this.db.prepare('SELECT * FROM scheduler_executions ORDER BY sequence').all().map(plain); }
  #insert(data, state, at, { admittedAt = null, updatedAt = at, ownerId = null, token = null, cloudTaskId = null, reasonCode = 'QUEUED' } = {}) {
    if (this.db.prepare('SELECT execution_id FROM scheduler_executions WHERE company_id=? AND issue_id=? AND attempt=?').get(data.companyId, data.paperclipIssueId, data.attempt)) fail('IDENTITY_CONFLICT');
    if (cloudTaskId && this.db.prepare('SELECT execution_id FROM scheduler_executions WHERE cloud_task_id=?').get(cloudTaskId)) fail('CLOUD_ID_CONFLICT');
    this.db.prepare('INSERT INTO scheduler_executions(execution_id,company_id,issue_id,attempt,repository,state,revision,owner_id,token,cloud_task_id,created_at,admitted_at,updated_at,terminal_at,reason_code) VALUES(?,?,?,?,?,?,0,?,?,?,?,?,?,?,?)').run(data.executionId, data.companyId, data.paperclipIssueId, data.attempt, data.repository, state, ownerId, token, cloudTaskId, at, admittedAt, updatedAt, TERMINAL.has(state) ? updatedAt : null, reason(reasonCode));
    const result = this.get(data.executionId); this.#event(state === 'queued' ? 'queued' : 'journal_adopted', reasonCode, updatedAt, result); return result;
  }
  enqueue(input, { now, configHash } = {}) {
    const data = identity(input), at = timestamp(input.createdAt ?? now);
    return this.transaction(() => {
      this.assertConfiguration(data.repository, configHash);
      const existing = this.get(data.executionId);
      if (existing) { sameBinding(existing, data); return existing; }
      const repo = this.#repository(data.repository); if (!repo) fail('REPOSITORY_NOT_REGISTERED');
      if (data.attempt > repo.effectiveMaxAttempts) fail('ATTEMPT_LIMIT');
      if (this.db.prepare('SELECT execution_id FROM scheduler_executions WHERE company_id=? AND issue_id=? AND attempt=?').get(data.companyId, data.paperclipIssueId, data.attempt)) fail('IDENTITY_CONFLICT');
      const previous = this.db.prepare('SELECT attempt,state FROM scheduler_executions WHERE company_id=? AND issue_id=? ORDER BY attempt').all(data.companyId, data.paperclipIssueId);
      if (previous.some(row => !TERMINAL.has(row.state)) || data.attempt !== (previous.at(-1)?.attempt ?? 0) + 1) fail('ATTEMPT_REQUIRES_TERMINAL');
      return this.#insert(data, 'queued', at);
    });
  }
  #globalGate(at, settings) {
    if (settings.paused) return { reason: 'ACCOUNT_PAUSED' };
    if (settings.cooldownUntil && Date.parse(settings.cooldownUntil) > at) return { reason: 'PROVIDER_COOLDOWN', retryAt: settings.cooldownUntil };
    if (settings.nextDispatchAt && Date.parse(settings.nextDispatchAt) > at) return { reason: 'PROVIDER_RATE_LIMIT', retryAt: settings.nextDispatchAt };
    const active = this.db.prepare("SELECT COUNT(*) AS count FROM scheduler_executions WHERE state IN ('admitted','submitted','unknown')").get().count;
    return active >= settings.limits.maxGlobalActive ? { reason: 'GLOBAL_CAPACITY' } : null;
  }
  #next(at) {
    const settings = this.settings(), gate = this.#globalGate(at, settings);
    if (gate) return { ...gate, record: null };
    const row = this.db.prepare(`
      SELECT e.* FROM scheduler_repositories r JOIN scheduler_executions e ON e.repository=r.repository
      WHERE r.paused=0 AND e.state='queued'
        AND e.attempt<=MIN(r.max_attempts,?)
        AND e.sequence=(SELECT MIN(q.sequence) FROM scheduler_executions q WHERE q.repository=r.repository AND q.state='queued' AND q.attempt<=MIN(r.max_attempts,?))
        AND (SELECT COUNT(*) FROM scheduler_executions a WHERE a.repository=r.repository AND a.state IN ('admitted','submitted','unknown'))<MIN(r.max_active,?,?)
      ORDER BY r.last_served,e.sequence,r.repository LIMIT 1
    `).get(settings.limits.maxAttempts, settings.limits.maxAttempts, settings.limits.maxRepositoryActive, settings.limits.maxGlobalActive);
    return { record: plain(row), reason: row ? null : 'NO_ELIGIBLE_WORK' };
  }
  peekNext({ now } = {}) { return this.#next(timestamp(now)); }
  claim(executionId, { ownerId, now, configHash } = {}) {
    uuid(executionId); const owner = uuid(ownerId), at = timestamp(now);
    return this.transaction(() => {
      const current = this.get(executionId); if (!current) fail('EXECUTION_NOT_FOUND');
      this.assertConfiguration(current.repository, configHash);
      if (current.state !== 'queued') return { claimed: false, record: current, reason: current.state === 'held' ? 'EXECUTION_HELD' : ACTIVE.has(current.state) ? 'ALREADY_ADMITTED' : 'ALREADY_TERMINAL' };
      const next = this.#next(at);
      if (!next.record) return { claimed: false, record: current, reason: next.reason, ...(next.retryAt ? { retryAt: next.retryAt } : {}) };
      if (next.record.executionId !== current.executionId) return { claimed: false, record: current, reason: 'FAIR_QUEUE_WAIT', nextExecutionId: next.record.executionId };
      const settings = this.settings(), token = randomUUID();
      this.db.prepare('UPDATE scheduler_executions SET state=\'admitted\',revision=revision+1,owner_id=?,token=?,admitted_at=?,updated_at=?,reason_code=\'ADMITTED\' WHERE execution_id=? AND revision=? AND state=\'queued\'').run(owner, token, at, at, current.executionId, current.revision);
      this.db.prepare('UPDATE scheduler_repositories SET last_served=? WHERE repository=?').run(settings.serviceCounter + 1, current.repository);
      this.db.prepare('UPDATE scheduler_settings SET service_counter=service_counter+1,next_dispatch_at=MAX(next_dispatch_at,?) WHERE id=1').run(at + settings.limits.minDispatchIntervalMs);
      const record = this.get(executionId); this.#event('admitted', 'ADMITTED', at, record); return { claimed: true, record };
    });
  }
  #owned(executionId, token, expectedRevision) {
    const record = this.get(executionId); if (!record) fail('EXECUTION_NOT_FOUND');
    integer(expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'INVALID_REVISION'); uuid(token);
    if (record.revision !== expectedRevision || record.token !== token || !ACTIVE.has(record.state)) fail('STALE_OWNER');
    return record;
  }
  #update(record, state, at, { cloudTaskId = record.cloudTaskId, reasonCode, admittedAt = record.admittedAt && Date.parse(record.admittedAt), ownerId = record.ownerId, token = record.token } = {}) {
    if (record.cloudTaskId && cloudTaskId !== record.cloudTaskId) fail('CLOUD_ID_CHANGED');
    if (cloudTaskId && this.db.prepare('SELECT execution_id FROM scheduler_executions WHERE cloud_task_id=? AND execution_id<>?').get(cloudTaskId, record.executionId)) fail('CLOUD_ID_CONFLICT');
    const result = this.db.prepare('UPDATE scheduler_executions SET state=?,revision=revision+1,cloud_task_id=?,admitted_at=?,owner_id=?,token=?,updated_at=?,terminal_at=?,reason_code=? WHERE execution_id=? AND revision=?').run(state, cloudTaskId, admittedAt ?? null, ownerId, token, at, TERMINAL.has(state) ? at : null, reason(reasonCode), record.executionId, record.revision);
    if (result.changes !== 1) fail('STALE_OWNER');
    const updated = this.get(record.executionId); this.#event(state, reasonCode, at, updated); return updated;
  }
  markSubmitted(executionId, { token, expectedRevision, cloudTaskId, now } = {}) {
    cloudId(cloudTaskId); const at = timestamp(now);
    return this.transaction(() => this.#update(this.#owned(executionId, token, expectedRevision), 'submitted', at, { cloudTaskId, reasonCode: 'SUBMITTED' }));
  }
  markUnknown(executionId, { token, expectedRevision, cloudTaskId, reasonCode = 'SUBMISSION_UNKNOWN', now } = {}) {
    if (cloudTaskId !== undefined) cloudId(cloudTaskId); const at = timestamp(now);
    return this.transaction(() => {
      const record = this.#owned(executionId, token, expectedRevision);
      return this.#update(record, 'unknown', at, { cloudTaskId: cloudTaskId ?? record.cloudTaskId, reasonCode });
    });
  }
  #terminal(record, evidence, at) {
    const data = identity(evidence); sameBinding(record, data);
    if (!TERMINAL.has(evidence.state) || (evidence.state === 'succeeded' && !evidence.cloudTaskId)) fail('TERMINAL_PROOF_REQUIRED');
    if (evidence.cloudTaskId) cloudId(evidence.cloudTaskId);
    if (record.cloudTaskId && record.cloudTaskId !== evidence.cloudTaskId) fail('CLOUD_ID_CHANGED');
    if (TERMINAL.has(record.state)) {
      if (record.state !== evidence.state || record.cloudTaskId !== (evidence.cloudTaskId ?? null)) fail('TERMINAL_STATE_CHANGED');
      return record;
    }
    return this.#update(record, evidence.state, at, { cloudTaskId: evidence.cloudTaskId ?? null, reasonCode: 'TERMINAL_JOURNAL' });
  }
  confirmTerminal(executionId, { expectedRevision, evidence, now } = {}) {
    const at = timestamp(now); integer(expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'INVALID_REVISION');
    return this.transaction(() => { const record = this.get(executionId); if (!record) fail('EXECUTION_NOT_FOUND'); if (record.revision !== expectedRevision) fail('STALE_OWNER'); return this.#terminal(record, evidence, at); });
  }
  cancelQueued(executionId, { expectedRevision, now } = {}) {
    const at = timestamp(now); integer(expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'INVALID_REVISION');
    return this.transaction(() => {
      const record = this.get(executionId); if (!record) fail('EXECUTION_NOT_FOUND');
      if (record.revision !== expectedRevision || !['queued', 'held'].includes(record.state)) fail('QUEUED_CANCEL_CONFLICT');
      return this.#update(record, 'cancelled', at, { reasonCode: 'OPERATOR_CANCELLED' });
    });
  }
  holdQueued(executionId, { expectedRevision, reasonCode, now } = {}) {
    const at = timestamp(now); integer(expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'INVALID_REVISION');
    if (!HOLD_REASONS.has(reasonCode)) fail('INVALID_HOLD_REASON');
    return this.transaction(() => {
      const record = this.get(executionId); if (!record) fail('EXECUTION_NOT_FOUND');
      if (record.revision !== expectedRevision || record.state !== 'queued') fail('HOLD_CONFLICT');
      return this.#update(record, 'held', at, { reasonCode });
    });
  }
  resumeHeld(executionId, { expectedRevision, now } = {}) {
    const at = timestamp(now); integer(expectedRevision, 0, Number.MAX_SAFE_INTEGER, 'INVALID_REVISION');
    return this.transaction(() => {
      const record = this.get(executionId); if (!record) fail('EXECUTION_NOT_FOUND');
      if (record.revision !== expectedRevision || record.state !== 'held') fail('HOLD_CONFLICT');
      return this.#update(record, 'queued', at, { reasonCode: 'OPERATOR_RESUMED' });
    });
  }
  adoptJournalExecution(input, { now } = {}) {
    const data = identity(input), at = timestamp(now ?? input.updatedAt), sourceStates = { queued: 'queued', dispatching: 'admitted', running: 'submitted', unknown: 'unknown', succeeded: 'succeeded', failed: 'failed', cancelled: 'cancelled' };
    const state = sourceStates[input.state]; if (!state || (input.state === 'running' || input.state === 'succeeded') && !input.cloudTaskId) fail('INVALID_JOURNAL_EVIDENCE');
    if (input.cloudTaskId) cloudId(input.cloudTaskId);
    return this.transaction(() => {
      if (!this.#repository(data.repository)) fail('REPOSITORY_NOT_REGISTERED');
      const prior = this.get(data.executionId);
      if (!prior) return this.#insert(data, state, timestamp(input.createdAt ?? at), {
        updatedAt: timestamp(input.updatedAt ?? at),
        admittedAt: ACTIVE.has(state) || TERMINAL.has(state) && input.cloudTaskId ? timestamp(input.dispatchedAt ?? input.updatedAt ?? at) : null,
        ownerId: input.paperclipRunId ? uuid(input.paperclipRunId) : null, token: ACTIVE.has(state) ? randomUUID() : null,
        cloudTaskId: input.cloudTaskId ?? null, reasonCode: 'IMPORTED_JOURNAL',
      });
      sameBinding(prior, data);
      if (prior.cloudTaskId && input.cloudTaskId && prior.cloudTaskId !== input.cloudTaskId) fail('CLOUD_ID_CHANGED');
      if (TERMINAL.has(input.state)) return this.#terminal(prior, input, at);
      if (TERMINAL.has(prior.state) || state === 'queued') return prior;
      const selectedState = state === 'admitted' && ACTIVE.has(prior.state) ? prior.state : state;
      if (prior.state === selectedState && (!input.cloudTaskId || input.cloudTaskId === prior.cloudTaskId)) return prior;
      return this.#update(prior, selectedState, at, {
        cloudTaskId: input.cloudTaskId ?? prior.cloudTaskId, admittedAt: prior.admittedAt ? Date.parse(prior.admittedAt) : timestamp(input.dispatchedAt ?? input.updatedAt ?? at),
        ownerId: prior.ownerId ?? (input.paperclipRunId ? uuid(input.paperclipRunId) : null), token: prior.token ?? randomUUID(), reasonCode: 'IMPORTED_JOURNAL',
      });
    });
  }
  setPaused(paused, { repository: name, now, reasonCode } = {}) {
    if (typeof paused !== 'boolean') fail('INVALID_PAUSE'); const at = timestamp(now), code = reasonCode ?? (paused ? 'OPERATOR_PAUSED' : 'OPERATOR_RESUMED');
    return this.transaction(() => {
      if (name !== undefined) {
        const key = repository(name); if (!this.#repository(key)) fail('REPOSITORY_NOT_REGISTERED');
        this.db.prepare('UPDATE scheduler_repositories SET paused=?,revision=revision+1 WHERE repository=?').run(paused ? 1 : 0, key);
        this.#event(paused ? 'repository_paused' : 'repository_resumed', code, at, { repository: key }); return this.#repository(key);
      }
      this.db.prepare('UPDATE scheduler_settings SET paused=?,revision=revision+1 WHERE id=1').run(paused ? 1 : 0);
      this.#event(paused ? 'account_paused' : 'account_resumed', code, at); return this.settings();
    });
  }
  deferProviderRequests({ now, delayMs } = {}) {
    const at = timestamp(now); integer(delayMs, 1000, 86_400_000, 'INVALID_COOLDOWN');
    return this.transaction(() => {
      this.db.prepare('UPDATE scheduler_settings SET cooldown_until=MAX(cooldown_until,?),revision=revision+1 WHERE id=1').run(at + delayMs);
      this.#event('provider_cooldown', 'PROVIDER_COOLDOWN', at); return { retryAt: this.settings().cooldownUntil };
    });
  }
  events({ limit = 100 } = {}) {
    integer(limit, 1, 1000, 'INVALID_LIMIT');
    return this.db.prepare('SELECT * FROM scheduler_events ORDER BY sequence DESC LIMIT ?').all(limit).map(row => ({ sequence: row.sequence, executionId: row.execution_id, repository: row.repository, kind: row.kind, reasonCode: row.reason_code, at: iso(row.at) }));
  }
  snapshot({ now, limit = 100 } = {}) {
    const at = timestamp(now); integer(limit, 1, 1000, 'INVALID_LIMIT');
    return this.transaction(() => {
      const counts = { queued: 0, held: 0, admitted: 0, submitted: 0, unknown: 0, succeeded: 0, failed: 0, cancelled: 0 };
      for (const row of this.db.prepare('SELECT state,COUNT(*) AS count FROM scheduler_executions GROUP BY state').all()) counts[row.state] = row.count;
      const executions = this.db.prepare("SELECT * FROM scheduler_executions WHERE state IN ('queued','held','admitted','submitted','unknown') ORDER BY CASE WHEN state IN ('queued','held') THEN 1 ELSE 0 END,sequence LIMIT ?").all(limit).map(row => {
        const record = plain(row); delete record.token; delete record.ownerId;
        return { ...record, ageMs: Math.max(0, at - row.created_at), durationMs: row.admitted_at === null ? null : Math.max(0, at - row.admitted_at) };
      });
      const active = counts.admitted + counts.submitted + counts.unknown, nonterminal = active + counts.queued + counts.held;
      const terminal = counts.succeeded + counts.failed + counts.cancelled;
      const next = this.#next(at);
      if (next.record) { delete next.record.token; delete next.record.ownerId; }
      return { settings: this.settings(), repositories: this.repositories(), counts, queueDepth: counts.queued, attentionDepth: counts.held, activeCount: active,
        knownCloudTaskIds: executions.filter(record => ACTIVE.has(record.state) && record.cloudTaskId).map(record => record.cloudTaskId),
        executions, truncated: nonterminal > executions.length, terminalCount: terminal, successRate: terminal ? counts.succeeded / terminal : null, next };
    });
  }
}
