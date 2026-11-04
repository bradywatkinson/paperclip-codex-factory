import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createPaperclipMcpServer, validatePaperclipMcpConfig } from '../lib/paperclip-mcp.mjs';
import { McpIntentStore } from '../lib/mcp-intents.mjs';

const COMPANY = '11111111-1111-4111-8111-111111111111', PROJECT = '22222222-2222-4222-8222-222222222222', AGENT = '33333333-3333-4333-8333-333333333333', OTHER = '44444444-4444-4444-8444-444444444444';
const PRIVATE = 'RAW_PRIVATE_FIXTURE_MUST_NOT_LEAK';
async function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-mcp-'));
  const config = { schemaVersion: 1, companyId: COMPANY, projectIds: [PROJECT], agentIds: [AGENT], paperclipCommand: '/fixture/paperclip', stateDir: path.join(directory, 'intents'), ...overrides };
  const existing = { id: randomUUID(), companyId: COMPANY, projectId: PROJECT, title: 'Existing scoped fixture', description: PRIVATE, identifier: 'FIX-1', status: 'backlog', assigneeAgentId: null, assigneeUserId: null, billingCode: null, createdByUserId: 'fixture-board', createdByAgentId: null };
  const state = { calls: [], issues: [existing], creates: 0, pauses: 0, failCreate: false, omitCreated: false, projectCompany: COMPANY, agentCompany: COMPANY, agentStatus: 'idle', commandFailure: false, createBarrier: null, runs: [{ id: randomUUID(), companyId: COMPANY, agentId: AGENT, status: 'succeeded', startedAt: '2026-11-03T12:00:00.000Z', finishedAt: '2026-11-03T12:00:01.000Z', stdout: PRIVATE, contextSnapshot: { secret: PRIVATE } }] };
  const run = async (command, args, options) => {
    state.calls.push({ command, args, options }); assert.equal(command, '/fixture/paperclip');
    assert.equal(args.includes('exec'), false); assert.equal(options.env.PAPERCLIP_API_KEY, undefined);
    assert.equal(options.env.OPENAI_API_KEY, undefined); assert.equal(options.env.PAPERCLIP_RUN_ID, undefined);
    if (state.commandFailure) return { code: 1, stdout: PRIVATE, stderr: PRIVATE };
    const [group, action, id] = args;
    const json = value => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
    if (group === 'project') return json({ id, companyId: state.projectCompany, archivedAt: null, secret: PRIVATE });
    if (group === 'whoami') return json({ userId: 'fixture-board', companyIds: [COMPANY], keyId: PRIVATE });
    if (group === 'agent' && action === 'configuration') return json({ id, companyId: state.agentCompany, status: state.agentStatus, adapterConfig: { env: { SECRET: PRIVATE } } });
    if (group === 'agent' && action === 'pause') { state.pauses++; state.agentStatus = 'paused'; return json({ id, companyId: state.agentCompany, status: 'paused', secret: PRIVATE }); }
    if (group === 'issue' && action === 'list') return json(state.issues);
    if (group === 'issue' && action === 'get') return json(state.issues.find(row => row.id === id));
    if (group === 'issue' && action === 'runs') return json(state.runs);
    if (group === 'issue' && action === 'create') {
      state.creates++;
      if (state.createBarrier) await state.createBarrier();
      const flag = name => args.some(value => value.startsWith(name + '=')) ? args.find(value => value.startsWith(name + '=')).slice(name.length + 1) : args.includes(name) ? args[args.indexOf(name) + 1] : null;
      const row = { id: randomUUID(), companyId: flag('--company-id'), projectId: flag('--project-id'), title: flag('--title'), description: flag('--description'), identifier: 'FIX-' + (state.issues.length + 1), status: flag('--status'), assigneeAgentId: flag('--assignee-agent-id'), assigneeUserId: null, billingCode: flag('--billing-code'), createdByUserId: 'fixture-board', createdByAgentId: null };
      if (!state.omitCreated) state.issues.push(row);
      return state.failCreate ? { code: null, stdout: '', stderr: PRIVATE, timedOut: true } : json(row);
    }
    throw new Error('Unexpected inert command');
  };
  let client, server;
  const connect = async () => {
    server = createPaperclipMcpServer({ config, run, env: { HOME: directory, PATH: process.env.PATH, PAPERCLIP_API_KEY: PRIVATE, OPENAI_API_KEY: PRIVATE, PAPERCLIP_RUN_ID: OTHER } });
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'factory-mcp-test', version: '1.0.0' });
    await server.connect(a); await client.connect(b);
  };
  await connect();
  t.after(async () => { await client.close(); await server.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    let data = result.structuredContent;
    if (!data) { try { data = JSON.parse(result.content.find(row => row.type === 'text').text); } catch { data = { code: 'MCP_SDK_INPUT_REJECTED' }; } }
    return { ...result, data };
  };
  const reopen = async () => { await client.close(); await server.close(); await connect(); };
  return { directory, config, state, existing, run, call, reopen, client: () => client };
}
const draft = () => ({ idempotencyKey: randomUUID(), projectId: PROJECT, title: 'Create an isolated draft', description: 'Acceptance: retain this draft for operator review.' });

