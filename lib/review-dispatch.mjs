import fs from 'node:fs';
import path from 'node:path';
import { dispatchFromPaperclip, validateProjectConfig, DispatchError, runCommand } from './cloud-dispatch.mjs';
import { configurationHash } from './repository-registry.mjs';
import { renderAgentRole } from './agent-roles.mjs';
import { DatabaseSync } from 'node:sqlite';
import { ReviewRoleBindings } from './review-onboarding.mjs';
import { ReviewPipeline } from './review-pipeline.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PLACEHOLDER = '00000000-0000-4000-8000-000000000000';
const fail = code => { throw new DispatchError(code); };
function originFor(context) {
  if (!context || !['companyId', 'agentId', 'runId'].every(key => UUID.test(context[key] ?? '')) || typeof context.apiKey !== 'string' || !context.apiKey || /[\r\n]/.test(context.apiKey)) fail('INVALID_REVIEW_CONTEXT');
  let url; try { url = new URL(context.apiUrl); } catch { fail('INVALID_API_ORIGIN'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('INVALID_API_ORIGIN');
  return url.origin;
}
async function readPrivateTask(context, config, request) {
  const origin = originFor(context);
  if (context.companyId !== config.companyId) fail('COMPANY_MISMATCH');
  const get = async endpoint => {
    let response;
    try { response = await request(origin + endpoint, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Authorization: 'Bearer ' + context.apiKey, 'X-Paperclip-Run-Id': context.runId, 'Content-Type': 'application/json' } }); }
    catch { fail('PAPERCLIP_UNAVAILABLE'); }
    if (!response?.ok) fail('PAPERCLIP_REQUEST_REJECTED');
    try {
      let bytes = 0; const chunks = [];
      if (response.body) for await (const chunk of response.body) { const value = Buffer.from(chunk); bytes += value.length; if (bytes > 1_000_000) fail('PAPERCLIP_RESPONSE_TOO_LARGE'); chunks.push(value); }
      else { const value = Buffer.from(await response.text()); if (value.length > 1_000_000) fail('PAPERCLIP_RESPONSE_TOO_LARGE'); chunks.push(value); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) { if (error instanceof DispatchError) throw error; fail('INVALID_PAPERCLIP_RESPONSE'); }
  };
  const agent = await get('/api/agents/me');
  if (agent.id !== context.agentId || agent.companyId !== context.companyId) fail('AGENT_MISMATCH');
  const heartbeat = await get('/api/heartbeat-runs/' + context.runId);
  if (heartbeat.id !== context.runId || heartbeat.agentId !== context.agentId || heartbeat.companyId !== context.companyId || heartbeat.status !== 'running' || !UUID.test(heartbeat.contextSnapshot?.issueId ?? '')) fail('RUN_MISMATCH');
  const task = await get('/api/issues/' + heartbeat.contextSnapshot.issueId);
  if (task.id !== heartbeat.contextSnapshot.issueId || task.companyId !== config.companyId || task.projectId !== config.projectId || task.assigneeAgentId !== context.agentId || task.assigneeUserId || !['todo', 'in_progress', 'blocked'].includes(task.status)) fail('TASK_SCOPE_MISMATCH');
  return { task, read: get };
}
function checkSource(job, config, agentId) {
  const a = job.source.delivery.association;
  if (job.role !== config.factoryRole || job.agentId !== agentId || a.companyId !== config.companyId || a.projectId !== config.projectId || a.repository !== config.repository || a.environmentId !== config.environmentId || job.source.context.configHash !== configurationHash(config.factoryConfig) || job.source.context.policyHash !== configurationHash(config.factoryPolicy)) fail('REVIEW_REGISTERED_BINDING_CHANGED');
  const checkout = job.checkout, expected = checkout?.mode === 'provided_patch_on_base' ? a.expectedBaseSha : a.expectedHeadSha;
  if (!checkout || !['provided_patch_on_base', 'exact_head'].includes(checkout.mode) || job.role !== 'reviewer' && checkout.mode !== 'exact_head' || checkout.expectedSha !== expected || checkout.branchObservation?.name !== checkout.branch || checkout.branchObservation?.commit?.sha !== expected || !UUID.test(checkout.workspaceId ?? '')) fail('REVIEW_CHECKOUT_BINDING_CHANGED');
}
export function renderReviewJobPrompt({ job, task, config, patch, executionId = PLACEHOLDER }) {
  const source = job.source.delivery, a = source.association;
  const baseSha = job.role === 'implementer' ? job.checkout.expectedSha : a.expectedBaseSha;
  const roleInput = { role: config.factoryRole, templateVersion: 1, repository: config.repository, branch: job.checkout.branch, task: { id: task.id, title: task.title, description: task.description }, baseSha, commands: config.factoryConfig.commands, delivery: config.factoryConfig.delivery, attempt: 1, maxAttempts: config.factoryConfig.concurrency.maxAttempts, receipt: { executionId: a.executionId, cloudTaskId: a.cloudTaskId, taskUrl: a.cloudTaskUrl }, ci: source.checks.required };
  if (job.role === 'implementer') return renderAgentRole(roleInput);
  roleInput.pullRequest = { repository: a.repository, number: a.pullRequestNumber, url: a.pullRequestUrl, baseSha: a.expectedBaseSha, headSha: a.expectedHeadSha };
  return renderAgentRole(roleInput, { trustedArtifact: { checkoutMode: job.checkout.mode, expectedCheckoutSha: job.checkout.expectedSha, binding: { pipelineId: job.pipelineId, jobId: job.jobId, roleExecutionId: executionId, sourceExecutionId: a.executionId, repository: a.repository, pullRequestNumber: a.pullRequestNumber, baseSha: a.expectedBaseSha, headSha: a.expectedHeadSha, sourcePatchSha256: source.patch.sha256 }, sourcePatch: patch } });
}

/** Private-role dispatch wrapper. Task data can identify a ledger job, never choose authority. */
export async function dispatchReviewFromPaperclip({ config: input, context, stateDir, run = runCommand, request = fetch, env = process.env } = {}) {
  const config = validateProjectConfig(input);
  if (!['implementer', 'reviewer', 'qa'].includes(config.factoryRole) || config.mode !== 'code_change' || !config.factoryConfig || config.attempt !== 1 || typeof config.reviewPipelineDirectory !== 'string' || !path.isAbsolute(config.reviewPipelineDirectory) || /[\0\r\n]/.test(config.reviewPipelineDirectory)) fail('INVALID_REVIEW_DISPATCH_CONFIG');
  const { task, read } = await readPrivateTask(context, config, request);
  const markers = typeof task.description === 'string' ? [...task.description.matchAll(/^Factory review job: ([a-f0-9-]{36})$/gm)] : [];
  if (!markers.length && config.factoryRole === 'implementer') return { ...await dispatchFromPaperclip({ config, context, stateDir, run, request, env }), evidenceVerified: false };
  if (markers.length !== 1 || !UUID.test(markers[0][1])) fail('REVIEW_JOB_MARKER_REQUIRED');
  const database = path.join(config.reviewPipelineDirectory, 'review-pipeline.sqlite');
  let stat; try { stat = fs.lstatSync(database); } catch { fail('REVIEW_PIPELINE_UNAVAILABLE'); }
  if (!stat.isFile() || stat.isSymbolicLink() || fs.lstatSync(config.reviewPipelineDirectory).isSymbolicLink()) fail('REVIEW_PIPELINE_UNAVAILABLE');
  let probe;
  try { probe = new DatabaseSync(database, { readOnly: true }); if (probe.prepare('PRAGMA application_id').get().application_id !== 0x46525031 || probe.prepare('PRAGMA user_version').get().user_version !== 1) fail('REVIEW_PIPELINE_UNAVAILABLE'); }
  catch { fail('REVIEW_PIPELINE_UNAVAILABLE'); } finally { probe?.close(); }
  const pipeline = new ReviewPipeline({ directory: config.reviewPipelineDirectory });
  let bindings;
  try {
    let resolution = pipeline.resolveTaskBinding(markers[0][1], { task, agentId: context.agentId }), job = resolution.job;
    checkSource(job, config, context.agentId);
    if (resolution.status === 'binding_pending') return { schemaVersion: 1, status: 'binding_pending', jobId: job.jobId, pipelineId: job.pipelineId, paperclipIssueId: task.id, companyId: config.companyId, evidenceVerified: false };
    const bindingDirectory = path.dirname(config.reviewPipelineDirectory);
    if (!fs.existsSync(path.join(bindingDirectory, 'role-bindings.sqlite'))) fail('REVIEW_PIPELINE_NOT_APPROVED');
    bindings = new ReviewRoleBindings({ directory: bindingDirectory });
    const verifyParent = async () => {
      const activation = bindings.get('activation:' + job.pipelineId), constraint = activation?.data.sourceTask;
      if (!activation?.data.approvedDispatch || activation.data.sourceConfigHash !== configurationHash(config.factoryConfig) || activation.data.policyHash !== configurationHash(config.factoryPolicy) || !constraint || constraint.id !== pipeline.get(job.pipelineId).initialSource.delivery.association.paperclipIssueId) fail('REVIEW_PIPELINE_NOT_APPROVED');
      if (activation.state !== 'active') fail('REVIEW_PIPELINE_PAUSED');
      const parent = await read('/api/issues/' + constraint.id);
      if (!parent || ['done', 'cancelled'].includes(parent.status) || ['id', 'companyId', 'projectId', 'title', 'description'].some(key => parent[key] !== constraint[key])) fail('REVIEW_PARENT_SCOPE_CHANGED');
    };
    await verifyParent();
    const source = job.source.delivery, a = source.association;
    const patch = pipeline.sourcePatch(job.jobId);
    const effectiveConfig = { ...config, branch: job.checkout.branch, workspaceId: job.checkout.workspaceId, factoryConfig: { ...config.factoryConfig, defaultBranch: job.checkout.branch } };
    const promptFactory = async (currentTask, _effective, { execution } = {}) => {
      await verifyParent();
      if (currentTask.assigneeUserId || currentTask.assigneeAgentId !== context.agentId || !['todo', 'in_progress', 'blocked'].includes(currentTask.status)) fail('TASK_SCOPE_MISMATCH');
      const current = pipeline.resolveTaskBinding(job.jobId, { task: currentTask, agentId: context.agentId });
      if (current.status !== 'bound') fail('REVIEW_TASK_BINDING_PENDING');
      checkSource(current.job, config, context.agentId);
      const executionId = execution?.executionId ?? PLACEHOLDER;
      if (!UUID.test(executionId)) fail('REVIEW_EXECUTION_BINDING_CHANGED');
      return renderReviewJobPrompt({ job, task: currentTask, config, patch, executionId });
    };
    const onQueued = execution => {
      job = pipeline.getJob(job.jobId);
      if (!job.executionId) job = pipeline.bindExecution(job.jobId, { expectedRevision: job.revision, execution });
      else if (job.executionId !== execution.executionId) fail('REVIEW_EXECUTION_BINDING_CHANGED');
    };
    const onObserved = execution => {
      job = pipeline.getJob(job.jobId);
      if (job.executionId !== execution.executionId) fail('REVIEW_EXECUTION_BINDING_CHANGED');
      if (job.execution && JSON.stringify(job.execution) === JSON.stringify(execution)) return;
      job = pipeline.observeExecution(job.jobId, { expectedRevision: job.revision, execution });
    };
    return { ...await dispatchFromPaperclip({ config: effectiveConfig, context, stateDir, run, request, env, promptFactory, onQueued, onObserved, registeredConfigHash: configurationHash(config.factoryConfig) }), evidenceVerified: false };
  } catch (error) {
    if (error instanceof DispatchError) throw error;
    const code = typeof error?.code === 'string' && /^(?:REVIEW_PIPELINE|ROLE)_[A-Z_]+$/.test(error.code) ? error.code : 'REVIEW_DISPATCH_FAILED';
    throw new DispatchError(code, 'rejected');
  } finally { bindings?.close(); pipeline.close(); }
}
