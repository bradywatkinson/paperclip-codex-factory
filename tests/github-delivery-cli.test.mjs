import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { RepositoryRegistry } from '../lib/repository-registry.mjs';
import { ExecutionJournal, JOURNAL_FILENAME, JOURNAL_SCHEMA_VERSION } from '../lib/execution-journal.mjs';
import { runDeliveryCli } from '../scripts/github-delivery.mjs';
import { DeliveryArtifactStore } from '../lib/delivery-artifacts.mjs';
import { summarizeDeliveryPatch } from '../lib/github-delivery.mjs';

const COMPANY = '11111111-1111-4111-8111-111111111111', ISSUE = '22222222-2222-4222-8222-222222222222', RUN = '33333333-3333-4333-8333-333333333333', PROJECT = '44444444-4444-4444-8444-444444444444';
const BASE = 'a'.repeat(40), HEAD = 'b'.repeat(40), CLOUD = 'task_e_' + 'c'.repeat(32);
const PATCH = 'diff --git a/src/demo.mjs b/src/demo.mjs\nindex aaaaaaa..bbbbbbb 100644\n--- a/src/demo.mjs\n+++ b/src/demo.mjs\n@@ -1 +1 @@\n-export const result = 1;\n+export const result = 2;\n';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-delivery-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const registryDir = path.join(directory, 'registry'), stateDir = path.join(directory, 'journal'), artifactDir = path.join(directory, 'artifacts');
  const registry = new RepositoryRegistry({ directory: registryDir });
  const { registration } = registry.register({ schemaVersion: 1, repository: 'fixture/project', cloud: { environmentId: 'd'.repeat(32) }, commands: { test: { argv: ['node', '--test'] } }, delivery: { requiredChecks: ['unit'] } }, { sourcePath: path.join(directory, '.factory.yaml') });
  registry.close();
  const journal = new ExecutionJournal({ directory: stateDir, companyId: COMPANY });
  journal.queue({ companyId: COMPANY, paperclipIssueId: ISSUE, paperclipRunId: RUN, projectId: PROJECT, repository: 'fixture/project', environmentId: 'd'.repeat(32), branch: 'main', mode: 'code_change' });
  journal.claim(ISSUE, RUN);
  const accepted = journal.accept(ISSUE, RUN, { cloudTaskId: CLOUD, emittedUrl: 'https://chatgpt.com/codex/tasks/' + CLOUD, taskUrl: 'https://chatgpt.com/remote/' + CLOUD });
  const execution = journal.transition(ISSUE, { expectedState: 'running', expectedRevision: accepted.revision, toState: 'succeeded' });
  journal.close();
  const state = { calls: [], fail: false, ciPending: false };
  const json = value => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
  const run = async (command, args, options) => {
    state.calls.push({ command, args, options });
    if (state.fail) return { code: 1, stdout: 'PRIVATE_DIAGNOSTIC_NEVER_SAVE', stderr: 'PRIVATE_DIAGNOSTIC_NEVER_SAVE' };
    if (command === '/fixture/codex') {
      if (args[0] === '--version') return { code: 0, stdout: 'codex-cli 0.167.0\n', stderr: '' };
      if (args[0] === 'login') return { code: 0, stdout: '', stderr: 'Logged in using ChatGPT' };
      assert.deepEqual(args, ['cloud', 'diff', CLOUD, '--attempt', '1']);
      return { code: 0, stdout: PATCH, stderr: '' };
    }
    assert.equal(command, '/fixture/gh');
    assert.equal(args[args.indexOf('--method') + 1], 'GET');
    const resource = args.at(-1);
    if (resource.includes('/compare/')) return json({ base_commit: { sha: BASE }, merge_base_commit: { sha: BASE }, status: 'ahead', ahead_by: 1, behind_by: 0 });
    if (resource.includes('/check-runs?')) return json({ total_count: 1, check_runs: [{ id: 1, name: 'unit', head_sha: HEAD, status: state.ciPending ? 'queued' : 'completed', conclusion: state.ciPending ? null : 'success', html_url: 'https://github.com/fixture/project/actions/runs/1', app: { id: 42 } }] });
    if (resource.includes('/status?')) return json({ sha: HEAD, repository: { full_name: 'fixture/project' }, total_count: 0, statuses: [] });
    assert.equal(resource, 'repos/fixture/project/pulls/9');
    if (args.includes('Accept: application/vnd.github.diff')) return { code: 0, stdout: PATCH, stderr: '' };
    return json({ number: 9, html_url: 'https://github.com/fixture/project/pull/9', state: 'open', merged: false, draft: false, base: { ref: 'main', sha: BASE, repo: { full_name: 'fixture/project' } }, head: { ref: 'factory/demo', sha: HEAD, repo: { full_name: 'fixture/project' } }, changed_files: 1, additions: 1, deletions: 1 });
  };
  const args = ['--registry', registryDir, '--repository', 'fixture/project', '--state-dir', stateDir, '--company', COMPANY, '--issue', ISSUE, '--base', BASE, '--head', HEAD, '--pr', '9', '--artifact-dir', artifactDir, '--github', '/fixture/gh', '--codex', '/fixture/codex', '--json'];
  const invoke = async (argv = args, options = {}) => {
    let stdout = '', stderr = '';
    const code = await runDeliveryCli(argv, { run, now: () => '2026-11-03T12:00:00.000Z', stdout: value => { stdout += value; }, stderr: value => { stderr += value; }, ...options });
    return { code, stdout, stderr };
  };
  return { directory, registryDir, stateDir, artifactDir, registration, execution, state, args, invoke, run };
}

