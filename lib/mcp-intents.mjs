import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const APPLICATION_ID = 0x464d4350;
export class McpIntentError extends Error {
  constructor(code) { super(code); this.name = 'McpIntentError'; this.code = code; }
}
const fail = code => { throw new McpIntentError(code); };
function syncDirectory(directory) { const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
const value = row => row ? { companyId: row.company_id, idempotencyKey: row.request_key, kind: row.kind, payloadHash: row.payload_hash, state: row.state, revision: row.revision, issueId: row.issue_id, actorUserId: row.actor_user_id } : null;

/** Durable creation intent. A committed pending request is never sent again. */
export class McpIntentStore {
  constructor({ directory }) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || /[\u0000-\u001f\u007f]/.test(directory)) fail('INVALID_MCP_INTENT_DIRECTORY');
    const firstCreated = fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) fail('MCP_INTENT_STORAGE_UNSAFE');
    fs.chmodSync(directory, 0o700);
    if (firstCreated) for (let current = directory;; current = path.dirname(current)) { syncDirectory(current); syncDirectory(path.dirname(current)); if (current === firstCreated) break; }
    const filename = path.join(directory, 'mcp-intents.sqlite');
    let fd;
    try { fd = fs.openSync(filename, 'wx', 0o600); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; syncDirectory(directory); }
    catch (error) { if (fd !== undefined) fs.closeSync(fd); if (error.code !== 'EEXIST') throw error; }
    for (const candidate of [filename, filename + '-wal', filename + '-shm']) {
      let stat; try { stat = fs.lstatSync(candidate); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!stat.isFile() || stat.isSymbolicLink()) fail('MCP_INTENT_STORAGE_UNSAFE');
    }
    fs.chmodSync(filename, 0o600);
    this.db = new DatabaseSync(filename);
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; BEGIN IMMEDIATE;');
      const version = this.db.prepare('PRAGMA user_version').get().user_version, app = this.db.prepare('PRAGMA application_id').get().application_id;
      if (version > 1 || (app && app !== APPLICATION_ID) || (version && app !== APPLICATION_ID) || (!version && this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().length)) fail('MCP_INTENT_MIGRATION_REQUIRED');
      this.db.exec(`CREATE TABLE IF NOT EXISTS create_intents (
        company_id TEXT NOT NULL, request_key TEXT NOT NULL, kind TEXT NOT NULL, payload_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('sending','unknown','confirmed')), revision INTEGER NOT NULL,
        issue_id TEXT, actor_user_id TEXT NOT NULL, PRIMARY KEY(company_id,request_key)
      ); PRAGMA user_version=1; PRAGMA application_id=${APPLICATION_ID}; COMMIT;`);
      this.db.exec('PRAGMA journal_mode=WAL;');
      syncDirectory(directory);
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch {} this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  get(companyId, key) {
    if (!UUID.test(companyId ?? '') || !UUID.test(key ?? '')) fail('INVALID_MCP_IDEMPOTENCY_KEY');
    return value(this.db.prepare('SELECT * FROM create_intents WHERE company_id=? AND request_key=?').get(companyId, key));
  }
  begin({ companyId, idempotencyKey, kind, payloadHash, actorUserId }) {
    if (!['draft', 'assignment'].includes(kind) || !/^[a-f0-9]{64}$/.test(payloadHash ?? '') || typeof actorUserId !== 'string' || !actorUserId || actorUserId.length > 200 || /[\u0000-\u001f\u007f]/.test(actorUserId)) fail('INVALID_MCP_CREATE_INTENT');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.get(companyId, idempotencyKey);
      if (prior) {
        if (prior.kind !== kind || prior.payloadHash !== payloadHash || prior.actorUserId !== actorUserId) fail('MCP_IDEMPOTENCY_CONFLICT');
        this.db.exec('COMMIT'); return { created: false, record: prior };
      }
      this.db.prepare("INSERT INTO create_intents VALUES(?,?,?,?,'sending',0,NULL,?)").run(companyId, idempotencyKey, kind, payloadHash, actorUserId);
      const record = this.get(companyId, idempotencyKey);
      this.db.exec('COMMIT'); return { created: true, record };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  finish(record, issueId) {
    if (issueId !== undefined && !UUID.test(issueId)) fail('INVALID_MCP_CREATED_ISSUE');
    const result = this.db.prepare('UPDATE create_intents SET state=?,issue_id=?,revision=revision+1 WHERE company_id=? AND request_key=? AND revision=? AND state IN (\'sending\',\'unknown\')').run(issueId ? 'confirmed' : 'unknown', issueId ?? null, record.companyId, record.idempotencyKey, record.revision);
    if (result.changes !== 1) fail('MCP_CREATE_INTENT_CONFLICT');
    return this.get(record.companyId, record.idempotencyKey);
  }
}
