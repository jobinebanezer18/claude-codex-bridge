import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { loadProject, mcpCommand, mcpName, mcpTitle, mcpVersion, promptFor, serverName } from './project.mjs';
import { Mailbox } from './store.mjs';
import { threadId, threadLink } from './thread-tools.mjs';

const startupTimeout = 20000;
const turnTimeout = 30 * 60 * 1000;
const clients = new Set();
const activeTurns = new Map();
const exec = promisify(execFile);

export function closeCodexClients() {
  for (const client of clients) client.close();
}

export class CodexRpc {
  constructor(args = ['app-server', '--stdio'], cwd = process.cwd()) {
    this.calls = new Map();
    this.sequence = 0;
    this.closed = false;
    clients.add(this);
    this.process = spawn(process.env.BRIDGE_CODEX || 'codex', args, { cwd });
    this.process.stderr.resume();
    this.process.stdin.on('error', (error) => this.fail(error));
    this.process.on('error', (error) => this.fail(error));
    this.process.once('close', () => {
      clients.delete(this);
      this.fail(new Error('Codex App Server exited.'));
    });
    this.reader = createInterface({ input: this.process.stdout });
    this.reader.on('line', (line) => this.receive(line));
  }

  write(message) {
    if (this.closed) throw new Error('Codex connection is closed.');
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method && Object.hasOwn(message, 'id')) {
      // An unattended bridge has no approval interface. Leave that work in the interactive session.
      this.write({ id: message.id, error: { code: -32601, message: 'Use the interactive Codex session for approvals.' } });
      return;
    }
    if (Object.hasOwn(message, 'id')) {
      const call = this.calls.get(message.id);
      if (!call) return;
      this.calls.delete(message.id);
      if (message.error) call.reject(new Error(message.error.message));
      else call.resolve(message.result);
      return;
    }
    this.onEvent?.(message);
  }

  request(method, params) {
    if (this.closed) return Promise.reject(new Error('Codex connection is closed.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error(`Codex timed out during ${method}.`));
      }, startupTimeout);
      this.calls.set(id, {
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.write({ method, id, params });
    });
  }

  async start() {
    await this.request('initialize', {
      clientInfo: { name: mcpName, title: mcpTitle, version: mcpVersion },
    });
    this.write({ method: 'initialized' });
  }

  fail(error) {
    this.closed = true;
    for (const call of this.calls.values()) call.reject(error);
    this.calls.clear();
    this.onFailure?.(error);
  }

  close() {
    clients.delete(this);
    this.fail(new Error('Codex connection closed.'));
    this.reader.close();
    this.process.stdin.end();
    this.process.kill('SIGTERM');
  }
}

export function codexHostSocket(explicit) {
  const configured = explicit || process.env.BRIDGE_CODEX_SOCKET;
  if (configured) return configured;
  const standard = join(process.env.CODEX_HOME || join(homedir(), '.codex'),
    'app-server-control', 'app-server-control.sock');
  return existsSync(standard) ? standard : undefined;
}

export function codexThreads(explicit) {
  const socket = codexHostSocket(explicit);
  return listCodexThreads(socket
    ? new CodexRpc(['app-server', 'proxy', '--sock', socket])
    : new CodexRpc(), !!socket);
}

async function listCodexThreads(rpc, sharedRuntime) {
  try {
    await rpc.start();
    const sourceKinds = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview',
      'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
    async function pageThrough(archived) {
      const sessions = [];
      let cursor;
      do {
        const page = await rpc.request('thread/list', {
          limit: 100, cursor, archived, sortKey: 'updated_at', currentAccountOnly: true, sourceKinds,
        });
        sessions.push(...page.data.filter((thread) => !thread.ephemeral).map((thread) => {
          const status = thread.status?.type;
          const live = sharedRuntime && (status === 'active' || status === 'idle');
          return {
            session: thread.id, title: thread.name || thread.preview || 'Untitled Codex thread',
            cwd: thread.cwd, time: thread.updatedAt * 1000, status, archived,
            presence: archived ? 'archived' : live ? 'live' : sharedRuntime ? 'saved' : 'unknown',
          };
        }));
        cursor = page.nextCursor;
      } while (cursor);
      return sessions;
    }
    const [current, archived] = await Promise.all([pageThrough(false), pageThrough(true)]);
    return [...current, ...archived];
  } finally {
    rpc.close();
  }
}

function threadHost(cwd, explicit) {
  const socket = codexHostSocket(explicit);
  return new CodexRpc(socket ? ['app-server', 'proxy', '--sock', socket] : ['app-server', '--stdio'], cwd);
}