function notificationFixture(f) {
  const agentId = '55555555-5555-4555-8555-555555555555', state = { calls: [], cards: [], unknown: false, terminal: false };
  const output = value => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
  const run = async (command, args, options) => {
    if (command !== '/fixture/paperclip') return f.run(command, args, options);
    state.calls.push(args); assert.equal(args.at(-1), '--json');
    if (args[0] === 'whoami') return output({ userId: 'local-board', companyIds: [COMPANY] });
    if (args[0] === 'run') return output({ id: RUN, companyId: COMPANY, agentId, status: 'succeeded', contextSnapshot: { issueId: ISSUE } });
    if (args[0] === 'project') return output({ id: PROJECT, companyId: COMPANY, workspaces: [{ id: agentId, repoUrl: 'https://github.com/fixture/project', repoRef: 'main' }] });
    if (args[1] === 'get') return output({ id: ISSUE, companyId: COMPANY, projectId: PROJECT, assigneeAgentId: agentId, assigneeUserId: null, status: state.terminal ? 'done' : 'blocked' });
    if (args[1] === 'interactions') return output(state.cards);
    assert.equal(args[1], 'interaction:create');
    const payload = JSON.parse(args[args.indexOf('--payload-json') + 1]);
    const card = { id: agentId, companyId: COMPANY, issueId: ISSUE, createdByUserId: 'local-board', createdByAgentId: null, ...payload };
    state.cards.push(card);
    if (state.unknown) return { code: 1, stdout: '', stderr: 'PRIVATE_PAPERCLIP_DIAGNOSTIC' };
    return output(card);
  };
  const args = [...f.args, '--notify-paperclip', '--paperclip', '/fixture/paperclip', '--api-base', 'http://127.0.0.1:8100'];
  return { state, args, run };
}

test('optional notification projects the freshly inspected actual journal result into one native card', async t => {
  const f = setup(t), native = notificationFixture(f), output = await f.invoke(native.args, { run: native.run });
  assert.equal(output.code, 0, output.stderr); const result = JSON.parse(output.stdout); assert.equal(result.notification.status, 'notified');
  assert.equal(native.state.cards.length, 1); assert.match(native.state.cards[0].payload.detailsMarkdown, /Verified PR/);
  assert.match(native.state.cards[0].payload.detailsMarkdown, /actions\/runs\/1/); assert.equal(native.state.cards[0].continuationPolicy, 'none');
  assert.equal((await f.invoke(native.args, { run: native.run })).code, 0); assert.equal(native.state.cards.length, 1);
  f.state.ciPending = true; const pending = await f.invoke(native.args, { run: native.run }); assert.equal(pending.code, 1);
  assert.equal(JSON.parse(pending.stdout).notification.status, 'notified'); assert.equal(native.state.cards.length, 2); assert.match(native.state.cards[1].payload.detailsMarkdown, /CI_PENDING/);
  assert.equal(native.state.calls.some(args => args.includes('wake') || args.includes('update') || args.includes('comment')), false);
});

