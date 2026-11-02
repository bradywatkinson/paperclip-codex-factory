import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ExecutionJournal, JOURNAL_FILENAME, JOURNAL_APPLICATION_ID,
  JOURNAL_SCHEMA_VERSION, JOURNAL_MIGRATIONS,
} from '../lib/execution-journal.mjs';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const ISSUE = '22222222-2222-4222-8222-222222222222';
const RUN = '33333333-3333-4333-8333-333333333333';
const RUN2 = '44444444-4444-4444-8444-444444444444';
const PROJECT = '55555555-5555-4555-8555-555555555555';
const WORKSPACE = '66666666-6666-4666-8666-666666666666';
const CLOUD = 'task_e_0123456789abcdef0123456789abcdef';
const SECRET = 'Bearer pcp_board_TEST_CREDENTIAL_MUST_NEVER_ENTER_JOURNAL';
const identity = {
  companyId: COMPANY, paperclipIssueId: ISSUE, paperclipRunId: RUN,
  projectId: PROJECT, workspaceId: WORKSPACE, repository: 'fixture/project',
  environmentId: 'a'.repeat(32), branch: 'main', mode: 'read_only',
};
const receipt = {
  cloudTaskId: CLOUD, emittedUrl: 'https://chatgpt.com/codex/tasks/' + CLOUD,
  taskUrl: 'https://chatgpt.com/remote/' + CLOUD,
};
const moduleUrl = new URL('../lib/execution-journal.mjs', import.meta.url).href;

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-execution-journal-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
function open(directory) { return new ExecutionJournal({ directory, companyId: COMPANY }); }
async function withJournal(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'factory-execution-journal-'));
  const journal = open(directory);
  t.after(async () => { journal.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, journal };
}
function legacy(status = 'dispatched', patch = {}) {
  return {
    schemaVersion: 1, status, ...identity,
    createdAt: '2026-11-02T10:00:00.000Z',
    ...(status === 'dispatched' ? { ...receipt, dispatchedAt: '2026-11-02T10:00:02.000Z' } : {}),
    ...patch,
  };
}
async function legacyFile(directory, value) {
  const file = path.join(directory, ISSUE + '.json');
  await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value) + '\n', { mode: 0o600 });
  return file;
}
async function sqliteDoesNotContain(directory, forbidden) {
  for (const name of await fs.readdir(directory)) {
    if (name === JOURNAL_FILENAME || name.startsWith(JOURNAL_FILENAME + '-')) {
      assert.equal((await fs.readFile(path.join(directory, name))).includes(Buffer.from(forbidden)), false, 'Sensitive bytes persisted in ' + name);
    }
  }
}
async function waitFor(file, deadlineMs = 5000) {
  const until = Date.now() + deadlineMs;
  while (true) {
    try { await fs.access(file); return; }
    catch { if (Date.now() >= until) throw new Error('Child fixture did not reach its barrier'); }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function child(source, args, directory) {
  const processChild = spawn(process.execPath, ['--input-type=module', '-e', source, ...args], {
    env: { PATH: process.env.PATH, HOME: directory, TMPDIR: os.tmpdir() },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  processChild.stdout.on('data', chunk => { stdout += chunk; });
  processChild.stderr.on('data', chunk => { stderr += chunk; });
  const closed = new Promise(resolve => processChild.once('close', (code, signal) => resolve({ code, signal, stdout, stderr })));
  return { process: processChild, closed };
}

test('journal persists scoped mappings, schema, privacy and a queued attempt across reopen', async t => {
  const directory = await temporary(t);
  let journal = open(directory);
  const queued = journal.queue(identity);
  assert.equal(queued.state, 'queued');
  assert.equal(queued.attempt, 1);
  assert.equal(queued.schemaVersion, JOURNAL_SCHEMA_VERSION);
  assert.equal(typeof queued.executionId, 'string');
  assert.equal(queued.paperclipRunId, RUN);
  for (const key of ['companyId', 'paperclipIssueId', 'projectId', 'workspaceId', 'repository', 'environmentId', 'branch', 'mode']) assert.equal(queued[key], identity[key]);
  assert.ok(Number.isFinite(Date.parse(queued.createdAt)));
  assert.ok(Number.isFinite(Date.parse(queued.updatedAt)));
  journal.close();
  journal = open(directory);
  try {
    assert.equal(journal.get(ISSUE).executionId, queued.executionId);
    assert.equal(journal.queue({ ...identity, paperclipRunId: RUN2 }).executionId, queued.executionId);
    assert.equal(journal.get(ISSUE).paperclipRunId, RUN);
    assert.deepEqual(new Set(journal.runs(ISSUE).map(run => run.paperclipRunId)), new Set([RUN, RUN2]));
    assert.equal(journal.list().length, 1);
    assert.equal(journal.listNonterminal().length, 1);
  } finally { journal.close(); }
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(directory, JOURNAL_FILENAME))).mode & 0o777, 0o600);
});

test('claim is single-use, acceptance preserves the Cloud receipt and duplicate claims never resubmit', async t => {
  const { journal } = await withJournal(t);
  journal.queue(identity);
  const first = journal.claim(ISSUE, RUN);
  assert.equal(first.claimed, true);
  assert.equal(first.record.state, 'dispatching');
  const second = journal.claim(ISSUE, RUN2);
  assert.equal(second.claimed, false);
  assert.equal(second.record.executionId, first.record.executionId);
  const running = journal.accept(ISSUE, RUN, receipt);
  assert.equal(running.state, 'running');
  assert.equal(running.cloudTaskId, CLOUD);
  assert.equal(running.emittedUrl, receipt.emittedUrl);
  assert.equal(running.taskUrl, receipt.taskUrl);
  assert.equal(journal.claim(ISSUE, RUN2).claimed, false);
  assert.ok(journal.events(ISSUE).length >= 3);
  assert.ok(journal.runs(ISSUE).some(run => run.paperclipRunId === RUN || run.runId === RUN));
});

test('CAS state transitions reject stale writers and preserve immutable terminal attempts', async t => {
  const { journal } = await withJournal(t);
  journal.queue(identity); journal.claim(ISSUE, RUN);
  const running = journal.accept(ISSUE, RUN, receipt);
  assert.throws(() => journal.transition(ISSUE, { attempt: 1, expectedState: 'queued', expectedRevision: running.revision, toState: 'failed', errorCode: 'FIXTURE_FAILED' }));
  assert.throws(() => journal.transition(ISSUE, { attempt: 1, expectedState: 'running', expectedRevision: running.revision - 1, toState: 'failed', errorCode: 'FIXTURE_FAILED' }));
  const done = journal.transition(ISSUE, { attempt: 1, expectedState: 'running', expectedRevision: running.revision, toState: 'succeeded' });
  assert.equal(done.state, 'succeeded');
  assert.ok(done.revision > running.revision);
  assert.equal(journal.listNonterminal().length, 0);
  assert.throws(() => journal.transition(ISSUE, { attempt: 1, expectedState: 'succeeded', expectedRevision: done.revision, toState: 'running', ...receipt }));
  assert.equal(journal.get(ISSUE).state, 'succeeded');
});

test('later attempts require explicit sequential creation after terminal resolution', async t => {
  const { journal } = await withJournal(t);
  journal.queue(identity);
  assert.throws(() => journal.queue({ ...identity, attempt: 2, paperclipRunId: RUN2 }));
  let queued = journal.get(ISSUE);
  journal.transition(ISSUE, { attempt: 1, expectedState: 'queued', expectedRevision: queued.revision, toState: 'cancelled' });
  assert.throws(() => journal.queue({ ...identity, attempt: 3, paperclipRunId: RUN2 }));
  const next = journal.queue({ ...identity, attempt: 2, paperclipRunId: RUN2 });
  assert.equal(next.attempt, 2);
  assert.equal(next.state, 'queued');
  assert.notEqual(next.executionId, journal.get(ISSUE, 1).executionId);
});

test('ambiguous outcomes retain known Cloud IDs and cannot be claimed again', async t => {
  const { journal } = await withJournal(t);
  journal.queue(identity); journal.claim(ISSUE, RUN);
  const unknown = journal.markUnknown(ISSUE, RUN, 'DISPATCH_RECORDING_FAILED', receipt);
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.cloudTaskId, CLOUD);
  assert.equal(unknown.errorCode, 'DISPATCH_RECORDING_FAILED');
  assert.equal(journal.claim(ISSUE, RUN2).claimed, false);
  assert.throws(() => journal.queue({ ...identity, attempt: 2, paperclipRunId: RUN2 }));
  assert.throws(() => journal.transition(ISSUE, { attempt: 1, expectedState: 'unknown', expectedRevision: unknown.revision, toState: 'queued' }));
  assert.equal(journal.get(ISSUE).cloudTaskId, CLOUD);
});

