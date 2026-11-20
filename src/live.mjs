import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { entry, loadProject, monitorInstructions, promptFor, rebind } from './project.mjs';
import { Mailbox, view } from './store.mjs';
import { steerCodex } from './codex.mjs';
import { threadId } from './thread-tools.mjs';
import { claudeRegistries } from './claude-profiles.mjs';
import { createIdeWake } from './ide-wake.mjs';

const socketPath = (directory) => join('/tmp', `relay-desk-${process.getuid()}-${createHash('sha256').update(directory).digest('hex').slice(0, 16)}`, 'live.sock');
const monitorDuration = 30 * 60 * 1000;
const monitorWarning = 2 * 60 * 1000;
const grantDuration = 5 * 60 * 1000;
const grantDirectory = (directory) => join(dirname(socketPath(directory)), 'monitor-grants');
const grantName = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}[.]json$/;
const wire = (socket, data) => socket.write(JSON.stringify(data) + '\n');

export function liveClaudeIdentities(directory) {
  const pids = new Set(claudeRegistries(directory).flatMap((registry) => {
    try { return readdirSync(registry).filter((name) => /^\d+\.json$/.test(name)).map((name) => Number(name.slice(0, -5))); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }));
  return [...pids].flatMap((pid) => {
    try { return [readBridgeClaudeIdentity(directory, pid)]; } catch { return []; }
  });
}

function readClaudeIdentity(pid, registry) {
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error('Invalid Claude process identity.');
  process.kill(pid, 0);
  const record = JSON.parse(readFileSync(join(registry, `${pid}.json`), 'utf8'));
  if (record.pid !== pid || !record.sessionId) throw new Error('Claude Code has no live identity for this process.');
  return record;
}

export function readBridgeClaudeIdentity(directory, pid = process.ppid) {
  const matches = claudeRegistries(directory).flatMap((registry) => {
    try { return [readClaudeIdentity(pid, registry)]; } catch { return []; }
  });
  if (!matches.length || matches.some((row) => row.sessionId !== matches[0].sessionId)) {
    throw new Error('Relay Desk could not uniquely verify the parent Claude Code session.');
  }
  return matches[0];
}

function assertClaudeSession(session, pid, directory) {
  let identity;
  try { identity = readBridgeClaudeIdentity(directory, pid); }
  catch { throw new Error('Relay Desk could not verify the parent Claude Code session.'); }
  if (identity.sessionId !== session) {
    throw new Error('Only the Claude Code chat paired as C1 can use this project’s Relay Desk tools.');
  }
  return identity;
}

function matchesLead(record, lead) {
  try { return !!lead.title && record.name?.trim().toLowerCase() === lead.title.trim().toLowerCase() && realpathSync(record.cwd) === lead.cwd; }
  catch { return false; }
}

function uniqueNamedReplacement(lead, live) {
  return new Set(live.filter((record) => matchesLead(record, lead)).map((record) => record.sessionId)).size === 1;
}

export function resolveWorkspaceC1(file, pid = process.ppid) {
  const project = loadProject(file);
  let identity;
  try { identity = readBridgeClaudeIdentity(dirname(file), pid); }
  catch { throw new Error('Open the Relay Desk server from the live Claude Code chat.'); }
  if (identity.sessionId === project.c1.session) {
    if (identity.name && identity.name !== project.c1.title) {
      return rebind(project, 'c1', { ...project.c1, title: identity.name });
    }
    return project;
  }
  if (!matchesLead(identity, project.c1)) throw new Error('Only the Claude Code chat paired as C1 can use this project’s Relay Desk tools.');
  const live = liveClaudeIdentities(dirname(file));
  if (live.some((record) => record.sessionId === project.c1.session) ||
      !uniqueNamedReplacement(project.c1, live)) {
    throw new Error('More than one C1 can claim this workspace. Use the intended live C1 chat.');
  }
  const changed = rebind(project, 'c1', { session: identity.sessionId, cwd: project.c1.cwd, title: identity.name });
  return changed;
}

function monitorProject(project, identity) {
  if (identity.entrypoint !== 'claude-vscode' || identity.kind !== 'interactive' || typeof identity.procStart !== 'string' || !identity.procStart ||
      !identity.cwd || realpathSync(identity.cwd) !== project.c1.cwd) return null;
  const session = threadId.parse(identity.sessionId);
  const mailbox = new Mailbox(project.dbPath, project);
  try {
    return mailbox.transaction(() => {
      const binding = mailbox.binding();
      if (project.c1.cwd !== binding.c1.cwd) return null;
      const owner = JSON.stringify({ pid: identity.pid, started: identity.procStart });
      const previous = mailbox.db.prepare("SELECT value FROM project_settings WHERE name = 'monitor_owner'").get()?.value;
      if (binding.c1.session !== session) {
        if (previous !== owner && !matchesLead(identity, binding.c1)) return null;
        const live = liveClaudeIdentities(dirname(project.path));
        if (live.some((record) => record.sessionId === binding.c1.session) ||
            (previous !== owner && !uniqueNamedReplacement(binding.c1, live))) return null;
        mailbox.updateBinding(binding, 'c1', { ...binding.c1, session, title: identity.name?.slice(0, 500) || binding.c1.title });
      }
      mailbox.db.prepare(`INSERT INTO project_settings VALUES ('monitor_owner', ?)
        ON CONFLICT(name) DO UPDATE SET value = excluded.value`).run(owner);
      return { ...project, ...mailbox.binding() };
    });
  } finally { mailbox.close(); }
}

export async function serveLive({ directory, resolveProject, manageThread, projectStatus, projectWork, workerReceipt, workerReport }) {
  const path = socketPath(directory);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const owner = lstatSync(dirname(path));
  if (!owner.isDirectory() || owner.uid !== process.getuid() || (owner.mode & 0o077)) throw new Error('Relay Desk requires a private local socket.');
  const grantFolder = grantDirectory(directory);
  mkdirSync(grantFolder, { mode: 0o700, recursive: true });
  const grantOwner = lstatSync(grantFolder);
  if (!grantOwner.isDirectory() || grantOwner.uid !== process.getuid() || (grantOwner.mode & 0o077)) {
    throw new Error('Relay Desk requires a private Monitor grant directory.');
  }

  const watchers = new Map();
  const ideWake = createIdeWake(directory, (pid) => readBridgeClaudeIdentity(directory, pid));
  const monitorHistory = new Map();
  const watchGrants = new Map();
  const sockets = new Set();
  const requests = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
    let buffered = 0;
    const limit = (chunk) => {
      buffered += chunk.length;
      if (buffered > 262144) socket.destroy();
    };
    socket.on('data', limit);
    socket.setTimeout(10000, () => socket.destroy());
    const lines = createInterface({ input: socket });
    lines.once('line', (line) => {
      if (socket.destroyed) return;
      socket.removeListener('data', limit);
      socket.setTimeout(0);
      const request = handleLine(line, socket);
      requests.add(request);
      void request.finally(() => requests.delete(request));
    });
  });

  async function handleLine(line, socket) {
      try {
        const { project: id, type, actor, session, pid, action, input, grant, persistent } = JSON.parse(line);
        if (type === 'catalog') {
          const identity = assertClaudeSession(session, pid, directory);
          if (!['list', 'create', 'message', 'projects', 'create-project', 'claude-sessions', 'direct-status', 'diagnostics', 'recover'].includes(action)) {
            throw new Error('Unsupported standalone Codex operation.');
          }
          const result = await manageThread(null, action, input, undefined, identity);
          socket.end(JSON.stringify(action === 'recover' ? recoveryResponse(result, input, pid) : result) + '\n');
          return;
        }
        if (type === 'codex-report') {
          const result = workerReport(session, input?.id, grant, input?.disposition, input?.body);
          socket.end(JSON.stringify(result) + '\n');
          return;
        }
        if (type === 'codex-receipt') {
          const result = workerReceipt(session, input?.id, grant);
          socket.end(JSON.stringify(result) + '\n');
          return;
        }
        let project = resolveProject(id);
        if (type === 'ide-watch') {
          const identity = assertClaudeSession(session, pid, directory);
          if (action === 'register') {
            project = monitorProject(project, identity);
            socket.end(JSON.stringify({ path: project && ideWake.register(project, id, identity) }) + '\n');
          } else if (action === 'drain' && session === project.c1.session) {
            const messages = ideWake.drain(project, id, identity, input?.filePath);
            if (ideWake.status(project, id)?.state === 'ready') {
              const oldMonitor = watcherFor(project, id);
              if (oldMonitor) retireWatcher(id, oldMonitor, 'replaced');
              revokeGrant(id);
            }
            socket.end(JSON.stringify({ messages }) + '\n');
          } else {
            socket.end(JSON.stringify({}) + '\n');
          }
          return;
        }
        if (type === 'project-status' || type === 'project-work') {
          if (!['c1', 'x1'].includes(actor) || project[actor].session !== session) throw new Error('The paired chat changed.');
          socket.end(JSON.stringify(type === 'project-work' ? projectWork(project, id, input) : await projectStatus(project, id, input?.doctor)) + '\n');
          return;
        }
        if (type === 'watch') {
          let ownerPid = pid;
          let ownerStarted;
          let takeover = false;
          if (persistent === true) {
            if (grant) throw new Error('A session Monitor does not accept a manual grant.');
            const identity = readBridgeClaudeIdentity(directory, pid);
            project = monitorProject(project, identity);
            if (!project) { socket.end(JSON.stringify({ state: 'not-paired' }) + '\n'); return; }
            ownerStarted = identity.procStart;
            takeover = true;
          } else if (grant) {
            const issued = watchGrantFor(project, id);
            if (!issued || grant !== issued.token) {
              throw new Error('Monitor setup expired or was already used. Call bridge_monitor_setup for a fresh prompt.');
            }
            ownerPid = issued.pid;
            takeover = issued.takeover;
            assertClaudeSession(issued.session, ownerPid, directory);
            revokeGrant(id);
          } else {
            assertClaudeSession(project.c1.session, ownerPid, directory);
          }
          const previous = watcherFor(project, id);
          if (previous?.mode === 'session') {
            if (persistent !== true) throw new Error('The session Monitor is already active.');
            socket.end(JSON.stringify({ state: 'already-listening' }) + '\n');
            return;
          }
          if (previous && !takeover) {
            throw new Error(`A Monitor is already active until ${new Date(previous.expiresAt).toISOString()}. Use bridge_monitor_setup with takeover set to true to replace it.`);
          }
          if (previous) retireWatcher(id, previous, 'replaced');
          const startedAt = Date.now();
          const mode = persistent === true ? 'session' : 'manual';
          const entry = { socket, session: project.c1.session, pid: ownerPid, ownerStarted, startedAt, mode,
            expiresAt: mode === 'manual' ? startedAt + monitorDuration : null };
          watchers.set(id, entry);
          monitorHistory.delete(id);
          if (mode === 'manual') {
            entry.warning = setTimeout(() => {
              if (watchers.get(id) !== entry || socket.destroyed) return;
              wire(socket, { message: 'Relay Desk Monitor expires in about two minutes. If you still need live replies, call bridge_monitor_setup with takeover set to true and start the replacement Monitor.' });
            }, monitorDuration - monitorWarning);
            entry.expiry = setTimeout(() => { if (watchers.get(id) === entry) retireWatcher(id, entry, 'expired'); }, monitorDuration);
            entry.warning.unref();
            entry.expiry.unref();
          }
          socket.once('close', () => {
            if (watchers.get(id) === entry) {
              retireWatcher(id, entry, entry.expiresAt && Date.now() >= entry.expiresAt - 10000 ? 'expired' : 'offline');
            }
          });
          wire(socket, { state: 'watching', mode });
          return;
        }
        if (type === 'thread') {
          if (actor === 'x1' && action === 'team-send' && session === project.x1.session) {
            const result = await manageThread(id, action, input, undefined, undefined, session);
            socket.end(JSON.stringify(result) + '\n');
            return;
          }
          if (actor !== 'c1' || session !== project.c1.session) throw new Error('Only the paired project lead can manage this route.');
          const identity = assertClaudeSession(session, pid, directory);
          let result;
          if (action === 'monitor') {
            const prompt = issueWatchGrant(project, id, pid, input?.takeover === true);
            result = { prompt, monitor: monitorStatus(project, id) };
          } else {
            result = await manageThread(id, action, input, session, identity);
          }
          socket.end(JSON.stringify(action === 'recover' ? recoveryResponse(result, input, pid) : result) + '\n');
          return;
        }
        if (type !== 'send' || !['c1', 'x1'].includes(actor) || project[actor].session !== session) {
          throw new Error('The live request does not match the paired chat.');
        }
        const receipt = await sendNow(project, id, actor, input);
        socket.end(JSON.stringify(receipt) + '\n');
      } catch (error) {
        socket.end(JSON.stringify({ error: error.message }) + '\n');
      }
  }

  function recoveryResponse(result, input, pid) {
    if (input?.prepareMonitor === false) return result;
    const id = result.id;
    const project = resolveProject(id);
    const status = monitorStatus(project, id);
    if (status.state === 'ready' || (status.mode === 'ide-hook' && status.state === 'starting')) return { ...result, monitor: status };
    try {
      const monitorPrompt = issueWatchGrant(project, id, pid, true);
      return { ...result, monitor: monitorStatus(project, id), monitorPrompt };
    } catch (error) {
      return { ...result, monitor: status, monitorError: error.message };
    }
  }

  function retireWatcher(id, watcher, state) {
    if (watchers.get(id) !== watcher) return;
    watchers.delete(id);
    clearTimeout(watcher.warning);
    clearTimeout(watcher.expiry);
    monitorHistory.set(id, { state, mode: watcher.mode, startedAt: watcher.startedAt, expiresAt: watcher.expiresAt, endedAt: Date.now() });
    watcher.socket.destroy();
  }

  function watcherFor(project, id) {
    const watcher = watchers.get(id);
    if (!watcher) return null;
    if (watcher.session !== project.c1.session) { retireWatcher(id, watcher, 'stale'); return null; }
    if (watcher.expiresAt && watcher.expiresAt <= Date.now()) { retireWatcher(id, watcher, 'expired'); return null; }
    if (watcher.socket.destroyed) { retireWatcher(id, watcher, 'offline'); return null; }
    try {
      const identity = assertClaudeSession(watcher.session, watcher.pid, directory);
      if (identity.sessionId !== watcher.session || (watcher.ownerStarted && watcher.ownerStarted !== identity.procStart)) {
        throw new Error('The Monitor owner changed.');
      }
    }
    catch { retireWatcher(id, watcher, 'stale'); return null; }
    return watcher;
  }

  function monitorStatus(project, id) {
    const ide = ideWake.status(project, id);
    if (ide?.state === 'ready') return ide;
    const watcher = watcherFor(project, id);
    const pending = watchGrantFor(project, id);
    if (watcher) return {
      state: watcher.expiresAt && watcher.expiresAt - Date.now() <= monitorWarning ? 'expiring' : 'ready',
      mode: watcher.mode, startedAt: watcher.startedAt, expiresAt: watcher.expiresAt,
      ...(pending ? { setupExpiresAt: pending.expires } : {}),
    };
    if (pending) return { state: 'starting', mode: 'manual', startedAt: null, expiresAt: null, setupExpiresAt: pending.expires };
    return ide ?? monitorHistory.get(id) ?? { state: 'offline', startedAt: null, expiresAt: null };
  }

  function watchGrantFor(project, id) {
    const issued = watchGrants.get(id);
    if (!issued) return null;
    try {
      if (issued.session === project.c1.session && issued.expires > Date.now() && existsSync(issued.file)) {
        assertClaudeSession(issued.session, issued.pid, directory);
        return issued;
      }
    } catch { /* A closed or replaced tab cannot redeem the grant. */ }
    revokeGrant(id);
    return null;
  }

  function revokeGrant(id) {
    const issued = watchGrants.get(id);
    if (!issued) return;
    watchGrants.delete(id);
    clearTimeout(issued.timer);
    try { unlinkSync(issued.file); }
    catch (error) { if (error.code !== 'ENOENT') console.error('Could not remove an expired Relay Desk Monitor grant.'); }
  }

  function issueWatchGrant(project, id, pid, takeover) {
    assertClaudeSession(project.c1.session, pid, directory);
    if (ideWake.status(project, id)?.state === 'ready') throw new Error('The Claude IDE notification route is already active.');
    const existing = watcherFor(project, id);
    if (existing?.mode === 'session') throw new Error('The session Monitor is already active.');
    if (existing && !takeover) {
      throw new Error(`A Monitor is already active until ${new Date(existing.expiresAt).toISOString()}. Use takeover to replace it.`);
    }
    const previous = watchGrantFor(project, id);
    if (previous?.pid === pid) {
      previous.takeover ||= takeover;
      return monitorInstructions(project, previous.file);
    }
    revokeGrant(id);
    const token = randomBytes(24).toString('base64url');
    const file = join(grantDirectory(directory), `${randomUUID()}.json`);
    writeFileSync(file, JSON.stringify({ token }), { mode: 0o600, flag: 'wx' });
    const timer = setTimeout(() => revokeGrant(id), grantDuration);
    timer.unref();
    watchGrants.set(id, { token, file, pid, takeover, timer, session: project.c1.session, expires: Date.now() + grantDuration });
    return monitorInstructions(project, file);
  }

  function claudeRoute(project, id) {
    return ideWake.status(project, id)?.state === 'ready' ? 'ide-hook' : watcherFor(project, id);
  }

  function notifyClaude(project, id, route, message) {
    const text = `Relay Desk message ${message.id}. ${message.subject}: ${message.body.slice(0, 600)}. Call bridge_status with this ID for the full message, then bridge_acknowledge.`;
    if (route === 'ide-hook') return ideWake.notify(project, id, message.id, text);
    return new Promise((resolve, reject) => {
      route.socket.write(JSON.stringify({ message: text }) + '\n', (error) => error ? reject(error) : resolve());
    });
  }

  async function deliverQueuedClaude(project, id) {
    const route = claudeRoute(project, id);
    if (!route) return;
    const mailbox = new Mailbox(project.dbPath, project);
    try {
      const next = mailbox.next('c1');
      const message = next && mailbox.claim(next.id, project.c1.session);
      if (!message) return;
      try {
        await notifyClaude(project, id, route, message);
        mailbox.complete(message, 'notified');
      } catch (error) {
        mailbox.complete(message, 'uncertain', { error: error.message });
      }
    } finally {
      mailbox.close();
    }
  }

  async function sendNow(project, id, actor, fields) {
    const mailbox = new Mailbox(project.dbPath, project);
    try {
      const receipt = mailbox.liveReceipt(actor, fields, project[actor].session);
      if (receipt) return view(receipt, mailbox.binding());
      const route = actor === 'x1' ? claudeRoute(project, id) : null;
      if (actor === 'x1' && !route) {
        if (monitorStatus(project, id).state === 'starting') {
          throw new Error('C1’s Monitor is starting. Retry once monitorReady is true. Nothing was queued.');
        }
        throw new Error('C1 has no live Monitor in Antigravity. Nothing was queued.');
      }
      const { message, created } = mailbox.send(actor, fields, 'sending-now', project[actor].session,
        project[actor === 'c1' ? 'x1' : 'c1'].session);
      if (!created) {
        if (['live-failed', 'live-uncertain'].includes(message.state)) throw new Error(message.error);
        if (!['live-accepted', 'delivered'].includes(message.state)) {
          throw new Error('This request key already exists. Check its delivery state.');
        }
        return view(message);
      }
      const prompt = promptFor(project, message, mailbox.brief()) + '\nCall bridge_acknowledge with the message ID to confirm you read it.';
      try {
        if (route) {
          await notifyClaude(project, id, route, message);
        } else {
          await steerCodex(project, prompt);
        }
        return view(mailbox.finishLive(message.id, 'live-accepted'));
      } catch (error) {
        const definitelyUnsent = ['CODEX_NO_ACTIVE_TURN', 'CODEX_PAIR_CHANGED'].includes(error.code);
        mailbox.finishLive(message.id, definitelyUnsent ? 'live-failed' : 'live-uncertain', error.message);
        throw error;
      }
    } finally {
      mailbox.close();
    }
  }

  const listen = () => new Promise((resolve, reject) => {
    const failed = (error) => reject(error);
    server.once('error', failed);
    server.listen(path, () => { server.removeListener('error', failed); resolve(); });
  });
  try {
    await listen();
  } catch (error) {
    if (error.code !== 'EADDRINUSE' || !statSync(path).isSocket()) throw error;
    const ownerActive = await new Promise((resolve, reject) => {
      const probe = createConnection(path);
      probe.once('connect', () => { probe.destroy(); resolve(true); });
      probe.once('error', (cause) => {
        if (cause.code === 'ECONNREFUSED') resolve(false);
        else reject(cause);
      });
    });
    if (ownerActive) throw error;
    unlinkSync(path);
    await listen();
  }
  for (const name of readdirSync(grantFolder)) {
    if (grantName.test(name)) {
      try { unlinkSync(join(grantFolder, name)); }
      catch (error) { if (error.code !== 'ENOENT') console.error('Could not remove an old Monitor grant.'); }
    }
  }

  return {
    ready: (project, id) => !!claudeRoute(project, id),
    monitorStatus,
    sendNow,
    deliverQueuedClaude,
    async close() {
      ideWake.close();
      for (const id of watchGrants.keys()) revokeGrant(id);
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
      await Promise.allSettled(requests);
    },
  };
}