test('optional notification keeps ambiguous native sends sticky and recovers the same card by reads', async t => {
  const f = setup(t), native = notificationFixture(f); native.state.unknown = true;
  const first = await f.invoke(native.args, { run: native.run }); assert.equal(first.code, 1); assert.equal(JSON.parse(first.stdout).notification.status, 'notification_unknown');
  const second = await f.invoke(native.args, { run: native.run }); assert.equal(second.code, 0); assert.equal(JSON.parse(second.stdout).notification.status, 'notified');
  assert.equal(native.state.calls.filter(args => args[1] === 'interaction:create').length, 1); assert.equal(first.stdout.includes('PRIVATE_PAPERCLIP_DIAGNOSTIC'), false);
});

test('optional notification skips terminal native tasks and requires explicit safe CLI flags before provider reads', async t => {
  const f = setup(t), native = notificationFixture(f); native.state.terminal = true;
  const output = await f.invoke(native.args, { run: native.run }); assert.equal(JSON.parse(output.stdout).notification.status, 'skipped'); assert.equal(native.state.cards.length, 0);
  const before = f.state.calls.length;
  for (const extra of [ ['--notify-paperclip'], ['--paperclip', '/fixture/paperclip'], ['--notify-paperclip', '--paperclip', '/fixture/paperclip', '--api-base', 'https://example.invalid'], ['--notify-paperclip', '--paperclip', '/fixture/paperclip', '--api-base', 'http://127.0.0.1:8100/path'] ]) {
    const invalid = await f.invoke([...f.args, ...extra], { run: native.run }); assert.equal(invalid.code, 1); assert.match(invalid.stderr, /USAGE_GITHUB_DELIVERY/);
  }
  assert.equal(f.state.calls.length, before);
});

test('CLI durably associates actual journal execution, immutable GitHub provenance and captured patch', async t => {
  const f = setup(t), output = await f.invoke();
  assert.equal(output.code, 0, output.stderr);
  const result = JSON.parse(output.stdout);
  assert.equal(result.status, 'ready_for_independent_review');
  assert.equal(result.association.executionId, f.execution.executionId);
  assert.equal(result.association.paperclipIssueId, ISSUE);
  assert.equal(result.association.cloudTaskId, CLOUD);
  assert.equal(result.provenance.headSha, HEAD);
  assert.equal(result.humanApprovalEligible, false);
  assert.equal(output.stdout.includes('export const result'), false);
  const observationBytes = fs.readFileSync(result.artifacts.observationPath);
  assert.equal(digest(observationBytes), result.artifacts.observationSha256);
  const observation = JSON.parse(observationBytes);
  assert.equal(observation.delivery.association.executionId, f.execution.executionId);
  assert.equal(observation.context.configHash, f.registration.configHash);
  assert.equal(observation.context.policyHash, f.registration.policyHash);
  assert.equal(observation.context.journalSchemaVersion, JOURNAL_SCHEMA_VERSION);
  assert.equal(observation.context.executionRevision, f.execution.revision);
  assert.equal(fs.readFileSync(result.artifacts.patchPath, 'utf8'), PATCH);
  assert.equal(digest(PATCH), result.artifacts.patchSha256);
  for (const filename of [result.artifacts.patchPath, result.artifacts.observationPath]) assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.artifactDir).mode & 0o777, 0o700);
  const again = JSON.parse((await f.invoke()).stdout);
  assert.equal(again.artifacts.patchPath, result.artifacts.patchPath);
  assert.notEqual(again.artifacts.observationId, result.artifacts.observationId);
  const journal = new ExecutionJournal({ directory: f.stateDir, companyId: COMPANY });
  assert.deepEqual(journal.get(ISSUE), f.execution); journal.close();
  assert.equal(f.state.calls.some(call => call.args.includes('exec')), false);
});

