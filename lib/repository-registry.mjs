import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
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
      if (version !== 0 && version !== 1) fail('REGISTRY_MIGRATION_REQUIRED');
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS repositories (
          repository TEXT PRIMARY KEY, config_hash TEXT NOT NULL, config_json TEXT NOT NULL,
          policy_json TEXT NOT NULL, source_path TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS bootstrap_operations (
          repository TEXT PRIMARY KEY REFERENCES repositories(repository), revision INTEGER NOT NULL,
          state TEXT NOT NULL, data_json TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        PRAGMA user_version=1;
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
