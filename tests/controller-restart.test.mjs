import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dispatchFromPaperclip } from '../lib/cloud-dispatch.mjs';
import { ExecutionJournal } from '../lib/execution-journal.mjs';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const ISSUE = '22222222-2222-4222-8222-222222222222';
const RUN = '33333333-3333-4333-8333-333333333333';
const PROJECT = '44444444-4444-4444-8444-444444444444';
const AGENT = '55555555-5555-4555-8555-555555555555';
const WORKSPACE = '66666666-6666-4666-8666-666666666666';
const USER = '77777777-7777-4777-8777-777777777777';
const CLOUD = 'task_e_0123456789abcdef0123456789abcdef';
const NOW = '2030-01-02T00:00:00.000Z';
const entrypoint = fileURLToPath(new URL('../scripts/controller-recovery.mjs', import.meta.url));
const project = { id: PROJECT, companyId: COMPANY, workspaces: [{ id: WORKSPACE, companyId: COMPANY, projectId: PROJECT, repoUrl: 'https://github.com/fixture/project.git', repoRef: 'main', isPrimary: true }] };
const initialIssue = { id: ISSUE, companyId: COMPANY, projectId: PROJECT, projectWorkspaceId: WORKSPACE, assigneeAgentId: AGENT, status: 'todo', title: 'Inspect the fixture README', description: 'Acceptance criteria: read the README without changing files.' };
const load = file => fs.readFile(file, 'utf8').then(JSON.parse);
async function save(file, value) { const temporary = file + '.parent.tmp'; await fs.writeFile(temporary, JSON.stringify(value)); await fs.rename(temporary, file); }
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-controller-restart-'));
  const children = [];
  t.after(async () => {
    for (const process of children) if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill('SIGKILL');
    await Promise.allSettled(children.map(process => process.completed));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const stateFile = path.join(directory, 'inert-remote.json');
  const command = path.join(directory, 'inert-cli.mjs');
  const clock = path.join(directory, 'clock.mjs');
  const configFile = path.join(directory, 'controller.json');
  const stateDir = path.join(directory, 'journal');
  await save(stateFile, { now: NOW, remoteStatus: 'pending', runStatus: 'running', issue: initialIssue, project, submissions: 0, listReads: 0, cards: [] });
  const source = `#!${process.execPath}
import fs from 'node:fs';
const file=${JSON.stringify(stateFile)}, a=process.argv.slice(2), s=JSON.parse(fs.readFileSync(file,'utf8'));
const save=()=>{const tmp=file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(s));fs.renameSync(tmp,file);};
const out=value=>process.stdout.write(JSON.stringify(value)+'\\n');
if(a[0]==='--version') process.stdout.write('codex-cli 0.166.0\\n');
else if(a[0]==='login') process.stderr.write('Logged in using ChatGPT\\n');
else if(a[0]==='cloud'&&a[1]==='exec'){s.submissions++;save();process.stdout.write('https://chatgpt.com/codex/tasks/${CLOUD}\\n');}
else if(a[0]==='cloud'&&a[1]==='list'){s.listReads++;save();out({tasks:[{id:${JSON.stringify(CLOUD)},url:'https://chatgpt.com/codex/tasks/${CLOUD}',status:s.remoteStatus,updated_at:'2029-12-31T00:00:00Z',environment_id:null,summary:{files_changed:0,lines_added:0,lines_removed:0}}],cursor:null});}
else if(a[0]==='whoami') out({userId:${JSON.stringify(USER)},companyIds:[${JSON.stringify(COMPANY)}]});
else if(a[0]==='run'&&a[1]==='get') out({id:${JSON.stringify(RUN)},companyId:${JSON.stringify(COMPANY)},agentId:${JSON.stringify(AGENT)},status:s.runStatus,contextSnapshot:{issueId:${JSON.stringify(ISSUE)}}});
else if(a[0]==='issue'&&a[1]==='get') out(s.issue);
else if(a[0]==='project'&&a[1]==='get') out(s.project);
else if(a[0]==='issue'&&a[1]==='interactions') out(s.cards);
else if(a[0]==='issue'&&a[1]==='interaction:create'){const payload=JSON.parse(a[a.indexOf('--payload-json')+1]);let card=s.cards.find(c=>c.idempotencyKey===payload.idempotencyKey);if(!card){card={...payload,id:'88888888-8888-4888-8888-888888888888',companyId:${JSON.stringify(COMPANY)},issueId:${JSON.stringify(ISSUE)},createdByUserId:${JSON.stringify(USER)},createdByAgentId:null};s.cards.push(card);save();}out(card);}
else {process.stderr.write('Unexpected inert CLI operation');process.exitCode=2;}
`;
  await fs.writeFile(command, source, { mode: 0o700 });
  // Advance wall time between processes without waiting for the production poll
  // interval. Native timers still run normally while each subprocess is alive.
  await fs.writeFile(clock, `import fs from 'node:fs';const RealDate=Date,start=RealDate.now(),file=${JSON.stringify(stateFile)};const current=()=>RealDate.parse(JSON.parse(fs.readFileSync(file,'utf8')).now)+RealDate.now()-start;globalThis.Date=class extends RealDate{constructor(...a){super(...(a.length?a:[current()]));}static now(){return current();}};`);
  const config = { schemaVersion: 1, companyId: COMPANY, stateDir, codexCommand: command, paperclipCommand: command, intervalMs: 15000, maxRecords: 1, maxPages: 1, commandTimeoutMs: 3000, leaseMs: 20000 };
  await save(configFile, config);
  return { directory, stateFile, command, clock, configFile, config, stateDir, children };
}
function controller(f, mode, extra = []) {
  const child = spawn(process.execPath, ['--import', f.clock, entrypoint, '--config', f.configFile, mode, ...extra], { stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [], watchers = [];
  let stdout = '', stderr = '', done;
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { done = { code, signal, lines, stderr }; resolve(done); for (const waiter of watchers.splice(0)) waiter.reject(new Error('Controller exited before expected report: ' + JSON.stringify(done))); });
  });
  child.stdout.on('data', chunk => {
    stdout += chunk;
    for (;;) {
      const end = stdout.indexOf('\n'); if (end < 0) break;
      const line = stdout.slice(0, end); stdout = stdout.slice(end + 1);
      if (!line.trim()) continue;
      let value; try { value = JSON.parse(line); } catch { continue; }
      lines.push(value);
      for (let i = watchers.length - 1; i >= 0; i--) if (watchers[i].predicate(value)) { watchers.splice(i, 1)[0].resolve(value); }
    }
  });
  child.stderr.on('data', chunk => stderr += chunk);
  const waitFor = predicate => {
    const existing = lines.find(predicate); if (existing) return Promise.resolve(existing);
    if (done) return Promise.reject(new Error('Controller already exited: ' + JSON.stringify(done)));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Controller report deadline: ' + stderr)), 20000);
      watchers.push({ predicate, resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    });
  };
  const handle = { child, completed, waitFor };
  f.children.push(handle);
  return handle;
}

