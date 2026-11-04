import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { RepositoryRegistry, configurationHash } from '../../lib/repository-registry.mjs';
import { DispatchScheduler } from '../../lib/dispatch-scheduler.mjs';
import { ExecutionJournal } from '../../lib/execution-journal.mjs';
import { buildOnboardingPlan, buildRegisteredDispatchConfig } from '../../lib/repository-onboarding.mjs';
import { DeliveryArtifactStore } from '../../lib/delivery-artifacts.mjs';
import { inspectGitHubDelivery } from '../../lib/github-delivery.mjs';
import { bootstrapReviewRoles, buildReviewPlan, ReviewRoleBindings } from '../../lib/review-onboarding.mjs';
import { ReviewPipeline } from '../../lib/review-pipeline.mjs';
import { dispatchReviewFromPaperclip } from '../../lib/review-dispatch.mjs';

export const BASE = 'a'.repeat(40), HEAD = 'b'.repeat(40);
export const PATCH = 'diff --git a/value b/value\nnew file mode 100644\nindex 0000000..1234567\n--- /dev/null\n+++ b/value\n@@ -0,0 +1 @@\n+new\n';
const json = value => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
export function reviewFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-real-review-')), registry = new RepositoryRegistry({ directory: path.join(directory, 'registry') });
  const companyId = randomUUID(), projectId = randomUUID(), workspaceId = randomUUID(), implementationAgentId = randomUUID(), sourceIssueId = randomUUID(), sourceRunId = randomUUID(), repository = 'fixture/project';
  const runtime = { nodeCommand: process.execPath, paperclipCommand: '/fixture/paperclip', codexCommand: '/fixture/codex', githubCommand: '/fixture/github', factoryRoot: process.cwd(), privateDir: path.join(directory, 'instance/onboarding'), apiBase: 'http://127.0.0.1:8100' };
  const { registration } = registry.register({ schemaVersion: 1, repository, cloud: { environmentId: 'a'.repeat(32) }, commands: { test: { argv: ['node', '--test'] } }, delivery: { requiredChecks: ['unit'] } }, { sourcePath: path.join(directory, 'factory.yaml') });
  const main = buildOnboardingPlan({ registration, companyId, runtime }), operationId = randomUUID();
  registry.beginOperation(repository, { expectedConfigHash: registration.configHash, state: 'configured', data: { companyId, plan: main, operationId, planHash: configurationHash(main), projectId, workspaceId, agentId: implementationAgentId } });
  const mainConfig = buildRegisteredDispatchConfig({ registration, companyId, projectId, workspaceId, plan: main }); fs.mkdirSync(path.dirname(main.dispatchConfigPath), { recursive: true }); fs.writeFileSync(main.dispatchConfigPath, JSON.stringify(mainConfig));
  const scheduler = new DispatchScheduler({ directory: main.schedulerDirectory, limits: registration.policy.concurrency }), journal = new ExecutionJournal({ directory: main.journalDirectory, companyId });
  const queued = journal.queue({ companyId, paperclipIssueId: sourceIssueId, paperclipRunId: sourceRunId, projectId, workspaceId, repository, environmentId: registration.config.cloud.environmentId, branch: 'main', mode: 'code_change' }); journal.claim(sourceIssueId, sourceRunId);
  let sourceExecution = journal.accept(sourceIssueId, sourceRunId, { cloudTaskId: 'task_e_' + 'c'.repeat(32), emittedUrl: 'https://chatgpt.com/remote/task_e_' + 'c'.repeat(32), taskUrl: 'https://chatgpt.com/remote/task_e_' + 'c'.repeat(32) });
  sourceExecution = journal.transition(sourceIssueId, { expectedState: 'running', expectedRevision: sourceExecution.revision, toState: 'succeeded' });
  scheduler.registerRepository({ repository, maxActive: registration.config.concurrency.maxActive, maxAttempts: registration.config.concurrency.maxAttempts });
  scheduler.configureLimits({ expectedRevision: scheduler.settings().revision, limits: { ...scheduler.settings().limits, minDispatchIntervalMs: 0 } });
  const sourceIssue = { id: sourceIssueId, companyId, projectId, projectWorkspaceId: workspaceId, assigneeAgentId: implementationAgentId, assigneeUserId: null, status: 'blocked', title: 'Implement fixture', description: 'Factory base SHA: ' + BASE, executionRunId: sourceRunId };
  const primary = { id: workspaceId, companyId, projectId, sourceType: 'git_repo', repoUrl: 'https://github.com/' + repository, repoRef: 'main', defaultRef: 'main', isPrimary: true };
  const f = { directory, registry, registration, scheduler, journal, companyId, projectId, workspaceId, implementationAgentId, repository, runtime, main, sourceExecution, sourceIssueId, calls: [], issues: new Map([[sourceIssueId, sourceIssue]]), agents: new Map(), workspaces: new Map([[workspaceId, primary]]), runs: new Map([[sourceRunId, { id: sourceRunId, companyId, agentId: implementationAgentId, status: 'succeeded', contextSnapshot: { issueId: sourceIssueId } }]]), interactions: [], cloudDiffs: new Map([[sourceExecution.cloudTaskId, PATCH]]), head: HEAD, fullPatch: PATCH, deltaPatch: null, checkState: 'success', createAgentUnknown: false, createTaskUnknown: false, wakeUnknown: false, approvalUnknown: false, agentApproval: false, branchDrift: false, live: [], nextCloud: 1 };
  f.run = async (command, args) => {
    f.calls.push({ command, args });
    if (command === runtime.nodeCommand && args[0] === '--version') return { code: 0, stdout: 'v24.15.0\n', stderr: '' };
    if (command === runtime.codexCommand) {
      if (args[0] === '--version') return { code: 0, stdout: 'codex-cli 0.166.0\n', stderr: '' };
      if (args[0] === 'login') return { code: 0, stdout: '', stderr: 'Logged in using ChatGPT\n' };
      if (args[0] === 'cloud' && args[1] === 'diff') return { code: 0, stdout: f.cloudDiffs.get(args[2]) ?? '', stderr: '' };
      if (args[0] === 'cloud' && args[1] === 'exec') { const cloudTaskId = 'task_e_' + String(f.nextCloud++).padStart(32, '0'); return { code: 0, stdout: 'https://chatgpt.com/remote/' + cloudTaskId + '\n', stderr: '' }; }
      if (args[0] === 'cloud' && args[1] === 'list') return json({ tasks: [], cursor: null });
      throw new Error('Unexpected inert codex command');
    }
    if (command === runtime.githubCommand) {
      const resource = args.at(-1), isDiff = args.some(value => value.includes('application/vnd.github.diff'));
      if (resource.includes('/branches/')) { const name = decodeURIComponent(resource.split('/branches/')[1]); return json({ name, commit: { sha: f.branchDrift ? 'f'.repeat(40) : name === 'main' ? BASE : f.head } }); }
      if (resource.includes('/check-runs?')) return json({ total_count: 1, check_runs: [{ id: 23, name: 'unit', head_sha: f.head, status: 'completed', conclusion: f.checkState, html_url: null, app: { id: 123 } }] });
      if (resource.includes('/status?')) return json({ sha: f.head, repository: { full_name: repository }, total_count: 0, statuses: [] });
      if (resource.includes('/compare/')) { const base = resource.split('/compare/')[1].split('...')[0], delta = base !== BASE; if (isDiff) return { code: 0, stdout: delta ? f.deltaPatch : f.fullPatch, stderr: '' }; return json({ base_commit: { sha: base }, merge_base_commit: { sha: base }, status: 'ahead', ahead_by: 1, behind_by: 0, ...(delta ? { files: [{ filename: 'value', additions: 1, deletions: 1 }] } : {}) }); }
      if (resource.endsWith('/pulls/7')) return isDiff ? { code: 0, stdout: f.fullPatch, stderr: '' } : json({ number: 7, html_url: 'https://github.com/' + repository + '/pull/7', state: 'open', merged: false, draft: false, base: { ref: 'main', sha: BASE, repo: { full_name: repository } }, head: { ref: 'published/head', sha: f.head, repo: { full_name: repository } }, changed_files: 1, additions: 1, deletions: 0 });
      throw new Error('Unexpected inert GitHub resource: ' + resource);
    }
    if (command !== runtime.paperclipCommand) throw new Error('Unexpected inert executable');
    const [kind, action, id] = args, valueAfter = flag => args[args.indexOf(flag) + 1];
    if (kind === 'whoami') return json({ userId: 'local-board', companyIds: [companyId] });
    if (kind === 'agent') {
      if (action === 'list') return json([...f.agents.values()]);
      if (action === 'create') {
        const body = JSON.parse(valueAfter('--payload-json')), agent = { ...body, id: randomUUID(), companyId, status: f.agentApproval ? 'pending_approval' : 'idle' }; f.agents.set(agent.id, agent);
        if (f.createAgentUnknown) return { code: 1, stdout: '', stderr: 'PRIVATE_DIAGNOSTIC' }; return json(agent);
      }
      if (action === 'get') return json(f.agents.get(id));
      if (action === 'configuration') { const agent = f.agents.get(id); if (!agent) return json(null); const { metadata, ...projection } = agent; return json(projection); }
      if (action === 'wake') { const body = JSON.parse(valueAfter('--payload')), wake = { id: randomUUID(), companyId, agentId: id, status: 'succeeded', contextSnapshot: { issueId: body.issueId } }; f.runs.set(wake.id, wake); if (f.wakeUnknown) return { code: 1, stdout: '', stderr: 'PRIVATE_DIAGNOSTIC' }; return json(wake); }
    }
    if (kind === 'project') return json({ id: projectId, companyId, workspaces: [...f.workspaces.values()] });
    if (kind === 'project-workspace') {
      if (action === 'list') return json([...f.workspaces.values()]);
      if (action === 'create') { const body = JSON.parse(valueAfter('--payload-json')), workspace = { ...body, id: randomUUID(), companyId, projectId }; f.workspaces.set(workspace.id, workspace); return json(workspace); }
    }
    if (kind === 'run') return json(f.runs.get(id));
    if (kind === 'issue') {
      if (action === 'get') return json(f.issues.get(id));
      if (action === 'list') return json([...f.issues.values()]);
      if (action === 'live-runs') return json(f.live);
      if (action === 'child:create') {
        const body = JSON.parse(valueAfter('--payload-json')), task = { ...body, id: randomUUID(), companyId, parentId: id, createdByUserId: 'local-board', createdByAgentId: null, assigneeUserId: null }; f.issues.set(task.id, task);
        if (f.createTaskUnknown) return { code: 1, stdout: '', stderr: 'PRIVATE_DIAGNOSTIC' }; return json(task);
      }
      if (action === 'interactions') return json(f.interactions.filter(row => row.issueId === id));
      if (action === 'interaction:create') {
        const body = JSON.parse(valueAfter('--payload-json')), card = { ...body, id: randomUUID(), companyId, issueId: id, createdByUserId: 'local-board', createdByAgentId: null }; f.interactions.push(card);
        if (f.approvalUnknown) return { code: 1, stdout: '', stderr: 'PRIVATE_DIAGNOSTIC' }; return json(card);
      }
    }
    throw new Error('Unexpected inert Paperclip command: ' + args.slice(0, 3).join(' '));
  };
  f.bootstrap = () => bootstrapReviewRoles({ registry, repository, run: f.run });
  f.makeObservation = async () => {
    const store = new DeliveryArtifactStore({ directory: path.join(directory, 'source-delivery') }), result = await inspectGitHubDelivery({ execution: sourceExecution, repositoryConfig: registration.config, expectedBaseSha: BASE, expectedHeadSha: HEAD, pullRequest: { repository, number: 7 }, runtime, run: f.run, capturePatch: value => store.capturePatch(value) });
    const written = store.recordObservation({ result, context: { configHash: registration.configHash, policyHash: registration.policyHash, journalSchemaVersion: 4, executionRevision: sourceExecution.revision } });
    f.observationPath = written.observationPath; f.patchPath = store.patches.get(sourceExecution.executionId).patchPath; return { observationPath: f.observationPath, patchPath: f.patchPath };
  };
  f.pipeline = () => new ReviewPipeline({ directory: buildReviewPlan({ registry, repository }).pipelineDirectory });
  f.dispatch = async job => {
    const agent = f.agents.get(job.agentId), configPath = agent.adapterConfig.args.at(-1), config = JSON.parse(fs.readFileSync(configPath, 'utf8')), runId = randomUUID();
    f.runs.set(runId, { id: runId, companyId, agentId: job.agentId, status: 'running', contextSnapshot: { issueId: job.taskId } });
    const request = async (url, options) => {
      const endpoint = new URL(url).pathname; let value;
      if (endpoint === '/api/agents/me') value = f.agents.get(job.agentId);
      else if (endpoint === '/api/heartbeat-runs/' + runId) value = f.runs.get(runId);
      else if (endpoint === '/api/projects/' + projectId) value = { id: projectId, companyId, workspaces: [...f.workspaces.values()] };
      else if (endpoint.endsWith('/checkout')) { value = f.issues.get(job.taskId); Object.assign(value, { status: 'in_progress', executionRunId: runId, checkoutRunId: runId }); }
      else { value = f.issues.get(endpoint.split('/').at(-1)); if (options.method === 'PATCH') Object.assign(value, JSON.parse(options.body)); }
      return new Response(JSON.stringify(value));
    };
    try { return await dispatchReviewFromPaperclip({ config, context: { companyId, agentId: job.agentId, runId, apiUrl: runtime.apiBase, apiKey: 'FIXTURE_SCOPED_BEARER' }, request, run: f.run }); }
    finally { f.runs.get(runId).status = 'succeeded'; }
  };
  f.finish = (job, outcome = job.role === 'reviewer' ? 'clean' : 'passed') => {
    const execution = journal.getExecution(job.executionId); journal.transition(job.taskId, { expectedState: execution.state, expectedRevision: execution.revision, toState: 'succeeded' });
    const a = job.source.delivery.association, binding = { pipelineId: job.pipelineId, jobId: job.jobId, roleExecutionId: job.executionId, sourceExecutionId: a.executionId, repository, pullRequestNumber: 7, baseSha: a.expectedBaseSha, headSha: a.expectedHeadSha, sourcePatchSha256: job.source.delivery.patch.sha256 };
    const report = { schemaVersion: 1, templateVersion: 1, role: job.role, taskId: job.taskId, repository, baseSha: a.expectedBaseSha, headSha: a.expectedHeadSha, summary: 'Observed fixture verification.', evidence: [{ kind: 'command', description: 'Focused tests executed.', status: 'passed', command: ['node', '--test'], exitCode: 0 }], evidenceSource: 'agent_report', evidenceVerified: false, outcome, ...(job.role === 'reviewer' ? { findings: outcome === 'changes_requested' ? [{ id: 'R1', classification: 'blocking', message: 'Repair the approved defect.', path: 'value', line: 1 }] : [] } : { checks: [{ criterion: 'Approved fixture criterion.', status: 'passed', evidenceIndexes: [0] }] }) };
    const name = '.factory/reviews/' + job.executionId + '.json', lines = JSON.stringify({ schemaVersion: 1, binding, report }, null, 2).split('\n');
    f.cloudDiffs.set(job.cloudTaskId, [`diff --git a/${name} b/${name}`, 'new file mode 100644', 'index 0000000..1234567', '--- /dev/null', '+++ b/' + name, `@@ -0,0 +1,${lines.length} @@`, ...lines.map(line => '+' + line), ''].join('\n'));
    scheduler.adoptJournalExecution(journal.getExecution(job.executionId));
  };
  t.after(() => { journal.close(); scheduler.close(); registry.close(); fs.rmSync(directory, { recursive: true, force: true }); }); return f;
}
