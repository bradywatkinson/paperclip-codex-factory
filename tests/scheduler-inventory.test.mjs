import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { DispatchScheduler } from '../lib/dispatch-scheduler.mjs';
import { ExecutionJournal, JOURNAL_FILENAME } from '../lib/execution-journal.mjs';
import { inventoryJournalRoot } from '../lib/scheduler-inventory.mjs';

const COMPANY_A = '11111111-1111-4111-8111-111111111111';
const COMPANY_B = '22222222-2222-4222-8222-222222222222';
const OWNER = '33333333-3333-4333-8333-333333333333';
const PROJECT = '44444444-4444-4444-8444-444444444444';
const WORKSPACE = '55555555-5555-4555-8555-555555555555';
const CLOUD = 'task_e_' + 'a'.repeat(32);
const receipt = { cloudTaskId: CLOUD, emittedUrl: 'https://chatgpt.com/codex/tasks/' + CLOUD, taskUrl: 'https://chatgpt.com/remote/' + CLOUD };
const hash = filename => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
function fixture(t, limits = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-inventory-'));
  const root = path.join(directory, 'journals'); fs.mkdirSync(root);
  const scheduler = new DispatchScheduler({ directory: path.join(directory, 'scheduler'), limits: { maxGlobalActive: 1, maxRepositoryActive: 1, maxAttempts: 3, minDispatchIntervalMs: 0, ...limits } });
  t.after(() => { scheduler.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, root, scheduler };
}
function execution(root, companyId, { state = 'running', repository = 'fixture/project', attempt = 1, issueId = randomUUID(), knownCloudId = CLOUD } = {}) {
  const directory = path.join(root, companyId), journal = new ExecutionJournal({ directory, companyId });
  let record;
  try {
    record = journal.queue({ companyId, paperclipIssueId: issueId, paperclipRunId: OWNER, projectId: PROJECT, workspaceId: WORKSPACE, repository, environmentId: 'a'.repeat(32), branch: 'main', mode: 'code_change', attempt });
    if (state !== 'queued') record = journal.claim(issueId, OWNER, attempt).record;
    if (state === 'running' || state === 'succeeded') record = journal.accept(issueId, OWNER, { ...receipt, cloudTaskId: knownCloudId, emittedUrl: 'https://chatgpt.com/codex/tasks/' + knownCloudId, taskUrl: 'https://chatgpt.com/remote/' + knownCloudId }, attempt);
    if (state === 'unknown') record = journal.markUnknown(issueId, OWNER, 'INTERRUPTED_DISPATCH', undefined, attempt);
    if (state === 'succeeded') record = journal.transition(issueId, { attempt, expectedState: record.state, expectedRevision: record.revision, toState: 'succeeded' });
  } finally { journal.close(); }
  return { record, directory, filename: path.join(directory, JOURNAL_FILENAME), guard: path.join(directory, issueId + '.json') };
}
function edit(filename, sql, bindings = []) { const db = new DatabaseSync(filename); try { bindings.length ? db.prepare(sql).run(...bindings) : db.exec(sql); } finally { db.close(); } }

test('current schema-4 sibling-company work occupies the single account slot before new admission', t => {
  const f = fixture(t);
  const own = execution(f.root, COMPANY_A, { state: 'queued', repository: 'fixture/own' });
  const sibling = execution(f.root, COMPANY_B, { state: 'running', repository: 'fixture/sibling' });
  const result = inventoryJournalRoot({ directory: f.root, scheduler: f.scheduler });
  assert.deepEqual(result, { companyIds: [COMPANY_A, COMPANY_B], companies: 2, executions: 2, active: 1, queued: 1, terminal: 0 });
  assert.equal(f.scheduler.get(sibling.record.executionId).cloudTaskId, CLOUD);
  assert.equal(f.scheduler.claim(own.record.executionId, { ownerId: OWNER }).reason, 'GLOBAL_CAPACITY');
  assert.equal(f.scheduler.snapshot().activeCount, 1);
});

test('schema-3 metadata fails before migration, adoption, or repository registration writes', t => {
  const f = fixture(t);
  execution(f.root, COMPANY_A);
  const old = execution(f.root, COMPANY_B, { knownCloudId: 'task_e_' + 'b'.repeat(32) });
  edit(old.filename, 'PRAGMA user_version=3;');
  const before = hash(old.filename);
  assert.throws(() => inventoryJournalRoot({ directory: f.root, scheduler: f.scheduler }), { code: 'SCHEDULER_INVENTORY_MIGRATION_REQUIRED' });
  assert.equal(hash(old.filename), before);
  const db = new DatabaseSync(old.filename, { readOnly: true });
  try { assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3); } finally { db.close(); }
  assert.deepEqual(f.scheduler.list(), []); assert.deepEqual(f.scheduler.repositories(), []);
});

