import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { validateRepositoryConfig, validateFactoryPolicy } from './repository-config.mjs';

export class RegistryError extends Error {
  constructor(code) { super(code); this.name = 'RegistryError'; this.code = code; }
}
const fail = code => { throw new RegistryError(code); };
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export const configurationHash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function repositoryKey(repository) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository)) fail('INVALID_REPOSITORY');
  return repository.toLowerCase();
}
function rowValue(row) {
  if (!row) return null;
  const policy = JSON.parse(row.policy_json);
  return { repository: row.repository, configHash: row.config_hash, config: JSON.parse(row.config_json), policy, policyHash: configurationHash(policy), sourcePath: row.source_path, createdAt: row.created_at };
}
function operationValue(row) {
  if (!row) return null;
  return { repository: row.repository, revision: row.revision, state: row.state, data: JSON.parse(row.data_json), updatedAt: row.updated_at };
}
function updateValue(row) {
  if (row && (!['prepared', 'completed'].includes(row.state) || !/^[a-f0-9]{64}$/.test(row.previous_hash) || !/^[a-f0-9]{64}$/.test(row.next_hash))) fail('INVALID_CONFIGURATION_UPDATE');
  return row ? { updateId: row.update_id, repository: row.repository, previousHash: row.previous_hash, nextHash: row.next_hash,
    state: row.state, payload: JSON.parse(row.payload_json), createdAt: row.created_at, completedAt: row.completed_at } : null;
}
export function validateConfigurationUpdate(registration, input) {
  if (!registration) fail('REPOSITORY_NOT_REGISTERED');
  const config = validateRepositoryConfig(input, { policy: registration.policy });
  const restored = { ...config, delivery: { ...config.delivery, requiredChecks: registration.config.delivery.requiredChecks } };
  if (!isDeepStrictEqual(restored, registration.config) || registration.config.delivery.requiredChecks.some(name => !config.delivery.requiredChecks.includes(name))) fail('CONFIGURATION_UPDATE_SCOPE_UNSUPPORTED');
  return config;
}