test('interrupted dispatch recovery is sticky and does not become a new queued submission', async t => {
  const directory = await temporary(t);
  let journal = open(directory);
  journal.queue(identity); journal.claim(ISSUE, RUN); journal.close();
  journal = open(directory);
  try {
    const recovered = journal.recoverInterrupted(ISSUE);
    assert.equal(recovered.state, 'unknown');
    assert.equal(journal.claim(ISSUE, RUN2).claimed, false);
    assert.equal(journal.get(ISSUE).executionId, recovered.executionId);
  } finally { journal.close(); }
});

test('two actual processes racing for one queued attempt produce exactly one claimant', async t => {
  const directory = await temporary(t);
  const journal = open(directory); journal.queue(identity); journal.close();
  const source = `import fs from 'node:fs/promises';import {ExecutionJournal} from ${JSON.stringify(moduleUrl)};const[d,c,i,r]=process.argv.slice(1);const j=new ExecutionJournal({directory:d,companyId:c});await fs.writeFile(d+'/ready-'+r,'ready');while(true){try{await fs.access(d+'/go');break}catch{}await new Promise(r=>setTimeout(r,10))}const v=j.claim(i,r);j.close();console.log(JSON.stringify(v));`;
  const a = child(source, [directory, COMPANY, ISSUE, RUN], directory);
  const b = child(source, [directory, COMPANY, ISSUE, RUN2], directory);
  t.after(() => { a.process.kill('SIGKILL'); b.process.kill('SIGKILL'); });
  await Promise.all([waitFor(path.join(directory, 'ready-' + RUN)), waitFor(path.join(directory, 'ready-' + RUN2))]);
  await fs.writeFile(path.join(directory, 'go'), 'go');
  const results = await Promise.all([a.closed, b.closed]);
  assert.ok(results.every(result => result.code === 0), results.map(result => result.stderr).join('\n'));
  const claims = results.map(result => JSON.parse(result.stdout));
  assert.equal(claims.filter(result => result.claimed).length, 1);
  const reopened = open(directory);
  try { assert.equal(reopened.get(ISSUE).state, 'dispatching'); assert.equal(reopened.list().length, 1); }
  finally { reopened.close(); }
});

