import { open } from 'node:fs/promises';
import { isAlias, isMap, isPair, isSeq, parseDocument } from 'yaml';

export const REPOSITORY_CONFIG_VERSION = 1;
export const MAX_CONFIG_BYTES = 65_536;
const MAX_DEPTH = 16;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export class RepositoryConfigError extends Error {
  constructor(code, field, detail) {
    super(`${field}: ${detail}`);
    this.name = 'RepositoryConfigError';
    this.code = code;
    this.field = field;
  }
}
const fail = (code, field, detail) => { throw new RepositoryConfigError(code, field, detail); };
const invalid = (field, detail) => fail('INVALID_REPOSITORY_CONFIG', field, detail);
function object(value, field, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(field, 'must be a mapping');
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid(field, 'contains unsupported fields; remove unknown keys and credential values');
  return value;
}
function integer(value, field, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) invalid(field, `must be an integer from ${min} to ${max}`);
  return value;
}
function string(value, field, max = 256) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max || /[\u0000-\u001f\u007f]/.test(value)) invalid(field, 'must be a nonempty string without control characters');
  return value;
}
function version(value, field) {
  if (value !== 1) fail('CONFIG_MIGRATION_REQUIRED', field, 'only schemaVersion 1 is supported; migrate explicitly before use');
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function checks(value, field) {
  if (!Array.isArray(value) || value.length > 50) invalid(field, 'must be an array of at most 50 unique check names');
  const result = value.map(item => string(item, field, 200));
  if (new Set(result).size !== result.length) invalid(field, 'must not contain duplicate check names');
  return result;
}
function gates(input = {}, field, requiredChecks = []) {
  object(input, field, ['requiredChecks', 'requireIndependentReview', 'requireHumanApproval', 'autoMerge', 'deploy']);
  for (const name of ['requireIndependentReview', 'requireHumanApproval']) {
    if (input[name] !== undefined && input[name] !== true) fail('POLICY_VIOLATION', `${field}.${name}`, 'must remain enabled');
  }
  for (const name of ['autoMerge', 'deploy']) {
    if (input[name] !== undefined && input[name] !== false) fail('POLICY_VIOLATION', `${field}.${name}`, 'must remain disabled');
  }
  const resolvedChecks = [...new Set([...requiredChecks, ...checks(input.requiredChecks ?? [], `${field}.requiredChecks`)])];
  if (resolvedChecks.length > 50) invalid(`${field}.requiredChecks`, 'resolved central and repository requirements must contain at most 50 check names');
  return {
    requiredChecks: resolvedChecks,
    requireIndependentReview: true, requireHumanApproval: true, autoMerge: false, deploy: false,
  };
}

/** Factory convention, separate from Paperclip's native configuration. No I/O or commands. */
export function validateFactoryPolicy(input = {}) {
  checkStructure(input);
  object(input, 'policy', ['schemaVersion', 'delivery', 'concurrency', 'maxCommandTimeoutMs']);
  version(input.schemaVersion ?? 1, 'policy.schemaVersion');
  const c = input.concurrency ?? {};
  object(c, 'policy.concurrency', ['maxGlobalActive', 'maxRepositoryActive', 'maxAttempts']);
  const maxGlobalActive = integer(c.maxGlobalActive ?? 2, 'policy.concurrency.maxGlobalActive', 1, 100);
  const maxRepositoryActive = integer(c.maxRepositoryActive ?? 1, 'policy.concurrency.maxRepositoryActive', 1, maxGlobalActive);
  return freeze({
    schemaVersion: 1,
    delivery: gates(input.delivery, 'policy.delivery'),
    concurrency: { maxGlobalActive, maxRepositoryActive, maxAttempts: integer(c.maxAttempts ?? 3, 'policy.concurrency.maxAttempts', 1, 100) },
    maxCommandTimeoutMs: integer(input.maxCommandTimeoutMs ?? 3_600_000, 'policy.maxCommandTimeoutMs', 1_000, 3_600_000),
  });
}
export const DEFAULT_FACTORY_POLICY = validateFactoryPolicy();

function checkStructure(input) {
  let count = 0;
  const seen = new Set();
  const stack = [{ value: input, depth: 0 }];
  while (stack.length) {
    const { value, depth } = stack.pop();
    if (++count > 10_000 || depth > MAX_DEPTH) invalid('config', 'exceeds maximum structure size or nesting depth');
    if (value === null) invalid('config', 'null values are not supported; omit optional fields instead');
    if (!value || typeof value !== 'object') continue;
    if (seen.has(value)) invalid('config', 'aliases and cyclic values are not supported');
    seen.add(value);
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid('config', 'must contain only plain mappings, arrays, and scalar values');
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) invalid('config', 'contains an unsupported mapping key');
      stack.push({ value: child, depth: depth + 1 });
    }
  }
}
export function validateRepositoryConfig(input, { policy: policyInput = DEFAULT_FACTORY_POLICY } = {}) {
  checkStructure(input);
  const policy = validateFactoryPolicy(policyInput);
  object(input, 'config', ['schemaVersion', 'repository', 'defaultBranch', 'cloud', 'commands', 'delivery', 'concurrency', 'secretRefs']);
  version(input.schemaVersion, 'schemaVersion');
  const repository = string(input.repository, 'repository', 200);
  if (!REPOSITORY.test(repository) || repository.endsWith('.git') || repository.split('/').some(part => ['.', '..'].includes(part))) invalid('repository', 'must be a GitHub owner/name without a URL or .git suffix');
  const defaultBranch = string(input.defaultBranch ?? 'main', 'defaultBranch', 200);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(defaultBranch) || /\.\.|\/\/|\/$|\.$|\.lock(?:\/|$)|\/\./.test(defaultBranch)) invalid('defaultBranch', 'must be a valid branch name');
  const cloud = object(input.cloud, 'cloud', ['environmentId']);
  if (typeof cloud.environmentId !== 'string' || !/^[a-f0-9]{32}$/.test(cloud.environmentId)) invalid('cloud.environmentId', 'must be a 32-character lowercase hexadecimal identifier');
  object(input.commands, 'commands', ['test', 'lint', 'build']);
  if (input.commands.test === undefined) invalid('commands.test', 'is required; provide an argv array and optional timeoutMs');
  const commands = {};
  for (const name of ['test', 'lint', 'build']) {
    const command = input.commands[name];
    if (command === undefined) continue;
    object(command, `commands.${name}`, ['argv', 'timeoutMs']);
    if (!Array.isArray(command.argv) || !command.argv.length || command.argv.length > 128) invalid(`commands.${name}.argv`, 'must be a nonempty argv array of at most 128 strings');
    commands[name] = {
      argv: command.argv.map(arg => string(arg, `commands.${name}.argv`, 4_096)),
      timeoutMs: integer(command.timeoutMs ?? Math.min(600_000, policy.maxCommandTimeoutMs), `commands.${name}.timeoutMs`, 1_000, policy.maxCommandTimeoutMs),
    };
  }
  const c = input.concurrency ?? {};
  object(c, 'concurrency', ['maxActive', 'maxAttempts']);
  const active = integer(c.maxActive ?? 1, 'concurrency.maxActive', 1, 100);
  const attempts = integer(c.maxAttempts ?? Math.min(3, policy.concurrency.maxAttempts), 'concurrency.maxAttempts', 1, 100);
  if (active > policy.concurrency.maxRepositoryActive || active > policy.concurrency.maxGlobalActive) fail('POLICY_VIOLATION', 'concurrency.maxActive', 'exceeds the central repository or global ceiling');
  if (attempts > policy.concurrency.maxAttempts) fail('POLICY_VIOLATION', 'concurrency.maxAttempts', 'exceeds the central retry ceiling');
  const secretInput = input.secretRefs ?? {};
  if (!secretInput || typeof secretInput !== 'object' || Array.isArray(secretInput) || Object.keys(secretInput).length > 32) invalid('secretRefs', 'must be a mapping with at most 32 environment references');
  const secretRefs = {};
  for (const [name, ref] of Object.entries(secretInput)) {
    if (!ENV_NAME.test(name)) invalid('secretRefs', 'reference names must be uppercase environment variable names');
    object(ref, 'secretRefs', ['env']);
    if (typeof ref.env !== 'string' || !ENV_NAME.test(ref.env)) invalid('secretRefs', 'each reference must contain only an uppercase env name, never a secret value');
    secretRefs[name] = { env: ref.env };
  }
  return freeze({
    schemaVersion: 1, repository, defaultBranch, cloud: { environmentId: cloud.environmentId }, commands,
    delivery: gates(input.delivery, 'delivery', policy.delivery.requiredChecks),
    concurrency: { maxActive: active, maxAttempts: attempts }, secretRefs,
  });
}

