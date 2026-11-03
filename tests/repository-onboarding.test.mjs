import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RepositoryRegistry } from '../lib/repository-registry.mjs';
import { bootstrapRepository, buildOnboardingPlan, inspectRepository } from '../lib/repository-onboarding.mjs';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const WORKSPACE = '33333333-3333-4333-8333-333333333333';
const AGENT = '44444444-4444-4444-8444-444444444444';
const input = () => ({ schemaVersion: 1, repository: 'fixture/project', cloud: { environmentId: 'a'.repeat(32) }, commands: { test: { argv: ['node', '--test'] } } });
function fixture(t, config = input()) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-onboard-'));
  fs.mkdirSync(path.join(directory, 'scripts'));
  fs.writeFileSync(path.join(directory, 'scripts/cloud-dispatch.mjs'), '// Inert dispatcher entrypoint fixture.\n');
  const registry = new RepositoryRegistry({ directory: path.join(directory, 'registry') });
  const { registration } = registry.register(config, { sourcePath: path.join(directory, '.factory.yaml') });
  t.after(() => { registry.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const runtime = { nodeCommand: '/fixture/node', paperclipCommand: '/fixture/paperclip', codexCommand: '/fixture/codex', githubCommand: '/fixture/gh', factoryRoot: directory, privateDir: path.join(directory, 'private'), apiBase: 'http://127.0.0.1:8100' };
  const state = { projects: [], workspaces: [], agents: [], calls: [], writes: [], pending: false, failAfterProject: false, environmentTasks: [{ id: 'task_e_' + 'a'.repeat(32), environment_id: null, environment_label: 'fixture/project' }], githubChecks: { total_count: 0, check_runs: [] } };
  const result = value => ({ code: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
  const run = async (command, args, options) => {
    state.calls.push({ command, args, options });
    const [group, action, ...rest] = args;
    if (action === undefined && group === '--version') return result(command === runtime.nodeCommand ? 'v24.15.0\n' : command === runtime.codexCommand ? 'codex-cli 0.166.0\n' : '2026.1023.0\n');
    if (command === runtime.githubCommand) {
      const resource = args.at(-1);
      if (resource.endsWith('/branches/main')) return result({ name: 'main', commit: { sha: 'b'.repeat(40) } });
      if (resource.includes('/check-runs?')) return result(state.githubChecks);
      return result({ full_name: 'fixture/project', default_branch: 'main' });
    }
    if (group === 'login') return { code: 0, stdout: '', stderr: 'Logged in using ChatGPT\n' };
    if (group === 'cloud') return result({ tasks: state.environmentTasks, cursor: null });
    if (group === 'company') return result({ id: COMPANY, status: 'active', requireBoardApprovalForNewAgents: state.pending });
    if (action === 'list') return result(group === 'project' ? state.projects : group === 'project-workspace' ? state.workspaces : state.agents);
    if (action === 'configuration') return result({ ...state.agents.find(row => row.id === rest[0]), ...state.configurationPatch });
    if (action !== 'create') throw new Error('Unexpected command');
    state.writes.push({ group, args });
    const valueOf = name => args[args.indexOf(name) + 1];
    if (group === 'project') {
      const row = { id: PROJECT, companyId: COMPANY, name: valueOf('--name'), description: valueOf('--description'), archivedAt: null };
      state.projects.push(row);
      if (state.failAfterProject) return { code: null, stdout: '', timedOut: true };
      return result(row);
    }
    const payload = JSON.parse(valueOf('--payload-json'));
    const row = { ...payload, id: group === 'agent' ? AGENT : WORKSPACE, companyId: COMPANY, ...(group === 'agent' ? { status: state.pending ? 'pending_approval' : 'idle' } : { projectId: PROJECT }) };
    (group === 'agent' ? state.agents : state.workspaces).push(row);
    return result(row);
  };
  const bootstrap = extra => bootstrapRepository({ registry, repository: registration.repository, companyId: COMPANY, runtime, run, ...extra });
  return { directory, registry, registration, runtime, state, run, bootstrap };
}

test('dry-run creates a concrete plan without operations, files, or subprocesses', async t => {
  const f = fixture(t);
  const result = await f.bootstrap({ dryRun: true });
  assert.equal(result.status, 'planned');
  assert.equal(f.registry.getOperation('fixture/project'), null);
  assert.equal(fs.existsSync(f.runtime.privateDir), false);
  assert.equal(f.state.calls.length, 0);
  assert.deepEqual(result.plan.taskContract.commands.test.argv, ['node', '--test']);
  assert.equal(result.plan.taskContract.delivery.autoMerge, false);
});

test('missing dispatcher entrypoint blocks setup before any external create', async t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.runtime.factoryRoot, 'scripts/cloud-dispatch.mjs'));
  const result = await f.bootstrap();
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.validation.checks.find(row => row.name === 'factory_runtime').code, 'FACTORY_DISPATCHER_UNAVAILABLE');
  assert.equal(f.state.writes.length, 0);
  assert.equal(f.registry.getOperation('fixture/project'), null);
});

