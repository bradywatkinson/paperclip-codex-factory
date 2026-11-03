#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ExecutionJournal, JOURNAL_FILENAME, JOURNAL_SCHEMA_VERSION, JOURNAL_APPLICATION_ID } from '../lib/execution-journal.mjs';
import { RepositoryRegistry } from '../lib/repository-registry.mjs';
import { inspectGitHubDelivery, inspectRepairGitHubDelivery } from '../lib/github-delivery.mjs';
import { DeliveryArtifactStore } from '../lib/delivery-artifacts.mjs';
import { notifyDeliveryFromPaperclip } from '../lib/delivery-notification.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{40}$/;
const HELP = `Usage: node scripts/github-delivery.mjs
  --registry ABS_DIRECTORY --repository OWNER/REPO --state-dir EXISTING_ABS_DIRECTORY
  --company UUID --issue UUID --base IMMUTABLE_SHA --artifact-dir ABS_DIRECTORY
  [--attempt 1] [--head IMMUTABLE_SHA --pr NUMBER]
  [--previous-observation ABS_JSON_FILE --head NEW_IMMUTABLE_SHA]
  [--notify-paperclip --paperclip ABS_PAPERCLIP_EXECUTABLE --api-base http://127.0.0.1:8100]
  [--github ABS_GH_EXECUTABLE] [--codex ABS_CODEX_EXECUTABLE] [--json]

Reads an existing registered repository and journal execution. Never dispatches,
applies patches, pushes, creates PRs, merges, deploys, or changes Paperclip status.
Without --pr, captures a patch fallback with unverified base/head provenance.
Passing CI and provenance permit independent review only, not human approval.
Repair mode verifies an already published incremental patch; publication is manual.
Opt-in notification creates one informational human-only Paperclip card. It does
not approve work, change task status, or wake agents. Unknown writes are read-recovered only.
`;
const FLAGS = new Set(['--registry', '--repository', '--state-dir', '--company', '--issue', '--attempt', '--base', '--head', '--pr', '--github', '--codex', '--artifact-dir', '--previous-observation', '--paperclip', '--api-base']);
const advice = {
  USAGE_GITHUB_DELIVERY: 'Use --help for the required identifiers, immutable base SHA, and absolute storage paths.',
  DELIVERY_REGISTRY_NOT_FOUND: 'Register the repository with factory repo add before inspecting delivery.',
  DELIVERY_JOURNAL_NOT_FOUND: 'Use the existing dispatch journal directory; this command will not create a replacement journal.',
  DELIVERY_JOURNAL_MIGRATION_REQUIRED: 'Follow the documented stopped-backup and explicit journal migration procedure first.',
  DELIVERY_EXECUTION_NOT_FOUND: 'Inspect the original Paperclip issue and logical attempt in the existing journal.',
  REPOSITORY_NOT_REGISTERED: 'Register the intended repository before inspecting its Cloud result.',
  DELIVERY_EXECUTION_NOT_READY: 'Reconcile the original Cloud task to READY first; do not submit another job.',
};
const failure = code => { throw Object.assign(new Error(code), { code }); };
function absolute(value) { return typeof value === 'string' && path.isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value); }
function existingFile(directory, filename, code) {
  let directoryStat, stat;
  try { directoryStat = fs.lstatSync(directory); stat = fs.lstatSync(path.join(directory, filename)); }
  catch { failure(code); }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink()) failure(code);
}
function parse(args, home) {
  if (!args.length || args.includes('--help')) return { help: true };
  const values = new Map();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (values.has(flag)) failure('USAGE_GITHUB_DELIVERY');
    if (['--json', '--notify-paperclip'].includes(flag)) values.set(flag, true);
    else if (FLAGS.has(flag)) {
      const value = args[++index]; if (!value || value.startsWith('--')) failure('USAGE_GITHUB_DELIVERY');
      values.set(flag, value);
    } else failure('USAGE_GITHUB_DELIVERY');
  }
  for (const key of ['--registry', '--state-dir', '--artifact-dir']) if (!absolute(values.get(key))) failure('USAGE_GITHUB_DELIVERY');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(values.get('--repository') ?? '') || ['--company', '--issue'].some(key => !UUID.test(values.get(key) ?? '')) || !SHA.test(values.get('--base') ?? '')) failure('USAGE_GITHUB_DELIVERY');
  const attempt = values.has('--attempt') ? Number(values.get('--attempt')) : 1;
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 100) failure('USAGE_GITHUB_DELIVERY');
  if (values.has('--head') && !SHA.test(values.get('--head'))) failure('USAGE_GITHUB_DELIVERY');
  if (values.has('--previous-observation') && (!absolute(values.get('--previous-observation')) || !values.has('--head'))) failure('USAGE_GITHUB_DELIVERY');
  const pr = values.has('--pr') ? Number(values.get('--pr')) : undefined;
  if (pr !== undefined && (!Number.isSafeInteger(pr) || pr < 1 || !values.has('--head'))) failure('USAGE_GITHUB_DELIVERY');
  const runtime = { githubCommand: values.get('--github') ?? '/opt/homebrew/bin/gh', codexCommand: values.get('--codex') ?? path.join(home, '.local/bin/codex') };
  if (!absolute(runtime.githubCommand) || !absolute(runtime.codexCommand)) failure('USAGE_GITHUB_DELIVERY');
  if (values.has('--notify-paperclip')) {
    if (!absolute(values.get('--paperclip'))) failure('USAGE_GITHUB_DELIVERY');
    let url; try { url = new URL(values.get('--api-base')); } catch { failure('USAGE_GITHUB_DELIVERY'); }
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') failure('USAGE_GITHUB_DELIVERY');
  } else if (values.has('--paperclip') || values.has('--api-base')) failure('USAGE_GITHUB_DELIVERY');
  return { values, attempt, pr, runtime };
}
function checkJournalSchema(directory) {
  const db = new DatabaseSync(path.join(directory, JOURNAL_FILENAME), { readOnly: true });
  try {
    if (db.prepare('PRAGMA user_version').get().user_version !== JOURNAL_SCHEMA_VERSION || db.prepare('PRAGMA application_id').get().application_id !== JOURNAL_APPLICATION_ID) failure('DELIVERY_JOURNAL_MIGRATION_REQUIRED');
  } finally { db.close(); }
}

