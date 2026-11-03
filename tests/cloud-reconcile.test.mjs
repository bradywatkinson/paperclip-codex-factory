import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ExecutionJournal } from '../lib/execution-journal.mjs';
import { parseCloudPage, reconcileOnce, validateReconcileConfig } from '../lib/cloud-reconcile.mjs';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const ISSUE = '22222222-2222-4222-8222-222222222222';
const RUN = '33333333-3333-4333-8333-333333333333';
const PROJECT = '44444444-4444-4444-8444-444444444444';
const AGENT = '55555555-5555-4555-8555-555555555555';
const WORKSPACE = '66666666-6666-4666-8666-666666666666';
const USER = '77777777-7777-4777-8777-777777777777';
const ENVIRONMENT = 'a'.repeat(32);
const CLOUD = 'task_e_0123456789abcdef0123456789abcdef';
const NOW = '2030-01-02T00:00:00.000Z';
const RECEIPT = { cloudTaskId: CLOUD, emittedUrl: 'https://chatgpt.com/codex/tasks/' + CLOUD, taskUrl: 'https://chatgpt.com/remote/' + CLOUD };
const IDENTITY = { companyId: COMPANY, paperclipIssueId: ISSUE, paperclipRunId: RUN, projectId: PROJECT, workspaceId: WORKSPACE, repository: 'fixture/project', environmentId: ENVIRONMENT, branch: 'main', mode: 'read_only' };
const RESULT = { code: 0, stdout: '', stderr: '', timedOut: false, outputExceeded: false, failedToStart: false, signal: null };

