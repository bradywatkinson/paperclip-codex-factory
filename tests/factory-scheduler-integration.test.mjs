import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { dispatchFromPaperclip } from '../lib/cloud-dispatch.mjs';
import { ExecutionJournal } from '../lib/execution-journal.mjs';
import { DispatchScheduler } from '../lib/dispatch-scheduler.mjs';

const BASE = 'a'.repeat(40);
const POLICY = { schemaVersion: 1, concurrency: { maxGlobalActive: 1, maxRepositoryActive: 1, maxAttempts: 3 } };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-scheduler-integration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  // Advance only the existing scheduler Date.now clock, with no waits or new
  // production clock hook. Journal creation timestamps remain real observations.
  const originalNow = Date.now;
  let clock = originalNow() + 60_000;
  Date.now = () => clock;
  t.after(() => { Date.now = originalNow; });
  const schedulerDirectory = path.join(directory, 'account');
  const lanes = [0, 1].map(index => {
    const companyId = randomUUID(), projectId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), workspaceId = randomUUID();
    const repository = 'fixture/' + (index ? 'b' : 'a'), environmentId = (index ? 'b' : 'a').repeat(32);
    const issue = { id: issueId, companyId, projectId, assigneeAgentId: agentId, status: 'todo', title: 'Implement one isolated fixture change', description: `Factory base SHA: ${BASE}\nChange the isolated fixture and report test evidence.` };
    const stateDir = path.join(directory, 'journals', companyId);
    const config = {
      schemaVersion: 1, companyId, projectId, workspaceId, repository, environmentId, branch: 'main', mode: 'code_change', codexCommand: process.execPath,
      schedulerDirectory, stateDirectory: stateDir, journalRootDirectory: path.join(directory, 'journals'), factoryPolicy: POLICY,
      factoryConfig: { schemaVersion: 1, repository, cloud: { environmentId }, commands: { test: { argv: ['node', '--test'], timeoutMs: 120000 } }, delivery: { requiredChecks: ['unit-tests'] }, concurrency: { maxActive: 1, maxAttempts: 3 } },
    };
    const lane = { companyId, projectId, agentId, issueId, workspaceId, repository, environmentId, stateDir, config, issue, apiCalls: [], commands: [], runs: new Map(), unknown: false, cloudTaskId: 'task_e_' + String(index + 1).padStart(32, '0') };
    lane.invoke = async () => {
      const runId = randomUUID();
      lane.runs.set(runId, 'running');
      const context = { apiUrl: 'http://127.0.0.1:8100', apiKey: 'FIXTURE_SCOPED_BEARER', companyId, agentId, runId };
      const request = async (url, options) => {
        const pathname = new URL(url).pathname, method = options.method ?? 'GET', body = options.body ? JSON.parse(options.body) : undefined;
        lane.apiCalls.push({ pathname, method, body });
        let value;
        if (pathname === '/api/agents/me') value = { id: agentId, companyId };
        else if (pathname.startsWith('/api/heartbeat-runs/')) {
          const requestedRun = pathname.split('/').at(-1);
          value = { id: requestedRun, companyId, agentId, status: lane.runs.get(requestedRun), contextSnapshot: { issueId } };
        } else if (pathname === '/api/projects/' + projectId) value = { id: projectId, companyId, workspaces: [{ id: workspaceId, companyId, projectId, repoUrl: 'https://github.com/' + repository, repoRef: 'main', isPrimary: true }] };
        else if (pathname === '/api/issues/' + issueId + '/checkout' && method === 'POST') {
          Object.assign(issue, { status: 'in_progress', executionRunId: runId, checkoutRunId: runId }); value = { ...issue };
        } else if (pathname === '/api/issues/' + issueId) {
          if (method === 'PATCH') Object.assign(issue, body);
          value = { ...issue };
        } else throw new Error('Unexpected fixture endpoint');
        return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
      };
      const run = async (command, args, options) => {
        lane.commands.push({ command, args, options });
        if (args[0] === '--version') return { code: 0, stdout: 'codex-cli 0.167.0\n', stderr: '' };
        if (args[0] === 'login') return { code: 0, stdout: '', stderr: 'Logged in using ChatGPT\n' };
        assert.equal(args[0], 'cloud'); assert.equal(args[1], 'exec');
        return lane.unknown ? { code: null, stdout: '', stderr: 'PRIVATE_FIXTURE_DIAGNOSTIC', timedOut: true } : { code: 0, stdout: 'https://chatgpt.com/codex/tasks/' + lane.cloudTaskId + '\n', stderr: '' };
      };
      try {
        const result = await dispatchFromPaperclip({ config: lane.config, context, stateDir, request, run });
        lane.runs.set(runId, 'succeeded'); return result;
      } catch (error) { lane.runs.set(runId, 'failed'); throw error; }
    };
    lane.record = () => {
      const journal = new ExecutionJournal({ directory: stateDir, companyId });
      try { return journal.get(issueId); } finally { journal.close(); }
    };
    lane.complete = () => {
      const journal = new ExecutionJournal({ directory: stateDir, companyId });
      try {
        const current = journal.get(issueId);
        return journal.transition(issueId, { expectedState: current.state, expectedRevision: current.revision, toState: 'succeeded' });
      } finally { journal.close(); }
    };
    lane.cloudExecs = () => lane.commands.filter(call => call.args[0] === 'cloud' && call.args[1] === 'exec');
    lane.patches = () => lane.apiCalls.filter(call => call.method === 'PATCH');
    return lane;
  });
  const withScheduler = action => {
    const scheduler = new DispatchScheduler({ directory: schedulerDirectory });
    try { return action(scheduler); } finally { scheduler.close(); }
  };
  return { directory, schedulerDirectory, lanes, withScheduler, advance: (milliseconds = 1001) => { clock += milliseconds; } };
}