test('configuration requires explicit company/project/agent scope and loopback-only trusted paths', () => {
  const good = { schemaVersion: 1, companyId: COMPANY, projectIds: [PROJECT], agentIds: [AGENT], paperclipCommand: '/fixture/pc', stateDir: '/fixture/intents' };
  assert.equal(validatePaperclipMcpConfig(good).allowAssignments, false);
  for (const patch of [{ companyId: undefined }, { projectIds: [] }, { agentIds: [] }, { agentIds: [AGENT, AGENT] }, { stateDir: 'relative' }, { apiBase: 'https://external.example' }, { apiBase: 'http://user:password@127.0.0.1:8100' }, { token: PRIVATE }, { allowAssignments: 'yes' }]) assert.throws(() => validatePaperclipMcpConfig({ ...good, ...patch }));
});

test('official SDK handshake exposes exactly five scoped tools and bounded safe summaries', async t => {
  const f = await fixture(t), tools = (await f.client().listTools()).tools;
  assert.deepEqual(tools.map(row => row.name).sort(), ['create_assignment', 'create_task_draft', 'list_tasks', 'pause_agent', 'view_runs']);
  const listed = await f.call('list_tasks', { projectId: PROJECT, limit: 1 });
  assert.equal(listed.isError, undefined); assert.equal(listed.data.tasks.length, 1);
  assert.equal(JSON.stringify(listed).includes(PRIVATE), false);
  const runs = await f.call('view_runs', { issueId: f.existing.id });
  assert.equal(runs.data.runs.length, 1); assert.equal(JSON.stringify(runs).includes(PRIVATE), false);
  assert.equal(fs.existsSync(f.config.stateDir), false, 'Read tools must not create mutation state');
});

test('draft creation is unassigned, literal argv, and idempotent after server restart', async t => {
  const f = await fixture(t), task = { ...draft(), title: '--assignee-agent-id=untrusted $(do-not-run) `text`', description: '--status=todo\nQuoted "text"\nwith newlines and acceptance criteria.' };
  const created = await f.call('create_task_draft', task);
  assert.equal(created.data.status, 'created'); assert.equal(created.data.task.status, 'backlog');
  assert.equal(created.data.task.assigneeAgentId, null); assert.equal(created.data.mayWakeCloud, false);
  const command = f.state.calls.find(row => row.args[0] === 'issue' && row.args[1] === 'create');
  assert.equal(command.args.includes('--assignee-agent-id'), false); assert.equal(command.args.includes('--comment'), false);
  assert.ok(command.args.includes('--description=' + task.description));
  assert.ok(command.args.includes('--title=' + task.title));
  await f.reopen();
  const repeated = await f.call('create_task_draft', { ...task, idempotencyKey: task.idempotencyKey.toUpperCase() });
  assert.equal(repeated.data.status, 'already_created'); assert.equal(repeated.data.task.id, created.data.task.id);
  assert.equal(f.state.creates, 1);
  assert.equal(fs.statSync(path.join(f.config.stateDir, 'mcp-intents.sqlite')).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(f.config.stateDir, 'mcp-intents.sqlite')).includes(Buffer.from(task.description)), false);
});

test('same idempotency key cannot create a different task or cross the draft/assignment boundary', async t => {
  const f = await fixture(t, { allowAssignments: true }), task = draft();
  await f.call('create_task_draft', task);
  const changed = await f.call('create_task_draft', { ...task, title: 'Different task' });
  assert.equal(changed.isError, true); assert.equal(changed.data.code, 'MCP_IDEMPOTENCY_CONFLICT');
  const assignment = await f.call('create_assignment', { ...task, agentId: AGENT, confirmAssignment: true });
  assert.equal(assignment.data.code, 'MCP_IDEMPOTENCY_CONFLICT'); assert.equal(f.state.creates, 1);
});