export async function createNamedCodexThread(cwd, title, onCreated, socket) {
  const folder = realpathSync(cwd);
  if (!statSync(folder).isDirectory()) throw new Error('Choose a workspace directory.');
  const rpc = threadHost(folder, socket);
  try {
    await rpc.start();
    const { thread } = await rpc.request('thread/start', { cwd: folder });
    const session = threadId.parse(thread.id);
    const created = { session, cwd: folder, title, link: threadLink(session), time: Date.now() };
    onCreated(created);
    // Persist neutral setup context without starting a model turn.
    await rpc.request('thread/inject_items', {
      threadId: session,
      items: [{
        type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text: 'Thread created by Relay Desk. Awaiting the user’s first assignment.' }],
      }],
    });
    await rpc.request('thread/name/set', { threadId: session, name: title });
    return created;
  } finally {
    rpc.close();
  }
}

export async function renameCodexThread(endpoint, title, socket) {
  const rpc = threadHost(endpoint.cwd, socket);
  try {
    await rpc.start();
    await rpc.request('thread/name/set', { threadId: endpoint.session, name: title });
  } finally {
    rpc.close();
  }
}

function localArguments(project) {
  const { command, args } = mcpCommand(project, 'x1');
  return [
    '-c', `mcp_servers.${serverName}.command=${JSON.stringify(command)}`,
    '-c', `mcp_servers.${serverName}.args=${JSON.stringify(args)}`,
    'app-server', '--stdio',
  ];
}

function sameFolder(expected, actual) {
  try {
    return realpathSync(actual) === expected;
  } catch {
    return false;
  }
}

function waitForTurn(rpc, threadId, turnId, earlyEvents) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => fail(new Error('Codex turn timed out.')), turnTimeout);
    let lastText = '';
    function fail(error) {
      clearTimeout(timer);
      reject(error);
    }

    function event(message) {
      const params = message.params;
      if (params?.threadId !== threadId) return;
      if (message.method === 'item/completed' && params.turnId === turnId &&
          params.item.type === 'agentMessage' && params.item.phase !== 'commentary') {
        lastText = params.item.text;
      }
      if (message.method !== 'turn/completed' || params.turn?.id !== turnId) return;
      clearTimeout(timer);
      if (params.turn.status !== 'completed') {
        fail(new Error(`Codex turn ${params.turn.status}.`));
        return;
      }
      const final = params.turn.items?.findLast((item) => item.type === 'agentMessage' && item.phase !== 'commentary');
      resolve((final?.text || lastText).slice(0, 24000));
    }

    rpc.onFailure = fail;
    rpc.onEvent = event;
    if (rpc.closed) fail(new Error('Codex disconnected before the turn completed.'));
    else for (const message of earlyEvents) event(message);
  });
}

export async function steerCodex(project, text) {
  if (loadProject(project.path).x1.session !== project.x1.session) {
    throw Object.assign(new Error('X1 pairing changed. Nothing was queued.'), { code: 'CODEX_PAIR_CHANGED' });
  }
  await steerThread(project.x1, text, project.codexSocket);
}

export async function steerThread(endpoint, text, codexSocket) {
  let active = activeTurns.get(endpoint.session);
  let shared;
  try {
    if (!active) {
      const socket = codexHostSocket(codexSocket);
      if (socket) {
        shared = new CodexRpc(['app-server', 'proxy', '--sock', socket], endpoint.cwd);
        await shared.start();
        const { thread } = await shared.request('thread/read', { threadId: endpoint.session, includeTurns: false });
        if (thread.status?.type === 'active' && sameFolder(endpoint.cwd, thread.cwd)) {
          const { data } = await shared.request('thread/turns/list', { threadId: endpoint.session, limit: 1 });
          if (data[0]?.status === 'inProgress') active = { rpc: shared, turnId: data[0].id };
        }
      }
    }
    if (!active) {
      throw Object.assign(new Error('Relay Desk cannot reach an active turn in the selected Codex thread. Nothing was queued.'),
        { code: 'CODEX_NO_ACTIVE_TURN' });
    }
    await active.rpc.request('turn/steer', {
      threadId: endpoint.session, expectedTurnId: active.turnId,
      input: [{ type: 'text', text }],
    });
  } finally {
    shared?.close();
  }
}