test('read-only inventory preserves the current journal and immutable guard bytes', t => {
  const f = fixture(t), current = execution(f.root, COMPANY_A);
  const before = { database: hash(current.filename), guard: hash(current.guard), files: fs.readdirSync(current.directory).sort() };
  inventoryJournalRoot({ directory: f.root, scheduler: f.scheduler });
  assert.equal(hash(current.filename), before.database); assert.equal(hash(current.guard), before.guard);
  // SQLite may create WAL/shared-memory bookkeeping even for a readOnly connection.
  // These sidecars do not authorize schema migration or execution-row writes.
  assert.deepEqual(fs.readdirSync(current.directory).filter(name => ![JOURNAL_FILENAME + '-wal', JOURNAL_FILENAME + '-shm'].includes(name)).sort(), before.files.filter(name => ![JOURNAL_FILENAME + '-wal', JOURNAL_FILENAME + '-shm'].includes(name)));
  assert.equal(fs.statSync(current.filename).mode & 0o777, 0o600);
});

test('unknown submissions without receipts remain occupied and repeated inventory does not release them', t => {
  const f = fixture(t), unknown = execution(f.root, COMPANY_B, { state: 'unknown' });
  inventoryJournalRoot({ directory: f.root, scheduler: f.scheduler });
  const first = f.scheduler.get(unknown.record.executionId);
  assert.equal(first.state, 'unknown'); assert.equal(first.cloudTaskId, null);
  inventoryJournalRoot({ directory: f.root, scheduler: f.scheduler });
  assert.deepEqual(f.scheduler.get(unknown.record.executionId), first);
  assert.equal(f.scheduler.snapshot().activeCount, 1);
});

test('terminal journal evidence releases only the matching original identity after later inventory', t => {
  const f = fixture(t), current = execution(f.root, COMPANY_A);
  inventoryJournalRoot({ directory: f.root, scheduler: f.scheduler });
  const journal = new ExecutionJournal({ directory: current.directory, companyId: COMPANY_A });
  try { journal.transition(current.record.paperclipIssueId, { expectedState: 'running', expectedRevision: current.record.revision, toState: 'succeeded' }); }
  finally { journal.close(); }
  const result = inventoryJournalRoot({ directory: f.root, scheduler: f.scheduler });
  assert.equal(result.terminal, 1); assert.equal(f.scheduler.get(current.record.executionId).state, 'succeeded');
  assert.equal(f.scheduler.snapshot().activeCount, 0);
});

test('previously managed repository ceilings are preserved during cross-company inventory', t => {
  const f = fixture(t, { maxGlobalActive: 3, maxRepositoryActive: 2 });
  f.scheduler.registerRepository({ repository: 'fixture/project', maxActive: 2, maxAttempts: 2 });
  execution(f.root, COMPANY_A);
  inventoryJournalRoot({ directory: f.root, scheduler: f.scheduler });
  const config = f.scheduler.repositories().find(item => item.repository === 'fixture/project');
  assert.equal(config.maxActive, 2); assert.equal(config.maxAttempts, 2);
});

test('a legacy UUID guard without a current journal prevents admission rather than being ignored', t => {
  const f = fixture(t);
  const directory = path.join(f.root, COMPANY_A); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, randomUUID() + '.json'), '{}');
  let admissionCalled = false;
  assert.throws(() => {
    inventoryJournalRoot({ directory: f.root, scheduler: f.scheduler });
    admissionCalled = true;
  }, { code: 'SCHEDULER_INVENTORY_UNREPRESENTED_GUARD' });
  assert.equal(admissionCalled, false); assert.deepEqual(f.scheduler.list(), []);
});