function connectOnce(directory) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath(directory));
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.removeListener('error', reject);
      resolve(socket);
    });
  });
}

async function connectBridge(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const normalized = realpathSync(directory);
  const offline = (error) => ['ENOENT', 'ECONNREFUSED'].includes(error.code);
  try {
    return await connectOnce(normalized);
  } catch (error) {
    if (!offline(error)) throw error;
  }
  const daemon = spawn(process.execPath, [entry, 'daemon', normalized], {
    detached: true, stdio: 'ignore',
  });
  daemon.on('error', () => {});
  daemon.unref();
  for (let i = 0; i < 30; i++) {
    await delay(150);
    try { return await connectOnce(normalized); }
    catch (error) { if (!offline(error)) throw error; }
  }
  throw new Error('Relay Desk background service could not start.');
}

const projectKey = (project) => project.path.split('/').at(-1).slice(0, -5);

async function requestBridge(project, request, timeout, directory) {
  const socket = await connectBridge(project ? dirname(project.path) : directory);
  return new Promise((resolve, reject) => {
    socket.setTimeout(timeout, () => socket.destroy(new Error('Relay Desk timed out. Check the handoff before retrying.')));
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('Relay Desk disconnected. Check the handoff before retrying.')));
    createInterface({ input: socket }).once('line', (line) => {
      socket.end();
      try {
        const result = JSON.parse(line);
        if (result.error) reject(new Error(result.error));
        else resolve(result);
      } catch (error) { reject(error); }
    });
    wire(socket, project ? { ...request, project: projectKey(project) } : request);
  });
}

