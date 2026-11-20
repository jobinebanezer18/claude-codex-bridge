import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadProject, mcpName, mcpTitle, mcpVersion, promptFor } from './project.mjs';
import { kinds, Mailbox, other, view } from './store.mjs';
import { readBridgeClaudeIdentity, requestCatalog, requestLive, requestProjectStatus, requestProjectWork, requestThreadManagement, resolveWorkspaceC1 } from './live.mjs';

import { connectionInstructions } from './service.mjs';
import { alias, createThreadFields, listThreadFields, pairThreadFields, projectId, recoveryFields, renameThreadFields, sendThreadFields, teamSetFields, threadId, workFields } from './thread-tools.mjs';

export const subject = z.string().trim().min(1).max(160);
export const body = z.string().trim().min(1).max(24000);
export const sendFields = {
  kind: z.enum(kinds),
  subject,
  body,
  parentId: z.string().uuid().optional(),
  reference: z.string().trim().min(1).max(500).optional(),
  requestKey: z.string().trim().min(1).max(128),
};
const messageId = { id: z.string().uuid() };

export async function serveCodexCatalog(directory) {
  const server = new McpServer({ name: `${mcpName}-catalog`, title: `${mcpTitle} Catalog`, version: mcpVersion }, {
    instructions: 'Browse local Codex chats, create a named thread, or message an exact Codex chat at the user’s request. Project pairing is optional. Use live delivery for immediate steering and inbox delivery only when the user wants a Codex follow-up.',
  });
  const register = (name, description, inputSchema, action) => {
    server.registerTool(name, { description, inputSchema }, async (input) => {
      try {
        const identity = readBridgeClaudeIdentity(directory);
        const payload = action === 'create' ? { ...input, cwd: input.cwd || identity.cwd, pairAsX1: false } : input;
        const result = await requestCatalog(directory, identity.sessionId, action, payload);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error.message }] };
      }
    });
  };
  register('codex_threads', 'List local Codex chats with names, exact IDs and open links.', listThreadFields, 'list');
  const { pairAsX1, ...standaloneCreate } = createThreadFields;
  register('codex_create_thread', 'Create and name a Codex chat on the user’s instruction. Reuse the request key for a retry.',
    standaloneCreate, 'create');
  register('codex_send_thread', 'Send to an exact local Codex chat on the user’s instruction. No UI pairing is needed.',
    sendThreadFields, 'message');
  register('codex_delivery_status', 'Check whether a direct Codex message was accepted or acknowledged.',
    { messageId: messageId.id }, 'direct-status');
  register('bridge_diagnostics', 'Show host routing and invalid local project records without opening a chat.', {}, 'diagnostics');
  register('bridge_projects', 'List Relay Desk projects in this Claude workspace.', {}, 'projects');
  register('bridge_recover', 'Resume a project from this Claude chat, replace leads explicitly, and adopt selected handoff IDs. Returns work and Monitor setup.',
    { ...recoveryFields, projectId }, 'recover');
  register('bridge_claude_sessions', 'List active local Claude Code sessions, including open Antigravity sessions.', {}, 'claude-sessions');
  register('bridge_project_create', 'On user request, link this live Claude chat as C1 and an exact Codex thread as X1. Direct Codex messages do not require a link.',
    { name: z.string().trim().min(1).max(120), ...pairThreadFields, automaticDelivery: z.boolean().optional() }, 'create-project');
  await server.connect(new StdioServerTransport());
}