test('assignments require opt-in and per-call confirmation, then create only a NEW allowed assigned issue', async t => {
  const disabled = await fixture(t), input = { ...draft(), agentId: AGENT, confirmAssignment: true };
  assert.equal((await disabled.call('create_assignment', input)).data.code, 'MCP_ASSIGNMENTS_DISABLED');
  assert.equal(disabled.state.calls.length, 0);
  const enabled = await fixture(t, { allowAssignments: true });
  enabled.existing.status = 'done'; enabled.existing.assigneeUserId = 'human-owner';
  const rejected = await enabled.call('create_assignment', { ...input, confirmAssignment: false }); assert.equal(rejected.isError, true);
  const created = await enabled.call('create_assignment', input);
  assert.equal(created.data.status, 'created'); assert.equal(created.data.mayWakeCloud, true);
  assert.equal(created.data.task.status, 'todo'); assert.equal(created.data.task.assigneeAgentId, AGENT);
  assert.notEqual(created.data.task.id, enabled.existing.id);
  assert.equal(enabled.existing.status, 'done'); assert.equal(enabled.existing.assigneeUserId, 'human-owner');
  assert.equal(enabled.state.calls.some(row => row.args[0] === 'issue' && row.args[1] === 'update'), false);
});

test('project/agent allowlists, cross-company responses, extra fields and malformed IDs never mutate', async t => {
  const f = await fixture(t, { allowAssignments: true });
  for (const [name, input] of [['list_tasks', { projectId: OTHER }], ['create_task_draft', { ...draft(), projectId: OTHER }], ['create_assignment', { ...draft(), agentId: OTHER, confirmAssignment: true }], ['pause_agent', { agentId: OTHER }], ['create_assignment', { ...draft(), agentId: AGENT, confirmAssignment: true, issueId: f.existing.id }], ['list_tasks', { projectId: '../outside', companyId: OTHER }]]) assert.equal((await f.call(name, input)).isError, true);
  f.state.projectCompany = OTHER;
  assert.equal((await f.call('create_task_draft', draft())).data.code, 'MCP_COMPANY_SCOPE_MISMATCH');
  f.state.projectCompany = COMPANY; f.state.agentCompany = OTHER;
  assert.equal((await f.call('create_assignment', { ...draft(), agentId: AGENT, confirmAssignment: true })).data.code, 'MCP_COMPANY_SCOPE_MISMATCH');
  assert.equal(f.state.creates, 0); assert.equal(f.state.pauses, 0);
});

test('ambiguous creation is recovered by exact owned request/payload reads without another create', async t => {
  const f = await fixture(t), input = draft(); f.state.failCreate = true;
  const first = await f.call('create_task_draft', input);
  assert.equal(first.data.code, 'MCP_CREATE_OUTCOME_UNKNOWN'); assert.equal(f.state.creates, 1);
  await f.reopen(); f.state.failCreate = false;
  const recovered = await f.call('create_task_draft', input);
  assert.equal(recovered.data.status, 'recovered_existing'); assert.equal(f.state.creates, 1);
  assert.equal(recovered.data.task.id, f.state.issues.at(-1).id);
});

test('an absent or differently authored ambiguous creation never authorizes a retry', async t => {
  const f = await fixture(t), input = draft(); f.state.failCreate = true; f.state.omitCreated = true;
  await f.call('create_task_draft', input); f.state.failCreate = false;
  assert.equal((await f.call('create_task_draft', input)).data.code, 'MCP_CREATE_OUTCOME_UNKNOWN');
  f.state.issues.push({ ...f.existing, id: randomUUID(), title: input.title, description: input.description, billingCode: 'factory-mcp:' + input.idempotencyKey, createdByUserId: 'another-board-user' });
  assert.equal((await f.call('create_task_draft', input)).data.code, 'MCP_CREATE_OUTCOME_UNKNOWN');
  assert.equal(f.state.creates, 1);
});

