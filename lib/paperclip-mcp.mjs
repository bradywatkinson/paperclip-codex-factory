import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { cloudEnvironment, runCommand } from './cloud-dispatch.mjs';
import { McpIntentStore } from './mcp-intents.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ID = z.string().regex(UUID), KEY = z.string().regex(UUID);
const COUNT = z.number().int().min(1).max(100).optional();
const STATUSES = ['backlog', 'todo', 'in_progress', 'blocked', 'done', 'cancelled'];
const requiredText = (limit, multiline = false) => z.string().min(1).refine(value => value.trim() && Buffer.byteLength(value) <= limit && !(multiline ? /[\u0000\u007f]/ : /[\u0000-\u001f\u007f]/).test(value), 'Invalid or oversized text');
export class PaperclipMcpError extends Error {
  constructor(code) { super(code); this.name = 'PaperclipMcpError'; this.code = code; }
}
const fail = code => { throw new PaperclipMcpError(code); };
const safeCode = error => typeof error?.code === 'string' && /^(?:MCP|INVALID_MCP)_[A-Z_]+$/.test(error.code) ? error.code : 'MCP_OPERATION_FAILED';
const json = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
function safeText(value, maximum) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maximum || /[\u0000-\u001f\u007f]/.test(value)) fail('MCP_INVALID_RESPONSE');
  return value;
}
function canonical(value) { return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : Array.isArray(value) ? value.map(canonical) : value; }
const payloadHash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function validatePaperclipMcpConfig(input) {
  const allowed = ['schemaVersion', 'companyId', 'projectIds', 'agentIds', 'paperclipCommand', 'apiBase', 'stateDir', 'allowAssignments', 'timeoutMs', 'maxOutputBytes', 'maxRecords'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key)) || input.schemaVersion !== 1 || !UUID.test(input.companyId ?? '')) fail('INVALID_MCP_CONFIG');
  const config = { ...input };
  for (const key of ['projectIds', 'agentIds']) {
    if (!Array.isArray(config[key]) || !config[key].length || config[key].length > 50 || config[key].some(value => typeof value !== 'string' || !UUID.test(value)) || new Set(config[key]).size !== config[key].length) fail('INVALID_MCP_ALLOWLIST');
    config[key] = Object.freeze([...config[key]]);
  }
  for (const key of ['paperclipCommand', 'stateDir']) if (typeof config[key] !== 'string' || !path.isAbsolute(config[key]) || /[\u0000-\u001f\u007f]/.test(config[key])) fail('INVALID_MCP_PATH');
  let url; try { url = new URL(config.apiBase ?? 'http://127.0.0.1:8100'); } catch { fail('INVALID_MCP_API_ORIGIN'); }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('INVALID_MCP_API_ORIGIN');
  config.apiBase = url.origin; config.allowAssignments ??= false;
  if (typeof config.allowAssignments !== 'boolean') fail('INVALID_MCP_CONFIG');
  for (const [key, value, min, max] of [['timeoutMs', 15000, 1000, 30000], ['maxOutputBytes', 256000, 4096, 1000000], ['maxRecords', 50, 1, 100]]) {
    config[key] ??= value;
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) fail('INVALID_MCP_LIMIT');
  }
  return Object.freeze(config);
}

