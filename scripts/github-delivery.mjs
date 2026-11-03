#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ExecutionJournal, JOURNAL_FILENAME, JOURNAL_SCHEMA_VERSION, JOURNAL_APPLICATION_ID } from '../lib/execution-journal.mjs';
import { RepositoryRegistry } from '../lib/repository-registry.mjs';
import { inspectGitHubDelivery } from '../lib/github-delivery.mjs';
import { DeliveryArtifactStore } from '../lib/delivery-artifacts.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{40}$/;
const HELP = `Usage: node scripts/github-delivery.mjs 
  --registry ABS_DIRECTORY --repository OWNER/REPO --state-dir EXISTING_ABS_DIRECTORY
  --company UUID --issue UUID --base IMMUTABLE_SHA --artifact-dir ABS_DIRECTORY
  [--attempt 1] [--head IMMUTABLE_SHA --pr NUMBER]
  [--github ABS_GH_EXECUTABLE] [--codex ABS_CODEX_EXECUTABLE] [--json]

Reads an existing registered repository and journal execution. Never dispatches,
applies patches, pushes, creates PRs, merges, deploys, or changes Paperclip status.
Without --pr, captures a patch fallback with unverified base/head provenance.
Passing CI and provenance permit independent review only, not human approval.
`;
const FLAGS = new Set(['--registry', '--repository', '--state-dir', '--company', '--issue', '--attempt', '--base', '--head', '--pr', '--github', '--codex', '--artifact-dir']);
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
    if (flag === '--json') values.set(flag, true);
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
  const pr = values.has('--pr') ? Number(values.get('--pr')) : undefined;
  if (pr !== undefined && (!Number.isSafeInteger(pr) || pr < 1 || !values.has('--head'))) failure('USAGE_GITHUB_DELIVERY');
  const runtime = { githubCommand: values.get('--github') ?? '/opt/homebrew/bin/gh', codexCommand: values.get('--codex') ?? path.join(home, '.local/bin/codex') };
  if (!absolute(runtime.githubCommand) || !absolute(runtime.codexCommand)) failure('USAGE_GITHUB_DELIVERY');
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
    const result = await inspectGitHubDelivery({ execution, repositoryConfig: registration.config, expectedBaseSha: values.get('--base'), expectedHeadSha: values.get('--head'), pullRequest: pr === undefined ? null : { repository: registration.repository, number: pr }, runtime, env, ...(run ? { run } : {}), ...(now ? { now } : {}), capturePatch: evidence => {
      try { return artifacts.capturePatch(evidence); }
      catch (error) { captureFailure = error; throw error; }
    } });
    if (captureFailure) throw captureFailure;
    const recorded = artifacts.recordObservation({ result, context: { configHash: registration.configHash, policyHash: registration.policyHash, journalSchemaVersion: JOURNAL_SCHEMA_VERSION, executionRevision: execution.revision } });
    const output = { status: result.status, association: result.association, provenance: result.provenance, checks: { state: result.checks.state, required: result.checks.required.map(check => ({ name: check.name, state: check.state, links: check.observations?.map(row => row.url).filter(Boolean) ?? [] })) }, reasons: result.reasons, humanApprovalEligible: false, artifacts: recorded };
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
      stdout('  Independent review and explicit human approval are still required.\n');
    }
    return result.status === 'ready_for_independent_review' ? 0 : 1;
  } catch (error) {
    const code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(error.code) ? error.code : 'DELIVERY_COMMAND_FAILED';
    const result = { status: 'needs_attention', code, correction: advice[code] ?? 'Inspect the original execution and delivery prerequisites; no remote write or automatic retry was made.' };
    stderr(json ? JSON.stringify(result) + '\n' : `${code}: ${result.correction}\n`);
    return 1;
  } finally { journal?.close(); registry?.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runDeliveryCli(process.argv.slice(2));