test('missing PR permits no guessed head and captures a non-ready patch fallback', async t => {
  const f = setup(t), args = f.args.filter((value, index, all) => !['--head', '--pr'].includes(value) && !['--head', '--pr'].includes(all[index - 1]));
  const output = await f.invoke(args);
  assert.equal(output.code, 1);
  const result = JSON.parse(output.stdout);
  assert.equal(result.status, 'patch_fallback');
  assert.equal(result.association.expectedHeadSha, undefined);
  assert.equal(result.provenance.verified, false);
  assert.equal(result.checks.state, 'unverified');
  assert.equal(fs.readFileSync(result.artifacts.patchPath, 'utf8'), PATCH);
});

test('pending CI is persisted as attention with actionable links and a nonzero exit', async t => {
  const f = setup(t); f.state.ciPending = true;
  const output = await f.invoke();
  assert.equal(output.code, 1);
  const result = JSON.parse(output.stdout);
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.checks.state, 'pending');
  assert.deepEqual(result.checks.required[0].links, ['https://github.com/fixture/project/actions/runs/1']);
  const saved = JSON.parse(fs.readFileSync(result.artifacts.observationPath));
  assert.equal(saved.delivery.checks.state, 'pending');
});

test('missing journal or registry fails before creating replacement state or making remote calls', async t => {
  const f = setup(t);
  for (const [flag, suffix, code] of [['--state-dir', 'absent-journal', 'DELIVERY_JOURNAL_NOT_FOUND'], ['--registry', 'absent-registry', 'DELIVERY_REGISTRY_NOT_FOUND']]) {
    const args = [...f.args], missing = path.join(f.directory, suffix); args[args.indexOf(flag) + 1] = missing;
    const output = await f.invoke(args);
    assert.equal(output.code, 1); assert.equal(JSON.parse(output.stderr).code, code);
    assert.equal(fs.existsSync(missing), false);
    assert.equal(fs.existsSync(f.artifactDir), false);
  }
  assert.equal(f.state.calls.length, 0);
});

test('journal schema mismatch requires explicit migration and leaves journal unchanged', async t => {
  const f = setup(t), filename = path.join(f.stateDir, JOURNAL_FILENAME);
  const db = new DatabaseSync(filename); db.exec('PRAGMA user_version=3'); db.close();
  const output = await f.invoke();
  assert.equal(JSON.parse(output.stderr).code, 'DELIVERY_JOURNAL_MIGRATION_REQUIRED');
  const inspected = new DatabaseSync(filename, { readOnly: true });
  assert.equal(inspected.prepare('PRAGMA user_version').get().user_version, 3); inspected.close();
  assert.equal(f.state.calls.length, 0);
  assert.equal(fs.existsSync(f.artifactDir), false);
});

test('wrong company/issue cannot substitute arbitrary execution JSON or reach provider reads', async t => {
  const f = setup(t);
  for (const flag of ['--company', '--issue']) {
    const args = [...f.args]; args[args.indexOf(flag) + 1] = '99999999-9999-4999-8999-999999999999';
    const output = await f.invoke(args);
    assert.equal(output.code, 1); assert.equal(JSON.parse(output.stderr).code, 'DELIVERY_EXECUTION_NOT_FOUND');
  }
  assert.equal(f.state.calls.length, 0);
  assert.equal(fs.existsSync(f.artifactDir), false);
});

test('CLI failures save stable diagnostics without stderr secrets or patch source in output', async t => {
  const f = setup(t); f.state.fail = true;
  const output = await f.invoke();
  assert.equal(output.code, 1);
  assert.equal((output.stdout + output.stderr).includes('PRIVATE_DIAGNOSTIC_NEVER_SAVE'), false);
  const result = JSON.parse(output.stdout), saved = fs.readFileSync(result.artifacts.observationPath, 'utf8');
  assert.equal(saved.includes('PRIVATE_DIAGNOSTIC_NEVER_SAVE'), false);
  assert.equal(result.artifacts.patchPath, undefined);
});

test('malformed flags and relative storage paths fail before accessing state', async t => {
  const f = setup(t);
  for (const args of [['--execution-json', '{"arbitrary":true}', '--json'], f.args.map(value => value === f.artifactDir ? 'relative/artifacts' : value), [...f.args, '--pr', '10']]) {
    const output = await f.invoke(args);
    assert.equal(output.code, 1); assert.equal(JSON.parse(output.stderr).code, 'USAGE_GITHUB_DELIVERY');
  }
  assert.equal(f.state.calls.length, 0);
  assert.equal(fs.existsSync(f.artifactDir), false);
});

