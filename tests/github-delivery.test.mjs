import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { inspectGitHubDelivery, inspectRepairGitHubDelivery, summarizeDeliveryPatch } from '../lib/github-delivery.mjs';
import { configurationHash } from '../lib/repository-registry.mjs';

const BASE = 'a'.repeat(40), HEAD = 'b'.repeat(40);
const PATCH = 'diff --git a/src/demo.mjs b/src/demo.mjs\nindex aaaaaaa..bbbbbbb 100644\n--- a/src/demo.mjs\n+++ b/src/demo.mjs\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n';
function fixture() {
  const execution = { executionId: '11111111-1111-4111-8111-111111111111', companyId: '22222222-2222-4222-8222-222222222222', paperclipIssueId: '33333333-3333-4333-8333-333333333333', paperclipRunId: '44444444-4444-4444-8444-444444444444', projectId: '55555555-5555-4555-8555-555555555555', cloudTaskId: 'task_e_' + 'c'.repeat(32), repository: 'fixture/project', environmentId: 'd'.repeat(32), branch: 'main', state: 'succeeded', mode: 'code_change', attempt: 1 };
  const repositoryConfig = { schemaVersion: 1, repository: 'fixture/project', cloud: { environmentId: execution.environmentId }, defaultBranch: 'main', delivery: { requiredChecks: ['unit'] } };
  const runtime = { githubCommand: '/fixture/gh', codexCommand: '/fixture/codex' };
  const state = {
    calls: [], patch: PATCH, githubPatch: PATCH, metadataReads: 0, changedHead: false,
    pr: { number: 9, html_url: 'https://github.com/fixture/project/pull/9', state: 'open', merged: false, draft: false, base: { ref: 'main', sha: BASE, repo: { full_name: 'fixture/project' } }, head: { ref: 'factory/change', sha: HEAD, repo: { full_name: 'fixture/project' } }, changed_files: 1, additions: 1, deletions: 1 },
    checks: [{ id: 1, name: 'unit', head_sha: HEAD, status: 'completed', conclusion: 'success', html_url: 'https://github.com/fixture/project/actions/runs/1', app: { id: 42 } }],
    statuses: [], checkTotal: null, badStatusSha: false, staleAncestry: false,
  };
  const output = value => ({ code: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
  const run = async (command, args, options) => {
    state.calls.push({ command, args, options });
    if (command === runtime.codexCommand) {
      if (args[0] === '--version') return output('codex-cli 0.167.0\n');
      if (args[0] === 'login') return { code: 0, stdout: '', stderr: 'Logged in using ChatGPT\n' };
      assert.deepEqual(args, ['cloud', 'diff', execution.cloudTaskId, '--attempt', '1']);
      return output(state.patch);
    }
    assert.equal(command, runtime.githubCommand);
    assert.equal(args.includes('--method'), true);
    assert.equal(args[args.indexOf('--method') + 1], 'GET');
    const resource = args.at(-1);
    if (resource.includes('/compare/')) return output({ base_commit: { sha: BASE }, merge_base_commit: { sha: state.staleAncestry ? 'f'.repeat(40) : BASE }, status: state.staleAncestry ? 'diverged' : 'ahead', ahead_by: 1, behind_by: state.staleAncestry ? 1 : 0 });
    if (resource.includes('/check-runs?')) {
      const page = Number(/page=(\d+)$/.exec(resource)[1]);
      return output({ total_count: state.checkTotal ?? state.checks.length, check_runs: state.checks.slice((page - 1) * 100, page * 100) });
    }
    if (resource.includes('/status?')) {
      const page = Number(/page=(\d+)$/.exec(resource)[1]);
      return output({ sha: state.badStatusSha ? BASE : HEAD, repository: { full_name: 'fixture/project' }, total_count: state.statuses.length, statuses: state.statuses.slice((page - 1) * 100, page * 100) });
    }
    assert.equal(resource, 'repos/fixture/project/pulls/9');
    if (args.includes('Accept: application/vnd.github.diff')) return output(state.githubPatch);
    state.metadataReads++;
    const pr = structuredClone(state.pr);
    if (state.changedHead && state.metadataReads > 1) pr.head.sha = 'e'.repeat(40);
    return output(pr);
  };
  const inspect = options => inspectGitHubDelivery({ execution, repositoryConfig, expectedBaseSha: BASE, expectedHeadSha: HEAD, pullRequest: { repository: 'fixture/project', number: 9 }, runtime, run, now: () => '2026-11-03T12:00:00.000Z', ...options });
  return { execution, repositoryConfig, runtime, state, run, inspect };
}

test('complete exact Cloud/PR patch plus SHA-scoped CI permits independent review only', async () => {
  const f = fixture(); let captured;
  const result = await f.inspect({ capturePatch: value => { captured = value; }, env: { HOME: '/private/home', PAPERCLIP_API_KEY: 'fixture-not-forwarded', GITHUB_TOKEN: 'fixture-not-forwarded' } });
  assert.equal(result.status, 'ready_for_independent_review');
  assert.equal(result.humanApprovalEligible, false);
  assert.equal(result.provenance.verified, true);
  assert.equal(result.provenance.cloudPatchSha256, result.provenance.githubPatchSha256);
  assert.equal(result.checks.state, 'passed');
  assert.equal(result.association.executionId, f.execution.executionId);
  assert.equal(result.association.paperclipIssueId, f.execution.paperclipIssueId);
  assert.equal(result.association.expectedBaseSha, BASE);
  assert.equal(result.association.expectedHeadSha, HEAD);
  assert.equal(result.association.pullRequestUrl, 'https://github.com/fixture/project/pull/9');
  assert.equal(captured.patch, PATCH);
  assert.equal(JSON.stringify(result).includes('export const value'), false);
  assert.equal(f.state.metadataReads, 2);
  for (const call of f.state.calls) {
    assert.equal(call.options.env.PAPERCLIP_API_KEY, undefined);
    assert.equal(call.options.env.GITHUB_TOKEN, undefined);
    assert.ok(call.options.timeoutMs <= 30000);
    assert.ok(call.options.maxOutputBytes <= 1000000);
  }
});

test('no PR preserves a captured patch fallback without claiming base, head or CI verification', async () => {
  const f = fixture(); let saved = false;
  const result = await f.inspect({ pullRequest: null, expectedHeadSha: undefined, capturePatch: () => { saved = true; } });
  assert.equal(result.status, 'patch_fallback');
  assert.equal(saved, true);
  assert.equal(result.provenance.verified, false);
  assert.equal(result.checks.state, 'unverified');
  assert.ok(result.reasons.includes('BASE_AND_HEAD_PROVENANCE_UNVERIFIED'));
  assert.equal(result.humanApprovalEligible, false);
  assert.equal(f.state.calls.some(call => call.command === f.runtime.githubCommand), false);
});

test('wrong configured repository or explicit PR target reject before any remote reads', async () => {
  const f = fixture();
  await assert.rejects(f.inspect({ pullRequest: { repository: 'other/project', number: 9 } }), { code: 'INVALID_DELIVERY_PR' });
  await assert.rejects(f.inspect({ repositoryConfig: { ...f.repositoryConfig, repository: 'other/project' } }), { code: 'DELIVERY_REPOSITORY_MISMATCH' });
  await assert.rejects(f.inspect({ execution: { ...f.execution, state: 'running' } }), { code: 'DELIVERY_EXECUTION_NOT_READY' });
  assert.equal(f.state.calls.length, 0);
});

test('PR repo, base branch/base SHA and head SHA must match independently of title or markers', async t => {
  for (const [name, alter, code] of [
    ['repo', pr => { pr.base.repo.full_name = 'other/project'; }, 'GITHUB_PR_REPOSITORY_MISMATCH'],
    ['fork', pr => { pr.head.repo.full_name = 'other/project'; }, 'GITHUB_PR_REPOSITORY_MISMATCH'],
    ['base branch', pr => { pr.base.ref = 'develop'; }, 'GITHUB_PR_BASE_MISMATCH'],
    ['base SHA', pr => { pr.base.sha = 'f'.repeat(40); }, 'GITHUB_PR_BASE_MISMATCH'],
    ['head SHA', pr => { pr.head.sha = 'f'.repeat(40); }, 'GITHUB_PR_HEAD_MISMATCH'],
    ['draft', pr => { pr.draft = true; }, 'GITHUB_PR_DRAFT'],
    ['closed', pr => { pr.state = 'closed'; }, 'GITHUB_PR_NOT_OPEN'],
  ]) await t.test(name, async () => {
    const f = fixture(); alter(f.state.pr);
    const result = await f.inspect();
    assert.equal(result.status, 'needs_attention');
    assert.ok(result.reasons.includes(code));
    assert.equal(result.provenance.verified, false);
  });
});

test('patch mismatch or GitHub truncated diff metadata cannot establish provenance', async () => {
  const f = fixture(); f.state.githubPatch = PATCH.replace('value = 2', 'value = 3');
  assert.ok((await f.inspect()).reasons.includes('GITHUB_CLOUD_PATCH_MISMATCH'));
  f.state.githubPatch = PATCH;
  f.state.pr.changed_files = 2;
  const truncated = await f.inspect();
  assert.ok(truncated.reasons.includes('GITHUB_PATCH_INCOMPLETE'));
  assert.equal(truncated.provenance.verified, false);
});

test('CI failures, pending states, missing names and unknown conclusions block readiness', async t => {
  for (const [name, change, state, reason] of [
    ['failure', f => { f.state.checks[0].conclusion = 'failure'; }, 'failed', 'CI_FAILED'],
    ['timeout', f => { f.state.checks[0].conclusion = 'timed_out'; }, 'failed', 'CI_FAILED'],
    ['pending', f => { f.state.checks[0].status = 'in_progress'; f.state.checks[0].conclusion = null; }, 'pending', 'CI_PENDING'],
    ['missing', f => { f.state.checks = []; }, 'unknown', 'CI_UNVERIFIED'],
    ['neutral', f => { f.state.checks[0].conclusion = 'neutral'; }, 'unknown', 'CI_UNVERIFIED'],
    ['skipped', f => { f.state.checks[0].conclusion = 'skipped'; }, 'unknown', 'CI_UNVERIFIED'],
    ['new status', f => { f.state.checks[0].status = 'new_status'; }, 'unknown', 'CI_UNVERIFIED'],
    ['unconfigured', f => { f.repositoryConfig.delivery.requiredChecks = []; }, 'unconfigured', 'CI_REQUIREMENTS_UNCONFIGURED'],
  ]) await t.test(name, async () => {
    const f = fixture(); change(f);
    const result = await f.inspect();
    assert.equal(result.status, 'needs_attention'); assert.equal(result.checks.state, state);
    assert.ok(result.reasons.includes(reason)); assert.equal(result.humanApprovalEligible, false);
  });
});

test('commit statuses participate in configured gates and expose actionable sanitized links', async () => {
  const f = fixture(); f.state.checks = [];
  f.state.statuses = [{ id: 2, context: 'unit', state: 'failure', target_url: 'https://ci.example/job/2?token=do-not-publish#private' }];
  const failed = await f.inspect();
  assert.equal(failed.checks.state, 'failed');
  assert.equal(failed.checks.required[0].observations[0].url, 'https://ci.example/job/2');
  assert.equal(JSON.stringify(failed).includes('do-not-publish'), false);
  f.state.statuses[0].state = 'success';
  assert.equal((await f.inspect()).status, 'ready_for_independent_review');
});

test('same check name from multiple producers and wrong-SHA observations fail closed', async () => {
  const f = fixture();
  f.state.checks.push({ ...f.state.checks[0], id: 3, app: { id: 43 } });
  const ambiguous = await f.inspect();
  assert.equal(ambiguous.checks.state, 'unknown');
  assert.equal(ambiguous.status, 'needs_attention');
  f.state.checks = [f.state.checks[0]]; f.state.checks[0].head_sha = BASE;
  assert.ok((await f.inspect()).reasons.includes('GITHUB_CHECKS_INCOMPLETE'));
  f.state.checks[0].head_sha = HEAD; f.state.badStatusSha = true;
  assert.ok((await f.inspect()).reasons.includes('GITHUB_CHECKS_INCOMPLETE'));
});

test('bounded pagination reaches a later required check and refuses a truncated inventory', async () => {
  const f = fixture();
  f.state.checks = Array.from({ length: 101 }, (_, index) => ({ ...f.state.checks[0], id: index + 1, name: index === 100 ? 'unit' : 'other-' + index }));
  const passed = await f.inspect(); assert.equal(passed.status, 'ready_for_independent_review');
  const blocked = await f.inspect({ runtime: { ...f.runtime, maxPages: 1 } });
  assert.ok(blocked.reasons.includes('GITHUB_CHECKS_INCOMPLETE'));
  assert.equal(blocked.status, 'needs_attention');
});

test('a changed PR head during inspection invalidates an otherwise passing result', async () => {
  const f = fixture(); f.state.changedHead = true;
  const result = await f.inspect();
  assert.equal(result.status, 'needs_attention');
  assert.ok(result.reasons.includes('GITHUB_PR_HEAD_MISMATCH'));
  assert.equal(result.provenance.verified, false);
});

test('an exact patch on a head that predates the approved immutable base cannot pass', async () => {
  const f = fixture(); f.state.staleAncestry = true;
  const result = await f.inspect();
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.provenance.verified, false);
  assert.ok(result.reasons.includes('GITHUB_PR_ANCESTRY_UNVERIFIED'));
});

test('provider/permission failure, oversized output, and unsupported version never echo raw diagnostics', async () => {
  const f = fixture(), secret = 'secret-output-never-echo';
  const failed = await f.inspect({ run: async () => ({ code: 1, stdout: secret, stderr: secret }) });
  assert.equal(failed.status, 'needs_attention'); assert.equal(JSON.stringify(failed).includes(secret), false);
  const oversized = await f.inspect({ run: async () => ({ code: 0, stdout: 'x'.repeat(1000001), stderr: secret }) });
  assert.ok(oversized.reasons.includes('DELIVERY_OUTPUT_LIMIT'));
  const unsupported = await f.inspect({ run: async () => ({ code: 0, stdout: 'codex-cli 9.9.9\n', stderr: '' }) });
  assert.ok(unsupported.reasons.includes('UNSUPPORTED_CODEX_VERSION'));
  const ghFailure = await f.inspect({ run: async (command, args, options) => command === f.runtime.githubCommand ? { code: 1, stderr: secret, stdout: '' } : f.run(command, args, options) });
  assert.ok(ghFailure.reasons.includes('GITHUB_READ_FAILED')); assert.equal(JSON.stringify(ghFailure).includes(secret), false);
});

test('unified-diff parser rejects prefixes, binary output, unsafe paths, empty and truncated hunks', () => {
  const summary = summarizeDeliveryPatch(PATCH);
  assert.deepEqual(summary.files, ['src/demo.mjs']); assert.equal(summary.additions, 1); assert.equal(summary.deletions, 1);
  for (const patch of ['', 'Here is your patch\n' + PATCH, PATCH.slice(0, -1), PATCH.replace('@@ -1 +1 @@', '@@ -2,2 +2,2 @@'), PATCH.replace('a/src/demo.mjs b/src/demo.mjs', 'a/../file b/../file'), 'diff --git a/file b/file\nBinary files a/file and b/file differ\n']) assert.throws(() => summarizeDeliveryPatch(patch), { code: 'UNSUPPORTED_PATCH_FORMAT' });
});

async function repairFixture() {
  const original = fixture(), result = await original.inspect();
  const previous = { schemaVersion: 1, observationId: randomUUID(), observedAt: result.observedAt, context: { configHash: configurationHash(original.repositoryConfig), policyHash: 'e'.repeat(64), journalSchemaVersion: 4, executionRevision: 2 }, delivery: result };
  const newHead = 'e'.repeat(40), execution = { ...original.execution, executionId: randomUUID(), paperclipIssueId: randomUUID(), paperclipRunId: randomUUID(), branch: 'factory/change', cloudTaskId: 'task_e_' + 'f'.repeat(32) };
  const delta = PATCH.replace('aaaaaaa..bbbbbbb', 'bbbbbbb..eeeeeee').replace('-export const value = 1;', '-export const value = 2;').replace('+export const value = 2;', '+export const value = 3;');
  const full = PATCH.replace('aaaaaaa..bbbbbbb', 'aaaaaaa..eeeeeee').replace('+export const value = 2;', '+export const value = 3;');
  const state = { calls: [], metadataReads: 0, headRace: false, cloudDelta: delta, githubDelta: delta, full, fullComparisonPatch: full, deltaBase: HEAD, deltaMergeBase: HEAD, fullBase: BASE, fileAdditions: 1,
    pr: { ...structuredClone(original.state.pr), head: { ...structuredClone(original.state.pr.head), sha: newHead } }, checks: [{ ...original.state.checks[0], head_sha: newHead }], statuses: [], badStatusSha: false };
  const output = value => ({ code: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' });
  const run = async (command, args, options) => {
    state.calls.push({ command, args, options });
    if (command === original.runtime.codexCommand) {
      if (args[0] === '--version') return output('codex-cli 0.167.0\n');
      if (args[0] === 'login') return { code: 0, stdout: '', stderr: 'Logged in using ChatGPT' };
      assert.deepEqual(args, ['cloud', 'diff', execution.cloudTaskId, '--attempt', '1']); return output(state.cloudDelta);
    }
    assert.equal(args[args.indexOf('--method') + 1], 'GET');
    const resource = args.at(-1), diff = args.includes('Accept: application/vnd.github.diff');
    if (resource.includes('/compare/')) {
      const fullRange = resource.includes('/' + BASE + '...');
      if (diff) return output(fullRange ? state.fullComparisonPatch : state.githubDelta);
      const base = fullRange ? state.fullBase : state.deltaBase;
      return output({ base_commit: { sha: base }, merge_base_commit: { sha: fullRange ? state.fullBase : state.deltaMergeBase }, status: 'ahead', ahead_by: 1, behind_by: 0, files: [{ filename: 'src/demo.mjs', additions: state.fileAdditions, deletions: 1 }] });
    }
    if (resource.includes('/check-runs?')) {
      const page = Number(/page=(\d+)$/.exec(resource)[1]); return output({ total_count: state.checks.length, check_runs: state.checks.slice((page - 1) * 100, page * 100) });
    }
    if (resource.includes('/status?')) return output({ sha: state.badStatusSha ? HEAD : newHead, repository: { full_name: 'fixture/project' }, total_count: state.statuses.length, statuses: state.statuses });
    assert.equal(resource, 'repos/fixture/project/pulls/9');
    if (diff) return output(state.full);
    const pr = structuredClone(state.pr); if (state.headRace && ++state.metadataReads > 1) pr.head.sha = '9'.repeat(40); return output(pr);
  };
  const inspect = extra => inspectRepairGitHubDelivery({ previousDeliveryObservation: previous, repairExecution: execution, repositoryConfig: original.repositoryConfig, expectedHeadSha: newHead, runtime: original.runtime, run, now: () => '2026-11-03T12:01:00.000Z', ...extra });
  return { previous, execution, newHead, delta, full, state, inspect, run, repositoryConfig: original.repositoryConfig, runtime: original.runtime };
}

test('published repair delta is verified independently and the complete PR patch is captured last', async () => {
  const f = await repairFixture(), captured = [];
  const result = await f.inspect({ captureDelta: item => { captured.push(['delta', item.patch]); return { deltaPatchPath: '/private/tmp/fixture-delta.patch', deltaPatchSha256: item.summary.sha256 }; }, capturePatch: item => { captured.push(['full', item.patch]); } });
  assert.equal(result.status, 'ready_for_independent_review');
  assert.deepEqual(captured, [['delta', f.delta], ['full', f.full]]);
  assert.equal(result.association.requestedBranch, 'factory/change'); assert.equal(result.association.deliveryBaseBranch, 'main');
  assert.equal(result.provenance.comparison, 'exact_incremental_text_diff_with_full_pr');
  assert.equal(result.provenance.incremental.previousHeadSha, HEAD); assert.equal(result.provenance.incremental.newHeadSha, f.newHead);
  assert.equal(result.provenance.incremental.previousObservationId, f.previous.observationId);
  assert.equal(result.provenance.incremental.cloudPatchSha256, summarizeDeliveryPatch(f.delta).sha256);
  assert.equal(result.patch.sha256, summarizeDeliveryPatch(f.full).sha256); assert.notEqual(result.patch.sha256, result.deltaPatch.sha256);
  assert.equal(result.provenance.cloudPatchSha256, undefined); assert.equal(result.humanApprovalEligible, false);
});

test('ordinary inspector still rejects a repair branch and invalid repair source bindings make no provider calls', async () => {
  const f = await repairFixture();
  await assert.rejects(inspectGitHubDelivery({ execution: f.execution, repositoryConfig: f.repositoryConfig, expectedBaseSha: BASE, expectedHeadSha: f.newHead, runtime: f.runtime, run: f.run }), { code: 'DELIVERY_REPOSITORY_MISMATCH' });
  for (const extra of [{ repairExecution: { ...f.execution, cloudTaskId: f.previous.delivery.association.cloudTaskId } }, { repairExecution: { ...f.execution, companyId: randomUUID() } }, { expectedHeadSha: HEAD }, { pullRequest: { repository: 'fixture/project', number: 10 } }]) await assert.rejects(f.inspect(extra), { code: 'INVALID_REPAIR_DELIVERY_BINDING' });
  const unverified = structuredClone(f.previous); unverified.delivery.provenance.verified = false;
  await assert.rejects(f.inspect({ previousDeliveryObservation: unverified }), { code: 'PREVIOUS_DELIVERY_UNVERIFIED' });
  assert.equal(f.state.calls.length, 0);
});

test('wrong previous head, unrelated branch, incomplete delta/full evidence and new-head races cannot pass repair provenance', async t => {
  for (const [name, change, reason] of [
    ['previous head', f => { f.state.deltaBase = '9'.repeat(40); }, 'GITHUB_REPAIR_ANCESTRY_UNVERIFIED'],
    ['delta ancestry', f => { f.state.deltaMergeBase = BASE; }, 'GITHUB_REPAIR_ANCESTRY_UNVERIFIED'],
    ['branch', f => { f.state.pr.head.ref = 'unrelated/branch'; }, 'GITHUB_REPAIR_BRANCH_MISMATCH'],
    ['delta text', f => { f.state.githubDelta = f.delta.replace('+export const value = 3;', '+export const value = 4;'); }, 'GITHUB_CLOUD_REPAIR_DELTA_MISMATCH'],
    ['delta metadata', f => { f.state.fileAdditions = 7; }, 'GITHUB_REPAIR_DELTA_INCOMPLETE'],
    ['full metadata', f => { f.state.pr.changed_files = 2; }, 'GITHUB_PATCH_INCOMPLETE'],
    ['full text', f => { f.state.full = f.full.replace('+export const value = 3;', '+export const value = 4;'); }, 'GITHUB_REPAIR_FULL_PATCH_MISMATCH'],
    ['full ancestry', f => { f.state.fullBase = HEAD; }, 'GITHUB_REPAIR_ANCESTRY_UNVERIFIED'],
    ['head changed', f => { f.state.headRace = true; }, 'GITHUB_PR_HEAD_MISMATCH'],
  ]) await t.test(name, async () => {
    const f = await repairFixture(); change(f); const result = await f.inspect();
    assert.equal(result.status, 'needs_attention'); assert.equal(result.provenance.verified, false); assert.ok(result.reasons.includes(reason), result.reasons.join(','));
  });
});

test('repair CI must be fresh at the new head and pagination remains bounded', async () => {
  const f = await repairFixture(); f.state.checks[0].head_sha = HEAD;
  assert.ok((await f.inspect()).reasons.includes('GITHUB_CHECKS_INCOMPLETE'));
  f.state.checks[0].head_sha = f.newHead; f.state.checks[0].status = 'queued'; f.state.checks[0].conclusion = null;
  assert.equal((await f.inspect()).checks.state, 'pending');
  f.state.checks = Array.from({ length: 101 }, (_, i) => ({ ...f.state.checks[0], id: i + 1, name: i === 100 ? 'unit' : 'other-' + i, status: 'completed', conclusion: 'success' }));
  assert.equal((await f.inspect()).status, 'ready_for_independent_review');
  assert.ok((await f.inspect({ runtime: { ...f.runtime, maxPages: 1 } })).reasons.includes('GITHUB_CHECKS_INCOMPLETE'));
});
