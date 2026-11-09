import path from 'node:path';
import { createHash } from 'node:crypto';
import { cloudEnvironment, runCommand } from './cloud-dispatch.mjs';
import { configurationHash } from './repository-registry.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const MAX_PATCH_BYTES = 1_000_000;
export class DeliveryError extends Error {
  constructor(code) { super(code); this.name = 'DeliveryError'; this.code = code; }
}
const fail = code => { throw new DeliveryError(code); };
const hash = text => createHash('sha256').update(text).digest('hex');
function filename(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.@+/-]+$/.test(value) || value.startsWith('/') || value.split('/').some(part => !part || ['.', '..'].includes(part))) fail('UNSUPPORTED_PATCH_FORMAT');
  return value;
}

// A conservative complete text-diff parser. Unsupported/binary/quoted path
// formats require manual review; no prefix or truncated hunk can pass as proof.
export function summarizeDeliveryPatch(patch) {
  if (typeof patch !== 'string' || !patch || Buffer.byteLength(patch) > MAX_PATCH_BYTES || /[\0\x1b]/.test(patch) || !patch.endsWith('\n')) fail('UNSUPPORTED_PATCH_FORMAT');
  const lines = patch.slice(0, -1).split('\n'), files = [];
  let cursor = 0, additions = 0, deletions = 0;
  while (cursor < lines.length) {
    const header = /^diff --git a\/([^ ]+) b\/([^ ]+)$/.exec(lines[cursor++]);
    if (!header) fail('UNSUPPORTED_PATCH_FORMAT');
    const oldPath = filename(header[1]), newPath = filename(header[2]);
    if (oldPath !== newPath || files.includes(newPath) || files.length >= 300) fail('UNSUPPORTED_PATCH_FORMAT');
    files.push(newPath);
    let oldHeader = false, newHeader = false, index = false, hunks = 0;
    while (cursor < lines.length && !lines[cursor].startsWith('diff --git ')) {
      const line = lines[cursor++];
      if (/^(?:new file mode|deleted file mode|old mode|new mode) [0-7]{6}$/.test(line)) continue;
      if (/^index [a-f0-9]{7,40}\.\.[a-f0-9]{7,40}(?: [0-7]{6})?$/.test(line) && !index && !hunks) { index = true; continue; }
      if (line.startsWith('--- ') && !oldHeader && !hunks) {
        if (line !== '--- /dev/null' && line !== '--- a/' + oldPath) fail('UNSUPPORTED_PATCH_FORMAT');
        oldHeader = true; continue;
      }
      if (line.startsWith('+++ ') && oldHeader && !newHeader && !hunks) {
        if (line !== '+++ /dev/null' && line !== '+++ b/' + newPath) fail('UNSUPPORTED_PATCH_FORMAT');
        newHeader = true; continue;
      }
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line);
      if (!hunk || !oldHeader || !newHeader || !index) fail('UNSUPPORTED_PATCH_FORMAT');
      let oldRemaining = Number(hunk[2] ?? 1), newRemaining = Number(hunk[4] ?? 1);
      if (![Number(hunk[1]), Number(hunk[3]), oldRemaining, newRemaining].every(Number.isSafeInteger)) fail('UNSUPPORTED_PATCH_FORMAT');
      hunks++;
      while (oldRemaining || newRemaining) {
        if (cursor >= lines.length) fail('UNSUPPORTED_PATCH_FORMAT');
        const content = lines[cursor++];
        if (content.startsWith(' ')) { oldRemaining--; newRemaining--; }
        else if (content.startsWith('-')) { oldRemaining--; deletions++; }
        else if (content.startsWith('+')) { newRemaining--; additions++; }
        else if (content === '\\ No newline at end of file') continue;
        else fail('UNSUPPORTED_PATCH_FORMAT');
        if (oldRemaining < 0 || newRemaining < 0) fail('UNSUPPORTED_PATCH_FORMAT');
      }
      if (lines[cursor] === '\\ No newline at end of file') cursor++;
    }
    if (!hunks) fail('UNSUPPORTED_PATCH_FORMAT');
  }
  return Object.freeze({ sha256: hash(patch), bytes: Buffer.byteLength(patch), files, additions, deletions, format: 'git-unified-text-v1' });
}
function validateInput({ execution, repositoryConfig, expectedBaseSha, expectedHeadSha, pullRequest, runtime }, repair = false) {
  if (!execution || ['executionId', 'companyId', 'paperclipIssueId', 'paperclipRunId', 'projectId'].some(key => !UUID.test(execution[key] ?? '')) || !Number.isInteger(execution.attempt) || execution.attempt < 1 || execution.attempt > 100 || !/^task_e_[a-f0-9]{32}$/.test(execution.cloudTaskId ?? '')) fail('INVALID_DELIVERY_EXECUTION');
  if (execution.state !== 'succeeded' || execution.mode !== 'code_change') fail('DELIVERY_EXECUTION_NOT_READY');
  if (!repositoryConfig || repositoryConfig.schemaVersion !== 1 || !REPOSITORY.test(repositoryConfig.repository ?? '') || execution.repository?.toLowerCase() !== repositoryConfig.repository.toLowerCase() || execution.environmentId !== repositoryConfig.cloud?.environmentId || !repair && execution.branch !== repositoryConfig.defaultBranch) fail('DELIVERY_REPOSITORY_MISMATCH');
  const requiredChecks = repositoryConfig.delivery?.requiredChecks;
  if (!Array.isArray(requiredChecks) || requiredChecks.length > 50 || requiredChecks.some(name => typeof name !== 'string' || !name || Buffer.byteLength(name) > 200 || /[\0\r\n]/.test(name)) || new Set(requiredChecks).size !== requiredChecks.length) fail('INVALID_DELIVERY_CHECKS');
  if (!SHA.test(expectedBaseSha ?? '')) fail('INVALID_DELIVERY_BASE');
  if (expectedHeadSha !== undefined && !SHA.test(expectedHeadSha)) fail('INVALID_DELIVERY_HEAD');
  if (pullRequest !== undefined && pullRequest !== null) {
    if (!Number.isSafeInteger(pullRequest.number) || pullRequest.number < 1 || pullRequest.repository?.toLowerCase() !== execution.repository.toLowerCase()) fail('INVALID_DELIVERY_PR');
    if (!SHA.test(expectedHeadSha ?? '')) fail('INVALID_DELIVERY_HEAD');
  }
  const r = { ...runtime };
  for (const key of ['githubCommand', 'codexCommand']) if (typeof r[key] !== 'string' || !path.isAbsolute(r[key]) || /[\0\r\n]/.test(r[key])) fail('INVALID_DELIVERY_COMMAND');
  for (const [key, value, minimum, maximum] of [['timeoutMs', 15000, 1000, 30000], ['maxPages', 5, 1, 10], ['maxOutputBytes', MAX_PATCH_BYTES, 1024, MAX_PATCH_BYTES]]) {
    r[key] ??= value;
    if (!Number.isInteger(r[key]) || r[key] < minimum || r[key] > maximum) fail('INVALID_DELIVERY_LIMIT');
  }
  return r;
}
function safeLink(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) fail('INVALID_GITHUB_RESPONSE');
  let parsed; try { parsed = new URL(value); } catch { fail('INVALID_GITHUB_RESPONSE'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) fail('INVALID_GITHUB_RESPONSE');
  parsed.search = ''; parsed.hash = '';
  return parsed.href;
}
function checkName(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 200 || /[\u0000-\u001f\u007f]/.test(value)) fail('INVALID_GITHUB_RESPONSE');
  return value;
}
const statusText = value => typeof value === 'string' && /^[a-z_]{1,64}$/.test(value) ? value : null;
function checkState(status, conclusion) {
  if (['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(status)) return 'pending';
  if (status !== 'completed') return 'unknown';
  if (conclusion === 'success') return 'passed';
  if (['action_required', 'cancelled', 'failure', 'timed_out'].includes(conclusion)) return 'failed';
  return 'unknown';
}
function validatePr(pr, association) {
  const repo = association.repository;
  if (pr?.number !== association.pullRequestNumber || typeof pr.html_url !== 'string' || pr.html_url.toLowerCase() !== association.pullRequestUrl.toLowerCase() || pr.base?.repo?.full_name?.toLowerCase() !== repo || pr.head?.repo?.full_name?.toLowerCase() !== repo) fail('GITHUB_PR_REPOSITORY_MISMATCH');
  if (pr.base.ref !== (association.deliveryBaseBranch ?? association.requestedBranch) || pr.base.sha !== association.expectedBaseSha) fail('GITHUB_PR_BASE_MISMATCH');
  if (pr.head.sha !== association.expectedHeadSha) fail('GITHUB_PR_HEAD_MISMATCH');
  if (pr.state !== 'open' || pr.merged !== false) fail('GITHUB_PR_NOT_OPEN');
  if (pr.draft !== false) fail('GITHUB_PR_DRAFT');
  for (const key of ['changed_files', 'additions', 'deletions']) if (!Number.isSafeInteger(pr[key]) || pr[key] < 0) fail('INVALID_GITHUB_RESPONSE');
}


async function inspectChecks({ gh, association, repositoryConfig, limits }) {
    const headResource = 'repos/' + association.repository + '/commits/' + association.expectedHeadSha;
    const checkRuns = [], statuses = [];
    let checkTotal, statusTotal;
    for (let page = 1; page <= limits.maxPages; page++) {
      const response = await gh(headResource + '/check-runs?filter=latest&per_page=100&page=' + page);
      if (!Array.isArray(response?.check_runs) || response.check_runs.length > 100 || !Number.isSafeInteger(response.total_count) || response.total_count < 0 || (checkTotal !== undefined && response.total_count !== checkTotal)) fail('GITHUB_CHECKS_INCOMPLETE');
      checkTotal = response.total_count; checkRuns.push(...response.check_runs);
      if (checkRuns.length === checkTotal) break;
      if (checkRuns.length > checkTotal || response.check_runs.length < 100 || page === limits.maxPages) fail('GITHUB_CHECKS_INCOMPLETE');
    }
    for (let page = 1; page <= limits.maxPages; page++) {
      const response = await gh(headResource + '/status?per_page=100&page=' + page);
      if (response?.sha !== association.expectedHeadSha || response.repository?.full_name?.toLowerCase() !== association.repository || !Array.isArray(response.statuses) || response.statuses.length > 100 || !Number.isSafeInteger(response.total_count) || response.total_count < 0 || (statusTotal !== undefined && response.total_count !== statusTotal)) fail('GITHUB_CHECKS_INCOMPLETE');
      statusTotal = response.total_count; statuses.push(...response.statuses);
      if (statuses.length === statusTotal) break;
      if (statuses.length > statusTotal || response.statuses.length < 100 || page === limits.maxPages) fail('GITHUB_CHECKS_INCOMPLETE');
    }
    const seen = new Set(), observations = [];
    for (const row of checkRuns) {
      if (!Number.isSafeInteger(row?.id) || seen.has('check:' + row.id) || row.head_sha !== association.expectedHeadSha) fail('GITHUB_CHECKS_INCOMPLETE');
      seen.add('check:' + row.id);
      const name = checkName(row.name);
      observations.push({ name, source: 'check_run', state: checkState(row.status, row.conclusion), status: statusText(row.status), conclusion: statusText(row.conclusion), url: safeLink(row.html_url), id: row.id, appId: Number.isSafeInteger(row.app?.id) ? row.app.id : null });
    }
    for (const row of statuses) {
      if (!Number.isSafeInteger(row?.id) || seen.has('status:' + row.id)) fail('GITHUB_CHECKS_INCOMPLETE');
      seen.add('status:' + row.id);
      observations.push({ name: checkName(row.context), source: 'commit_status', state: row.state === 'success' ? 'passed' : ['failure', 'error'].includes(row.state) ? 'failed' : row.state === 'pending' ? 'pending' : 'unknown', status: statusText(row.state), conclusion: null, url: safeLink(row.target_url), id: row.id });
    }
    const required = repositoryConfig.delivery.requiredChecks.map(name => {
      const matching = observations.filter(row => row.name === name);
      let state;
      if (!matching.length) state = 'missing';
      else if (matching.filter(row => row.source === 'check_run').length > 1 || matching.filter(row => row.source === 'commit_status').length > 1) state = 'unknown';
      else if (matching.some(row => row.state === 'failed')) state = 'failed';
      else if (matching.some(row => row.state === 'unknown')) state = 'unknown';
      else if (matching.some(row => row.state === 'pending')) state = 'pending';
      else state = 'passed';
      return { name, state, observations: matching };
    });
    return { state: !required.length ? 'unconfigured' : required.every(row => row.state === 'passed') ? 'passed' : required.some(row => row.state === 'failed') ? 'failed' : required.some(row => ['missing', 'unknown'].includes(row.state)) ? 'unknown' : 'pending', required, observations, observedCount: observations.length };
}

/** Read-only observation. The caller must durably persist the returned association
 * before publishing it; a passing result permits independent review, never merge. */
export async function inspectGitHubDelivery({ execution, repositoryConfig, expectedBaseSha, expectedHeadSha, pullRequest, runtime, run = runCommand, env = process.env, now = () => new Date().toISOString(), capturePatch }) {
  const limits = validateInput({ execution, repositoryConfig, expectedBaseSha, expectedHeadSha, pullRequest, runtime });
  const association = {
    executionId: execution.executionId, companyId: execution.companyId, paperclipIssueId: execution.paperclipIssueId,
    paperclipRunId: execution.paperclipRunId, projectId: execution.projectId, attempt: execution.attempt,
    cloudTaskId: execution.cloudTaskId, cloudTaskUrl: 'https://chatgpt.com/remote/' + execution.cloudTaskId,
    repository: execution.repository.toLowerCase(), environmentId: execution.environmentId, requestedBranch: execution.branch,
    expectedBaseSha, ...(expectedHeadSha ? { expectedHeadSha } : {}),
    ...(pullRequest ? { pullRequestNumber: pullRequest.number, pullRequestUrl: 'https://github.com/' + execution.repository.toLowerCase() + '/pull/' + pullRequest.number } : {}),
  };
  const result = { schemaVersion: 1, status: 'needs_attention', association, provenance: { verified: false }, checks: { state: 'unverified', required: [] }, reasons: [], humanApprovalEligible: false, requiresFreshInspection: true };
  const childEnv = cloudEnvironment(env), ghEnv = { ...childEnv };
  for (const key of ['GH_CONFIG_DIR', 'XDG_CONFIG_HOME']) if (typeof env[key] === 'string') ghEnv[key] = env[key];
  const command = async (kind, args, json = false) => {
    let response;
    try { response = await run(limits[kind + 'Command'], args, { env: kind === 'github' ? ghEnv : childEnv, timeoutMs: limits.timeoutMs, maxOutputBytes: limits.maxOutputBytes }); }
    catch { fail(kind === 'github' ? 'GITHUB_READ_FAILED' : 'CLOUD_DIFF_UNAVAILABLE'); }
    if (response?.code !== 0 || response?.signal || response?.timedOut || response?.outputExceeded || response?.failedToStart) fail(kind === 'github' ? 'GITHUB_READ_FAILED' : 'CLOUD_DIFF_UNAVAILABLE');
    if (typeof response.stdout !== 'string' || Buffer.byteLength(response.stdout) > limits.maxOutputBytes) fail('DELIVERY_OUTPUT_LIMIT');
    if (json) { try { return JSON.parse(response.stdout); } catch { fail('INVALID_GITHUB_RESPONSE'); } }
    return response;
  };
  const gh = (resource, diff = false) => command('github', ['api', '--hostname', 'github.com', '--method', 'GET', '--header', 'Accept: ' + (diff ? 'application/vnd.github.diff' : 'application/vnd.github+json'), '--header', 'X-GitHub-Api-Version: 2022-11-28', resource], !diff);
  try {
    const version = await command('codex', ['--version']);
    if (version.stdout.trim() !== 'codex-cli 0.167.0') fail('UNSUPPORTED_CODEX_VERSION');
    const authentication = await command('codex', ['login', 'status']);
    if (!/Logged in using ChatGPT/.test(authentication.stdout + '\n' + authentication.stderr)) fail('CODEX_CHATGPT_LOGIN_REQUIRED');
    const cloud = await command('codex', ['cloud', 'diff', execution.cloudTaskId, '--attempt', '1']);
    result.patch = summarizeDeliveryPatch(cloud.stdout);
    if (capturePatch) {
      // Only the trusted caller chooses storage; no filename from provider output
      // is used as a local output path. The callback's return value is not logged.
      await capturePatch({ patch: cloud.stdout, summary: result.patch, association: { ...association } });
    }
    if (!pullRequest) {
      result.status = 'patch_fallback';
      result.reasons.push('PULL_REQUEST_NOT_PROVIDED', 'BASE_AND_HEAD_PROVENANCE_UNVERIFIED');
      return { ...result, observedAt: now() };
    }
    const resource = 'repos/' + association.repository + '/pulls/' + pullRequest.number;
    const pr = await gh(resource);
    validatePr(pr, association);
    const ancestry = await gh('repos/' + association.repository + '/compare/' + association.expectedBaseSha + '...' + association.expectedHeadSha + '?per_page=1');
    if (ancestry?.base_commit?.sha !== association.expectedBaseSha || ancestry.merge_base_commit?.sha !== association.expectedBaseSha || ancestry.status !== 'ahead' || !Number.isSafeInteger(ancestry.ahead_by) || ancestry.ahead_by < 1 || ancestry.behind_by !== 0) fail('GITHUB_PR_ANCESTRY_UNVERIFIED');
    const github = await gh(resource, true), summary = summarizeDeliveryPatch(github.stdout);
    if (summary.sha256 !== result.patch.sha256 || github.stdout !== cloud.stdout) fail('GITHUB_CLOUD_PATCH_MISMATCH');
    if (pr.changed_files !== summary.files.length || pr.additions !== summary.additions || pr.deletions !== summary.deletions) fail('GITHUB_PATCH_INCOMPLETE');
    result.provenance = { verified: true, cloudPatchSha256: result.patch.sha256, githubPatchSha256: summary.sha256, baseSha: pr.base.sha, headSha: pr.head.sha, mergeBaseSha: ancestry.merge_base_commit.sha, comparison: 'exact_complete_text_diff' };
    result.checks = await inspectChecks({ gh, association, repositoryConfig, limits });
    const currentPr = await gh(resource);
    validatePr(currentPr, association);
    if (currentPr.changed_files !== pr.changed_files || currentPr.additions !== pr.additions || currentPr.deletions !== pr.deletions) fail('GITHUB_PR_CHANGED_DURING_INSPECTION');
    if (result.checks.state === 'passed') result.status = 'ready_for_independent_review';
    else result.reasons.push(result.checks.state === 'unconfigured' ? 'CI_REQUIREMENTS_UNCONFIGURED' : result.checks.state === 'failed' ? 'CI_FAILED' : result.checks.state === 'pending' ? 'CI_PENDING' : 'CI_UNVERIFIED');
  } catch (error) {
    result.status = 'needs_attention';
    result.provenance.verified = false;
    result.reasons.push(error instanceof DeliveryError || (typeof error?.code === 'string' && /^(?:DELIVERY_ARTIFACT_[A-Z_]+|INVALID_DELIVERY_ARTIFACT(?:_DIRECTORY)?)$/.test(error.code)) ? error.code : 'DELIVERY_INSPECTION_FAILED');
  }
  return { ...result, observedAt: now() };
}

function previousDelivery(input, repositoryConfig) {
  if (!repositoryConfig || repositoryConfig.schemaVersion !== 1 || typeof repositoryConfig.repository !== 'string' || !repositoryConfig.cloud || !Array.isArray(repositoryConfig.delivery?.requiredChecks) || !repositoryConfig.delivery.requiredChecks.length) fail('INVALID_PREVIOUS_DELIVERY');
  const delivery = input?.delivery, a = delivery?.association, p = delivery?.provenance;
  if (input?.schemaVersion !== 1 || !UUID.test(input.observationId ?? '') || !/^[a-f0-9]{64}$/.test(input.context?.configHash ?? '') || input.context.configHash !== configurationHash(repositoryConfig) || !/^[a-f0-9]{64}$/.test(input.context.policyHash ?? '') || !Number.isInteger(input.context.journalSchemaVersion) || !Number.isInteger(input.context.executionRevision) || input.context.executionRevision < 0 || !Number.isFinite(Date.parse(input.observedAt)) || !a || ['executionId', 'companyId', 'paperclipIssueId', 'paperclipRunId', 'projectId'].some(key => !UUID.test(a[key] ?? '')) || !/^task_e_[a-f0-9]{32}$/.test(a.cloudTaskId ?? '') || a.cloudTaskUrl !== 'https://chatgpt.com/remote/' + a.cloudTaskId || a.repository !== repositoryConfig.repository.toLowerCase() || a.environmentId !== repositoryConfig.cloud.environmentId || (a.deliveryBaseBranch ?? a.requestedBranch) !== repositoryConfig.defaultBranch || !SHA.test(a.expectedBaseSha ?? '') || !SHA.test(a.expectedHeadSha ?? '') || !Number.isSafeInteger(a.pullRequestNumber) || a.pullRequestNumber < 1 || a.pullRequestUrl !== `https://github.com/${a.repository}/pull/${a.pullRequestNumber}`) fail('INVALID_PREVIOUS_DELIVERY');
  if (delivery.status !== 'ready_for_independent_review' || delivery.checks?.state !== 'passed' || !Array.isArray(delivery.checks.required) || delivery.checks.required.some(check => check.state !== 'passed') || JSON.stringify(delivery.checks.required.map(check => check.name).sort()) !== JSON.stringify([...repositoryConfig.delivery.requiredChecks].sort()) || !/^[a-f0-9]{64}$/.test(delivery.patch?.sha256 ?? '') || p?.verified !== true || p.baseSha !== a.expectedBaseSha || p.headSha !== a.expectedHeadSha || p.mergeBaseSha !== a.expectedBaseSha) fail('PREVIOUS_DELIVERY_UNVERIFIED');
  if (p.comparison === 'exact_complete_text_diff') {
    if (p.cloudPatchSha256 !== delivery.patch.sha256 || p.githubPatchSha256 !== delivery.patch.sha256) fail('PREVIOUS_DELIVERY_UNVERIFIED');
  } else if (p.comparison === 'exact_incremental_text_diff_with_full_pr') {
    const delta = p.incremental;
    if (p.fullPrPatchSha256 !== delivery.patch.sha256 || p.githubPatchSha256 !== delivery.patch.sha256 || delta?.verified !== true || !SHA.test(delta.previousHeadSha ?? '') || delta.newHeadSha !== a.expectedHeadSha || delta.mergeBaseSha !== delta.previousHeadSha || !/^[a-f0-9]{64}$/.test(delta.cloudPatchSha256 ?? '') || delta.cloudPatchSha256 !== delta.githubDeltaPatchSha256 || delivery.deltaPatch?.sha256 !== delta.cloudPatchSha256) fail('PREVIOUS_DELIVERY_UNVERIFIED');
  } else fail('PREVIOUS_DELIVERY_UNVERIFIED');
  return delivery;
}
function ancestry(comparison, base) {
  if (comparison?.base_commit?.sha !== base || comparison.merge_base_commit?.sha !== base || comparison.status !== 'ahead' || !Number.isSafeInteger(comparison.ahead_by) || comparison.ahead_by < 1 || comparison.behind_by !== 0) fail('GITHUB_REPAIR_ANCESTRY_UNVERIFIED');
}
function deltaMetadata(comparison, summary) {
  // GitHub caps compare file inventories at 300. At that boundary completeness
  // cannot be established, so require a smaller exact file/stat inventory.
  if (!Array.isArray(comparison.files) || comparison.files.length >= 300 || comparison.files.length !== summary.files.length) fail('GITHUB_REPAIR_DELTA_INCOMPLETE');
  const names = new Set(); let additions = 0, deletions = 0;
  for (const file of comparison.files) {
    if (typeof file.filename !== 'string' || names.has(file.filename) || !summary.files.includes(file.filename) || !Number.isSafeInteger(file.additions) || file.additions < 0 || !Number.isSafeInteger(file.deletions) || file.deletions < 0) fail('GITHUB_REPAIR_DELTA_INCOMPLETE');
    names.add(file.filename); additions += file.additions; deletions += file.deletions;
  }
  if (additions !== summary.additions || deletions !== summary.deletions) fail('GITHUB_REPAIR_DELTA_INCOMPLETE');
}

/** Verify a published repair delta and retain the complete PR patch for review.
 * Manual publication must already have happened. This function only reads. */
export async function inspectRepairGitHubDelivery({ previousDeliveryObservation, repairExecution: execution, repositoryConfig, expectedHeadSha, pullRequest, runtime, run = runCommand, env = process.env, now = () => new Date().toISOString(), captureDelta, capturePatch }) {
  const previous = previousDelivery(previousDeliveryObservation, repositoryConfig), prior = previous.association;
  pullRequest ??= { repository: prior.repository, number: prior.pullRequestNumber };
  const limits = validateInput({ execution, repositoryConfig, expectedBaseSha: prior.expectedBaseSha, expectedHeadSha, pullRequest, runtime }, true);
  if (execution.companyId !== prior.companyId || execution.projectId !== prior.projectId || execution.executionId === prior.executionId || execution.cloudTaskId === prior.cloudTaskId || pullRequest.repository.toLowerCase() !== prior.repository || pullRequest.number !== prior.pullRequestNumber || expectedHeadSha === prior.expectedHeadSha || typeof execution.branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(execution.branch) || /\.\.|\/\/|\/$|\.$|\.lock(?:\/|$)|\/\./.test(execution.branch)) fail('INVALID_REPAIR_DELIVERY_BINDING');
  const association = {
    executionId: execution.executionId, companyId: execution.companyId, paperclipIssueId: execution.paperclipIssueId, paperclipRunId: execution.paperclipRunId, projectId: execution.projectId, attempt: execution.attempt,
    cloudTaskId: execution.cloudTaskId, cloudTaskUrl: 'https://chatgpt.com/remote/' + execution.cloudTaskId,
    repository: execution.repository.toLowerCase(), environmentId: execution.environmentId, requestedBranch: execution.branch,
    deliveryBaseBranch: repositoryConfig.defaultBranch, expectedBaseSha: prior.expectedBaseSha, expectedHeadSha,
    pullRequestNumber: prior.pullRequestNumber, pullRequestUrl: prior.pullRequestUrl,
  };
  const result = { schemaVersion: 1, status: 'needs_attention', association, provenance: { verified: false }, checks: { state: 'unverified', required: [] }, reasons: [], humanApprovalEligible: false, requiresFreshInspection: true };
  const childEnv = cloudEnvironment(env), ghEnv = { ...childEnv };
  for (const key of ['GH_CONFIG_DIR', 'XDG_CONFIG_HOME']) if (typeof env[key] === 'string') ghEnv[key] = env[key];
  const command = async (kind, args, json = false) => {
    let response; try { response = await run(limits[kind + 'Command'], args, { env: kind === 'github' ? ghEnv : childEnv, timeoutMs: limits.timeoutMs, maxOutputBytes: limits.maxOutputBytes }); }
    catch { fail(kind === 'github' ? 'GITHUB_READ_FAILED' : 'CLOUD_DIFF_UNAVAILABLE'); }
    if (response?.code !== 0 || response?.signal || response?.timedOut || response?.outputExceeded || response?.failedToStart) fail(kind === 'github' ? 'GITHUB_READ_FAILED' : 'CLOUD_DIFF_UNAVAILABLE');
    if (typeof response.stdout !== 'string' || Buffer.byteLength(response.stdout) > limits.maxOutputBytes) fail('DELIVERY_OUTPUT_LIMIT');
    if (json) { try { return JSON.parse(response.stdout); } catch { fail('INVALID_GITHUB_RESPONSE'); } }
    return response;
  };
  const gh = (resource, diff = false) => command('github', ['api', '--hostname', 'github.com', '--method', 'GET', '--header', 'Accept: ' + (diff ? 'application/vnd.github.diff' : 'application/vnd.github+json'), '--header', 'X-GitHub-Api-Version: 2022-11-28', resource], !diff);
  try {
    if ((await command('codex', ['--version'])).stdout.trim() !== 'codex-cli 0.167.0') fail('UNSUPPORTED_CODEX_VERSION');
    const login = await command('codex', ['login', 'status']);
    if (!/Logged in using ChatGPT/.test(login.stdout + '\n' + login.stderr)) fail('CODEX_CHATGPT_LOGIN_REQUIRED');
    const cloud = await command('codex', ['cloud', 'diff', execution.cloudTaskId, '--attempt', '1']);
    result.deltaPatch = summarizeDeliveryPatch(cloud.stdout);
    let deltaArtifact;
    if (captureDelta) {
      const stored = await captureDelta({ patch: cloud.stdout, summary: result.deltaPatch, association: { ...association } });
      if (stored !== undefined) {
        if (!path.isAbsolute(stored?.deltaPatchPath ?? '') || stored.deltaPatchSha256 !== result.deltaPatch.sha256 || /[\0\r\n]/.test(stored.deltaPatchPath)) fail('INVALID_DELIVERY_ARTIFACT');
        deltaArtifact = { path: stored.deltaPatchPath, sha256: stored.deltaPatchSha256 };
      }
    }
    const resource = `repos/${association.repository}/pulls/${association.pullRequestNumber}`, pr = await gh(resource);
    validatePr(pr, association);
    if (pr.head.ref !== execution.branch) fail('GITHUB_REPAIR_BRANCH_MISMATCH');
    const deltaResource = `repos/${association.repository}/compare/${prior.expectedHeadSha}...${expectedHeadSha}?per_page=1`;
    const deltaComparison = await gh(deltaResource); ancestry(deltaComparison, prior.expectedHeadSha);
    const delta = await gh(deltaResource, true), deltaSummary = summarizeDeliveryPatch(delta.stdout);
    deltaMetadata(deltaComparison, deltaSummary);
    if (delta.stdout !== cloud.stdout || deltaSummary.sha256 !== result.deltaPatch.sha256) fail('GITHUB_CLOUD_REPAIR_DELTA_MISMATCH');
    const fullResource = `repos/${association.repository}/compare/${prior.expectedBaseSha}...${expectedHeadSha}?per_page=1`;
    const fullComparison = await gh(fullResource);
    ancestry(fullComparison, prior.expectedBaseSha);
    // Read complete text through the immutable commit range, then require the
    // mutable PR endpoint to agree before attributing that patch to this PR.
    const full = await gh(fullResource, true); result.patch = summarizeDeliveryPatch(full.stdout);
    if (capturePatch) await capturePatch({ patch: full.stdout, summary: result.patch, association: { ...association } });
    const prDiff = await gh(resource, true);
    if (prDiff.stdout !== full.stdout) fail('GITHUB_REPAIR_FULL_PATCH_MISMATCH');
    if (pr.changed_files !== result.patch.files.length || pr.additions !== result.patch.additions || pr.deletions !== result.patch.deletions) fail('GITHUB_PATCH_INCOMPLETE');
    result.provenance = { verified: true, comparison: 'exact_incremental_text_diff_with_full_pr', baseSha: prior.expectedBaseSha, headSha: expectedHeadSha, mergeBaseSha: fullComparison.merge_base_commit.sha, fullPrPatchSha256: result.patch.sha256, githubPatchSha256: result.patch.sha256,
      incremental: { verified: true, previousHeadSha: prior.expectedHeadSha, newHeadSha: expectedHeadSha, mergeBaseSha: deltaComparison.merge_base_commit.sha, previousObservationId: previousDeliveryObservation.observationId, previousExecutionId: prior.executionId, previousPatchSha256: previous.patch.sha256, cloudPatchSha256: result.deltaPatch.sha256, githubDeltaPatchSha256: deltaSummary.sha256, ...(deltaArtifact ? { deltaArtifact } : {}) } };
    result.checks = await inspectChecks({ gh, association, repositoryConfig, limits });
    const current = await gh(resource); validatePr(current, association);
    if (current.head.ref !== execution.branch || current.changed_files !== pr.changed_files || current.additions !== pr.additions || current.deletions !== pr.deletions) fail('GITHUB_PR_CHANGED_DURING_INSPECTION');
    if (result.checks.state === 'passed') result.status = 'ready_for_independent_review';
    else result.reasons.push(result.checks.state === 'unconfigured' ? 'CI_REQUIREMENTS_UNCONFIGURED' : result.checks.state === 'failed' ? 'CI_FAILED' : result.checks.state === 'pending' ? 'CI_PENDING' : 'CI_UNVERIFIED');
  } catch (error) {
    result.provenance.verified = false;
    result.reasons.push(error instanceof DeliveryError || typeof error?.code === 'string' && /^(?:DELIVERY_ARTIFACT_[A-Z_]+|INVALID_DELIVERY_ARTIFACT(?:_DIRECTORY)?)$/.test(error.code) ? error.code : 'DELIVERY_INSPECTION_FAILED');
  }
  return { ...result, observedAt: now() };
}