test('dispatch, killed controller, and restart preserve the Cloud ID and submit exactly once', { timeout: 40000 }, async t => {
  const f = await fixture(t);
  let issue = { ...initialIssue };
  const request = async (url, options) => {
    const endpoint = new URL(url).pathname;
    let value;
    if (endpoint === '/api/agents/me') value = { id: AGENT, companyId: COMPANY };
    else if (endpoint === '/api/heartbeat-runs/' + RUN) value = { id: RUN, companyId: COMPANY, agentId: AGENT, status: 'running', contextSnapshot: { issueId: ISSUE } };
    else if (endpoint === '/api/projects/' + PROJECT) value = project;
    else if (endpoint === '/api/issues/' + ISSUE + '/checkout') value = issue = { ...issue, status: 'in_progress', checkoutRunId: RUN, executionRunId: RUN };
    else if (endpoint === '/api/issues/' + ISSUE) { if (options.method === 'PATCH') issue = { ...issue, ...JSON.parse(options.body) }; value = issue; }
    else throw new Error('Unexpected inert HTTP endpoint: ' + endpoint);
    return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  };
  const receipt = await dispatchFromPaperclip({ config: { schemaVersion: 1, companyId: COMPANY, projectId: PROJECT, workspaceId: WORKSPACE, repository: 'fixture/project', environmentId: 'a'.repeat(32), branch: 'main', mode: 'read_only', codexCommand: f.command },
    context: { apiUrl: 'http://127.0.0.1:8100', apiKey: 'INERT_FIXTURE_KEY', companyId: COMPANY, agentId: AGENT, runId: RUN }, stateDir: f.stateDir, request,
  });
  assert.equal(receipt.cloudTaskId, CLOUD);
  const state = await load(f.stateFile); state.issue = issue; state.runStatus = 'succeeded'; await save(f.stateFile, state);
  const first = controller(f, '--loop');
  t.after(async () => { if (first.child.exitCode === null && first.child.signalCode === null) first.child.kill('SIGKILL'); await first.completed; });
  const pending = await first.waitFor(value => value.reconciliation?.polled === 1);
  assert.equal(pending.reconciliation.ready, 0);
  first.child.kill('SIGKILL');
  const killed = await first.completed;
  assert.equal(killed.signal, 'SIGKILL');
  const before = new ExecutionJournal({ directory: f.stateDir, companyId: COMPANY });
  let executionId;
  try {
    const record = before.get(ISSUE); executionId = record.executionId;
    assert.equal(record.state, 'running'); assert.equal(record.cloudTaskId, CLOUD);
    assert.equal(before.observations(executionId).at(-1).status, 'pending');
  } finally { before.close(); }
  const remote = await load(f.stateFile); remote.remoteStatus = 'ready'; remote.now = '2030-01-02T00:01:00.000Z'; await save(f.stateFile, remote);
  const restarted = controller(f, '--once');
  t.after(async () => { if (restarted.child.exitCode === null && restarted.child.signalCode === null) restarted.child.kill('SIGKILL'); await restarted.completed; });
  const result = await restarted.completed;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.lines.at(-1).reconciliation.ready, 1);
  assert.equal(result.lines.at(-1).reconciliation.notified, 1);
  const after = new ExecutionJournal({ directory: f.stateDir, companyId: COMPANY });
  try {
    const record = after.get(ISSUE);
    assert.equal(record.executionId, executionId); assert.equal(record.cloudTaskId, CLOUD); assert.equal(record.state, 'succeeded');
    assert.equal(after.handoffs(executionId)[0].state, 'delivered');
    assert.deepEqual(after.observations(executionId).map(row => row.status), ['pending', 'ready']);
  } finally { after.close(); }
  const final = await load(f.stateFile);
  assert.equal(final.submissions, 1);
  assert.equal(final.listReads, 2);
  assert.equal(final.cards.length, 1);
  assert.equal(final.issue.status, 'blocked');
});

