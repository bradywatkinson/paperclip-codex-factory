import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { RepositoryRegistry, configurationHash } from '../lib/repository-registry.mjs';
import { DispatchScheduler, SCHEDULER_FILENAME } from '../lib/dispatch-scheduler.mjs';
import { ExecutionJournal } from '../lib/execution-journal.mjs';
import { buildOnboardingPlan, buildRegisteredDispatchConfig } from '../lib/repository-onboarding.mjs';
import { runFactoryControllerCli } from '../scripts/factory-controller.mjs';
import { runFactoryCli } from '../scripts/factory.mjs';

const BASE = 'a'.repeat(40);
function setup(t, { queued = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-controller-cli-'));
  const registryDirectory = path.join(directory, 'registry');
  const fakePaperclip = path.join(directory, 'paperclip-fixture.mjs'), wakeFile = path.join(directory, 'wake-calls.jsonl'), modelFile = path.join(directory, 'fixture.json');
  const registry = new RepositoryRegistry({ directory: registryDirectory });
  const entries = [], calls = [], wakes = [], policy = { schemaVersion: 1, concurrency: { maxGlobalActive: 2, maxRepositoryActive: 1, maxAttempts: 3 } };
  const add = (number, { privateDir = path.join(directory, 'instance', 'onboarding'), selectedPolicy = policy } = {}) => {
    const companyId = randomUUID(), projectId = randomUUID(), workspaceId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), ownerId = randomUUID(), operationId = randomUUID();
    const runtime = { nodeCommand: process.execPath, paperclipCommand: fakePaperclip, codexCommand: path.join(directory, 'unused-codex'), githubCommand: path.join(directory, 'unused-gh'), factoryRoot: process.cwd(), privateDir, apiBase: 'http://127.0.0.1:8100' };
    const { registration } = registry.register({ schemaVersion: 1, repository: 'fixture/project-' + number, cloud: { environmentId: number.toString(16).repeat(32) }, commands: { test: { argv: ['node', '--test'] } } }, { sourcePath: path.join(directory, 'repo-' + number + '.factory.yaml'), policy: selectedPolicy });
    const plan = buildOnboardingPlan({ registration, companyId, runtime });
    registry.beginOperation(registration.repository, { expectedConfigHash: registration.configHash, state: 'configured', data: { companyId, operationId, planHash: configurationHash(plan), plan, projectId, workspaceId, agentId } });
    const config = buildRegisteredDispatchConfig({ registration, companyId, projectId, workspaceId, plan });
    fs.mkdirSync(path.dirname(plan.dispatchConfigPath), { recursive: true }); fs.writeFileSync(plan.dispatchConfigPath, JSON.stringify(config));
    const journal = new ExecutionJournal({ directory: plan.journalDirectory, companyId });
    const record = queued ? journal.queue({ companyId, paperclipIssueId: issueId, paperclipRunId: ownerId, projectId, workspaceId, repository: registration.repository, environmentId: config.environmentId, branch: 'main', mode: 'code_change' }) : null;
    journal.close();
    const entry = { registration, plan, config, runtime, companyId, projectId, workspaceId, agentId, issueId, ownerId, operationId, record, wakeId: randomUUID() };
    entries.push(entry); return entry;
  };
  const first = add(1);
  const response = (entry, args) => {
    if (args[0] === 'issue' && args[1] === 'get') return { id: entry.issueId, companyId: entry.companyId, projectId: entry.projectId, projectWorkspaceId: entry.workspaceId, assigneeAgentId: entry.agentId, assigneeUserId: null, status: 'in_progress', title: 'Fix an isolated fixture', description: `Factory base SHA: ${BASE}\nRun approved focused checks and return evidence.` };
    if (args[0] === 'run') return { id: args[2], companyId: entry.companyId, agentId: entry.agentId, status: 'succeeded', contextSnapshot: { issueId: entry.issueId } };
    if (args[0] === 'issue' && args[1] === 'live-runs') return [];
    if (args[0] === 'agent' && args[1] === 'configuration') return { id: entry.agentId, companyId: entry.companyId, status: 'idle', adapterType: 'process', adapterConfig: { command: entry.runtime.nodeCommand, args: [path.join(entry.runtime.factoryRoot, 'scripts/cloud-dispatch.mjs'), '--config', entry.plan.dispatchConfigPath], cwd: entry.runtime.factoryRoot, timeoutSec: 180, graceSec: 10 }, runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0, wakeOnDemand: true, maxConcurrentRuns: 1 } }, metadata: { factory: { registrationId: entry.operationId, repository: entry.registration.repository } } };
    if (args[0] === 'project') return { id: entry.projectId, companyId: entry.companyId, workspaces: [{ id: entry.workspaceId, companyId: entry.companyId, projectId: entry.projectId, repoUrl: 'https://github.com/' + entry.registration.repository, repoRef: 'main', defaultRef: 'main', isPrimary: true }] };
    if (args[0] === 'agent' && args[1] === 'wake') return { id: entry.wakeId, companyId: entry.companyId, agentId: entry.agentId, status: 'succeeded', contextSnapshot: { issueId: entry.issueId } };
    throw new Error('Unexpected inert fixture command');
  };
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(command, fakePaperclip); assert.equal(args.includes('exec'), false);
    assert.equal(options.env.PAPERCLIP_API_KEY, undefined);
    const entry = entries.find(row => [row.issueId, row.ownerId, row.agentId, row.projectId, row.wakeId].includes(args[2]));
    assert.ok(entry, 'Command must reference the configured fixture binding');
    if (args[0] === 'agent' && args[1] === 'wake') wakes.push({ entry, args });
    return { code: 0, stdout: JSON.stringify(response(entry, args)), stderr: '' };
  };
  const invoke = async ({ args = ['--once', '--registry', registryDirectory, '--json'], unified = false, runOverride = run } = {}) => {
    let stdout = '', stderr = '';
    const options = { stdout: value => { stdout += value; }, stderr: value => { stderr += value; }, run: runOverride };
    const code = await (unified ? runFactoryCli(['controller', ...args], options) : runFactoryControllerCli(args, options));
    return { code, stdout, stderr, result: JSON.parse(stdout.trim() || stderr.trim()) };
  };
  const materializeSubprocessFixture = () => {
    // The child runs only this inert executable. It neither calls Paperclip nor
    // invokes the real dispatcher/provider; all bindings live in temporary state.
    fs.writeFileSync(modelFile, JSON.stringify({ entries, responses: Object.fromEntries(entries.map(entry => [entry.companyId, { issue: response(entry, ['issue', 'get', entry.issueId]), owner: response(entry, ['run', 'get', entry.ownerId]), agent: response(entry, ['agent', 'configuration', entry.agentId]), project: response(entry, ['project', 'get', entry.projectId]), wake: response(entry, ['agent', 'wake', entry.agentId]) }])) }));
    fs.writeFileSync(fakePaperclip, `#!${process.execPath}\nimport fs from 'node:fs';
const model=JSON.parse(fs.readFileSync(${JSON.stringify(modelFile)},'utf8'));
const args=process.argv.slice(2),entry=model.entries.find(row=>[row.issueId,row.ownerId,row.agentId,row.projectId,row.wakeId].includes(args[2]));
if(!entry||process.env.PAPERCLIP_API_KEY){process.stderr.write('Invalid inert fixture scope');process.exit(2)}
const data=model.responses[entry.companyId];let value;
if(args[0]==='issue'&&args[1]==='get')value=data.issue;
else if(args[0]==='run')value={...data.owner,id:args[2]};
else if(args[0]==='issue'&&args[1]==='live-runs')value=[];
else if(args[0]==='agent'&&args[1]==='configuration')value=data.agent;
else if(args[0]==='project')value=data.project;
else if(args[0]==='agent'&&args[1]==='wake'){fs.appendFileSync(${JSON.stringify(wakeFile)},JSON.stringify({args})+'\\n');value=data.wake}
else{process.stderr.write('Unexpected inert fixture command');process.exit(2)}
process.stdout.write(JSON.stringify(value)+'\\n');\n`, { mode: 0o700 });
  };
  t.after(() => { registry.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, registryDirectory, registry, first, entries, add, calls, wakes, invoke, wakeFile, materializeSubprocessFixture };
}