test('concurrent same-key calls persist intent before any POST and cannot duplicate creation', async t => {
  const f = await fixture(t), input = draft(); let signal, release;
  const entered = new Promise(resolve => { signal = resolve; }), barrier = new Promise(resolve => { release = resolve; });
  f.state.createBarrier = async () => { signal(); await barrier; };
  const first = f.call('create_task_draft', input); await entered;
  const second = await f.call('create_task_draft', input);
  assert.equal(second.data.code, 'MCP_CREATE_OUTCOME_UNKNOWN'); assert.equal(f.state.creates, 1);
  release(); assert.equal((await first).data.status, 'created'); assert.equal(f.state.creates, 1);
});

test('confirmed create retries preserve subsequent human terminal status and ownership', async t => {
  const f = await fixture(t), input = draft(), created = await f.call('create_task_draft', input);
  const row = f.state.issues.find(issue => issue.id === created.data.task.id); row.status = 'done'; row.assigneeUserId = 'human-owner';
  const repeated = await f.call('create_task_draft', input);
  assert.equal(repeated.data.status, 'already_created'); assert.equal(repeated.data.task.status, 'done'); assert.equal(repeated.data.task.assignedToHuman, true);
  assert.equal(f.state.creates, 1); assert.equal(row.assigneeUserId, 'human-owner');
});

test('agent pause is scoped, reversible metadata only, and repeated pause does not repeat the write', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('pause_agent', { agentId: AGENT })).data.status, 'paused');
  assert.equal((await f.call('pause_agent', { agentId: AGENT })).data.status, 'already_paused');
  assert.equal(f.state.pauses, 1); assert.equal(f.state.creates, 0);
});

test('run/task reads cannot leak a foreign company, hidden agent, raw context, or diagnostics', async t => {
  const f = await fixture(t);
  f.state.issues.push({ ...f.existing, id: randomUUID(), assigneeAgentId: OTHER });
  assert.equal((await f.call('list_tasks', { projectId: PROJECT })).data.tasks.length, 1);
  f.state.runs[0].companyId = OTHER;
  assert.equal((await f.call('view_runs', { issueId: f.existing.id })).data.code, 'MCP_COMPANY_SCOPE_MISMATCH');
  f.state.commandFailure = true;
  const failure = await f.call('list_tasks', { projectId: PROJECT });
  assert.equal(failure.data.code, 'MCP_PAPERCLIP_COMMAND_FAILED'); assert.equal(JSON.stringify(failure).includes(PRIVATE), false);
});

test('intent store rejects symlink destinations and never stores task plaintext', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-mcp-intent-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const linked = path.join(directory, 'linked'); fs.symlinkSync(directory, linked);
  assert.throws(() => new McpIntentStore({ directory: linked }), { code: 'MCP_INTENT_STORAGE_UNSAFE' });
});

test('official SDK stdio client initializes real process, lists tools, calls safe fixture, and closes cleanly', { timeout: 10000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-mcp-stdio-'));
  const pc = path.join(directory, 'paperclip-fixture.mjs'), configPath = path.join(directory, 'config.json'), calls = path.join(directory, 'calls.jsonl');
  fs.writeFileSync(pc, `#!${process.execPath}\nimport fs from 'node:fs';const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');if(args[0]==='project')process.stdout.write(JSON.stringify({id:${JSON.stringify(PROJECT)},companyId:${JSON.stringify(COMPANY)}}));else if(args[0]==='issue'&&args[1]==='list')process.stdout.write('[]');else process.exit(2);\n`, { mode: 0o700 });
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, companyId: COMPANY, projectIds: [PROJECT], agentIds: [AGENT], paperclipCommand: pc, stateDir: path.join(directory, 'intents') }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('scripts/paperclip-mcp.mjs'), '--config', configPath], env: { HOME: directory, PATH: process.env.PATH }, stderr: 'pipe', maxBufferSize: 128000 });
  const client = new Client({ name: 'factory-stdio-integration-test', version: '1.0.0' });
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk; });
  t.after(async () => { await client.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 5);
  const output = await client.callTool({ name: 'list_tasks', arguments: { projectId: PROJECT } });
  assert.deepEqual(output.structuredContent.tasks, []);
  const invalid = await client.callTool({ name: 'create_assignment', arguments: { ...draft(), agentId: AGENT, confirmAssignment: true } });
  assert.equal(invalid.structuredContent.code, 'MCP_ASSIGNMENTS_DISABLED');
  assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 2);
  assert.equal(fs.existsSync(path.join(directory, 'intents')), false);
  await client.close();
  assert.equal(stderr.includes(PRIVATE), false);
});