test('a killed process after durable claim cannot cause a second submission', async t => {
  const directory = await temporary(t);
  const journal = open(directory); journal.queue(identity); journal.close();
  const source = `import fs from 'node:fs/promises';import {ExecutionJournal} from ${JSON.stringify(moduleUrl)};const[d,c,i,r]=process.argv.slice(1);const j=new ExecutionJournal({directory:d,companyId:c});j.claim(i,r);await fs.writeFile(d+'/claimed','yes');setInterval(()=>{},10000);`;
  const proc = child(source, [directory, COMPANY, ISSUE, RUN], directory);
  t.after(() => proc.process.kill('SIGKILL'));
  await waitFor(path.join(directory, 'claimed'));
  proc.process.kill('SIGKILL');
  await proc.closed;
  const reopened = open(directory);
  try { assert.equal(reopened.claim(ISSUE, RUN2).claimed, false); assert.ok(['dispatching', 'unknown'].includes(reopened.get(ISSUE).state)); }
  finally { reopened.close(); }
});

test('legacy accepted guard imports once without altering source bytes or dispatching again', async t => {
  const directory = await temporary(t);
  const source = legacy(); const file = await legacyFile(directory, source);
  const bytes = await fs.readFile(file);
  let journal = open(directory);
  const imported = journal.importLegacyGuard(ISSUE);
  assert.equal(imported.state, 'running'); assert.equal(imported.attempt, 1);
  assert.equal(imported.cloudTaskId, CLOUD);
  assert.equal(journal.claim(ISSUE, RUN2).claimed, false);
  const executionId = imported.executionId;
  assert.equal(journal.importLegacyGuard(ISSUE).executionId, executionId);
  journal.close();
  journal = open(directory);
  try { assert.equal(journal.importLegacyGuard(ISSUE).executionId, executionId); assert.equal(journal.list().length, 1); }
  finally { journal.close(); }
  assert.deepEqual(await fs.readFile(file), bytes);
});