export async function serveMcp(project, actor, session, channel, workspaceScoped = false) {
  const mode = channel ? 'channel' : 'tools';
  const mailbox = new Mailbox(project.dbPath, project);
  const recipient = other(actor).toUpperCase();
  const role = actor === 'c1'
    ? 'You are the project lead, accountable to the human. Send assignments to the Codex lead.'
    : 'You lead the Codex workers and report progress and results to the project lead.';
  const server = new McpServer({ name: mcpName, title: mcpTitle, version: mcpVersion }, {
    instructions: `${role} This bridge links only the leaders for ${JSON.stringify(project.project)}. Read bridge_context when starting or resuming leadership. Use bridge_send_now for live handoffs and bridge_reply_now for live outcomes. Save verdicts with bridge_save_verdict when you write them. Use the queued tools only when explicitly requested. Do not reply merely to acknowledge a result. Follow the human’s scope and existing tool permissions.`,
    capabilities: channel ? { experimental: { 'claude/channel': {} } } : {},
  });

  function assertBound() {
    if (loadProject(project.path)[actor].session !== session) {
      throw new Error('This leader session was replaced. Reconnect the configured MCP server in the current project chat.');
    }
  }

  const register = (name, description, inputSchema, handler) => {
    server.registerTool(name, { description, inputSchema }, async (input) => {
      try {
        const bound = workspaceScoped ? resolveWorkspaceC1(project.path) : project;
        if (!workspaceScoped) assertBound();
        const currentSession = bound[actor].session;
        const result = await handler(input, currentSession);
        if (workspaceScoped || (actor === 'x1' && process.env.CODEX_THREAD_ID === currentSession)) {
          mailbox.recordToolUse(actor, currentSession);
        }
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error.message }] };
      }
    });
  };
  register('bridge_context', 'Read the current human-set brief for this project, including scope and acceptance criteria.',
    {}, () => ({ project: project.project, role: actor.toUpperCase(), brief: mailbox.brief(), briefConfigured: !!mailbox.brief(), x1: loadProject(project.path).x1 }));
  register('bridge_connection_status', 'Show live Monitor readiness and the paired chat delivery state.',
    {}, (_, currentSession) => requestProjectStatus(project, actor, currentSession));
  register('bridge_doctor', 'Check this chat’s pairing, MCP readiness, Codex host, and live reply route.',
    {}, (_, currentSession) => requestProjectStatus(project, actor, currentSession, true));
  register('bridge_work', 'Show the project roster, owners, acknowledgments, open handoffs, saved verdicts, and worker reports.',
    workFields, (input, currentSession) => requestProjectWork(project, actor, currentSession, input));
  register('bridge_history', 'List project handoffs and outcomes, including held and failed deliveries.',
    { limit: z.number().int().min(1).max(100).optional(), before: z.number().int().positive().optional() },
    ({ limit, before }) => {
      const binding = mailbox.binding();
      return mailbox.history(limit, before).map((message) => view(message, binding));
    });
  register('bridge_setup', 'Read the current project’s scoped configuration and X1 reply command.',
    {}, () => connectionInstructions(loadProject(project.path)));
  const { threadId: workerThreadId, ...teamSendFields } = sendThreadFields;
  register('bridge_team_send', 'Send work to a worker by project alias. Choose live for an active turn or explicitly choose the Codex inbox.',
    { ...teamSendFields, alias, requestKey: sendThreadFields.requestKey.unwrap() },
    (input, currentSession) => requestThreadManagement(project, currentSession, 'team-send', input, actor));
  if (actor === 'c1') {
    register('bridge_recover', 'Resume this project, optionally replace the Codex lead, and adopt selected handoffs. Call it from the catalog if this Claude chat is unpaired.',
      recoveryFields, (input, currentSession) => requestThreadManagement(project, currentSession, 'recover', input));
    register('bridge_team_set', 'Set a lead’s display alias or register a Codex worker. To replace a worker, provide its previous thread ID.',
      teamSetFields, (input, currentSession) => requestThreadManagement(project, currentSession, 'team-set', input));
    register('bridge_team_remove', 'Remove a worker alias after confirming its exact thread ID. Past work stays in project history.',
      { alias, expectedThreadId: threadId }, (input, currentSession) => requestThreadManagement(project, currentSession, 'team-remove', input));
    register('bridge_update_brief', 'Update the shared brief when the user asks.',
      { brief: z.string().trim().max(8000) },
      (input, currentSession) => requestThreadManagement(project, currentSession, 'brief', input));
    register('bridge_x1_delivery', 'Enable or pause automatic delivery of explicitly queued X1 handoffs on user request.',
      { enabled: z.boolean() },
      (input, currentSession) => requestThreadManagement(project, currentSession, 'delivery', input));
    register('bridge_resolve_delivery', 'On user request, record a confirmed receipt or explicitly retry an uncertain delivery.',
      { messageId: messageId.id, state: z.enum(['pending', 'delivered']) },
      (input, currentSession) => requestThreadManagement(project, currentSession, 'resolve', input));
    register('bridge_monitor_setup', 'Get one-time setup for a live Monitor in this C1 Antigravity tab. Set takeover to replace the same chat’s active Monitor.',
      { takeover: z.boolean().optional() }, (input, currentSession) => requestThreadManagement(project, currentSession, 'monitor', input));
    register('codex_threads', 'Browse local Codex threads, their links, and current pairings. Use nextOffset to keep listing.',
      listThreadFields, (input, currentSession) => requestThreadManagement(project, currentSession, 'list', input));
    register('codex_create_thread', 'On an explicit user request, create and name a new Codex thread. Set pairAsX1 to replace the project’s X1. Use the same requestKey on retry.',
      createThreadFields, (input, currentSession) => requestThreadManagement(project, currentSession, 'create', input));
    register('codex_pair_thread', 'On an explicit user request, set this project’s X1 to an existing Codex thread by exact ID. Undelivered work for the previous X1 is held in history.',
      pairThreadFields, (input, currentSession) => requestThreadManagement(project, currentSession, 'pair', input));
    register('codex_send_thread', 'On the user’s instruction, contact any local Codex chat by exact ID. No pairing is needed. Live steers a reachable active turn; inbox sends an explicit Codex follow-up.',
      sendThreadFields, (input, currentSession) => requestThreadManagement(project, currentSession, 'message', input));
    register('codex_delivery_status', 'Check whether a direct Codex message was accepted or acknowledged.',
      { messageId: messageId.id }, (input, currentSession) => requestThreadManagement(project, currentSession, 'direct-status', input));
    register('codex_rename_x1', 'On an explicit user request, rename this project’s current Codex X1 thread.',
      renameThreadFields, (input, currentSession) => requestThreadManagement(project, currentSession, 'rename', input));
  }
  register('bridge_send',
    `Enqueue a handoff for ${recipient}. Include scope, branch or commit, file references, and acceptance criteria as relevant. Reuse the request key if retrying. Link updates with parentId or reference.`,
    sendFields, (input, currentSession) => view(mailbox.send(actor, input, 'pending', currentSession)));
  register('bridge_send_now', `Send directly to the active ${recipient}. Returns an error if the live route is unavailable. It never queues for later.`,
    sendFields, (input, currentSession) => requestLive(project, actor, currentSession, input));
  const verdictFields = {
    ...messageId, body, disposition: z.enum(['completed', 'blocked']),
    verdict: z.string().trim().min(1).max(160).optional(),
    evidencePath: z.string().trim().min(1).max(2048).optional(),
  };
  const save = (input, currentSession) => mailbox.saveVerdict(
    actor, input.id, input.body, input.disposition, input, currentSession);
  const deliver = async (result, currentSession) => {
    try {
      return await requestLive(project, actor, currentSession, {
        kind: 'result', subject: result.subject, body: result.body, parentId: result.parent_id,
        requestKey: `result:${result.parent_id}`, disposition: result.disposition,
      });
    } catch (error) {
      throw new Error(`${error.message} Verdict record: ${result.id}. Check bridge_status for its delivery state.`);
    }
  };
  register('bridge_save_verdict', 'Record the verdict in Relay Desk as soon as it is written. Optionally attach its label and evidence file path. This saves the result without sending.',
    verdictFields, (input, currentSession) => view(save(input, currentSession)));
  register('bridge_send_saved_verdict', 'Send the existing verdict for a handoff over the live route. The id is the original request ID.',
    messageId, ({ id }, currentSession) => deliver(mailbox.savedVerdict(actor, id), currentSession));
  register('bridge_reply_now', 'Save the verdict and try live delivery. If the live route is unavailable, check the saved record before retrying.',
    verdictFields, (input, currentSession) => deliver(save(input, currentSession), currentSession));
  register('bridge_inbox', 'Read handoffs and replies addressed to this chat. Use bridge_work or bridge_history for items held for a previous chat.',
    { limit: z.number().int().min(1).max(50).optional() },
    ({ limit }, currentSession) => mailbox.inbox(actor, limit, currentSession).map((message) => view(message)));
  register('bridge_status', 'Get a handoff and linked outcomes or rechecks.',
    messageId, ({ id }) => view(mailbox.status(id), mailbox.binding()));
  register('bridge_acknowledge', 'Confirm receipt of a notification or a handoff you picked up from the inbox.',
    messageId, ({ id }, currentSession) => view(mailbox.acknowledge(actor, id, currentSession)));
  register('bridge_reply',
    `Send the outcome of a request to ${recipient}. Include evidence, test results, or clear blockers. Send one result per request.`,
    { ...messageId, body, disposition: z.enum(['completed', 'blocked']) },
    (input, currentSession) => view(mailbox.reply(actor, input.id, input.body, input.disposition, currentSession)));

  let timer;
  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      assertBound();
      if (channel) mailbox.touch(actor, session, mode);
      const pending = channel && mailbox.next(actor);
      const message = pending && mailbox.claim(pending.id, session);
      if (!message) return;
      const current = loadProject(project.path);
      if (current[actor].session !== session) {
        mailbox.complete(message, 'pending');
        return;
      }
      try {
        await server.server.notification({
          method: 'notifications/claude/channel',
          params: {
            content: `${promptFor(project, message, mailbox.brief())}\nConfirm receipt with bridge_acknowledge.`,
            meta: { message_id: message.id, sender: message.sender, kind: message.kind },
          },
        });
        // A transport write is not a receiver acknowledgment.
        mailbox.complete(message, 'notified');
      } catch {
        mailbox.complete(message, 'uncertain', { error: 'Claude channel delivery could not be confirmed.' });
      }
    } catch (error) {
      console.error(error.message);
      clearInterval(timer);
    } finally {
      polling = false;
    }
  }

  server.server.oninitialized = () => {
    if (channel) { timer = setInterval(poll, 2000); void poll(); }
  };
  server.server.onclose = () => {
    clearInterval(timer);
  };
  if (!workspaceScoped) assertBound();
  await server.connect(new StdioServerTransport());
}