export function requestLive(project, actor, session, input) {
  return requestBridge(project, { type: 'send', actor, session, input }, 30000);
}

export function requestThreadManagement(project, session, action, input, actor = 'c1') {
  return requestBridge(project, { type: 'thread', actor, session, pid: process.ppid, action, input }, 85000);
}

export function requestProjectStatus(project, actor, session, doctor = false) {
  return requestBridge(project, { type: 'project-status', actor, session, input: { doctor } }, doctor ? 85000 : 8000);
}

export function requestProjectWork(project, actor, session, input) {
  return requestBridge(project, { type: 'project-work', actor, session, input }, 8000);
}

export function requestCatalog(directory, session, action, input) {
  return requestBridge(null, { type: 'catalog', pid: process.ppid, session, action, input }, 85000, directory);
}

export function acknowledgeDirectCodex(directory, session, id, grant) {
  return requestBridge(null, { type: 'codex-receipt', session, input: { id }, grant }, 8000, directory);
}

export function reportDirectCodex(directory, session, id, grant, disposition, body) {
  return requestBridge(null, { type: 'codex-report', session, input: { id, disposition, body }, grant }, 8000, directory);
}

export async function watchInClaude(file, setupFile) {
  let grant;
  let project;
  if (setupFile) {
    const path = resolve(setupFile);
    const expected = grantDirectory(realpathSync(dirname(file)));
    try {
      if (dirname(path) !== expected || !grantName.test(basename(path))) throw new Error('Invalid grant path.');
      const info = lstatSync(path);
      if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('Invalid grant permissions.');
      grant = JSON.parse(readFileSync(path, 'utf8')).token;
      if (typeof grant !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(grant)) throw new Error('Invalid grant.');
      project = { path: file };
    } catch {
      throw new Error('Monitor setup expired or was already used. Call bridge_monitor_setup for a fresh prompt.');
    }
  }
  let pid = process.ppid;
  let rejection;
  for (let i = 0; !project && i < 6 && pid > 1; i++) {
    try {
      project = resolveWorkspaceC1(file, pid);
      break;
    } catch (error) {
      rejection ??= error;
      pid = Number(execFileSync('/bin/ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf8', timeout: 2000 }).trim());
    }
  }
  if (!project) throw rejection || new Error('Run the Monitor from the selected Claude Code chat.');
  const socket = await connectBridge(dirname(project.path));
  socket.once('error', (error) => {
    console.error(error.code === 'ENOENT' ? 'Start the Monitor again.' : error.message);
    process.exitCode = 1;
  });
  const stream = createInterface({ input: socket });
  wire(socket, { type: 'watch', project: projectKey(project), pid, grant });
  for await (const line of stream) {
    const event = JSON.parse(line);
    if (event.error) throw new Error(event.error);
    if (event.message) console.log(event.message.replaceAll('\n', ' '));
  }
}