export async function sendToCodexThread(endpoint, message, delivery, socket) {
  if (delivery === 'live') {
    await steerThread(endpoint, message, socket);
    return { state: 'live-accepted', threadId: endpoint.session, link: threadLink(endpoint.session) };
  }
  const remote = codexHostSocket(socket);
  const args = ['queue', '--thread', endpoint.session, '--message', message];
  if (remote) args.push('--remote', `unix://${remote}`);
  await exec(process.env.BRIDGE_CODEX || 'codex', args, { cwd: endpoint.cwd, timeout: 20000 });
  return { state: 'codex-inbox', threadId: endpoint.session, link: threadLink(endpoint.session) };
}

async function handToDesktop(project, mailbox, message, socket) {
  const messages = mailbox.claimFollowing(message);
  const envelope = [
    'Relay Desk handoffs for the paired X1 chat. The following messages were previously queued for delivery, oldest first. Consider the latest update before acting and avoid repeating work that has already completed.',
    ...messages.map((item) => promptFor(project, item, mailbox.brief())),
    'Acknowledge these handoffs in this chat. If Relay Desk tools are loaded, acknowledge each by ID and use bridge_reply_now for direct results when the C1 Monitor is available.',
  ].join('\n\n');
  try {
    await sendToCodexThread(project.x1, envelope, 'inbox', socket);
    mailbox.transaction(() => {
      for (const item of messages) mailbox.complete(item, 'codex-inbox');
    });
    return { state: 'codex-inbox' };
  } catch (error) {
    const reason = 'Codex inbox acceptance is unknown. Check the paired thread before retrying.';
    mailbox.transaction(() => {
      for (const item of messages) mailbox.complete(item, 'uncertain', { error: reason });
    });
    return { state: 'uncertain', error: reason };
  }
}

export async function deliverCodex(project, id) {
  const mailbox = new Mailbox(project.dbPath, project);
  const pending = mailbox.find(id);
  if (pending?.recipient !== 'x1' || pending.state !== 'pending') {
    mailbox.close();
    throw new Error('Choose a queued message addressed to X1.');
  }
  const message = mailbox.claim(id, project.x1.session);
  if (!message) {
    mailbox.close();
    return { state: 'busy' };
  }
  const renewal = setInterval(() => {
    try { mailbox.renew(message); }
    catch (error) { console.error(error.message); }
  }, 30000);
  let rpc;
  const socket = codexHostSocket(project.codexSocket);
  let submitted = false;
  try {
    const endpoint = project.x1;
    const args = socket
      ? ['app-server', 'proxy', '--sock', socket]
      : localArguments(project);
    rpc = new CodexRpc(args, endpoint.cwd);
    await rpc.start();
    const { thread } = await rpc.request('thread/read', { threadId: endpoint.session, includeTurns: false });
    if (!sameFolder(endpoint.cwd, thread.cwd)) throw new Error('X1 workspace does not match the selected thread.');
    if (thread.status?.type === 'active') {
      mailbox.complete(message, 'pending');
      return { state: 'busy' };
    }
    if (thread.status?.type === 'systemError') throw new Error('X1 thread reports a system error.');
    const resumed = await rpc.request('thread/resume', { threadId: endpoint.session, excludeTurns: true });
    if (resumed.thread.status?.type === 'active') {
      mailbox.complete(message, 'pending');
      return { state: 'busy' };
    }
    if (loadProject(project.path).x1.session !== endpoint.session) {
      mailbox.complete(message, 'pending');
      return { state: 'busy' };
    }
    const earlyEvents = [];
    rpc.onEvent = (event) => {
      if (['item/completed', 'turn/completed'].includes(event.method)) earlyEvents.push(event);
    };
    submitted = true;
    const { turn } = await rpc.request('turn/start', {
      threadId: endpoint.session,
      input: [{ type: 'text', text: promptFor(project, message, mailbox.brief()) }],
      clientUserMessageId: id,
    });
    activeTurns.set(endpoint.session, { rpc, turnId: turn.id });
    const result = await waitForTurn(rpc, endpoint.session, turn.id, earlyEvents);
    mailbox.complete(message, 'turn-completed', { result });
    return { state: 'turn-completed' };
  } catch (error) {
    if (!submitted && /already has an active writer/i.test(error.message)) {
      rpc?.close();
      rpc = undefined;
      if (loadProject(project.path).x1.session !== project.x1.session) {
        mailbox.complete(message, 'pending');
        return { state: 'busy' };
      }
      return await handToDesktop(project, mailbox, message, socket);
    }
    const state = submitted ? 'uncertain' : 'pending';
    mailbox.complete(message, state, { error: error.message });
    return { state, error: error.message };
  } finally {
    clearInterval(renewal);
    if (activeTurns.get(project.x1.session)?.rpc === rpc) activeTurns.delete(project.x1.session);
    rpc?.close();
    mailbox.close();
  }
}