test('fresh configuration response must still identify the owned usable process agent', async t => {
  const f = fixture(t);
  assert.equal((await f.bootstrap()).status, 'configured');
  for (const patch of [{ id: PROJECT }, { adapterType: 'codex_local' }, { metadata: {} }, { status: 'terminated' }, { status: 'error' }]) {
    f.state.configurationPatch = patch;
    const result = await f.bootstrap();
    assert.equal(result.status, 'needs_attention');
    assert.equal(result.code, 'BOOTSTRAP_RESOURCE_CHANGED');
  }
  assert.equal(f.state.writes.length, 3);
});

test('validation checks access and mapping without creating any resource or running configured tests', async t => {
  const f = fixture(t);
  const result = await inspectRepository({ registration: f.registration, companyId: COMPANY, runtime: f.runtime, run: f.run, env: { HOME: '/private/home', PAPERCLIP_API_KEY: 'not-forwarded', GH_TOKEN: 'not-forwarded' } });
  assert.equal(result.status, 'validated');
  assert.equal(f.state.writes.length, 0);
  assert.equal(fs.existsSync(f.runtime.privateDir), false);
  assert.equal(f.registry.getOperation('fixture/project'), null);
  for (const call of f.state.calls) {
    assert.equal(call.options.env.PAPERCLIP_API_KEY, undefined);
    assert.equal(call.options.env.GH_TOKEN, undefined);
    assert.equal(call.args.includes('--test'), false);
  }
});

test('Cloud access with an empty list or unrelated label does not prove repository mapping', async t => {
  const f = fixture(t);
  for (const tasks of [[], [{ environment_id: null, environment_label: 'other/project' }], [{ environment_id: 'b'.repeat(32), environment_label: 'fixture/project' }]]) {
    f.state.environmentTasks = tasks;
    const result = await f.bootstrap();
    assert.equal(result.status, 'needs_attention');
    assert.equal(result.validation.checks.find(row => row.name === 'cloud_environment').status, 'failed');
    assert.equal(f.state.writes.length, 0);
    assert.equal(f.registry.getOperation('fixture/project'), null);
  }
});

test('missing configured CI checks block setup without false readiness', async t => {
  const f = fixture(t, { ...input(), delivery: { requiredChecks: ['unit'] } });
  const result = await f.bootstrap();
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.validation.checks.find(row => row.name === 'github_required_checks').code, 'GITHUB_REQUIRED_CHECK_MISSING');
  assert.equal(f.state.writes.length, 0);
});

test('bootstrap persists binding and private contract, then repeated runs reuse exact resources', async t => {
  const f = fixture(t);
  const first = await f.bootstrap();
  assert.equal(first.status, 'configured');
  assert.equal(first.operation.data.projectId, PROJECT);
  assert.equal(first.operation.data.workspaceId, WORKSPACE);
  assert.equal(first.operation.data.agentId, AGENT);
  const dispatch = JSON.parse(fs.readFileSync(first.plan.dispatchConfigPath, 'utf8'));
  assert.equal(dispatch.mode, 'code_change');
  assert.equal(dispatch.companyId, COMPANY);
  assert.equal(dispatch.workspaceId, WORKSPACE);
  assert.equal(fs.statSync(first.plan.dispatchConfigPath).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(first.plan.taskContractPath)).delivery.requireHumanApproval, true);
  assert.equal(f.state.agents[0].runtimeConfig.heartbeat.enabled, false);
  assert.equal(f.state.agents[0].permissions.canCreateAgents, false);
  const second = await f.bootstrap();
  assert.equal(second.status, 'configured');
  assert.equal(second.operation.data.operationId, first.operation.data.operationId);
  assert.equal(f.state.writes.length, 3);
  assert.equal(f.state.calls.some(call => call.args.includes('exec')), false);
  assert.ok(second.outstandingGates.includes('global_concurrency'));
});