test('controller CLI refuses absent registry database without creating replacement state', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-controller-cli-missing-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const missing = path.join(directory, 'absent-registry'); let stdout = '', stderr = '';
  const code = await runFactoryControllerCli(['--once', '--registry', missing, '--json'], { stdout: value => { stdout += value; }, stderr: value => { stderr += value; }, run: async () => { throw new Error('External call forbidden'); } });
  assert.equal(code, 1); assert.equal(JSON.parse(stderr).code, 'FACTORY_REGISTRY_NOT_FOUND');
  assert.equal(stdout, ''); assert.deepEqual(fs.readdirSync(directory), []);
});

test('unified controller once loads the concrete registration and preserves queued execution identity', async t => {
  const f = setup(t), output = await f.invoke({ unified: true });
  assert.equal(output.code, 0, output.stderr); assert.equal(output.result.status, 'running');
  assert.equal(output.result.companies[0].companyId, f.first.companyId);
  assert.equal(output.result.woken[0].executionId, f.first.record.executionId);
  assert.equal(output.result.woken[0].paperclipIssueId, f.first.issueId);
  assert.equal(f.wakes.length, 1);
  const journal = new ExecutionJournal({ directory: f.first.plan.journalDirectory, companyId: f.first.companyId });
  assert.equal(journal.get(f.first.issueId).executionId, f.first.record.executionId); assert.equal(journal.get(f.first.issueId).state, 'queued'); journal.close();
  const repeated = await f.invoke();
  assert.equal(repeated.code, 1); assert.equal(f.wakes.length, 1);
  assert.ok(repeated.result.needsAttention.some(row => row.code === 'FACTORY_WAKE_ALREADY_REQUESTED'));
  assert.equal(f.calls.some(row => row.args.includes('update') || row.args.includes('exec')), false);
});