test('human output links private artifacts and states that approval is still required', async t => {
  const f = setup(t), output = await f.invoke(f.args.filter(value => value !== '--json'));
  assert.equal(output.code, 0, output.stderr);
  assert.match(output.stdout, /Observation: .*\.json/);
  assert.match(output.stdout, /Patch: .*\.patch/);
  assert.match(output.stdout, /Independent review and explicit human approval are still required/);
  assert.equal(output.stdout.includes('export const result'), false);
});

test('artifact files are immutable, hash-addressed, and reject symlink/conflicting destinations', t => {
  const f = setup(t), association = { executionId: f.execution.executionId, cloudTaskId: CLOUD }, summary = summarizeDeliveryPatch(PATCH);
  const store = new DeliveryArtifactStore({ directory: f.artifactDir });
  const first = store.capturePatch({ patch: PATCH, summary, association });
  assert.equal(path.basename(first.patchPath), summary.sha256 + '.patch');
  assert.deepEqual(store.capturePatch({ patch: PATCH, summary, association }), first);
  fs.writeFileSync(first.patchPath, 'operator-owned-conflict');
  assert.throws(() => store.capturePatch({ patch: PATCH, summary, association }), { code: 'DELIVERY_ARTIFACT_CONFLICT' });
  assert.equal(fs.readFileSync(first.patchPath, 'utf8'), 'operator-owned-conflict');
  const linked = path.join(f.directory, 'linked-artifacts'); fs.symlinkSync(f.artifactDir, linked);
  const unsafe = new DeliveryArtifactStore({ directory: linked });
  assert.throws(() => unsafe.capturePatch({ patch: PATCH, summary, association }), { code: 'DELIVERY_ARTIFACT_DIRECTORY_UNSAFE' });
});

test('partial storage failure never publishes a hash artifact and the same patch can retry', t => {
  const f = setup(t), store = new DeliveryArtifactStore({ directory: f.artifactDir });
  const evidence = { patch: PATCH, summary: summarizeDeliveryPatch(PATCH), association: { executionId: f.execution.executionId, cloudTaskId: CLOUD } };
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = (fd, content, ...options) => {
    originalWrite(fd, content.slice(0, 20), ...options);
    throw Object.assign(new Error('private filesystem diagnostic'), { code: 'ENOSPC' });
  };
  try { assert.throws(() => store.capturePatch(evidence), { code: 'DELIVERY_ARTIFACT_WRITE_FAILED' }); }
  finally { fs.writeFileSync = originalWrite; }
  assert.deepEqual(fs.readdirSync(path.join(f.artifactDir, 'patches')), []);
  const captured = store.capturePatch(evidence);
  assert.equal(fs.readFileSync(captured.patchPath, 'utf8'), PATCH);
  assert.deepEqual(fs.readdirSync(path.join(f.artifactDir, 'patches')), [evidence.summary.sha256 + '.patch']);
});

test('CLI retains the original artifact failure instead of masking it as missing patch evidence', async t => {
  const f = setup(t);
  const directory = path.join(f.artifactDir, 'patches'); fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, digest(PATCH) + '.patch'); fs.writeFileSync(filename, 'conflicting artifact');
  const output = await f.invoke();
  assert.equal(output.code, 1);
  assert.equal(JSON.parse(output.stderr).code, 'DELIVERY_ARTIFACT_CONFLICT');
  assert.equal(output.stderr.includes('DELIVERY_PATCH_ARTIFACT_MISSING'), false);
  assert.equal(fs.readFileSync(filename, 'utf8'), 'conflicting artifact');
  assert.deepEqual(fs.readdirSync(directory), [digest(PATCH) + '.patch']);
});

