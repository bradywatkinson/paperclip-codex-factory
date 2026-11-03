import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { JOURNAL_APPLICATION_ID, JOURNAL_FILENAME, JOURNAL_SCHEMA_VERSION } from './execution-journal.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const STATES = new Set(['queued', 'dispatching', 'running', 'unknown', 'succeeded', 'failed', 'cancelled']);
const ACTIVE = new Set(['dispatching', 'running', 'unknown']);
const TABLES = new Set(['executions', 'execution_events', 'execution_runs', 'legacy_imports', 'execution_polling', 'cloud_observations', 'reconciliation_outbox', 'provider_request_limits']);
const SQL_FILES = new Set([JOURNAL_FILENAME, JOURNAL_FILENAME + '-wal', JOURNAL_FILENAME + '-shm']);
export class SchedulerInventoryError extends Error {
  constructor(code) { super('SCHEDULER_INVENTORY_' + code); this.name = 'SchedulerInventoryError'; this.code = 'SCHEDULER_INVENTORY_' + code; }
}
const fail = code => { throw new SchedulerInventoryError(code); };
function uuid(value) { if (typeof value !== 'string' || !UUID.test(value)) fail('INVALID_IDENTITY'); return value.toLowerCase(); }
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT[0-9:.]+(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) fail('INVALID_IDENTITY');
  return new Date(value).toISOString();
}
function regular(filename, directory = false) {
  let stat; try { stat = fs.lstatSync(filename); } catch { fail('UNREADABLE_STATE'); }
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) fail('UNSAFE_STORAGE');
  return stat;
}
function receipt(value) {
  if (!/^task_e_[a-f0-9]{32}$/.test(value.cloudTaskId ?? '') || !['https://chatgpt.com/codex/tasks/' + value.cloudTaskId, 'https://chatgpt.com/remote/' + value.cloudTaskId].includes(value.emittedUrl) || value.taskUrl !== 'https://chatgpt.com/remote/' + value.cloudTaskId) fail('INVALID_RECEIPT');
}
function validated(row, companyId) {
  const result = {
    executionId: uuid(row.id), companyId: uuid(row.company_id), paperclipIssueId: uuid(row.issue_id), paperclipRunId: uuid(row.paperclip_run_id), projectId: uuid(row.project_id),
    ...(row.workspace_id !== null && row.workspace_id !== undefined ? { workspaceId: uuid(row.workspace_id) } : {}), repository: row.repository, environmentId: row.environment_id, branch: row.branch, mode: row.mode,
    attempt: row.attempt, state: row.state, revision: row.revision, createdAt: date(row.created_at), updatedAt: date(row.updated_at),
    ...(row.dispatched_at !== null && row.dispatched_at !== undefined ? { dispatchedAt: date(row.dispatched_at) } : {}),
    ...(row.cloud_task_id !== null && row.cloud_task_id !== undefined ? { cloudTaskId: row.cloud_task_id, emittedUrl: row.emitted_url, taskUrl: row.task_url } : {}),
  };
  if (result.companyId !== companyId || !Number.isInteger(result.attempt) || result.attempt < 1 || result.attempt > 100 || !Number.isInteger(result.revision) || result.revision < 0 || !STATES.has(result.state)) fail('INVALID_IDENTITY');
  if (typeof result.repository !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(result.repository) || result.repository.endsWith('.git') || result.repository.split('/').some(part => ['.', '..'].includes(part))) fail('INVALID_IDENTITY');
  if (typeof result.environmentId !== 'string' || !/^[a-f0-9]{32}$/.test(result.environmentId) || typeof result.branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(result.branch) || /\.\.|\/\/|\/$|\.$|\.lock(?:\/|$)|\/\./.test(result.branch) || !['read_only', 'code_change'].includes(result.mode)) fail('INVALID_IDENTITY');
  if (result.cloudTaskId) receipt(result);
  else if (['running', 'succeeded'].includes(result.state) || row.emitted_url || row.task_url) fail('INVALID_RECEIPT');
  if (result.state === 'queued' && result.cloudTaskId) fail('INVALID_RECEIPT');
  return result;
}
function verifyGuard(filename, issueId, records, db) {
  const stat = regular(filename); if (stat.size > 65_536) fail('INVALID_GUARD');
  let bytes, raw;
  try { bytes = fs.readFileSync(filename); if (bytes.length > 65_536) fail('INVALID_GUARD'); raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('INVALID_GUARD'); }
  if (!raw || raw.schemaVersion !== 1 || uuid(raw.paperclipIssueId) !== issueId || !['dispatching', 'dispatched', 'unknown'].includes(raw.status)) fail('INVALID_GUARD');
  let record;
  if (raw.journalExecutionId !== undefined) record = records.find(item => item.executionId === uuid(raw.journalExecutionId));
  else {
    const imported = db.prepare('SELECT execution_id,source_sha256 FROM legacy_imports WHERE source_path=?').get(filename);
    if (!imported || imported.source_sha256 !== createHash('sha256').update(bytes).digest('hex')) fail('UNREPRESENTED_GUARD');
    record = records.find(item => item.executionId === uuid(imported.execution_id));
  }
  if (!record || record.paperclipIssueId !== issueId || (raw.journalExecutionId === undefined && record.attempt !== 1) || uuid(raw.companyId) !== record.companyId || uuid(raw.projectId) !== record.projectId || (raw.workspaceId ? uuid(raw.workspaceId) : undefined) !== record.workspaceId || raw.repository !== record.repository || raw.environmentId !== record.environmentId || raw.branch !== record.branch || raw.mode !== record.mode || date(raw.createdAt) !== record.createdAt) fail('UNREPRESENTED_GUARD');
  const owner = uuid(raw.paperclipRunId);
  if (!db.prepare('SELECT run_id FROM execution_runs WHERE lower(execution_id)=? AND lower(run_id)=?').get(record.executionId, owner)) fail('UNREPRESENTED_GUARD');
  if (raw.cloudTaskId) { receipt(raw); if (raw.cloudTaskId !== record.cloudTaskId) fail('UNREPRESENTED_GUARD'); }
  else if (raw.status === 'dispatched') fail('INVALID_GUARD');
  if (raw.dispatchedAt && date(raw.dispatchedAt) !== record.dispatchedAt) fail('UNREPRESENTED_GUARD');
}
function readCompany(directory, companyId) {
  regular(directory, true);
  let names; try { names = fs.readdirSync(directory).sort(); } catch { fail('UNREADABLE_STATE'); }
  const guards = [];
  for (const name of names) {
    regular(path.join(directory, name));
    if (SQL_FILES.has(name)) continue;
    if (name.endsWith('.json') && UUID.test(name.slice(0, -5))) guards.push(name);
    else fail('UNKNOWN_STORAGE_SHAPE');
  }
  if (!names.includes(JOURNAL_FILENAME)) fail(guards.length ? 'UNREPRESENTED_GUARD' : 'JOURNAL_REQUIRED');
  let db;
  try {
    db = new DatabaseSync(path.join(directory, JOURNAL_FILENAME), { readOnly: true, timeout: 5000 });
    db.exec('PRAGMA query_only=ON; BEGIN;');
    if (db.prepare('PRAGMA user_version').get().user_version !== JOURNAL_SCHEMA_VERSION || db.prepare('PRAGMA application_id').get().application_id !== JOURNAL_APPLICATION_ID) fail('MIGRATION_REQUIRED');
    const tables = db.prepare("SELECT name,type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
    const actualTables = tables.filter(row => row.type === 'table');
    if (actualTables.length !== TABLES.size || actualTables.some(row => !TABLES.has(row.name))) fail('UNSUPPORTED_SCHEMA');
    const integrity = db.prepare('PRAGMA quick_check').all();
    if (integrity.length !== 1 || integrity[0].quick_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) fail('INCONSISTENT_JOURNAL');
    const rows = db.prepare('SELECT * FROM executions ORDER BY created_at,attempt,id LIMIT 100001').all();
    if (rows.length > 100_000) fail('TOO_LARGE');
    const records = rows.map(row => validated(row, companyId));
    for (const record of records) {
      const event = db.prepare('SELECT to_state,revision,run_id FROM execution_events WHERE lower(execution_id)=? ORDER BY id DESC LIMIT 1').get(record.executionId);
      if (!event || event.to_state !== record.state || event.revision !== record.revision || uuid(event.run_id) !== record.paperclipRunId) fail('INCONSISTENT_JOURNAL');
    }
    for (const name of guards) verifyGuard(path.join(directory, name), uuid(name.slice(0, -5)), records, db);
    db.exec('COMMIT'); return records;
  } catch (error) { throw error instanceof SchedulerInventoryError ? error : new SchedulerInventoryError('UNREADABLE_JOURNAL'); }
  finally { try { db?.close(); } catch {} }
}

/** Read current journals without migrating them; adopt only after the full root validates.
 * SQLite readOnly connections may create WAL/shared-memory coordination sidecars.
 */
export function inventoryJournalRoot({ directory, scheduler } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || /[\0\r\n]/.test(directory)) fail('INVALID_ROOT');
  directory = path.resolve(directory);
  let root;
  try { root = fs.lstatSync(directory); }
  catch (error) {
    if (error.code === 'ENOENT') return { companyIds: [], companies: 0, executions: 0, active: 0, queued: 0, terminal: 0 };
    fail('UNREADABLE_ROOT');
  }
  if (!root.isDirectory() || root.isSymbolicLink()) fail('UNSAFE_STORAGE');
  if (!scheduler || typeof scheduler.adoptJournalExecution !== 'function' || typeof scheduler.registerRepository !== 'function') fail('INVALID_SCHEDULER');
  let names; try { names = fs.readdirSync(directory).sort(); } catch { fail('UNREADABLE_ROOT'); }
  if (names.length > 1000) fail('TOO_LARGE');
  const companyIds = [], allRecords = [];
  // No scheduler writes occur until every file, guard, and sibling journal has passed.
  for (const name of names) {
    if (!UUID.test(name)) fail('UNKNOWN_STORAGE_SHAPE');
    const companyId = uuid(name); if (companyIds.includes(companyId)) fail('DUPLICATE_COMPANY');
    companyIds.push(companyId); allRecords.push(...readCompany(path.join(directory, name), companyId));
  }
  if (JSON.stringify(fs.readdirSync(directory).sort()) !== JSON.stringify(names)) fail('ROOT_CHANGED');
  const known = new Set(scheduler.repositories().map(item => item.repository));
  const settings = scheduler.settings();
  for (const record of allRecords) {
    const key = record.repository.toLowerCase();
    if (!known.has(key)) {
      scheduler.registerRepository({ repository: key, maxActive: 1, maxAttempts: Math.min(3, settings.limits.maxAttempts) });
      known.add(key);
    }
    scheduler.adoptJournalExecution(record);
  }
  const active = allRecords.filter(record => ACTIVE.has(record.state)).length, queued = allRecords.filter(record => record.state === 'queued').length;
  return { companyIds, companies: companyIds.length, executions: allRecords.length, active, queued, terminal: allRecords.length - active - queued };
}