test('operator CLI resume survives process restart while preserving receipt and the company cooldown', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const config = { ...f.config, maxPollErrors: 2 }; await save(f.configFile, config);
  const identity = { companyId: COMPANY, paperclipIssueId: ISSUE, paperclipRunId: RUN, projectId: PROJECT, workspaceId: WORKSPACE, repository: 'fixture/project', environmentId: 'a'.repeat(32), branch: 'main', mode: 'read_only' };
  const journal = new ExecutionJournal({ directory: f.stateDir, companyId: COMPANY });
  let record;
  try {
    journal.queue(identity); journal.claim(ISSUE, RUN);
    record = journal.accept(ISSUE, RUN, { cloudTaskId: CLOUD, emittedUrl: 'https://chatgpt.com/codex/tasks/' + CLOUD, taskUrl: 'https://chatgpt.com/remote/' + CLOUD });
    const lease = journal.claimPoll(record.executionId, { ownerId: AGENT, now: NOW, leaseMs: 1000 });
    journal.recordObservation({ executionId: record.executionId, token: lease.token, expectedRevision: record.revision, now: NOW, nextPollAt: NOW, errorCount: 2, observation: { cloudTaskId: CLOUD, errorCode: 'CLOUD_CLI_FAILED' } });
    journal.deferProviderRequests({ now: NOW, delayMs: 900000 });
  } finally { journal.close(); }
  const state = await load(f.stateFile); state.issue.status = 'blocked'; state.runStatus = 'succeeded'; await save(f.stateFile, state);
  const first = controller(f, '--once'), paused = await first.completed;
  assert.equal(paused.code, 0, paused.stderr);
  assert.equal(paused.lines.at(-1).status, 'needs_attention');
  assert.equal(paused.lines.at(-1).recovery.needsAttention[0].reason, 'poll_retry_limit');
  const resume = controller(f, '--resume-poll', [record.executionId]), resumed = await resume.completed;
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(resumed.lines.at(-1).status, 'polling_resumed');
  assert.equal(resumed.lines.at(-1).executionId, record.executionId);
  const inspect = new ExecutionJournal({ directory: f.stateDir, companyId: COMPANY });
  try {
    assert.deepEqual(inspect.get(ISSUE), record);
    assert.equal(inspect.polling(record.executionId).errorCount, 0);
    assert.equal(inspect.providerRequestLimit().retryAt, '2030-01-02T00:15:00.000Z');
  } finally { inspect.close(); }
  const cooling = controller(f, '--once'), waiting = await cooling.completed;
  assert.equal(waiting.code, 0, waiting.stderr);
  assert.equal(waiting.lines.at(-1).status, 'recovering');
  assert.equal((await load(f.stateFile)).listReads, 0);
  const remote = await load(f.stateFile); remote.now = '2030-01-02T00:20:00.000Z'; remote.remoteStatus = 'ready'; await save(f.stateFile, remote);
  const final = controller(f, '--once'), completed = await final.completed;
  assert.equal(completed.code, 0, completed.stderr);
  assert.equal(completed.lines.at(-1).reconciliation.ready, 1);
  assert.equal(completed.lines.at(-1).reconciliation.notified, 1);
  const result = await load(f.stateFile);
  assert.equal(result.submissions, 0, 'Resetting read-only polling must never issue cloud exec');
  assert.equal(result.listReads, 1);
  assert.equal(result.cards.length, 1);
});