test('an ambiguous project creation is recovered by exact persisted marker without another POST', async t => {
  const f = fixture(t);
  f.state.failAfterProject = true;
  const first = await f.bootstrap();
  assert.equal(first.code, 'BOOTSTRAP_OUTCOME_UNKNOWN');
  assert.equal(first.operation.data.pending.kind, 'project');
  assert.equal(f.state.writes.length, 1);
  f.state.failAfterProject = false;
  const resumed = await f.bootstrap();
  assert.equal(resumed.status, 'configured');
  assert.equal(f.state.writes.filter(row => row.group === 'project').length, 1);
});

test('an unresolved creation never retries after absence, and same-name resources are not adopted', async t => {
  const f = fixture(t);
  f.state.failAfterProject = true;
  const first = await f.bootstrap();
  f.state.projects = [{ id: PROJECT, companyId: COMPANY, name: first.plan.project.name, description: 'unrelated', archivedAt: null }];
  f.state.failAfterProject = false;
  const second = await f.bootstrap();
  assert.equal(second.code, 'BOOTSTRAP_OUTCOME_UNKNOWN');
  assert.equal(f.state.writes.length, 1);
  assert.equal(second.operation.data.pending.kind, 'project');
});

test('cross-company resource and changed agent configuration fail closed', async t => {
  const f = fixture(t);
  await f.bootstrap();
  f.state.projects[0].companyId = '99999999-9999-4999-8999-999999999999';
  const scope = await f.bootstrap();
  assert.equal(scope.code, 'PAPERCLIP_SCOPE_MISMATCH');
  f.state.projects[0].companyId = COMPANY;
  f.state.agents[0].adapterConfig.args = ['/different/entrypoint'];
  const changed = await f.bootstrap();
  assert.equal(changed.code, 'BOOTSTRAP_RESOURCE_CHANGED');
  assert.equal(f.state.writes.length, 3);
});

test('native hire approval remains pending, without auto-approve or wake', async t => {
  const f = fixture(t); f.state.pending = true;
  const result = await f.bootstrap();
  assert.equal(result.status, 'approval_required');
  assert.equal(f.state.calls.some(call => call.args.includes('approve') || call.args.includes('wake')), false);
});

test('configuration conflicts and changed runtime bindings cannot silently replace private files', async t => {
  const f = fixture(t);
  const plan = buildOnboardingPlan({ registration: f.registration, companyId: COMPANY, runtime: f.runtime });
  fs.mkdirSync(path.dirname(plan.dispatchConfigPath), { recursive: true });
  fs.writeFileSync(plan.dispatchConfigPath, 'operator-owned');
  const conflict = await f.bootstrap();
  assert.equal(conflict.code, 'BOOTSTRAP_CONFIGURATION_CONFLICT');
  assert.equal(fs.readFileSync(plan.dispatchConfigPath, 'utf8'), 'operator-owned');
  assert.equal(f.state.agents.length, 0);
  await assert.rejects(f.bootstrap({ runtime: { ...f.runtime, codexCommand: '/different/codex' } }), { code: 'BOOTSTRAP_BINDING_CHANGED' });
});

test('a competing bootstrap cannot send a duplicate while the first creation is in flight', async t => {
  const f = fixture(t);
  let announce, release;
  const entered = new Promise(resolve => { announce = resolve; });
  const proceed = new Promise(resolve => { release = resolve; });
  const run = async (command, args, options) => {
    if (command === f.runtime.paperclipCommand && args[0] === 'project' && args[1] === 'create') { announce(); await proceed; }
    return f.run(command, args, options);
  };
  const first = f.bootstrap({ run });
  await entered;
  const competing = await f.bootstrap({ run });
  assert.equal(competing.code, 'BOOTSTRAP_OUTCOME_UNKNOWN');
  assert.equal(f.state.writes.length, 0);
  release();
  assert.equal((await first).status, 'configured');
  assert.equal(f.state.writes.filter(row => row.group === 'project').length, 1);
});

test('permission failures and credential-bearing diagnostics remain sanitized and never trigger writes', async t => {
  const f = fixture(t);
  const secret = 'credential-fixture-never-echo';
  const run = async (command, args, options) => command === f.runtime.githubCommand
    ? { code: 1, stdout: secret, stderr: secret }
    : f.run(command, args, options);
  const result = await f.bootstrap({ run });
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.validation.checks.find(row => row.name === 'github_repository').code, 'GITHUB_COMMAND_FAILED');
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(f.state.writes.length, 0);
});
