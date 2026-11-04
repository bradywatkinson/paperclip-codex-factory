import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_FACTORY_POLICY, MAX_CONFIG_BYTES, RepositoryConfigError,
  loadFactoryPolicy, loadRepositoryConfig, parseFactoryPolicy,
  parseRepositoryConfig, validateFactoryPolicy, validateRepositoryConfig,
} from '../lib/repository-config.mjs';

const source = `schemaVersion: 1
repository: fixture/project
cloud:
  environmentId: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
commands:
  test:
    argv: [node, --test]
`;
const input = () => ({ schemaVersion: 1, repository: 'fixture/project', cloud: { environmentId: 'a'.repeat(32) }, commands: { test: { argv: ['node', '--test'] } } });
const failure = (code, field) => error => error instanceof RepositoryConfigError && error.code === code && (!field || error.field === field);

test('ordinary block and flow YAML normalize to a frozen safe config', () => {
  const config = parseRepositoryConfig(source);
  assert.equal(config.repository, 'fixture/project');
  assert.equal(config.defaultBranch, 'main');
  assert.deepEqual(config.commands.test, { argv: ['node', '--test'], timeoutMs: 600_000 });
  assert.deepEqual(config.delivery, { requiredChecks: [], requireIndependentReview: true, requireHumanApproval: true, autoMerge: false, deploy: false });
  assert.deepEqual(config.concurrency, { maxActive: 1, maxAttempts: 3 });
  assert.throws(() => { config.commands.test.argv.push('unexpected'); }, TypeError);
  assert.throws(() => { DEFAULT_FACTORY_POLICY.delivery.autoMerge = true; }, TypeError);
});

test('two distinct repository examples and private policy load through the public API', async () => {
  const directory = new URL('../examples/repositories/', import.meta.url);
  const policy = await loadFactoryPolicy(new URL('factory-policy.yaml', directory));
  const first = await loadRepositoryConfig(new URL('node-service.factory.yaml', directory), { policy });
  const second = await loadRepositoryConfig(new URL('typescript-site.factory.yaml', directory), { policy });
  assert.notEqual(first.repository, second.repository);
  assert.notEqual(first.cloud.environmentId, second.cloud.environmentId);
  assert.deepEqual(second.secretRefs, { GITHUB_TOKEN: { env: 'FACTORY_GITHUB_TOKEN' } });
  assert.equal(second.defaultBranch, 'develop');
});

test('central required checks cannot be removed and repository checks may strengthen them', () => {
  const policy = validateFactoryPolicy({ delivery: { requiredChecks: ['security', 'unit-tests'] } });
  const config = validateRepositoryConfig({ ...input(), delivery: { requiredChecks: ['build', 'unit-tests'] } }, { policy });
  assert.deepEqual(config.delivery.requiredChecks, ['security', 'unit-tests', 'build']);
  assert.deepEqual(validateRepositoryConfig(input(), { policy }).delivery.requiredChecks, ['security', 'unit-tests']);
});

test('resolved required-check limits reject oversized unions before registry revalidation', () => {
  const policy = { delivery: { requiredChecks: Array.from({ length: 30 }, (_, i) => `central-${i}`) } };
  const oversized = { ...input(), delivery: { requiredChecks: Array.from({ length: 30 }, (_, i) => `repo-${i}`) } };
  assert.throws(() => validateRepositoryConfig(oversized, { policy }), failure('INVALID_REPOSITORY_CONFIG', 'delivery.requiredChecks'));
  const accepted = validateRepositoryConfig({ ...input(), delivery: { requiredChecks: Array.from({ length: 20 }, (_, i) => `repo-${i}`) } }, { policy });
  assert.equal(accepted.delivery.requiredChecks.length, 50);
  assert.deepEqual(validateRepositoryConfig(accepted, { policy }), accepted);
});

test('unsafe gates reject explicit overrides in repositories and central policy', () => {
  for (const delivery of [{ autoMerge: true }, { deploy: true }, { requireHumanApproval: false }, { requireIndependentReview: false }, { autoMerge: 'false' }]) {
    assert.throws(() => validateRepositoryConfig({ ...input(), delivery }), failure('POLICY_VIOLATION'));
    assert.throws(() => validateFactoryPolicy({ delivery }), failure('POLICY_VIOLATION'));
  }
});