function parseYaml(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > MAX_CONFIG_BYTES) fail('CONFIG_TOO_LARGE', 'config', `must be UTF-8 text of at most ${MAX_CONFIG_BYTES} bytes`);
  let document;
  try {
    document = parseDocument(source, { version: '1.2', schema: 'core', merge: false, strict: true, uniqueKeys: true, stringKeys: true, prettyErrors: false });
  } catch { fail('INVALID_CONFIG_YAML', 'config', 'cannot parse this YAML document'); }
  if (document.errors.length || document.warnings.length) fail('INVALID_CONFIG_YAML', 'config', 'requires one valid YAML 1.2 document with unique keys and standard types');
  if (document.directives.yaml.version && document.directives.yaml.version !== '1.2') fail('INVALID_CONFIG_YAML', 'config', 'requires YAML 1.2');
  const stack = [{ node: document.contents, depth: 0 }];
  while (stack.length) {
    const { node, depth } = stack.pop();
    if (depth > MAX_DEPTH) fail('INVALID_CONFIG_YAML', 'config', 'exceeds maximum nesting depth');
    if (isAlias(node)) fail('INVALID_CONFIG_YAML', 'config', 'aliases are not supported');
    if (isMap(node) || isSeq(node)) for (const child of node.items) stack.push({ node: child, depth: depth + 1 });
    else if (isPair(node)) { stack.push({ node: node.key, depth }); stack.push({ node: node.value, depth }); }
  }
  try { return document.toJS({ maxAliasCount: 0 }); }
  catch { fail('INVALID_CONFIG_YAML', 'config', 'cannot convert this YAML document'); }
}
export function parseRepositoryConfig(source, options) { return validateRepositoryConfig(parseYaml(source), options); }
export function parseFactoryPolicy(source) { return validateFactoryPolicy(parseYaml(source)); }
async function boundedRead(filename) {
  let handle;
  try {
    handle = await open(filename, 'r');
    if (!(await handle.stat()).isFile()) fail('CONFIG_READ_FAILED', 'config', 'must be a regular file');
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_CONFIG_BYTES) fail('CONFIG_TOO_LARGE', 'config', `must be at most ${MAX_CONFIG_BYTES} bytes`);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)); }
    catch { fail('INVALID_CONFIG_YAML', 'config', 'must contain valid UTF-8'); }
  } catch (error) {
    if (error instanceof RepositoryConfigError) throw error;
    fail('CONFIG_READ_FAILED', 'config', 'unable to read the configuration file');
  } finally { await handle?.close(); }
}
export async function loadRepositoryConfig(filename, options) { return parseRepositoryConfig(await boundedRead(filename), options); }
export async function loadFactoryPolicy(filename) { return parseFactoryPolicy(await boundedRead(filename)); }
