import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { configurationHash } from '../../lib/repository-registry.mjs';
import { buildRegisteredDispatchConfig } from '../../lib/repository-onboarding.mjs';
import { ReviewRoleBindings, bootstrapReviewRoles, buildReviewPlan } from '../../lib/review-onboarding.mjs';
import { updateRepositoryConfiguration } from '../../lib/repository-update.mjs';
import { reviewFixture, BASE } from './review-runtime.mjs';

const json = value => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });
const writeJson = (filename, value) => fs.writeFileSync(filename, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

/** Inert native objects use the same bootstrap plans and metadata-free agent
 * projection as Paperclip. Only the optional fixture setup creates role agents;
 * the update runner rejects every external write and Cloud submission. */
export async function configurationUpdateFixture(t, { roles = true } = {}) {
  const f = reviewFixture(t), operation = f.registry.getOperation(f.repository);
  f.registry.updateOperation(f.repository, { expectedRevision: operation.revision, state: 'configured', data: { ...operation.data, configurationWritten: true } });
  const marker = { registrationId: operation.data.operationId, repository: f.repository };
  f.project = { id: f.projectId, companyId: f.companyId, name: f.main.project.name, description: 'factory-onboarding-v1:' + marker.registrationId + ':' + marker.repository, archivedAt: null };
  Object.assign(f.workspaces.get(f.workspaceId), f.main.workspace, { metadata: { factory: marker } });
  f.oldDispatchConfig = buildRegisteredDispatchConfig({ registration: f.registration, companyId: f.companyId, projectId: f.projectId, workspaceId: f.workspaceId, plan: f.main });
  writeJson(f.main.dispatchConfigPath, f.oldDispatchConfig); writeJson(f.main.taskContractPath, f.main.taskContract);
  f.agents.set(f.implementationAgentId, {
    id: f.implementationAgentId, companyId: f.companyId, status: 'idle', adapterType: 'process', metadata: { factory: marker },
    adapterConfig: { command: f.runtime.nodeCommand, args: [path.join(f.runtime.factoryRoot, 'scripts/cloud-dispatch.mjs'), '--config', f.main.dispatchConfigPath], cwd: f.runtime.factoryRoot, timeoutSec: 180, graceSec: 10 },
    runtimeConfig: { heartbeat: { enabled: false, intervalSec: 0, wakeOnDemand: true, maxConcurrentRuns: 1 } },
  });
  if (roles) await bootstrapReviewRoles({ registry: f.registry, repository: f.repository, run: f.run });
  f.scheduler.adoptJournalExecution(f.sourceExecution);
  f.scheduler.setPaused(true);
  f.updateCalls = [];
  f.availableChecks = ['unit', 'application-tests'];
  f.agentGetPatch = {};
  f.projectionPatch = {};
  f.nativeRuns = [];
  const originalRun = f.run;
  f.run = async (command, args, options) => {
    f.updateCalls.push({ command, args, options });
    const [group, action, id] = args;
    if (command === f.runtime.githubCommand) {
      const resource = args.at(-1);
      if (resource === 'repos/' + f.repository) return json({ full_name: f.repository, default_branch: 'main', archived: false, disabled: false });
      if (resource.includes('/check-runs?')) {
        const sha = resource.match(/\/commits\/([a-f0-9]{40})\//)[1];
        return json({ total_count: f.availableChecks.length, check_runs: f.availableChecks.map((name, index) => ({ id: index + 1, name, head_sha: sha, status: 'completed', conclusion: 'success', app: { id: 123 } })) });
      }
      if (resource.includes('/status?')) return json({ sha: resource.match(/\/commits\/([a-f0-9]{40})\//)[1], repository: { full_name: f.repository }, total_count: 0, statuses: [] });
      if (resource.includes('/pulls?')) return json([]);
      return originalRun(command, args, options);
    }
    if (command === f.runtime.codexCommand && group === 'cloud' && action === 'list') return json({ tasks: [{ id: f.sourceExecution.cloudTaskId, environment_id: f.registration.config.cloud.environmentId, environment_label: f.repository }], cursor: null });
    if (command === f.runtime.paperclipCommand) {
      if (group === '--version') return { code: 0, stdout: '2026.1023.0\n', stderr: '' };
      if (group === 'company' && action === 'get') return json({ id: f.companyId, status: 'active' });
      if (group === 'project' && action === 'get') return json(f.project);
      if (group === 'project' && action === 'list') return json([f.project]);
      if (group === 'run' && action === 'list') return json(f.nativeRuns);
      if (group === 'agent' && action === 'get') return json({ ...f.agents.get(id), ...f.agentGetPatch });
      if (group === 'agent' && action === 'configuration') {
        const { metadata, ...projection } = f.agents.get(id);
        return json({ ...projection, ...f.projectionPatch });
      }
      if (!(['project-workspace', 'agent'].includes(group) && action === 'list') && group !== 'whoami') throw new Error('Unexpected native mutation or unsupported read: ' + args.slice(0, 3).join(' '));
    }
    if (command === f.runtime.codexCommand && group === 'cloud' && action !== 'list' && action !== 'diff') throw new Error('Unexpected Cloud submission');
    return originalRun(command, args, options);
  };
  f.config = { ...f.registration.config, delivery: { ...f.registration.config.delivery, requiredChecks: ['unit', 'application-tests'] } };
  f.sourcePath = path.join(f.directory, 'updated.factory.yaml');
  f.update = options => updateRepositoryConfiguration({ registry: f.registry, repository: f.repository, config: f.config, sourcePath: f.sourcePath, expectedConfigHash: f.registration.configHash, run: f.run, ...options });
  f.roleRecords = () => {
    const directory = path.join(path.dirname(f.main.dispatchConfigPath), 'review');
    if (!fs.existsSync(path.join(directory, 'role-bindings.sqlite'))) return [];
    const store = new ReviewRoleBindings({ directory }); try { return store.list(); } finally { store.close(); }
  };
  f.contractFiles = () => {
    const names = [f.main.dispatchConfigPath, f.main.taskContractPath, ...f.roleRecords().filter(row => row.key.startsWith('role:')).map(row => path.join(path.dirname(f.main.dispatchConfigPath), 'review', row.key.slice(5) + '.json'))];
    return Object.fromEntries(names.map(filename => [filename, fs.readFileSync(filename, 'utf8')]));
  };
  f.queueJournal = (state = 'queued') => {
    const issueId = randomUUID(), runId = randomUUID();
    let row = f.journal.queue({ companyId: f.companyId, paperclipIssueId: issueId, paperclipRunId: runId, projectId: f.projectId, workspaceId: f.workspaceId, repository: f.repository, environmentId: f.registration.config.cloud.environmentId, branch: 'main', mode: 'code_change' });
    if (state === 'unknown') { f.journal.claim(issueId, runId); row = f.journal.transition(issueId, { expectedState: 'dispatching', expectedRevision: 1, toState: 'unknown', errorCode: 'INTERRUPTED_DISPATCH' }); }
    return row;
  };
  f.assertCanonical = () => {
    const registration = f.registry.get(f.repository), current = f.registry.getOperation(f.repository);
    if (current.data.plan.configHash !== registration.configHash || current.data.planHash !== configurationHash(current.data.plan)) throw new Error('Noncanonical registered plan');
    return { registration, operation: current, reviewPlan: roles ? buildReviewPlan({ registry: f.registry, repository: f.repository }) : null };
  };
  f.baseSha = BASE;
  return f;
}