async function prepareRepair(f) {
  const initial = JSON.parse((await f.invoke()).stdout), previousPath = initial.artifacts.observationPath;
  const newHead = 'e'.repeat(40), repairIssue = '66666666-6666-4666-8666-666666666666', repairRun = '77777777-7777-4777-8777-777777777777', repairCloud = 'task_e_' + 'f'.repeat(32);
  const journal = new ExecutionJournal({ directory: f.stateDir, companyId: COMPANY });
  let execution;
  try {
    journal.queue({ companyId: COMPANY, paperclipIssueId: repairIssue, paperclipRunId: repairRun, projectId: PROJECT, repository: 'fixture/project', environmentId: 'd'.repeat(32), branch: 'factory/demo', mode: 'code_change' });
    journal.claim(repairIssue, repairRun);
    const accepted = journal.accept(repairIssue, repairRun, { cloudTaskId: repairCloud, emittedUrl: 'https://chatgpt.com/codex/tasks/' + repairCloud, taskUrl: 'https://chatgpt.com/remote/' + repairCloud });
    execution = journal.transition(repairIssue, { expectedState: 'running', expectedRevision: accepted.revision, toState: 'succeeded' });
  } finally { journal.close(); }
  const delta = PATCH.replace('aaaaaaa..bbbbbbb', 'bbbbbbb..eeeeeee').replace('-export const result = 1;', '-export const result = 2;').replace('+export const result = 2;', '+export const result = 3;');
  const full = PATCH.replace('aaaaaaa..bbbbbbb', 'aaaaaaa..eeeeeee').replace('+export const result = 2;', '+export const result = 3;');
  const state = { calls: [], staleCI: false, wrongDelta: false };
  const output = value => ({ code: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
  const run = async (command, args, options) => {
    state.calls.push({ command, args, options });
    if (command === '/fixture/codex') {
      if (args[0] === '--version') return output('codex-cli 0.167.0\n');
      if (args[0] === 'login') return { code: 0, stdout: '', stderr: 'Logged in using ChatGPT' };
      assert.deepEqual(args, ['cloud', 'diff', repairCloud, '--attempt', '1']); return output(delta);
    }
    const resource = args.at(-1), diff = args.includes('Accept: application/vnd.github.diff');
    assert.equal(args[args.indexOf('--method') + 1], 'GET');
    if (resource.includes('/compare/')) {
      const base = resource.includes('/' + HEAD + '...') ? HEAD : BASE;
      if (diff) return output(base === BASE ? full : state.wrongDelta ? full : delta);
      return output({ base_commit: { sha: base }, merge_base_commit: { sha: base }, status: 'ahead', ahead_by: 1, behind_by: 0, files: [{ filename: 'src/demo.mjs', additions: 1, deletions: 1 }] });
    }
    if (resource.includes('/check-runs?')) return output({ total_count: 1, check_runs: [{ id: 2, name: 'unit', head_sha: state.staleCI ? HEAD : newHead, status: 'completed', conclusion: 'success', html_url: 'https://github.com/fixture/project/actions/runs/2' }] });
    if (resource.includes('/status?')) return output({ sha: newHead, repository: { full_name: 'fixture/project' }, total_count: 0, statuses: [] });
    assert.equal(resource, 'repos/fixture/project/pulls/9');
    if (diff) return output(full);
    return output({ number: 9, html_url: 'https://github.com/fixture/project/pull/9', state: 'open', merged: false, draft: false, base: { ref: 'main', sha: BASE, repo: { full_name: 'fixture/project' } }, head: { ref: 'factory/demo', sha: newHead, repo: { full_name: 'fixture/project' } }, changed_files: 1, additions: 1, deletions: 1 });
  };
  const args = [...f.args, '--previous-observation', previousPath]; args[args.indexOf('--issue') + 1] = repairIssue; args[args.indexOf('--head') + 1] = newHead;
  return { previousPath, initial, execution, delta, full, state, run, args };
}

test('repair CLI persists both raw delta and complete PR patch with typed immutable provenance across restart', async t => {
  const f = setup(t), r = await prepareRepair(f), inspected = await f.invoke(r.args, { run: r.run });
  assert.equal(inspected.code, 0, inspected.stderr);
  const result = JSON.parse(inspected.stdout), saved = JSON.parse(fs.readFileSync(result.artifacts.observationPath));
  assert.equal(result.association.requestedBranch, 'factory/demo'); assert.equal(result.association.deliveryBaseBranch, 'main');
  assert.equal(result.association.executionId, r.execution.executionId);
  assert.equal(saved.delivery.provenance.comparison, 'exact_incremental_text_diff_with_full_pr');
  assert.equal(saved.delivery.provenance.incremental.previousObservationId, r.initial.artifacts.observationId);
  assert.equal(saved.delivery.deltaPatch.sha256, digest(r.delta)); assert.equal(saved.delivery.patch.sha256, digest(r.full));
  assert.equal(fs.readFileSync(saved.deltaArtifact.path, 'utf8'), r.delta); assert.equal(fs.readFileSync(saved.patchArtifact.path, 'utf8'), r.full);
  assert.equal(saved.deltaArtifact.sha256, digest(r.delta)); assert.equal(saved.patchArtifact.sha256, digest(r.full));
  for (const file of [saved.deltaArtifact.path, saved.patchArtifact.path]) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const afterRestart = JSON.parse((await f.invoke(r.args, { run: r.run })).stdout);
  assert.equal(afterRestart.artifacts.patchPath, result.artifacts.patchPath); assert.equal(afterRestart.artifacts.deltaPatchPath, result.artifacts.deltaPatchPath);
  assert.notEqual(afterRestart.artifacts.observationId, result.artifacts.observationId);
  assert.equal(r.state.calls.some(call => call.args.includes('exec')), false);
});

test('repair CLI preserves rejected delta and fresh CI failures without treating them as delivered repairs', async t => {
  const f = setup(t), r = await prepareRepair(f); r.state.wrongDelta = true;
  const rejected = await f.invoke(r.args, { run: r.run }), mismatch = JSON.parse(rejected.stdout);
  assert.equal(rejected.code, 1); assert.ok(mismatch.reasons.includes('GITHUB_CLOUD_REPAIR_DELTA_MISMATCH'));
  const mismatchRecord = JSON.parse(fs.readFileSync(mismatch.artifacts.observationPath));
  assert.equal(fs.readFileSync(mismatchRecord.deltaArtifact.path, 'utf8'), r.delta); assert.equal(mismatchRecord.patchArtifact, undefined);
  r.state.wrongDelta = false; r.state.staleCI = true;
  const stale = await f.invoke(r.args, { run: r.run }), result = JSON.parse(stale.stdout);
  assert.equal(stale.code, 1); assert.equal(result.provenance.verified, false); assert.ok(result.reasons.includes('GITHUB_CHECKS_INCOMPLETE'));
  assert.equal(fs.readFileSync(result.artifacts.patchPath, 'utf8'), r.full);
});

test('repair CLI rejects changed policy/base observations and symlink inputs before provider reads', async t => {
  const f = setup(t), r = await prepareRepair(f), previous = JSON.parse(fs.readFileSync(r.previousPath));
  previous.context.policyHash = '0'.repeat(64); fs.writeFileSync(r.previousPath, JSON.stringify(previous));
  const changed = await f.invoke(r.args, { run: r.run });
  assert.equal(JSON.parse(changed.stderr).code, 'INVALID_PREVIOUS_DELIVERY'); assert.equal(r.state.calls.length, 0);
  const linked = path.join(f.directory, 'previous-link.json'); fs.symlinkSync(r.previousPath, linked);
  const args = [...r.args]; args[args.indexOf('--previous-observation') + 1] = linked;
  assert.equal(JSON.parse((await f.invoke(args, { run: r.run })).stderr).code, 'INVALID_PREVIOUS_DELIVERY');
  assert.equal(r.state.calls.length, 0);
});

test('a reused artifact store never attributes an earlier full patch to a later delta-only failure', t => {
  const f = setup(t), store = new DeliveryArtifactStore({ directory: f.artifactDir }), association = { executionId: f.execution.executionId, cloudTaskId: CLOUD };
  const summary = summarizeDeliveryPatch(PATCH);
  store.capturePatch({ patch: PATCH, summary, association }); store.captureDelta({ patch: PATCH, summary, association });
  const written = store.recordObservation({ result: { schemaVersion: 1, status: 'needs_attention', association, deltaPatch: summary, reasons: ['GITHUB_CLOUD_REPAIR_DELTA_MISMATCH'], observedAt: '2026-11-03T12:00:00.000Z' }, context: { configHash: f.registration.configHash, policyHash: f.registration.policyHash, journalSchemaVersion: 4, executionRevision: f.execution.revision } });
  const saved = JSON.parse(fs.readFileSync(written.observationPath));
  assert.equal(saved.patchArtifact, undefined); assert.equal(written.patchPath, undefined);
  assert.equal(saved.deltaArtifact.sha256, summary.sha256);
});