function cloudTask(patch = {}) {
  return { id: CLOUD, url: RECEIPT.emittedUrl, title: 'Read the README', status: 'ready', updated_at: '2030-01-01T23:59:00Z', environment_id: null, environment_label: 'fixture/project', summary: { files_changed: 0, lines_added: 0, lines_removed: 0 }, is_review: false, attempt_total: 1, ...patch };
}
function issue(patch = {}) {
  return { id: ISSUE, companyId: COMPANY, projectId: PROJECT, projectWorkspaceId: WORKSPACE, assigneeAgentId: AGENT, status: 'blocked', ...patch };
}
function project(patch = {}) {
  return { id: PROJECT, companyId: COMPANY, workspaces: [{ id: WORKSPACE, companyId: COMPANY, projectId: PROJECT, repoUrl: 'https://github.com/fixture/project.git', repoRef: 'main', isPrimary: true }], ...patch };
}
async function setup(t, patch = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-cloud-reconcile-'));
  const journal = new ExecutionJournal({ directory, companyId: COMPANY });
  journal.queue(IDENTITY);
  journal.claim(ISSUE, RUN);
  journal.accept(ISSUE, RUN, RECEIPT);
  t.after(async () => { journal.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const config = { schemaVersion: 1, companyId: COMPANY, stateDir: directory, codexCommand: '/fixture/codex', paperclipCommand: '/fixture/paperclip', ...patch };
  return { directory, journal, config, executionId: journal.get(ISSUE).executionId };
}
function fixture(options = {}) {
  const calls = [], comments = options.comments ?? [], pages = options.pages ?? [{ tasks: [cloudTask(options.task)], cursor: null }];
  let page = 0;
  const run = async (command, args, commandOptions) => {
    calls.push({ command, args, options: commandOptions });
    const done = value => ({ ...RESULT, stdout: JSON.stringify(value) });
    if (args[0] === '--version') return { ...RESULT, stdout: 'codex-cli ' + (options.version ?? '0.166.0') + '\n' };
    if (args[0] === 'login') return options.authResult ?? { ...RESULT, stderr: 'Logged in using ChatGPT\n' };
    if (args[0] === 'cloud' && args[1] === 'list') return options.cloudResult ?? done(pages[page++] ?? { tasks: [], cursor: null });
    if (args[0] === 'whoami') return done({ userId: USER, companyIds: [COMPANY], isInstanceAdmin: false, source: 'board_key' });
    if (args[0] === 'run' && args[1] === 'get') return done({ id: RUN, companyId: COMPANY, agentId: AGENT, status: 'succeeded', contextSnapshot: { issueId: ISSUE }, ...options.heartbeat });
    if (args[0] === 'issue' && args[1] === 'get') return done(issue(options.issue));
    if (args[0] === 'project' && args[1] === 'get') return done(project(options.project));
    if (args[0] === 'issue' && args[1] === 'comments') return done(comments);
    if (args[0] === 'issue' && args[1] === 'comment') {
      const body = args[args.indexOf('--body') + 1];
      const saved = { id: '88888888-8888-4888-8888-888888888888', issueId: ISSUE, authorUserId: USER, body, createdAt: NOW };
      if (options.saveComment !== false) comments.unshift(saved);
      return options.commentResult ?? done(saved);
    }
    throw new Error('Unexpected fixture command: ' + JSON.stringify(args));
  };
  return { calls, comments, run };
}
const cloudCalls = f => f.calls.filter(c => c.args[0] === 'cloud');
const commentCalls = f => f.calls.filter(c => c.args[0] === 'issue' && c.args[1] === 'comment');
function invoke(context, f, at = NOW) {
  let clock = Date.parse(at);
  return reconcileOnce({ config: context.config, journal: context.journal, run: f.run, now: () => new Date(clock).toISOString(), sleep: async ms => { clock += ms; }, env: { HOME: '/fixture/home', PATH: '/fixture/bin', PAPERCLIP_API_KEY: 'SECRET_DO_NOT_PROPAGATE', PAPERCLIP_RUN_ID: RUN } });
}

test('configuration is loopback only and has bounded worker settings', () => {
  const base = { schemaVersion: 1, companyId: COMPANY, stateDir: '/fixture/state', codexCommand: '/fixture/codex', paperclipCommand: '/fixture/paperclip' };
  assert.equal(validateReconcileConfig(base).apiBase, 'http://127.0.0.1:8100');
  for (const patch of [{ apiBase: 'https://example.com' }, { apiBase: 'http://127.0.0.1:8100/?token=secret' }, { maxPages: 0 }, { maxRecords: 0 }, { requestGapMs: 0 }, { codexCommand: 'codex' }, { paperclipCommand: 'paperclip' }, { companyId: '../company' }, { handoffMode: 'status' }]) assert.throws(() => validateReconcileConfig({ ...base, ...patch }));
});

test('Cloud pages accept nullable environments and reject malformed task identity', () => {
  assert.equal(parseCloudPage(JSON.stringify({ tasks: [cloudTask()], cursor: null })).tasks[0].id, CLOUD);
  for (const value of ['not json', '{}', JSON.stringify({ tasks: {}, cursor: null }), JSON.stringify({ tasks: [cloudTask({ id: '../task' })], cursor: null })]) assert.throws(() => parseCloudPage(value));
});

test('ready Cloud execution sends one review notification and preserves the Paperclip status', async t => {
  const context = await setup(t), f = fixture();
  const result = await invoke(context, f);
  assert.equal(result.ready, 1);
  assert.equal(result.notified, 1);
  assert.equal(context.journal.get(ISSUE).state, 'succeeded');
  assert.equal(context.journal.handoffs(context.executionId)[0].state, 'delivered');
  assert.equal(commentCalls(f).length, 1);
  assert.match(f.comments[0].body, /review/i);
  assert.ok(f.comments[0].body.includes(RECEIPT.taskUrl));
  assert.equal(f.calls.some(c => c.args[0] === 'issue' && c.args[1] === 'update'), false);
  assert.equal(f.calls.some(c => c.args.includes('exec')), false);
  await invoke(context, f, '2030-01-02T00:10:00.000Z');
  assert.equal(commentCalls(f).length, 1);
  for (const call of f.calls) {
    assert.equal(call.options.env.PAPERCLIP_API_KEY, undefined);
    assert.equal(call.options.env.PAPERCLIP_RUN_ID, undefined);
  }
});

test('pending tasks stay pollable without a Paperclip notification', async t => {
  const context = await setup(t), f = fixture({ task: { status: 'pending' } });
  await invoke(context, f);
  assert.equal(context.journal.get(ISSUE).state, 'running');
  assert.equal(commentCalls(f).length, 0);
  assert.equal(context.journal.handoffs(context.executionId).length, 0);
  assert.equal(context.journal.observations(context.executionId)[0].status, 'pending');
});

test('unknown provider status never becomes failed, cancelled, or succeeded', async t => {
  const context = await setup(t), f = fixture({ task: { status: 'cancelled' } });
  await invoke(context, f);
  assert.ok(['running', 'unknown'].includes(context.journal.get(ISSUE).state));
  assert.equal(commentCalls(f).length, 0);
  assert.ok(context.journal.observations(context.executionId)[0].errorCode);
});

test('provider errors preserve the receipt and defer polling with backoff', async t => {
  const context = await setup(t), f = fixture({ cloudResult: { ...RESULT, code: 1, timedOut: true, stderr: 'SECRET_PROVIDER_STDERR' } });
  await invoke(context, f);
  assert.equal(context.journal.get(ISSUE).cloudTaskId, CLOUD);
  assert.ok(['running', 'unknown'].includes(context.journal.get(ISSUE).state));
  const poll = context.journal.polling(context.executionId);
  assert.ok(poll.nextPollAt > NOW);
  await invoke(context, f);
  assert.equal(cloudCalls(f).length, 1);
  for (const name of await fs.readdir(context.directory)) {
    assert.equal((await fs.readFile(path.join(context.directory, name))).includes(Buffer.from('SECRET_PROVIDER_STDERR')), false);
  }
});

test('bounded pagination finds a later receipt and sends its review notification', async t => {
  const context = await setup(t), f = fixture({ pages: [{ tasks: [], cursor: 'second-page' }, { tasks: [cloudTask()], cursor: null }] });
  await invoke(context, f);
  assert.equal(cloudCalls(f).length, 2);
  assert.ok(cloudCalls(f)[1].args.includes('second-page'));
  assert.equal(commentCalls(f).length, 1);
});

test('pagination exhaustion leaves missing tasks unresolved', async t => {
  const context = await setup(t, { maxPages: 2 }), f = fixture({ pages: [{ tasks: [], cursor: 'p2' }, { tasks: [], cursor: 'p3' }] });
  await invoke(context, f);
  assert.equal(cloudCalls(f).length, 2);
  assert.ok(['running', 'unknown'].includes(context.journal.get(ISSUE).state));
  assert.equal(commentCalls(f).length, 0);
});

test('repeated cursors terminate bounded polling without guessing a missing task outcome', async t => {
  const context = await setup(t), f = fixture({ pages: [{ tasks: [], cursor: 'loop' }, { tasks: [], cursor: 'loop' }] });
  await invoke(context, f);
  assert.equal(cloudCalls(f).length, 2);
  assert.equal(context.journal.get(ISSUE).state, 'running');
  assert.equal(context.journal.observations(context.executionId)[0].errorCode, 'CLOUD_CURSOR_LOOP');
});

for (const task of [{ url: 'https://evil.example/' }, { environment_id: 'b'.repeat(32) }, { summary: { files_changed: -1, lines_added: 0, lines_removed: 0 } }]) test('changed Cloud binding or invalid summary stays unresolved: ' + Object.keys(task)[0], async t => {
  const context = await setup(t), f = fixture({ task });
  await invoke(context, f);
  assert.equal(context.journal.get(ISSUE).state, 'running');
  assert.equal(commentCalls(f).length, 0);
  assert.equal(context.journal.observations(context.executionId)[0].status, null);
});

test('unsupported CLI versions and non-ChatGPT authentication stop before list requests', async t => {
  for (const options of [{ version: '0.167.0' }, { authResult: { ...RESULT, stderr: 'Logged in using an API key\n' } }]) {
    const context = await setup(t), f = fixture(options);
    await invoke(context, f);
    assert.equal(cloudCalls(f).length, 0);
    assert.equal(context.journal.get(ISSUE).state, 'running');
    assert.ok(context.journal.observations(context.executionId)[0].errorCode);
  }
});

test('a provider response arriving after its poll lease cannot finish execution or notify', async t => {
  const context = await setup(t), f = fixture();
  let clock = Date.parse(NOW);
  const run = async (...args) => {
    const result = await f.run(...args);
    if (args[1][0] === 'cloud') clock += 121000;
    return result;
  };
  const result = await reconcileOnce({ config: context.config, journal: context.journal, run, now: () => new Date(clock).toISOString(), sleep: async ms => { clock += ms; }, env: {} });
  assert.equal(result.unresolved, 1);
  assert.equal(context.journal.get(ISSUE).state, 'running');
  assert.equal(context.journal.observations(context.executionId).length, 0);
  assert.equal(commentCalls(f).length, 0);
});

test('shutdown during a command prevents every subsequent subprocess and notification', async t => {
  for (const stopAt of ['--version', 'cloud']) {
    const context = await setup(t), f = fixture();
    let clock = Date.parse(NOW), stopped = false;
    const run = async (...args) => {
      assert.equal(stopped, false, 'A command started after shutdown');
      const result = await f.run(...args);
      if (args[1][0] === stopAt) stopped = true;
      return result;
    };
    await reconcileOnce({ config: context.config, journal: context.journal, run, now: () => new Date(clock).toISOString(), sleep: async ms => { clock += ms; }, shouldStop: () => stopped, env: {} });
    assert.equal(stopped, true);
    assert.equal(commentCalls(f).length, 0);
    assert.equal(f.calls.at(-1).args[0], stopAt);
  }
});

test('provider rate contention beyond the poll lease records a deferred outcome without listing', async t => {
  const context = await setup(t), f = fixture();
  let clock = Date.parse(NOW);
  const run = async (...args) => {
    const result = await f.run(...args);
    if (args[1][0] === 'login') {
      clock += 1000;
      // Another controller reserves the provider while this auth command returns.
      assert.equal(context.journal.reserveProviderRequest({ now: new Date(clock).toISOString(), minIntervalMs: 3600000 }).allowed, true);
    }
    return result;
  };
  const result = await reconcileOnce({ config: context.config, journal: context.journal, run, now: () => new Date(clock).toISOString(), sleep: async ms => { clock += ms; }, env: {} });
  assert.equal(result.unresolved, 1);
  assert.equal(cloudCalls(f).length, 0);
  assert.equal(context.journal.get(ISSUE).state, 'running');
  assert.equal(context.journal.observations(context.executionId)[0].errorCode, 'PROVIDER_RATE_LIMIT');
});

for (const status of ['done', 'cancelled']) test('human ' + status + ' status suppresses a ready notification', async t => {
  const context = await setup(t), f = fixture({ issue: { status } });
  const result = await invoke(context, f);
  assert.equal(commentCalls(f).length, 0);
  assert.equal(context.journal.get(ISSUE).state, 'succeeded');
  assert.equal(context.journal.handoffs(context.executionId)[0].state, 'skipped');
  assert.ok(result.skipped > 0);
});

test('changed task scope or assignment suppresses the review notification', async t => {
  const context = await setup(t), f = fixture({ issue: { assigneeAgentId: USER } });
  await invoke(context, f);
  assert.equal(commentCalls(f).length, 0);
  assert.notEqual(context.journal.handoffs(context.executionId)[0].state, 'delivered');
});

test('changed project repository or branch suppresses the review notification', async t => {
  for (const workspace of [{ repoUrl: 'https://github.com/fixture/different.git' }, { repoRef: 'different' }]) {
    const context = await setup(t), f = fixture({ project: { workspaces: [{ ...project().workspaces[0], ...workspace }] } });
    await invoke(context, f);
    assert.equal(commentCalls(f).length, 0);
    assert.equal(context.journal.handoffs(context.executionId)[0].state, 'skipped');
    assert.equal(context.journal.handoffs(context.executionId)[0].errorCode, 'PAPERCLIP_BINDING_CHANGED');
  }
});

test('an ambiguous notification write is never automatically retried', async t => {
  const context = await setup(t), f = fixture({ saveComment: false, commentResult: { ...RESULT, code: null, timedOut: true } });
  await invoke(context, f);
  assert.equal(commentCalls(f).length, 1);
  assert.equal(context.journal.handoffs(context.executionId)[0].state, 'unknown');
  await invoke(context, f, '2030-01-02T00:10:00.000Z');
  assert.equal(commentCalls(f).length, 1);
  assert.equal(context.journal.handoffs(context.executionId)[0].state, 'unknown');
});

test('a read-confirmed notification resolves an ambiguous write without another comment', async t => {
  const context = await setup(t), f = fixture({ commentResult: { ...RESULT, code: null, timedOut: true } });
  await invoke(context, f);
  assert.equal(commentCalls(f).length, 1);
  await invoke(context, f, '2030-01-02T00:10:00.000Z');
  assert.equal(commentCalls(f).length, 1);
  assert.equal(context.journal.handoffs(context.executionId)[0].state, 'delivered');
});

test('an identical comment from a different author cannot resolve an ambiguous write', async t => {
  const context = await setup(t), f = fixture({ commentResult: { ...RESULT, code: null, timedOut: true } });
  await invoke(context, f);
  f.comments[0].authorUserId = AGENT;
  await invoke(context, f, '2030-01-02T00:10:00.000Z');
  assert.equal(commentCalls(f).length, 1);
  assert.equal(context.journal.handoffs(context.executionId)[0].state, 'unknown');
});