test('legacy dispatching/unknown guards stay ambiguous and retain any known receipt', async t => {
  for (const status of ['dispatching', 'unknown']) {
    const directory = await temporary(t);
    await legacyFile(directory, legacy(status, status === 'unknown' ? { ...receipt, errorCode: 'FIXTURE_FAILED' } : {}));
    const journal = open(directory);
    try {
      const record = journal.importLegacyGuard(ISSUE);
      assert.equal(record.state, 'unknown');
      if (status === 'unknown') assert.equal(record.cloudTaskId, CLOUD);
      assert.equal(journal.claim(ISSUE, RUN2).claimed, false);
    } finally { journal.close(); }
  }
});

test('legacy corruption and changed source fail closed without copying raw errors', async t => {
  const directory = await temporary(t);
  const file = await legacyFile(directory, SECRET);
  let journal = open(directory);
  assert.throws(() => journal.importLegacyGuard(ISSUE), error => !String(error).includes(SECRET));
  assert.equal(journal.list().length, 0);
  await sqliteDoesNotContain(directory, SECRET);
  journal.close();
  await legacyFile(directory, legacy());
  journal = open(directory); journal.importLegacyGuard(ISSUE);
  await fs.writeFile(file, JSON.stringify(legacy('dispatched', { createdAt: '2026-11-03T10:00:00.000Z' })));
  try { assert.throws(() => journal.importLegacyGuard(ISSUE)); assert.equal(journal.get(ISSUE).cloudTaskId, CLOUD); }
  finally { journal.close(); }
});

test('schema migration is transactional and rejects newer or foreign databases', async t => {
  const directory = await temporary(t);
  let db = new DatabaseSync(path.join(directory, JOURNAL_FILENAME));
  db.exec(JOURNAL_MIGRATIONS[0]);
  db.exec('PRAGMA application_id = ' + JOURNAL_APPLICATION_ID + '; PRAGMA user_version = 1;');
  db.close();
  const journal = open(directory); journal.queue(identity); journal.close();
  db = new DatabaseSync(path.join(directory, JOURNAL_FILENAME));
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, JOURNAL_SCHEMA_VERSION);
  db.exec('PRAGMA user_version = ' + (JOURNAL_SCHEMA_VERSION + 1)); db.close();
  assert.throws(() => open(directory));
  const foreign = await temporary(t);
  db = new DatabaseSync(path.join(foreign, JOURNAL_FILENAME)); db.exec('PRAGMA application_id = 123;'); db.close();
  assert.throws(() => open(foreign));
});

test('journal never persists unexpected identity fields or raw credential-bearing errors', async t => {
  const { directory, journal } = await withJournal(t);
  let record;
  try { record = journal.queue({ ...identity, apiKey: SECRET, prompt: SECRET, stdout: SECRET, stderr: SECRET }); }
  catch (error) { assert.ok(!String(error).includes(SECRET)); journal.queue(identity); }
  if (record) assert.ok(!JSON.stringify(record).includes(SECRET));
  journal.claim(ISSUE, RUN);
  try { journal.markUnknown(ISSUE, RUN, SECRET, { ...receipt, apiKey: SECRET, stderr: SECRET }); }
  catch (error) { assert.ok(!String(error).includes(SECRET)); }
  assert.ok(!JSON.stringify(journal.list()).includes(SECRET));
  assert.ok(!JSON.stringify(journal.events(ISSUE)).includes(SECRET));
  await sqliteDoesNotContain(directory, SECRET);
});

test('a new explicit attempt can claim while the immutable old-writer fence stays in place', async t => {
  const { directory, journal } = await withJournal(t);
  journal.queue(identity); journal.claim(ISSUE, RUN);
  const first = journal.accept(ISSUE, RUN, receipt);
  journal.transition(ISSUE, { attempt: 1, expectedState: 'running', expectedRevision: first.revision, toState: 'succeeded' });
  const fence = path.join(directory, ISSUE + '.json');
  const oldBytes = await fs.readFile(fence);
  const second = journal.queue({ ...identity, paperclipRunId: RUN2, attempt: 2 });
  assert.equal(second.attempt, 2);
  const claim = journal.claim(ISSUE, RUN2, 2);
  assert.equal(claim.claimed, true);
  assert.equal(claim.record.attempt, 2);
  assert.notEqual(claim.record.executionId, first.executionId);
  assert.deepEqual(await fs.readFile(fence), oldBytes);
  assert.equal(journal.claim(ISSUE, RUN, 2).claimed, false);
});