test('two company dispatchers sharing an account admit one Cloud execution and retain the other as an unfenced queue', async t => {
  const f = fixture(t), [first, second] = f.lanes;
  const submitted = await first.invoke();
  assert.equal(submitted.status, 'dispatched');
  f.advance();
  const queued = await second.invoke();
  assert.equal(queued.status, 'queued_for_capacity');
  assert.equal(queued.schedulerReason, 'GLOBAL_CAPACITY');
  assert.notEqual(first.companyId, second.companyId);
  assert.equal(first.cloudExecs().length, 1); assert.equal(second.cloudExecs().length, 0);
  assert.equal(first.record().state, 'running'); assert.equal(second.record().state, 'queued');
  assert.equal(fs.existsSync(path.join(second.stateDir, second.issueId + '.json')), false);
  assert.equal(second.patches().length, 0); assert.equal(second.issue.status, 'in_progress');
  const snapshot = f.withScheduler(scheduler => scheduler.snapshot());
  assert.equal(snapshot.activeCount, 1); assert.equal(snapshot.queueDepth, 1);
  assert.equal(snapshot.knownCloudTaskIds[0], first.cloudTaskId);
});

test('terminal journal adoption frees the shared slot and resumes the original queued attempt exactly once', async t => {
  const f = fixture(t), [first, second] = f.lanes;
  await first.invoke(); f.advance();
  const queued = await second.invoke(), originalQueued = second.record();
  assert.equal(queued.status, 'queued_for_capacity');
  const terminal = first.complete();
  // The second company's next managed dispatch inventories the common journal
  // root and adopts the first company's terminal record before admission.
  assert.equal(f.withScheduler(scheduler => scheduler.snapshot()).activeCount, 1);
  f.advance();
  const dispatched = await second.invoke();
  assert.equal(dispatched.status, 'dispatched');
  assert.equal(dispatched.executionId, originalQueued.executionId);
  assert.equal(dispatched.attempt, 1);
  assert.equal(first.cloudExecs().length, 1); assert.equal(second.cloudExecs().length, 1);
  assert.equal(second.record().cloudTaskId, second.cloudTaskId);
  assert.equal(second.patches().length, 1);
  const reused = await first.invoke();
  assert.equal(reused.status, 'review_pending'); assert.equal(reused.executionId, terminal.executionId);
  assert.equal(f.withScheduler(scheduler => scheduler.snapshot()).activeCount, 1);
  assert.equal(f.withScheduler(scheduler => scheduler.snapshot()).queueDepth, 0);
});