// Registry writes never execute configured commands or contact external services.
// Bootstrap intent is committed before an external write; CAS updates fence owners.
export class RepositoryRegistry {
  constructor({ directory }) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || /[\0\r\n]/.test(directory)) fail('INVALID_REGISTRY_DIRECTORY');
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) fail('INVALID_REGISTRY_DIRECTORY');
    const filename = path.join(directory, 'registry.sqlite');
    try {
      const descriptor = fs.openSync(filename, 'wx', 0o600);
      fs.closeSync(descriptor);
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('INVALID_REGISTRY_FILE');
    fs.chmodSync(filename, 0o600);
    this.database = new DatabaseSync(filename);
    try {
      this.database.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA foreign_keys=ON;');
      const version = this.database.prepare('PRAGMA user_version').get().user_version;
      if (![0, 1, 2].includes(version)) fail('REGISTRY_MIGRATION_REQUIRED');
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS repositories (
          repository TEXT PRIMARY KEY, config_hash TEXT NOT NULL, config_json TEXT NOT NULL,
          policy_json TEXT NOT NULL, source_path TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS bootstrap_operations (
          repository TEXT PRIMARY KEY REFERENCES repositories(repository), revision INTEGER NOT NULL,
          state TEXT NOT NULL, data_json TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS configuration_updates (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, update_id TEXT NOT NULL UNIQUE,
          repository TEXT NOT NULL REFERENCES repositories(repository), previous_hash TEXT NOT NULL,
          next_hash TEXT NOT NULL, state TEXT NOT NULL, payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL, completed_at TEXT
        );
        PRAGMA user_version=2;
      `);
    } catch (error) { this.database.close(); throw error; }
  }
  close() { this.database.close(); }
  get(repository) { return rowValue(this.database.prepare('SELECT * FROM repositories WHERE repository=?').get(repositoryKey(repository))); }
  list() { return this.database.prepare('SELECT * FROM repositories ORDER BY repository').all().map(rowValue); }
  register(input, { sourcePath, policy, now = new Date().toISOString() } = {}) {
    const effectivePolicy = validateFactoryPolicy(policy);
    const config = validateRepositoryConfig(input, { policy: effectivePolicy });
    if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath) || /[\0\r\n]/.test(sourcePath)) fail('INVALID_CONFIG_PATH');
    const key = repositoryKey(config.repository), hash = configurationHash(config);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.get(key);
      if (prior && prior.configHash !== hash) fail('REPOSITORY_ALREADY_REGISTERED_WITH_DIFFERENT_CONFIG');
      if (prior && prior.policyHash !== configurationHash(effectivePolicy)) fail('REPOSITORY_ALREADY_REGISTERED_WITH_DIFFERENT_POLICY');
      if (!prior) this.database.prepare('INSERT INTO repositories VALUES(?,?,?,?,?,?)').run(key, hash, JSON.stringify(config), JSON.stringify(effectivePolicy), sourcePath, now);
      const result = this.get(key);
      this.database.exec('COMMIT');
      return { created: !prior, registration: result };
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
  getOperation(repository) { return operationValue(this.database.prepare('SELECT * FROM bootstrap_operations WHERE repository=?').get(repositoryKey(repository))); }
  getConfigurationUpdate(repository) {
    return updateValue(this.database.prepare('SELECT * FROM configuration_updates WHERE repository=? ORDER BY sequence DESC LIMIT 1').get(repositoryKey(repository)));
  }
  // Serialize new review activation with the update intent. No async work may
  // escape this transaction; provider/native reads happen before this guard.
  withConfigurationGuard(repository, expectedConfigHash, action) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      if (this.get(repository)?.configHash !== expectedConfigHash || this.getOperation(repository)?.state !== 'configured') fail('REGISTRY_CONFIG_CHANGED');
      const value = action();
      if (value && typeof value.then === 'function') fail('ASYNC_CONFIGURATION_GUARD');
      this.database.exec('COMMIT'); return value;
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
  prepareConfigurationUpdate(repository, { updateId, expectedConfigHash, expectedOperationRevision, payload, assertQuiescent = () => {}, now = new Date().toISOString() }) {
    const key = repositoryKey(repository);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(updateId ?? '') || !payload || Buffer.byteLength(JSON.stringify(payload)) > 2_000_000) fail('INVALID_CONFIGURATION_UPDATE');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const registration = this.get(key), operation = this.getOperation(key), prior = this.getConfigurationUpdate(key);
      if (prior?.updateId === updateId) {
        if (prior.previousHash !== expectedConfigHash || !isDeepStrictEqual(prior.payload, payload)) fail('CONFIGURATION_UPDATE_CONFLICT');
        this.database.exec('COMMIT'); return prior;
      }
      if (!registration || registration.configHash !== expectedConfigHash) fail('REGISTRY_CONFIG_CHANGED');
      if (operation?.state !== 'configured' || operation.revision !== expectedOperationRevision || operation.data.pending) fail('CONFIGURATION_UPDATE_NOT_QUIESCENT');
      const config = validateConfigurationUpdate(registration, payload.registration?.config);
      if (payload.registration?.configHash !== configurationHash(config) || payload.registration.repository !== key || payload.registration.policyHash !== registration.policyHash || !isDeepStrictEqual(payload.previousRegistration, registration) || !isDeepStrictEqual(payload.previousOperation, operation) || !isDeepStrictEqual(payload.registration.policy, registration.policy) || payload.registration.createdAt !== registration.createdAt || typeof payload.registration.sourcePath !== 'string' || !path.isAbsolute(payload.registration.sourcePath) || /[\0\r\n]/.test(payload.registration.sourcePath)) fail('INVALID_CONFIGURATION_UPDATE');
      assertQuiescent();
      this.database.prepare('INSERT INTO configuration_updates(update_id,repository,previous_hash,next_hash,state,payload_json,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(updateId, key, expectedConfigHash, configurationHash(config), 'prepared', JSON.stringify(payload), now);
      this.database.prepare('UPDATE bootstrap_operations SET revision=revision+1,state=?,data_json=?,updated_at=? WHERE repository=? AND revision=?')
        .run('configuration_updating', JSON.stringify({ ...operation.data, configurationUpdateId: updateId }), now, key, operation.revision);
      const result = this.getConfigurationUpdate(key); this.database.exec('COMMIT'); return result;
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
  finishConfigurationUpdate(repository, { updateId, assertComplete = () => {}, now = new Date().toISOString() }) {
    const key = repositoryKey(repository);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const update = this.getConfigurationUpdate(key), registration = this.get(key), operation = this.getOperation(key);
      if (!update || update.updateId !== updateId) fail('CONFIGURATION_UPDATE_CONFLICT');
      if (update.state === 'completed') {
        if (registration.configHash !== update.nextHash || operation?.state !== 'configured') fail('CONFIGURATION_UPDATE_CONFLICT');
        assertComplete();
        this.database.exec('COMMIT'); return update;
      }
      if (registration.configHash !== update.previousHash || operation?.state !== 'configuration_updating' || operation.data.configurationUpdateId !== updateId || operation.revision !== update.payload.previousOperation.revision + 1) fail('CONFIGURATION_UPDATE_CONFLICT');
      assertComplete();
      const next = update.payload.registration;
      this.database.prepare('UPDATE repositories SET config_hash=?,config_json=?,source_path=? WHERE repository=? AND config_hash=?')
        .run(next.configHash, JSON.stringify(next.config), next.sourcePath, key, update.previousHash);
      this.database.prepare('UPDATE bootstrap_operations SET revision=revision+1,state=?,data_json=?,updated_at=? WHERE repository=? AND revision=?')
        .run('configured', JSON.stringify(update.payload.operationData), now, key, operation.revision);
      this.database.prepare("UPDATE configuration_updates SET state='completed',completed_at=? WHERE update_id=? AND state='prepared'").run(now, updateId);
      const result = this.getConfigurationUpdate(key); this.database.exec('COMMIT'); return result;
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
  beginOperation(repository, { expectedConfigHash, state = 'planned', data = {}, now = new Date().toISOString() } = {}) {
    const key = repositoryKey(repository);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const registration = this.get(key);
      if (!registration || registration.configHash !== expectedConfigHash) fail('REGISTRY_CONFIG_CHANGED');
      if (this.getOperation(key)) fail('BOOTSTRAP_OPERATION_EXISTS');
      this.#checkOperation(state, data);
      this.database.prepare('INSERT INTO bootstrap_operations VALUES(?,0,?,?,?)').run(key, state, JSON.stringify(data), now);
      const result = this.getOperation(key);
      this.database.exec('COMMIT'); return result;
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
  updateOperation(repository, { expectedRevision, state, data, now = new Date().toISOString() }) {
    this.#checkOperation(state, data);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) fail('INVALID_OPERATION_REVISION');
    const key = repositoryKey(repository);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = this.database.prepare('UPDATE bootstrap_operations SET revision=revision+1,state=?,data_json=?,updated_at=? WHERE repository=? AND revision=?')
        .run(state, JSON.stringify(data), now, key, expectedRevision);
      if (result.changes !== 1) fail('BOOTSTRAP_OPERATION_CONFLICT');
      const operation = this.getOperation(key);
      this.database.exec('COMMIT'); return operation;
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
  #checkOperation(state, data) {
    if (typeof state !== 'string' || !/^[a-z][a-z_]{0,63}$/.test(state) || !data || typeof data !== 'object' || Array.isArray(data) || Buffer.byteLength(JSON.stringify(data)) > 128_000) fail('INVALID_BOOTSTRAP_OPERATION');
  }
}