test('an uncommitted SQLite writer killed mid-transaction rolls back to the durable state', async t => {
  const directory = await temporary(t);
  const initial = open(directory); initial.queue(identity); initial.close();
  const source = `import fs from 'node:fs';import {ExecutionJournal} from ${JSON.stringify(moduleUrl)};const[d,c,i]=process.argv.slice(1);const j=new ExecutionJournal({directory:d,companyId:c});j.transaction(()=>{j.db.prepare("UPDATE executions SET state='dispatching' WHERE issue_id=?").run(i);fs.writeFileSync(d+'/uncommitted','yes');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);});`;
  const proc = child(source, [directory, COMPANY, ISSUE], directory);
  t.after(() => proc.process.kill('SIGKILL'));
  await waitFor(path.join(directory, 'uncommitted'));
  proc.process.kill('SIGKILL'); await proc.closed;
  const recovered = open(directory);
  try {
    assert.equal(recovered.get(ISSUE).state, 'queued');
    assert.equal(recovered.events(ISSUE).length, 1);
    assert.equal(recovered.claim(ISSUE, RUN2).claimed, true);
  } finally { recovered.close(); }
});

test('a crash after simulated remote acceptance preserves ambiguity without inventing a receipt', async t => {
  const directory = await temporary(t);
  const initial = open(directory); initial.queue(identity); initial.close();
  const source = `import fs from 'node:fs';import {ExecutionJournal} from ${JSON.stringify(moduleUrl)};const[d,c,i,r,id]=process.argv.slice(1);const j=new ExecutionJournal({directory:d,companyId:c});j.claim(i,r);fs.writeFileSync(d+'/remote-accepted',id);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);`;
  const proc = child(source, [directory, COMPANY, ISSUE, RUN, CLOUD], directory);
  t.after(() => proc.process.kill('SIGKILL'));
  await waitFor(path.join(directory, 'remote-accepted'));
  proc.process.kill('SIGKILL'); await proc.closed;
  assert.equal(await fs.readFile(path.join(directory, 'remote-accepted'), 'utf8'), CLOUD);
  const recovered = open(directory);
  try {
    const unknown = recovered.recoverInterrupted(ISSUE);
    assert.equal(unknown.state, 'unknown');
    assert.equal(unknown.cloudTaskId, undefined);
    assert.equal(recovered.claim(ISSUE, RUN2).claimed, false);
    assert.throws(() => recovered.queue({ ...identity, paperclipRunId: RUN2, attempt: 2 }));
  } finally { recovered.close(); }
});

test('lost journal plus an orphan compatibility fence imports unknown rather than submitting again', async t => {
  const directory = await temporary(t);
  let journal = open(directory);
  journal.queue(identity);
  const claimed = journal.claim(ISSUE, RUN).record;
  journal.close();
  const fence = path.join(directory, ISSUE + '.json');
  const original = await fs.readFile(fence);
  for (const name of await fs.readdir(directory)) {
    if (name === JOURNAL_FILENAME || name.startsWith(JOURNAL_FILENAME + '-')) await fs.rm(path.join(directory, name));
  }
  journal = open(directory);
  try {
    const imported = journal.importLegacyGuard(ISSUE);
    assert.equal(imported.state, 'unknown');
    assert.equal(imported.executionId, claimed.executionId);
    assert.equal(journal.claim(ISSUE, RUN2).claimed, false);
    assert.deepEqual(await fs.readFile(fence), original);
  } finally { journal.close(); }
});

function insertV1(db, patch = {}) {
  const record = {
    id: WORKSPACE, company_id: COMPANY, issue_id: ISSUE, attempt: 1,
    paperclip_run_id: RUN, project_id: PROJECT, workspace_id: WORKSPACE,
    repository: identity.repository, environment_id: identity.environmentId,
    branch: 'main', mode: 'read_only', state: 'running',
    cloud_task_id: CLOUD, emitted_url: receipt.emittedUrl, task_url: receipt.taskUrl,
    created_at: '2026-11-02T10:00:00.000Z', updated_at: '2026-11-02T10:00:02.000Z',
    dispatched_at: '2026-11-02T10:00:02.000Z', error_code: null,
    ...patch,
  };
  const columns = Object.keys(record);
  db.prepare('INSERT INTO executions(' + columns.join(',') + ') VALUES(' + columns.map(() => '?').join(',') + ')').run(...Object.values(record));
}