function parentClaudeIdentity(directory) {
  let pid = process.ppid;
  for (let depth = 0; depth < 6 && pid > 1; depth++) {
    try { return readBridgeClaudeIdentity(directory, pid); } catch { /* Claude may be above a shell. */ }
    try { pid = Number(execFileSync('/bin/ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf8', timeout: 1000 }).trim()); }
    catch { return null; }
  }
  return null;
}

export async function runClaudeIdeHook(file) {
  const directory = realpathSync(dirname(file));
  let input = '';
  for await (const chunk of process.stdin.setEncoding('utf8')) {
    input += chunk;
    if (input.length > 65536) return;
  }
  const payload = JSON.parse(input);
  let identity = parentClaudeIdentity(directory);
  for (let wait = 0; payload.hook_event_name === 'SessionStart' && identity?.sessionId !== payload.session_id && wait < 6; wait++) {
    await delay(125);
    identity = parentClaudeIdentity(directory);
  }
  if (identity?.entrypoint !== 'claude-vscode' || identity.sessionId !== payload.session_id) return;
  const base = { type: 'ide-watch', project: projectKey({ path: file }), pid: identity.pid, session: identity.sessionId };
  if (payload.hook_event_name === 'SessionStart') {
    const result = await requestBridge(null, { ...base, action: 'register' }, 8000, directory);
    if (result.path) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', watchPaths: [result.path] } }));
  } else if (payload.hook_event_name === 'FileChanged' && payload.event === 'change') {
    const result = await requestBridge(null, { ...base, action: 'drain', input: { filePath: payload.file_path } }, 8000, directory);
    if (result.messages?.length) {
      process.stderr.write(`Relay Desk notifications for this paired chat:\n${result.messages.join('\n')}\n`);
      process.exitCode = 2;
    }
  }
}