test('unrepresented or tampered guard identities block even when a schema-4 journal exists', t => {
  const f = fixture(t), current = execution(f.root, COMPANY_A);
  const raw = JSON.parse(fs.readFileSync(current.guard, 'utf8')); raw.journalExecutionId = randomUUID();
  fs.writeFileSync(current.guard, JSON.stringify(raw));
  assert.throws(() => inventoryJournalRoot({ directory: f.root, scheduler: f.scheduler }), { code: 'SCHEDULER_INVENTORY_UNREPRESENTED_GUARD' });
  assert.deepEqual(f.scheduler.list(), []);
});

test('an audited legacy guard is represented only with its original path/hash and execution identity', t => {
  const f = fixture(t), current = execution(f.root, COMPANY_A);
  const raw = JSON.parse(fs.readFileSync(current.guard, 'utf8')); delete raw.journalExecutionId;
  fs.writeFileSync(current.guard, JSON.stringify(raw));
  edit(current.filename, 'INSERT INTO legacy_imports VALUES(?,?,?,?)', [current.guard, hash(current.guard), current.record.executionId, current.record.createdAt]);
  assert.equal(inventoryJournalRoot({ directory: f.root, scheduler: f.scheduler }).active, 1);
  fs.appendFileSync(current.guard, '\n');
  assert.throws(() => inventoryJournalRoot({ directory: f.root, scheduler: f.scheduler }), { code: 'SCHEDULER_INVENTORY_UNREPRESENTED_GUARD' });
  assert.equal(f.scheduler.snapshot().activeCount, 1);
});

test('an execution-ID fence may first appear on attempt two after an unclaimed terminal attempt', t => {
  const f = fixture(t), directory = path.join(f.root, COMPANY_A);
  const journal = new ExecutionJournal({ directory, companyId: COMPANY_A });
  const issueId = randomUUID();
  const input = { companyId: COMPANY_A, paperclipIssueId: issueId, paperclipRunId: OWNER, projectId: PROJECT, workspaceId: WORKSPACE, repository: 'fixture/project', environmentId: 'a'.repeat(32), branch: 'main', mode: 'code_change' };
  let second;
  try {
    const first = journal.queue({ ...input, attempt: 1 });
    journal.transition(issueId, { expectedState: 'queued', expectedRevision: first.revision, toState: 'failed' });
    second = journal.queue({ ...input, attempt: 2 });
    journal.claim(issueId, OWNER, 2); journal.accept(issueId, OWNER, receipt, 2);
  } finally { journal.close(); }
  const guard = JSON.parse(fs.readFileSync(path.join(directory, issueId + '.json'), 'utf8'));
  assert.equal(guard.journalExecutionId, second.executionId);
  const result = inventoryJournalRoot({ directory: f.root, scheduler: f.scheduler });
  assert.equal(result.executions, 2); assert.equal(result.active, 1); assert.equal(result.terminal, 1);
  assert.equal(f.scheduler.get(second.executionId).attempt, 2);
  assert.equal(f.scheduler.get(second.executionId).state, 'submitted');
});

test('symlink roots, companies, journal files, and guards are rejected without following them', t => {
  const f = fixture(t), current = execution(f.root, COMPANY_A);
  const rootLink = path.join(f.directory, 'root-link'); fs.symlinkSync(f.root, rootLink);
  assert.throws(() => inventoryJournalRoot({ directory: rootLink, scheduler: f.scheduler }), { code: 'SCHEDULER_INVENTORY_UNSAFE_STORAGE' });
  const companyLink = path.join(f.root, COMPANY_B); fs.symlinkSync(current.directory, companyLink);
  assert.throws(() => inventoryJournalRoot({ directory: f.root, scheduler: f.scheduler }), { code: 'SCHEDULER_INVENTORY_UNSAFE_STORAGE' });
  fs.unlinkSync(companyLink);
  const savedGuard = current.guard + '.saved'; fs.renameSync(current.guard, savedGuard); fs.symlinkSync(savedGuard, current.guard);
  assert.throws(() => inventoryJournalRoot({ directory: f.root, scheduler: f.scheduler }), { code: 'SCHEDULER_INVENTORY_UNSAFE_STORAGE' });
  fs.unlinkSync(current.guard); fs.renameSync(savedGuard, current.guard);
  const savedDb = path.join(f.directory, 'saved.sqlite'); fs.renameSync(current.filename, savedDb); fs.symlinkSync(savedDb, current.filename);
  assert.throws(() => inventoryJournalRoot({ directory: f.root, scheduler: f.scheduler }), { code: 'SCHEDULER_INVENTORY_UNSAFE_STORAGE' });
  assert.deepEqual(f.scheduler.list(), []);
});

