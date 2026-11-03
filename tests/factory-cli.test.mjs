import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { runFactoryCli } from '../scripts/factory.mjs';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const YAML = `schemaVersion: 1
repository: example/project
defaultBranch: main
cloud:
  environmentId: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
commands:
  test:
    argv: [node, --test]
`;
async function setup(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-cli-'));
  const config = path.join(home, '.factory.yaml');
  await fs.writeFile(config, YAML);
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return { home, config, registry: path.join(home, 'registry') };
}
async function invoke(args, options) {
  let stdout = '', stderr = '';
  const calls = [];
  const code = await runFactoryCli(args, { ...options, stdout: value => { stdout += value; }, stderr: value => { stderr += value; }, run: async (...args) => { calls.push(args); throw new Error('Unexpected external access'); } });
  return { code, stdout, stderr, calls };
}
test('repo validate accepts ordinary YAML without executing commands or creating state', async t => {
  const context = await setup(t);
  const result = await invoke(['repo', 'validate', '--config', context.config, '--json'], context);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'configuration_valid');
  assert.equal(JSON.parse(result.stdout).accessChecked, false);
  assert.deepEqual(result.calls, []);
  assert.deepEqual(await fs.readdir(context.home), ['.factory.yaml']);
});
test('repo add deduplicates repeated configuration and exposes durable status', async t => {
  const context = await setup(t);
  const add = ['repo', 'add', '--config', context.config, '--registry', context.registry, '--json'];
  const first = await invoke(add, context), second = await invoke(add, context);
  assert.equal(first.code, 0, first.stderr); assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.parse(first.stdout).status, 'registered');
  assert.equal(JSON.parse(second.stdout).status, 'already_registered');
  const status = await invoke(['repo', 'status', 'example/project', '--registry', context.registry, '--json'], context);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).operationalVerified, false);
  const listed = await invoke(['repo', 'list', '--registry', context.registry, '--json'], context);
  assert.equal(JSON.parse(listed.stdout).repositories.length, 1);
  assert.deepEqual(first.calls, []);
});
test('dry-run returns a real onboarding plan with no local or external writes', async t => {
  const context = await setup(t);
  const result = await invoke(['repo', 'bootstrap', '--config', context.config, '--company', COMPANY, '--dry-run', '--json'], context);
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'dry_run');
  assert.equal(output.plan.workspace.repoUrl, 'https://github.com/example/project');
  assert.equal(output.externalWrites, false); assert.equal(output.cloudSubmissions, false);
  assert.deepEqual(result.calls, []);
  assert.deepEqual(await fs.readdir(context.home), ['.factory.yaml']);
});
test('invalid config and unsupported flags fail with actionable JSON before writes', async t => {
  const context = await setup(t);
  const badFlags = await invoke(['repo', 'add', '--config', context.config, '--auto-merge', '--json'], context);
  assert.equal(badFlags.code, 1);
  assert.equal(JSON.parse(badFlags.stderr).code, 'USAGE_FACTORY');
  await fs.writeFile(context.config, YAML + 'delivery:\n  autoMerge: true\n');
  const invalid = await invoke(['repo', 'add', '--config', context.config, '--registry', context.registry, '--json'], context);
  assert.equal(invalid.code, 1); assert.equal(JSON.parse(invalid.stderr).status, 'needs_attention');
  assert.deepEqual(await fs.readdir(context.home), ['.factory.yaml']);
});
test('central policy adds required checks and rejects a repository concurrency override', async t => {
  const context = await setup(t);
  const policy = path.join(context.home, 'policy.yaml');
  await fs.writeFile(policy, 'schemaVersion: 1\ndelivery:\n  requiredChecks: [security]\nconcurrency:\n  maxRepositoryActive: 1\n');
  const result = await invoke(['repo', 'validate', '--config', context.config, '--policy', policy, '--json'], context);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).delivery.requiredChecks, ['security']);
  await fs.appendFile(context.config, 'concurrency:\n  maxActive: 2\n');
  const rejected = await invoke(['repo', 'validate', '--config', context.config, '--policy', policy, '--json'], context);
  assert.equal(rejected.code, 1);
});