test('repository concurrency and retries may be stricter but not exceed central ceilings', () => {
  const policy = validateFactoryPolicy({ concurrency: { maxGlobalActive: 4, maxRepositoryActive: 2, maxAttempts: 2 } });
  const lower = validateRepositoryConfig({ ...input(), concurrency: { maxActive: 1, maxAttempts: 1 } }, { policy });
  assert.deepEqual(lower.concurrency, { maxActive: 1, maxAttempts: 1 });
  assert.equal(validateRepositoryConfig(input(), { policy }).concurrency.maxAttempts, 2);
  assert.throws(() => validateRepositoryConfig({ ...input(), concurrency: { maxActive: 3 } }, { policy }), failure('POLICY_VIOLATION', 'concurrency.maxActive'));
  assert.throws(() => validateRepositoryConfig({ ...input(), concurrency: { maxAttempts: 3 } }, { policy }), failure('POLICY_VIOLATION', 'concurrency.maxAttempts'));
  assert.throws(() => validateFactoryPolicy({ concurrency: { maxGlobalActive: 1, maxRepositoryActive: 2 } }), failure('INVALID_REPOSITORY_CONFIG', 'policy.concurrency.maxRepositoryActive'));
});

test('command arrays are data only and timeout defaults obey central caps', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-config-no-exec-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const marker = path.join(directory, 'executed');
  const config = validateRepositoryConfig({ ...input(), commands: { test: { argv: ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`] } } }, { policy: { maxCommandTimeoutMs: 2_000 } });
  assert.equal(config.commands.test.timeoutMs, 2_000);
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  assert.throws(() => validateRepositoryConfig(input(), { policy: { maxCommandTimeoutMs: 999 } }), failure('INVALID_REPOSITORY_CONFIG'));
  assert.throws(() => validateRepositoryConfig({ ...input(), commands: { test: { argv: ['node'], timeoutMs: 3_000 } } }, { policy: { maxCommandTimeoutMs: 2_000 } }), failure('INVALID_REPOSITORY_CONFIG', 'commands.test.timeoutMs'));
});

test('only environment-name secret references are accepted and diagnostics do not echo values', () => {
  const valid = validateRepositoryConfig({ ...input(), secretRefs: { API_TOKEN: { env: 'FACTORY_API_TOKEN' } } });
  assert.deepEqual(valid.secretRefs, { API_TOKEN: { env: 'FACTORY_API_TOKEN' } });
  const secret = 'TOKEN_FIXTURE_NEVER_ECHO';
  for (const secretRefs of [{ API_TOKEN: secret }, { API_TOKEN: { value: secret } }, { API_TOKEN: { env: `token-${secret}` } }, { 'invalid-name': { env: 'TOKEN' } }]) {
    assert.throws(() => validateRepositoryConfig({ ...input(), secretRefs }), error => failure('INVALID_REPOSITORY_CONFIG')(error) && !error.message.includes(secret));
  }
  assert.throws(() => parseRepositoryConfig(`${source}password: ${secret}\n`), error => !error.message.includes(secret));
});

test('unknown fields fail closed at each schema boundary', () => {
  for (const config of [
    { ...input(), companyId: 'do-not-accept-native-config' },
    { ...input(), cloud: { ...input().cloud, token: 'hidden' } },
    { ...input(), commands: { ...input().commands, deploy: { argv: ['false'] } } },
    { ...input(), commands: { test: { argv: ['node'], shell: true } } },
    { ...input(), concurrency: { unlimited: true } },
    { ...input(), delivery: { skipReview: true } },
  ]) assert.throws(() => validateRepositoryConfig(config), failure('INVALID_REPOSITORY_CONFIG'));
  assert.throws(() => validateFactoryPolicy({ autoMerge: true }), failure('INVALID_REPOSITORY_CONFIG'));
});

test('unsupported versions require explicit migration, with no guessed v0 translation', () => {
  for (const schemaVersion of [undefined, 0, 2, '1']) {
    assert.throws(() => validateRepositoryConfig({ ...input(), schemaVersion }), failure('CONFIG_MIGRATION_REQUIRED', 'schemaVersion'));
  }
  assert.throws(() => parseFactoryPolicy('schemaVersion: 2\n'), failure('CONFIG_MIGRATION_REQUIRED', 'policy.schemaVersion'));
  assert.throws(() => validateFactoryPolicy({ schemaVersion: null }), failure('INVALID_REPOSITORY_CONFIG'));
  assert.throws(() => validateRepositoryConfig({ ...input(), defaultBranch: null }), failure('INVALID_REPOSITORY_CONFIG'));
});

test('invalid repo identity, branch and environment cannot reach onboarding', () => {
  for (const patch of [
    { repository: 'https://github.com/fixture/project' }, { repository: 'fixture/project.git' }, { repository: '../repo' },
    { defaultBranch: 'main..other' }, { defaultBranch: 'main.lock' }, { defaultBranch: '--option' },
    { cloud: { environmentId: 'label-only' } }, { cloud: { environmentId: 'A'.repeat(32) } },
  ]) assert.throws(() => validateRepositoryConfig({ ...input(), ...patch }), failure('INVALID_REPOSITORY_CONFIG'));
});

test('malformed commands, limits and duplicate check names are rejected', () => {
  for (const patch of [
    { commands: {} }, { commands: { test: 'npm test' } }, { commands: { test: { argv: [] } } },
    { commands: { test: { argv: ['node', '\0'] } } }, { commands: { test: { argv: ['node'], timeoutMs: Infinity } } },
    { concurrency: { maxActive: 0 } }, { concurrency: { maxAttempts: 1.5 } },
    { delivery: { requiredChecks: ['test', 'test'] } }, { delivery: { requiredChecks: [false] } },
  ]) assert.throws(() => validateRepositoryConfig({ ...input(), ...patch }), failure('INVALID_REPOSITORY_CONFIG'));
});

test('duplicate YAML keys, multiple documents, aliases, merge keys and custom tags fail closed', () => {
  for (const yaml of [
    `${source}repository: fixture/other\n`, `${source}---\n${source}`,
    `${source}delivery: &shared {}\nsecretRefs: *shared\n`, `${source}delivery: { <<: {} }\n`,
    `${source}secretRefs: !unrecognized {}\n`, `%YAML 1.1\n---\n${source}`,
    'schemaVersion: [\n', `${source}commands:\n  test:\n    argv: [node]\n`,
  ]) assert.throws(() => parseRepositoryConfig(yaml), error => error instanceof RepositoryConfigError);
});

test('YAML parse errors never expose credential-looking source snippets', () => {
  const secret = 'RAW_SECRET_FIXTURE_DO_NOT_ECHO';
  assert.throws(() => parseRepositoryConfig(`cloud: [${secret}\n`), error => failure('INVALID_CONFIG_YAML')(error) && !error.message.includes(secret));
});

test('config size, nesting, prototype keys and direct cyclic inputs are bounded', () => {
  assert.throws(() => parseRepositoryConfig(' '.repeat(MAX_CONFIG_BYTES + 1)), failure('CONFIG_TOO_LARGE'));
  assert.throws(() => parseRepositoryConfig(`${source}secretRefs: ${'['.repeat(30)}0${']'.repeat(30)}\n`), failure('INVALID_CONFIG_YAML'));
  assert.throws(() => parseRepositoryConfig(`${source}secretRefs: { __proto__: {} }\n`), failure('INVALID_REPOSITORY_CONFIG'));
  const cyclic = input(); cyclic.secretRefs = cyclic;
  assert.throws(() => validateRepositoryConfig(cyclic), failure('INVALID_REPOSITORY_CONFIG'));
});

test('loader rejects oversized files, invalid UTF-8, directories, and unavailable paths with safe errors', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-config-input-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const oversized = path.join(directory, 'oversized.yaml');
  await fs.writeFile(oversized, ' '.repeat(MAX_CONFIG_BYTES + 1));
  await assert.rejects(loadRepositoryConfig(oversized), failure('CONFIG_TOO_LARGE'));
  const malformed = path.join(directory, 'invalid.yaml');
  await fs.writeFile(malformed, Buffer.from([0xff]));
  await assert.rejects(loadRepositoryConfig(malformed), failure('INVALID_CONFIG_YAML'));
  await assert.rejects(loadRepositoryConfig(directory), failure('CONFIG_READ_FAILED'));
  await assert.rejects(loadRepositoryConfig(path.join(directory, 'missing-secret-name.yaml')), error => failure('CONFIG_READ_FAILED')(error) && !error.message.includes('missing-secret-name'));
});