test('unknown root and company storage shapes fail closed instead of hiding executions', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'old-company-backup'));
  assert.throws(() => inventoryJournalRoot({ directory: f.root, scheduler: f.scheduler }), { code: 'SCHEDULER_INVENTORY_UNKNOWN_STORAGE_SHAPE' });
  fs.rmdirSync(path.join(f.root, 'old-company-backup'));
  const current = execution(f.root, COMPANY_A);
  fs.writeFileSync(path.join(current.directory, 'unrecognized-receipt.json'), '{}');
  assert.throws(() => inventoryJournalRoot({ directory: f.root, scheduler: f.scheduler }), { code: 'SCHEDULER_INVENTORY_UNKNOWN_STORAGE_SHAPE' });
  assert.deepEqual(f.scheduler.list(), []);
});

test('mismatched company identity and broken event state are rejected before adoption', t => {
  const f = fixture(t), current = execution(f.root, COMPANY_A);
  edit(current.filename, 'UPDATE executions SET company_id=?', [COMPANY_B]);
  assert.throws(() => inventoryJournalRoot({ directory: f.root, scheduler: f.scheduler }), { code: 'SCHEDULER_INVENTORY_INVALID_IDENTITY' });
  edit(current.filename, 'UPDATE executions SET company_id=?', [COMPANY_A]);
  edit(current.filename, "UPDATE execution_events SET to_state='unknown' WHERE revision=2");
  assert.throws(() => inventoryJournalRoot({ directory: f.root, scheduler: f.scheduler }), { code: 'SCHEDULER_INVENTORY_INCONSISTENT_JOURNAL' });
  assert.deepEqual(f.scheduler.list(), []);
});

test('wrong SQLite application and unreadable/corrupt journal fail with sanitized errors', t => {
  const f = fixture(t), current = execution(f.root, COMPANY_A);
  edit(current.filename, 'PRAGMA application_id=999;');
  assert.throws(() => inventoryJournalRoot({ directory: f.root, scheduler: f.scheduler }), { code: 'SCHEDULER_INVENTORY_MIGRATION_REQUIRED' });
  fs.writeFileSync(current.filename, 'credential-looking-fixture-never-copy');
  assert.throws(() => inventoryJournalRoot({ directory: f.root, scheduler: f.scheduler }), error => error.code === 'SCHEDULER_INVENTORY_UNREADABLE_JOURNAL' && !error.message.includes('credential-looking'));
  assert.deepEqual(f.scheduler.list(), []);
});

test('empty existing or definitively absent roots are safe, while dangling symlinks are not', t => {
  const f = fixture(t);
  assert.deepEqual(inventoryJournalRoot({ directory: f.root, scheduler: f.scheduler }), { companyIds: [], companies: 0, executions: 0, active: 0, queued: 0, terminal: 0 });
  const missing = path.join(f.directory, 'missing');
  assert.equal(inventoryJournalRoot({ directory: missing, scheduler: f.scheduler }).executions, 0);
  fs.symlinkSync(path.join(f.directory, 'nonexistent-target'), missing);
  assert.throws(() => inventoryJournalRoot({ directory: missing, scheduler: f.scheduler }), { code: 'SCHEDULER_INVENTORY_UNSAFE_STORAGE' });
});

test('empty company directories and oversized guards do not silently become empty inventories', t => {
  const f = fixture(t), directory = path.join(f.root, COMPANY_A); fs.mkdirSync(directory);
  assert.throws(() => inventoryJournalRoot({ directory: f.root, scheduler: f.scheduler }), { code: 'SCHEDULER_INVENTORY_JOURNAL_REQUIRED' });
  const current = execution(f.root, COMPANY_A);
  fs.writeFileSync(current.guard, ' '.repeat(65_537));
  assert.throws(() => inventoryJournalRoot({ directory: f.root, scheduler: f.scheduler }), { code: 'SCHEDULER_INVENTORY_INVALID_GUARD' });
  assert.deepEqual(f.scheduler.list(), []);
});
