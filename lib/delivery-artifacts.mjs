import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { summarizeDeliveryPatch } from './github-delivery.mjs';

const MAX_OBSERVATION_BYTES = 2_000_000;
const SHA256 = /^[a-f0-9]{64}$/;
export class DeliveryArtifactError extends Error {
  constructor(code) { super(code); this.name = 'DeliveryArtifactError'; this.code = code; }
}
const fail = code => { throw new DeliveryArtifactError(code); };
const hash = content => createHash('sha256').update(content).digest('hex');
function syncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function privateDirectory(directory) {
  const firstCreated = fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('DELIVERY_ARTIFACT_DIRECTORY_UNSAFE');
  fs.chmodSync(directory, 0o700);
  if (firstCreated) {
    for (let current = directory;; current = path.dirname(current)) {
      syncDirectory(current); syncDirectory(path.dirname(current));
      if (current === firstCreated) break;
    }
  }
}
function immutableFile(filename, content) {
  const directory = path.dirname(filename);
  privateDirectory(directory);
  const inspectExisting = () => {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== Buffer.byteLength(content) || fs.readFileSync(filename, 'utf8') !== content) fail('DELIVERY_ARTIFACT_CONFLICT');
    fs.chmodSync(filename, 0o600);
  };
  const temporary = path.join(directory, '.' + path.basename(filename) + '.' + randomUUID() + '.tmp');
  let fd, temporaryExists = false;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600); temporaryExists = true;
    fs.writeFileSync(fd, content); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    // The final hash-addressed name appears only after all bytes are durable.
    // link, unlike rename, never overwrites an existing immutable artifact.
    try { fs.linkSync(temporary, filename); }
    catch (error) { if (error.code !== 'EEXIST') throw error; inspectExisting(); }
    syncDirectory(directory);
  } catch (error) {
    if (error instanceof DeliveryArtifactError) throw error;
    fail('DELIVERY_ARTIFACT_WRITE_FAILED');
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* Preserve the storage failure. */ } }
    if (temporaryExists) {
      try { fs.unlinkSync(temporary); syncDirectory(directory); }
      catch (error) { if (error.code !== 'ENOENT') fail('DELIVERY_ARTIFACT_WRITE_FAILED'); }
    }
  }
}

/** Append-only private delivery evidence; filenames never come from diff paths. */
export class DeliveryArtifactStore {
  constructor({ directory }) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || /[\u0000-\u001f\u007f]/.test(directory)) fail('INVALID_DELIVERY_ARTIFACT_DIRECTORY');
    this.directory = path.resolve(directory);
    this.patches = new Map();
    // Creation is deferred until there is actual evidence to write.
  }
  capturePatch({ patch, summary, association }) {
    const verified = summarizeDeliveryPatch(patch);
    if (!summary || summary.sha256 !== verified.sha256 || summary.bytes !== verified.bytes || !association?.executionId || !association.cloudTaskId) fail('INVALID_DELIVERY_ARTIFACT');
    privateDirectory(this.directory);
    const filename = path.join(this.directory, 'patches', verified.sha256 + '.patch');
    immutableFile(filename, patch);
    this.patches.set(association.executionId, { patchPath: filename, patchSha256: verified.sha256 });
    return { patchPath: filename, patchSha256: verified.sha256 };
  }
  recordObservation({ result, context }) {
    if (!result || result.schemaVersion !== 1 || !result.association?.executionId || typeof result.status !== 'string' || !Array.isArray(result.reasons) || !Number.isFinite(Date.parse(result.observedAt))) fail('INVALID_DELIVERY_ARTIFACT');
    if (!context || !SHA256.test(context.configHash ?? '') || !SHA256.test(context.policyHash ?? '') || !Number.isInteger(context.journalSchemaVersion) || !Number.isInteger(context.executionRevision) || context.executionRevision < 0) fail('INVALID_DELIVERY_ARTIFACT_CONTEXT');
    const patch = this.patches.get(result.association.executionId);
    if (result.patch && (!patch || patch.patchSha256 !== result.patch.sha256)) fail('DELIVERY_PATCH_ARTIFACT_MISSING');
    const observationId = randomUUID();
    // Deliberately retain only the inspector's supported sanitized result fields.
    const delivery = Object.fromEntries(['schemaVersion', 'status', 'association', 'provenance', 'checks', 'reasons', 'humanApprovalEligible', 'requiresFreshInspection', 'observedAt', 'patch'].filter(key => result[key] !== undefined).map(key => [key, result[key]]));
    const envelope = { schemaVersion: 1, observationId, observedAt: result.observedAt, context: { configHash: context.configHash, policyHash: context.policyHash, journalSchemaVersion: context.journalSchemaVersion, executionRevision: context.executionRevision }, delivery, ...(patch ? { patchArtifact: { sha256: patch.patchSha256, path: patch.patchPath } } : {}) };
    const content = JSON.stringify(envelope, null, 2) + '\n';
    if (Buffer.byteLength(content) > MAX_OBSERVATION_BYTES) fail('DELIVERY_OBSERVATION_TOO_LARGE');
    const filename = path.join(this.directory, 'observations', observationId + '.json');
    privateDirectory(this.directory);
    immutableFile(filename, content);
    return { observationId, observationPath: filename, observationSha256: hash(content), ...(patch ?? {}) };
  }
}