test('version-one migration preserves existing accepted work and seeds history/run associations', async t => {
  const directory = await temporary(t);
  const db = new DatabaseSync(path.join(directory, JOURNAL_FILENAME));
  db.exec(JOURNAL_MIGRATIONS[0]);
  insertV1(db);
  db.exec('PRAGMA application_id=' + JOURNAL_APPLICATION_ID + '; PRAGMA user_version=1;');
  db.close();
  const journal = open(directory);
  try {
    const imported = journal.get(ISSUE);
    assert.equal(imported.executionId, WORKSPACE);
    assert.equal(imported.state, 'running');
    assert.equal(imported.cloudTaskId, CLOUD);
    assert.equal(imported.dispatchedAt, '2026-11-02T10:00:02.000Z');
    assert.equal(journal.events(ISSUE).length, 1);
    assert.deepEqual(journal.runs(ISSUE).map(run => run.paperclipRunId), [RUN]);
    assert.equal(journal.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(journal.db.prepare('PRAGMA synchronous').get().synchronous, 2);
    assert.equal(journal.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  } finally { journal.close(); }
});

test('a failed schema migration leaves the old schema and data intact', async t => {
  const directory = await temporary(t);
  let db = new DatabaseSync(path.join(directory, JOURNAL_FILENAME));
  db.exec(JOURNAL_MIGRATIONS[0]);
  insertV1(db, { state: 'queued', cloud_task_id: null, emitted_url: null, task_url: null });
  insertV1(db, { id: RUN2, attempt: 2, state: 'queued', cloud_task_id: null, emitted_url: null, task_url: null });
  db.exec('PRAGMA application_id=' + JOURNAL_APPLICATION_ID + '; PRAGMA user_version=1;');
  db.close();
  assert.throws(() => open(directory));
  db = new DatabaseSync(path.join(directory, JOURNAL_FILENAME));
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM executions').get().n, 2);
    assert.ok(!db.prepare('PRAGMA table_info(executions)').all().some(column => column.name === 'revision'));
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='execution_events'").get().n, 0);
  } finally { db.close(); }
});

test('failed and cancelled terminal outcomes are explicit and remain immutable', async t => {
  for (const state of ['failed', 'cancelled']) {
    const { journal } = await withJournal(t);
    journal.queue(identity); journal.claim(ISSUE, RUN);
    const current = journal.accept(ISSUE, RUN, receipt);
    const terminal = journal.transition(ISSUE, {
      attempt: 1, expectedState: 'running', expectedRevision: current.revision,
      toState: state, errorCode: state === 'failed' ? 'OPERATOR_VERIFIED_FAILED' : 'OPERATOR_VERIFIED_CANCELLED',
    });
    assert.equal(terminal.state, state);
    assert.equal(journal.listNonterminal().length, 0);
    assert.throws(() => journal.accept(ISSUE, RUN, receipt));
    assert.throws(() => journal.markUnknown(ISSUE, RUN, 'DISPATCH_OUTCOME_UNKNOWN'));
    assert.equal(journal.get(ISSUE).state, state);
  }
});

test('wrong run ownership and duplicate Cloud receipt association reject without corrupting records', async t => {
  const { journal } = await withJournal(t);
  journal.queue(identity); journal.claim(ISSUE, RUN);
  assert.throws(() => journal.accept(ISSUE, RUN2, receipt));
  assert.throws(() => journal.markUnknown(ISSUE, RUN2, 'DISPATCH_OUTCOME_UNKNOWN'));
  assert.equal(journal.get(ISSUE).state, 'dispatching');
  journal.accept(ISSUE, RUN, receipt);
  const otherIssue = '88888888-8888-4888-8888-888888888888';
  journal.queue({ ...identity, paperclipIssueId: otherIssue, paperclipRunId: RUN2 });
  journal.claim(otherIssue, RUN2);
  assert.throws(() => journal.accept(otherIssue, RUN2, receipt));
  assert.equal(journal.get(otherIssue).state, 'dispatching');
  assert.equal(journal.get(otherIssue).cloudTaskId, undefined);
  assert.equal(journal.get(ISSUE).cloudTaskId, CLOUD);
});

test('batch legacy import is atomic for malformed files and conflicting Cloud associations', async t => {
  const directory = await temporary(t);
  const secondIssue = '88888888-8888-4888-8888-888888888888';
  const firstFile = await legacyFile(directory, legacy());
  const secondFile = path.join(directory, secondIssue + '.json');
  await fs.writeFile(secondFile, SECRET, { mode: 0o600 });
  const firstBytes = await fs.readFile(firstFile);
  const journal = open(directory);
  try {
    assert.throws(() => journal.importLegacyGuards(), error => !String(error).includes(SECRET));
    assert.equal(journal.list().length, 0);
    await fs.writeFile(secondFile, JSON.stringify(legacy('dispatched', { paperclipIssueId: secondIssue, paperclipRunId: RUN2 })));
    assert.throws(() => journal.importLegacyGuards());
    assert.equal(journal.list().length, 0);
    assert.equal(journal.events(ISSUE).length, 0);
    const cloud2 = 'task_e_fedcba9876543210fedcba9876543210';
    await fs.writeFile(secondFile, JSON.stringify(legacy('dispatched', {
      paperclipIssueId: secondIssue, paperclipRunId: RUN2,
      cloudTaskId: cloud2,
      emittedUrl: 'https://chatgpt.com/codex/tasks/' + cloud2,
      taskUrl: 'https://chatgpt.com/remote/' + cloud2,
    })));
    const imported = journal.importLegacyGuards();
    assert.equal(imported.length, 2);
    assert.equal(journal.list().length, 2);
    assert.deepEqual(journal.importLegacyGuards().map(record => record.executionId), imported.map(record => record.executionId));
    assert.deepEqual(await fs.readFile(firstFile), firstBytes);
    await sqliteDoesNotContain(directory, SECRET);
  } finally { journal.close(); }
});

test('legacy raw error text is sanitized in database and events while source remains untouched', async t => {
  const directory = await temporary(t);
  const file = await legacyFile(directory, legacy('unknown', { ...receipt, errorCode: SECRET, stderr: SECRET, apiKey: SECRET }));
  const before = await fs.readFile(file);
  const journal = open(directory);
  try {
    const record = journal.importLegacyGuard(ISSUE);
    assert.equal(record.state, 'unknown');
    assert.equal(record.errorCode, 'UNCLASSIFIED_ERROR');
    assert.equal(record.cloudTaskId, CLOUD);
    assert.ok(!JSON.stringify(record).includes(SECRET));
    assert.ok(!JSON.stringify(journal.events(ISSUE)).includes(SECRET));
    await sqliteDoesNotContain(directory, SECRET);
    assert.deepEqual(await fs.readFile(file), before);
  } finally { journal.close(); }
});

test('an old writer winning the file fence after queue is imported before any new claim', async t => {
  for (const status of ['dispatching', 'dispatched']) {
    const { directory, journal } = await withJournal(t);
    const queued = journal.queue(identity);
    const source = legacy(status, { paperclipRunId: RUN2 });
    const file = await legacyFile(directory, source);
    const original = await fs.readFile(file);
    assert.throws(() => journal.claim(ISSUE, RUN));
    assert.equal(journal.get(ISSUE).state, 'queued');
    const imported = journal.importLegacyGuard(ISSUE);
    assert.equal(imported.executionId, queued.executionId);
    assert.equal(imported.state, status === 'dispatched' ? 'running' : 'unknown');
    assert.equal(imported.paperclipRunId, RUN2);
    if (status === 'dispatched') assert.equal(imported.cloudTaskId, CLOUD);
    assert.deepEqual(new Set(journal.runs(ISSUE).map(run => run.paperclipRunId)), new Set([RUN, RUN2]));
    assert.equal(journal.importLegacyGuard(ISSUE).executionId, queued.executionId);
    assert.equal(journal.claim(ISSUE, RUN).claimed, false);
    assert.deepEqual(await fs.readFile(file), original);
    assert.equal(journal.list().length, 1);
  }
});

test('legacy files cannot overwrite an execution that has already been claimed or accepted', async t => {
  for (const state of ['dispatching', 'running']) {
    const { directory, journal } = await withJournal(t);
    journal.queue(identity); journal.claim(ISSUE, RUN);
    if (state === 'running') journal.accept(ISSUE, RUN, receipt);
    const existing = journal.get(ISSUE);
    await legacyFile(directory, legacy('dispatched', { paperclipRunId: RUN2 }));
    assert.throws(() => journal.importLegacyGuard(ISSUE));
    const preserved = journal.get(ISSUE);
    assert.equal(preserved.executionId, existing.executionId);
    assert.equal(preserved.state, existing.state);
    assert.equal(preserved.paperclipRunId, existing.paperclipRunId);
    assert.equal(preserved.revision, existing.revision);
  }
});