test('unknown submission occupies account capacity across reopen and never permits a second dispatcher to execute', async t => {
  const f = fixture(t), [first, second] = f.lanes; first.unknown = true;
  await assert.rejects(first.invoke(), { code: 'DISPATCH_OUTCOME_UNKNOWN' });
  const unknown = first.record();
  assert.equal(unknown.state, 'unknown'); assert.equal(unknown.cloudTaskId, undefined);
  assert.equal(f.withScheduler(scheduler => scheduler.get(unknown.executionId)).state, 'unknown');
  f.advance(60_000);
  const firstQueue = await second.invoke();
  assert.equal(firstQueue.status, 'queued_for_capacity'); assert.equal(firstQueue.schedulerReason, 'GLOBAL_CAPACITY');
  const original = second.record();
  f.advance(24 * 60 * 60_000);
  const restartedQueue = await second.invoke();
  assert.equal(restartedQueue.status, 'queued_for_capacity');
  assert.equal(restartedQueue.executionId, original.executionId);
  assert.equal(first.cloudExecs().length, 1); assert.equal(second.cloudExecs().length, 0);
  assert.equal(second.patches().length, 0);
  assert.equal(fs.existsSync(path.join(second.stateDir, second.issueId + '.json')), false);
  const snapshot = f.withScheduler(scheduler => scheduler.snapshot());
  assert.equal(snapshot.counts.unknown, 1); assert.equal(snapshot.activeCount, 1); assert.equal(snapshot.queueDepth, 1);
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE_FIXTURE_DIAGNOSTIC'), false);
});

test('persisted account pause prevents Cloud submission and resumes the same queued execution after explicit unpause', async t => {
  const f = fixture(t), [first] = f.lanes;
  const seeded = new DispatchScheduler({ directory: f.schedulerDirectory, limits: POLICY.concurrency });
  seeded.setPaused(true); seeded.close();
  const paused = await first.invoke();
  assert.equal(paused.status, 'queued_for_capacity'); assert.equal(paused.schedulerReason, 'ACCOUNT_PAUSED');
  const queued = first.record(); assert.equal(queued.state, 'queued');
  assert.equal(first.cloudExecs().length, 0); assert.equal(first.patches().length, 0);
  assert.equal(fs.existsSync(path.join(first.stateDir, first.issueId + '.json')), false);
  f.withScheduler(scheduler => scheduler.setPaused(false));
  const resumed = await first.invoke();
  assert.equal(resumed.status, 'dispatched'); assert.equal(resumed.executionId, queued.executionId);
  assert.equal(first.cloudExecs().length, 1);
});

test('registered configuration requires one immutable base and dispatches the implementation role with configured gates', async t => {
  const f = fixture(t), [first] = f.lanes;
  first.issue.description = 'Implement a bounded change without an approved base.';
  await assert.rejects(first.invoke(), { code: 'FACTORY_TASK_BASE_REQUIRED' });
  assert.equal(first.commands.length, 0); assert.equal(fs.existsSync(first.stateDir), false);
  first.issue.description = `Factory base SHA: ${BASE}\nFactory base SHA: ${'b'.repeat(40)}\nAmbiguous bases must stop.`;
  await assert.rejects(first.invoke(), { code: 'FACTORY_TASK_BASE_REQUIRED' });
  assert.equal(first.commands.length, 0);
  first.issue.description = `Factory base SHA: ${BASE}\nImplement the bounded fixture change.`;
  assert.equal((await first.invoke()).status, 'dispatched');
  const cloud = first.cloudExecs()[0], prompt = cloud.args.at(-1);
  assert.match(prompt, /Role: implementer\./);
  assert.ok(prompt.includes(BASE));
  assert.ok(prompt.includes('"argv":["node","--test"]'));
  assert.ok(prompt.includes('"requiredChecks":["unit-tests"]'));
  assert.ok(prompt.includes('"requireIndependentReview":true'));
  assert.ok(prompt.includes('"requireHumanApproval":true'));
  assert.ok(prompt.includes('"autoMerge":false'));
  assert.equal(cloud.options.env.PAPERCLIP_API_KEY, undefined);
});