export async function runDeliveryCli(args, { stdout = value => process.stdout.write(value), stderr = value => process.stderr.write(value), run, now, home = os.homedir(), env = process.env } = {}) {
  let registry, journal;
  const json = args.includes('--json');
  try {
    const options = parse(args, home);
    if (options.help) { stdout(HELP); return 0; }
    const { values, attempt, pr, runtime } = options;
    existingFile(values.get('--registry'), 'registry.sqlite', 'DELIVERY_REGISTRY_NOT_FOUND');
    existingFile(values.get('--state-dir'), JOURNAL_FILENAME, 'DELIVERY_JOURNAL_NOT_FOUND');
    checkJournalSchema(values.get('--state-dir'));
    registry = new RepositoryRegistry({ directory: values.get('--registry') });
    const registration = registry.get(values.get('--repository'));
    if (!registration) failure('REPOSITORY_NOT_REGISTERED');
    journal = new ExecutionJournal({ directory: values.get('--state-dir'), companyId: values.get('--company') });
    const execution = journal.get(values.get('--issue'), attempt);
    if (!execution) failure('DELIVERY_EXECUTION_NOT_FOUND');
    const artifacts = new DeliveryArtifactStore({ directory: values.get('--artifact-dir') });
    let captureFailure;
    const shared = { repositoryConfig: registration.config, expectedHeadSha: values.get('--head'), runtime, env, ...(run ? { run } : {}), ...(now ? { now } : {}), capturePatch: evidence => {
      try { return artifacts.capturePatch(evidence); }
      catch (error) { captureFailure = error; throw error; }
    } };
    let result;
    if (values.has('--previous-observation')) {
      const filename = values.get('--previous-observation'); let previous;
      try {
        const stat = fs.lstatSync(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000) failure('INVALID_PREVIOUS_DELIVERY');
        previous = JSON.parse(fs.readFileSync(filename, 'utf8'));
      } catch { failure('INVALID_PREVIOUS_DELIVERY'); }
      if (previous.context?.configHash !== registration.configHash || previous.context?.policyHash !== registration.policyHash || previous.delivery?.association?.expectedBaseSha !== values.get('--base')) failure('INVALID_PREVIOUS_DELIVERY');
      result = await inspectRepairGitHubDelivery({ ...shared, previousDeliveryObservation: previous, repairExecution: execution, ...(pr === undefined ? {} : { pullRequest: { repository: registration.repository, number: pr } }), captureDelta: evidence => {
        try { return artifacts.captureDelta(evidence); }
        catch (error) { captureFailure = error; throw error; }
      } });
    } else result = await inspectGitHubDelivery({ ...shared, execution, expectedBaseSha: values.get('--base'), pullRequest: pr === undefined ? null : { repository: registration.repository, number: pr } });
    if (captureFailure) throw captureFailure;
    const recorded = artifacts.recordObservation({ result, context: { configHash: registration.configHash, policyHash: registration.policyHash, journalSchemaVersion: JOURNAL_SCHEMA_VERSION, executionRevision: execution.revision } });
    const output = { status: result.status, association: result.association, provenance: result.provenance, checks: { state: result.checks.state, required: result.checks.required.map(check => ({ name: check.name, state: check.state, links: check.observations?.map(row => row.url).filter(Boolean) ?? [] })) }, reasons: result.reasons, humanApprovalEligible: false, artifacts: recorded };
    if (values.has('--notify-paperclip')) output.notification = await notifyDeliveryFromPaperclip({ observation: JSON.parse(fs.readFileSync(recorded.observationPath, 'utf8')), execution, registration, directory: path.join(values.get('--artifact-dir'), 'notifications'), runtime: { paperclipCommand: values.get('--paperclip'), apiBase: values.get('--api-base') }, ...(run ? { run } : {}), ...(now ? { now } : {}), env });
    if (json) stdout(JSON.stringify(output) + '\n');
    else {
      stdout(`${output.status}\n  Cloud: ${output.association.cloudTaskUrl}\n`);
      if (output.association.pullRequestUrl) stdout(`  PR: ${output.association.pullRequestUrl}\n`);
      stdout(`  CI: ${output.checks.state}\n`);
      for (const check of output.checks.required) {
        stdout(`  ${check.name}: ${check.state}\n`);
        for (const link of check.links) stdout(`    ${link}\n`);
      }
      if (output.reasons.length) stdout(`  Attention: ${output.reasons.join(', ')}\n`);
      stdout(`  Observation: ${recorded.observationPath}\n`);
      if (recorded.patchPath) stdout(`  Patch: ${recorded.patchPath}\n`);
      if (recorded.deltaPatchPath) stdout(`  Repair delta: ${recorded.deltaPatchPath}\n`);
      if (output.notification) stdout(`  Paperclip notification: ${output.notification.status}${output.notification.code ? ' (' + output.notification.code + ')' : ''}\n`);
      stdout('  Independent review and explicit human approval are still required.\n');
    }
    return result.status === 'ready_for_independent_review' && !['notification_unknown', 'deferred'].includes(output.notification?.status) ? 0 : 1;
  } catch (error) {
    const code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(error.code) ? error.code : 'DELIVERY_COMMAND_FAILED';
    const result = { status: 'needs_attention', code, correction: advice[code] ?? 'Inspect the original execution and delivery prerequisites; no remote write or automatic retry was made.' };
    stderr(json ? JSON.stringify(result) + '\n' : `${code}: ${result.correction}\n`);
    return 1;
  } finally { journal?.close(); registry?.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runDeliveryCli(process.argv.slice(2));