export function createPaperclipMcpServer({ config: input, run = runCommand, env = process.env } = {}) {
  const config = validatePaperclipMcpConfig(input);
  const server = new McpServer({ name: 'paperclip-factory', version: '0.1.0' });
  const childEnv = { ...cloudEnvironment(env), PAPERCLIP_TELEMETRY_DISABLED: '1' };
  for (const key of ['PAPERCLIP_HOME', 'PAPERCLIP_INSTANCE_ID', 'PAPERCLIP_AUTH_STORE']) if (typeof env[key] === 'string') childEnv[key] = env[key];
  const pc = async args => {
    let result;
    try { result = await run(config.paperclipCommand, [...args, '--api-base', config.apiBase, '--json'], { env: childEnv, timeoutMs: config.timeoutMs, maxOutputBytes: config.maxOutputBytes }); }
    catch { fail('MCP_PAPERCLIP_COMMAND_FAILED'); }
    if (result?.code !== 0 || result.signal || result.timedOut || result.failedToStart || result.outputExceeded || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > config.maxOutputBytes) fail('MCP_PAPERCLIP_COMMAND_FAILED');
    try { return JSON.parse(result.stdout); } catch { fail('MCP_INVALID_RESPONSE'); }
  };
  const projectAllowed = id => { if (!config.projectIds.includes(id)) fail('MCP_PROJECT_NOT_ALLOWED'); };
  const agentAllowed = id => { if (!config.agentIds.includes(id)) fail('MCP_AGENT_NOT_ALLOWED'); };
  const scoped = (record, id) => { if (record?.id !== id || record.companyId !== config.companyId) fail('MCP_COMPANY_SCOPE_MISMATCH'); return record; };
  const project = async id => { projectAllowed(id); const value = scoped(await pc(['project', 'get', id]), id); if (value.archivedAt) fail('MCP_PROJECT_ARCHIVED'); return value; };
  const agent = async id => { agentAllowed(id); return scoped(await pc(['agent', 'configuration', id]), id); };
  const issue = async id => {
    const value = scoped(await pc(['issue', 'get', id]), id); projectAllowed(value.projectId);
    if (value.assigneeAgentId) agentAllowed(value.assigneeAgentId);
    return value;
  };
  const issueSummary = row => ({ id: row.id, identifier: row.identifier ? safeText(row.identifier, 100) : null, projectId: row.projectId, title: safeText(row.title, 500), status: safeText(row.status, 64), assigneeAgentId: row.assigneeAgentId ?? null, assignedToHuman: Boolean(row.assigneeUserId) });
  const register = (name, description, schema, action, readOnly = false) => server.registerTool(name, { description, inputSchema: schema, annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: true, openWorldHint: true } }, async args => {
    try {
      const result = await action(args);
      if (Buffer.byteLength(JSON.stringify(result)) > config.maxOutputBytes) fail('MCP_RESULT_TOO_LARGE');
      return json(result);
    } catch (error) { return { ...json({ status: 'needs_attention', code: safeCode(error) }), isError: true }; }
  });

  register('list_tasks', 'List bounded task summaries for one explicitly allowed project. No task descriptions, secrets, logs or credentials are returned.', z.object({ projectId: ID, status: z.enum(STATUSES).optional(), limit: COUNT }).strict(), async ({ projectId, status, limit }) => {
    await project(projectId);
    const rows = await pc(['issue', 'list', '--company-id', config.companyId, '--project-id', projectId, ...(status ? ['--status', status] : [])]);
    if (!Array.isArray(rows)) fail('MCP_INVALID_RESPONSE');
    for (const row of rows) { if (!UUID.test(row?.id ?? '') || row.companyId !== config.companyId || row.projectId !== projectId) fail('MCP_COMPANY_SCOPE_MISMATCH'); }
    const visible = rows.filter(row => !row.assigneeAgentId || config.agentIds.includes(row.assigneeAgentId)), count = Math.min(limit ?? config.maxRecords, config.maxRecords);
    return { status: 'ok', tasks: visible.slice(0, count).map(issueSummary), truncated: visible.length > count };
  }, true);

  const create = kind => async ({ idempotencyKey, projectId, agentId, title, description }) => {
    idempotencyKey = idempotencyKey.toLowerCase();
    if (kind === 'assignment' && !config.allowAssignments) fail('MCP_ASSIGNMENTS_DISABLED');
    await project(projectId);
    if (kind === 'assignment') { const target = await agent(agentId); if (!['idle', 'running'].includes(target.status)) fail('MCP_AGENT_NOT_ASSIGNABLE'); }
    const identity = await pc(['whoami']);
    if (typeof identity?.userId !== 'string' || !identity.userId || identity.userId.length > 200 || !Array.isArray(identity.companyIds) || !identity.companyIds.includes(config.companyId)) fail('MCP_BOARD_SIGN_IN_REQUIRED');
    const expected = { companyId: config.companyId, projectId, agentId: kind === 'assignment' ? agentId : null, title, description, kind };
    const marker = 'factory-mcp:' + idempotencyKey;
    const matches = row => row?.companyId === config.companyId && row.projectId === projectId && row.billingCode === marker && row.createdByUserId === identity.userId && !row.createdByAgentId && row.title === title && row.description === description && (row.assigneeAgentId ?? null) === expected.agentId && !row.assigneeUserId;
    const store = new McpIntentStore({ directory: config.stateDir });
    try {
      const claimed = store.begin({ companyId: config.companyId, idempotencyKey, kind, payloadHash: payloadHash(expected), actorUserId: identity.userId });
      if (claimed.record.state === 'confirmed') return { status: 'already_created', task: issueSummary(await issue(claimed.record.issueId)), mayWakeCloud: kind === 'assignment' };
      if (!claimed.created) {
        const rows = await pc(['issue', 'list', '--company-id', config.companyId, '--project-id', projectId]);
        if (!Array.isArray(rows)) fail('MCP_INVALID_RESPONSE');
        const candidates = rows.filter(matches);
        if (candidates.length !== 1 || !UUID.test(candidates[0].id ?? '')) fail('MCP_CREATE_OUTCOME_UNKNOWN');
        const recovered = await issue(candidates[0].id);
        if (!matches(recovered)) fail('MCP_CREATE_OUTCOME_UNKNOWN');
        store.finish(claimed.record, recovered.id);
        return { status: 'recovered_existing', task: issueSummary(recovered), mayWakeCloud: kind === 'assignment' };
      }
      let created;
      try {
        created = await pc(['issue', 'create', '--company-id', config.companyId, '--project-id', projectId, '--title=' + title, '--description=' + description, '--status', kind === 'assignment' ? 'todo' : 'backlog', '--standalone', '--billing-code', marker, ...(kind === 'assignment' ? ['--assignee-agent-id', agentId] : [])]);
        if (!UUID.test(created?.id ?? '') || !matches(created)) fail('MCP_CREATE_RESPONSE_UNVERIFIED');
        store.finish(claimed.record, created.id);
      } catch {
        try { store.finish(claimed.record); } catch { /* An uncertain or already confirmed intent never permits resubmission. */ }
        fail('MCP_CREATE_OUTCOME_UNKNOWN');
      }
      return { status: 'created', task: issueSummary(created), mayWakeCloud: kind === 'assignment' };
    } finally { store.close(); }
  };
  const createInput = { idempotencyKey: KEY, projectId: ID, title: requiredText(500), description: requiredText(24000, true) };
  register('create_task_draft', 'Create one NEW unassigned backlog task. Reuse its idempotencyKey on retries; ambiguous creation is never automatically resent. This cannot assign or reopen an existing task.', z.object(createInput).strict(), create('draft'));
  register('create_assignment', 'Create one NEW todo task assigned to an explicitly allowed agent. Requires allowAssignments and explicit human confirmation in the MCP client because assignment may immediately dispatch Codex Cloud. Never reassigns an existing task.', z.object({ ...createInput, agentId: ID, confirmAssignment: z.literal(true) }).strict(), create('assignment'));

  register('pause_agent', 'Pause an explicitly allowed Paperclip agent. This reversible operation does not cancel or forget accepted Codex Cloud work.', z.object({ agentId: ID }).strict(), async ({ agentId }) => {
    const before = await agent(agentId);
    if (before.status === 'paused') return { status: 'already_paused', agentId };
    if (!['idle', 'running'].includes(before.status)) fail('MCP_AGENT_NOT_PAUSABLE');
    let paused; try { paused = scoped(await pc(['agent', 'pause', agentId]), agentId); } catch { fail('MCP_PAUSE_OUTCOME_UNKNOWN'); }
    if (paused.status !== 'paused') fail('MCP_PAUSE_OUTCOME_UNKNOWN');
    return { status: 'paused', agentId };
  });
  register('view_runs', 'Read bounded heartbeat-run metadata for an allowed task. Omits prompts, context snapshots, logs, environment variables, and credentials.', z.object({ issueId: ID, limit: COUNT }).strict(), async ({ issueId, limit }) => {
    await issue(issueId);
    const rows = await pc(['issue', 'runs', issueId]);
    if (!Array.isArray(rows)) fail('MCP_INVALID_RESPONSE');
    for (const row of rows) if (!UUID.test(row?.id ?? '') || row.companyId !== config.companyId || !config.agentIds.includes(row.agentId)) fail('MCP_COMPANY_SCOPE_MISMATCH');
    const count = Math.min(limit ?? config.maxRecords, config.maxRecords);
    const runs = rows.slice(0, count).map(row => ({ id: row.id, agentId: row.agentId, status: safeText(row.status, 64), startedAt: typeof row.startedAt === 'string' && Number.isFinite(Date.parse(row.startedAt)) ? row.startedAt : null, finishedAt: typeof row.finishedAt === 'string' && Number.isFinite(Date.parse(row.finishedAt)) ? row.finishedAt : null }));
    return { status: 'ok', issueId, runs, truncated: rows.length > count };
  }, true);
  return server;
}