test('initial scheduler uses registered policy and later explicitly lowered account limits do not break CLI startup', async t => {
  const f = setup(t, { queued: false }), schedulerPath = path.join(f.first.plan.schedulerDirectory, SCHEDULER_FILENAME);
  assert.equal(fs.existsSync(schedulerPath), false);
  const initial = await f.invoke(); assert.equal(initial.code, 0, initial.stderr); assert.equal(initial.result.status, 'idle');
  let scheduler = new DispatchScheduler({ directory: f.first.plan.schedulerDirectory });
  assert.equal(scheduler.settings().limits.maxGlobalActive, 2);
  const settings = scheduler.settings(); scheduler.configureLimits({ expectedRevision: settings.revision, limits: { ...settings.limits, maxGlobalActive: 1 } }); scheduler.close();
  const restarted = await f.invoke();
  assert.equal(restarted.code, 0, restarted.stderr);
  assert.equal(restarted.result.scheduler.settings.limits.maxGlobalActive, 1);
  assert.deepEqual(f.calls, []);
});

test('different account directories and an overriding scheduler path reject before wake or scheduler creation', async t => {
  const f = setup(t); f.add(2, { privateDir: path.join(f.directory, 'other-instance', 'onboarding') });
  const diverged = await f.invoke();
  assert.equal(diverged.code, 1); assert.equal(diverged.result.code, 'FACTORY_ACCOUNT_CONFIG_DIVERGED');
  for (const entry of f.entries) assert.equal(fs.existsSync(entry.plan.schedulerDirectory), false);
  assert.equal(f.calls.length, 0);
  const clean = setup(t), alternate = path.join(clean.directory, 'unrelated-account');
  const override = await clean.invoke({ args: ['--once', '--registry', clean.registryDirectory, '--scheduler', alternate, '--json'] });
  assert.equal(override.code, 1); assert.equal(override.result.code, 'FACTORY_ACCOUNT_CONFIG_DIVERGED');
  assert.equal(fs.existsSync(alternate), false); assert.equal(clean.calls.length, 0);
});

test('tampered bound registration and malformed modes remain attention without a wake', async t => {
  const f = setup(t), operation = f.registry.getOperation(f.first.registration.repository);
  f.registry.updateOperation(f.first.registration.repository, { expectedRevision: operation.revision, state: 'configured', data: { ...operation.data, planHash: 'f'.repeat(64) } });
  const invalid = await f.invoke();
  assert.equal(invalid.code, 1); assert.ok(invalid.result.needsAttention.some(row => row.code === 'FACTORY_REGISTRATION_NOT_CONFIGURED')); assert.equal(f.wakes.length, 0);
  for (const args of [['--once', '--loop', '--json'], ['--once', '--interval-ms', '1', '--json']]) {
    const usage = await f.invoke({ args }); assert.equal(usage.code, 1); assert.equal(usage.result.code, 'USAGE_FACTORY_CONTROLLER');
  }
});

async function childController(t, fixture, args) {
  const child = spawn(process.execPath, [path.resolve('scripts/factory-controller.mjs'), ...args], { env: { HOME: fixture.directory, PATH: process.env.PATH, TMPDIR: os.tmpdir(), PAPERCLIP_API_KEY: 'fixture-must-be-stripped' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', exited = false;
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise(resolve => child.once('close', (code, signal) => { exited = true; resolve({ code, signal, stdout, stderr }); }));
  t.after(async () => { if (!exited) { child.kill('SIGKILL'); await closed; } });
  const deadline = Date.now() + 15000;
  while (!stdout.includes('\n')) {
    if (exited) throw new Error('Fixture controller exited before observation: ' + stderr);
    if (Date.now() >= deadline) throw new Error('Fixture controller observation deadline exceeded');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return { child, closed, first: JSON.parse(stdout.split('\n')[0]) };
}

test('loop process handles SIGTERM and a restarted controller never repeats the durable wake', { timeout: 25000 }, async t => {
  const f = setup(t); f.materializeSubprocessFixture();
  const args = ['--loop', '--registry', f.registryDirectory, '--interval-ms', '15000', '--json'];
  const first = await childController(t, f, args);
  assert.equal(first.first.woken.length, 1);
  first.child.kill('SIGTERM'); const stopped = await first.closed;
  assert.equal(stopped.code, 0, stopped.stderr); assert.equal(stopped.signal, null);
  assert.equal(fs.readFileSync(f.wakeFile, 'utf8').trim().split('\n').length, 1);
  const restarted = await childController(t, f, args);
  assert.equal(restarted.first.woken.length, 0);
  assert.ok(restarted.first.needsAttention.some(row => row.code === 'FACTORY_WAKE_ALREADY_REQUESTED'));
  restarted.child.kill('SIGTERM'); const stoppedAgain = await restarted.closed;
  assert.equal(stoppedAgain.code, 0, stoppedAgain.stderr); assert.equal(stoppedAgain.signal, null);
  assert.equal(fs.readFileSync(f.wakeFile, 'utf8').trim().split('\n').length, 1);
  assert.equal(fs.existsSync(path.join(f.first.plan.schedulerDirectory, 'controller-wakes.sqlite')), true);
});