export async function watchClaudeSession(file) {
  const directory = realpathSync(dirname(file));
  let owner;
  for (let attempt = 0; attempt < 40 && !owner; attempt++) {
    owner = parentClaudeIdentity(directory);
    if (!owner) await delay(250);
  }
  if (owner?.entrypoint !== 'claude-vscode' || owner.kind !== 'interactive' || !owner.procStart) return;
  const sameOwner = () => {
    try { return readBridgeClaudeIdentity(directory, owner.pid).procStart === owner.procStart; }
    catch { return false; }
  };
  let wait = 500;
  while (sameOwner()) {
    let socket;
    try { socket = await connectBridge(directory); }
    catch { await delay(wait); wait = Math.min(wait * 2, 5000); continue; }
    wire(socket, { type: 'watch', project: projectKey({ path: file }), pid: owner.pid, persistent: true });
    const stream = createInterface({ input: socket });
    try {
      for await (const line of stream) {
        const event = JSON.parse(line);
        if (event.state === 'not-paired') return;
        if (event.state === 'watching') {
          if (event.mode !== 'session') {
            console.error('Restart the Relay Desk background service to load session Monitor support.');
            return;
          }
          wait = 500;
        }
        if (event.message) console.log(event.message.replaceAll('\n', ' '));
      }
    } catch { /* A socket restart triggers a reconnect. */ }
    finally { socket.destroy(); stream.close(); }
    await delay(wait);
    wait = Math.min(wait * 2, 5000);
  }
}
