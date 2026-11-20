import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { codexHostSocket, codexThreads, createNamedCodexThread, deliverCodex, renameCodexThread } from './codex.mjs';
import { directDispatches } from './dispatch.mjs';
import { liveClaudeIdentities, serveLive } from './live.mjs';
import { entry, initialize, loadProject, mcpCommand, mcpName, mcpVersion, rebind, serverName } from './project.mjs';
import { actors, Mailbox, teamKey, view } from './store.mjs';
import { setupCommand } from './setup.mjs';
import { alias, createThreadFields, listThreadFields, pairThreadFields, projectId, recoveryFields, renameThreadFields, sendThreadFields, teamSetFields, threadLink, workFields } from './thread-tools.mjs';

const exec = promisify(execFile);
const uuid = z.string().uuid();
const endpoint = z.object({ session: uuid, cwd: z.string().min(1), title: z.string().max(500).optional() });
const shellQuote = (s) => "'" + s.replaceAll("'", "'\"'\"'") + "'";

export function connectionInstructions(project) {
  const claudeName = mcpName;
  const c1 = JSON.stringify({ type: 'stdio', ...mcpCommand(project, 'c1', false, true) });
  const x1 = mcpCommand(project, 'x1');
  return {
    claudeName,
    setupCommand: setupCommand(project),
    x1ReplyCommand: `${shellQuote(process.execPath)} ${shellQuote(entry)} x1-reply ${shellQuote(project.path)}`,
    claudeFolder: project.c1.cwd,
    claudeCommand: `cd ${shellQuote(project.c1.cwd)} && claude mcp add-json --scope local ${claudeName} ${shellQuote(c1)}`,
    codexConfig: `[mcp_servers.${serverName}]\ncommand = ${JSON.stringify(x1.command)}\nargs = ${JSON.stringify(x1.args)}`,
  };
}

export async function claudeSessions(directory) {
  const { stdout: ps } = await exec('/bin/ps', ['-axo', 'pid=,comm='], { timeout: 4000, maxBuffer: 4 * 1024 * 1024 });
  const livePids = new Set(ps.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(?:.*\/)?claude(?:-code)?$/i);
    return match ? [Number(match[1])] : [];
  }));
  const sessions = new Map();
  for (const row of liveClaudeIdentities(directory)) {
    if (!row.sessionId || !row.cwd || !livePids.has(row.pid)) continue;
    sessions.set(row.sessionId, {
      session: row.sessionId, cwd: row.cwd, title: row.name || 'Unnamed Claude session',
      time: row.startedAt, status: row.status, presence: 'live',
      source: row.kind, pid: row.pid,
    });
  }
  return [...sessions.values()].sort((a, b) => b.time - a.time);
}

function projectData(project, id, runner) {
  const { project: name, c1, x1 } = project;
  return { id, name, c1, x1, running: !!runner?.enabled, deliveryError: runner?.error || null, deliveryWaiting: !!runner?.waiting };
}

export async function startBridge({ directory }) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const runners = new Map();
  const running = new Set();
  const pathFor = (id) => join(directory, `${id}.json`);
  const invalidProjects = new Map();
  const listProjects = () => {
    invalidProjects.clear();
    return readdirSync(directory)
      .filter((entry) => entry.endsWith('.json') && uuid.safeParse(entry.slice(0, -5)).success)
      .flatMap((entry) => {
        const id = entry.slice(0, -5);
        try { return [projectData(loadProject(pathFor(id)), id, runners.get(id))]; }
        catch (error) { invalidProjects.set(id, error.message); return []; }
      }).sort((a, b) => a.name.localeCompare(b.name));
  };

  function checkAvailability(candidates, currentId) {
    for (const project of listProjects()) {
      if (project.id === currentId) continue;
      for (const key of actors) {
        if (project[key].session === candidates[key]?.session) {
          throw new Error(`${key.toUpperCase()} is already assigned to ${project.name}.`);
        }
      }
      if (candidates.x1 && hasWorker(project.id, candidates.x1.session)) {
        throw new Error(`That Codex thread is a worker on ${project.name}.`);
      }
    }
  }

  function hasWorker(id, threadId) {
    const project = loadProject(pathFor(id));
    return mailboxRead(project, (mailbox) => mailbox.team(project).some((member) => member.role === 'worker' && member.session === threadId));
  }

  function mailboxRead(project, fn) {
    const mailbox = new Mailbox(project.dbPath, project);
    try { return fn(mailbox); } finally { mailbox.close(); }
  }

  function switchPair(id, key, selected, expectedC1, expectedX1) {
    const project = loadProject(pathFor(id));
    if (expectedC1 && project.c1.session !== expectedC1) throw new Error('C1 changed during this request.');
    if (expectedX1 && project.x1.session !== expectedX1) throw new Error('X1 changed during this request. Review the new pairing before replacing it.');
    checkAvailability({ [key]: selected }, id);
    if (project[key].session === selected.session) return project;
    return rebind(project, key, selected, { announce: true });
  }

  const operations = new DatabaseSync(join(directory, 'thread-operations.sqlite'));
  operations.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS thread_operations (
      scope TEXT NOT NULL,
      request_key TEXT NOT NULL,
      options TEXT NOT NULL,
      result TEXT,
      PRIMARY KEY (scope, request_key)
    );
  `);

  const direct = directDispatches(operations, directory);

  function projectWork(project, id, input) {
    const fields = z.object(workFields).parse(input);
    return mailboxRead(project, (mailbox) => {
      const team = mailbox.team(project).map((person) => ({ ...person,
        ...(person.role === 'project-lead' ? {} : { link: threadLink(person.session) }),
      }));
      return { project: project.project, team, handoffs: mailbox.work(fields), workers: direct.work(id, fields) };
    });
  }

  async function catalog(socket) {
    const rows = await codexThreads(socket);
    const ids = new Set(rows.map((thread) => thread.session));
    const history = operations.prepare('SELECT scope, request_key, result FROM thread_operations WHERE result IS NOT NULL').all();
    for (const { scope, request_key: key, result: stored } of history) {
      const result = JSON.parse(stored);
      if (!result.thread) continue;
      if (ids.has(result.thread.session)) {
        if (!result.wasListed) {
          operations.prepare('UPDATE thread_operations SET result = ? WHERE scope = ? AND request_key = ?')
            .run(JSON.stringify({ ...result, wasListed: true }), scope, key);
        }
      } else if (result.ready && !result.wasListed) {
        ids.add(result.thread.session);
        rows.push({ ...result.thread, time: result.thread.time, presence: 'saved', archived: false });
      }
    }
    return rows.sort((a, b) => (b.time || 0) - (a.time || 0));
  }

  async function manageThread(id, action, payload, expectedC1, identity, expectedX1) {
    const project = id ? loadProject(pathFor(id)) : null;
    if (expectedC1 && project?.c1.session !== expectedC1) throw new Error('This C1 pairing has changed.');
    if (expectedX1 && project?.x1.session !== expectedX1) throw new Error('The Codex lead changed.');
    if (action === 'diagnostics') {
      const projects = listProjects();
      return {
        projects: projects.length,
        invalidProjects: [...invalidProjects].map(([projectId, error]) => ({ projectId, error })),
        codexHost: codexHostSocket(project?.codexSocket) ? 'shared-socket' : 'local-profile',
      };
    }
    if (action === 'projects') {
      const cwd = identity?.cwd && realpathSync(identity.cwd);
      return listProjects().filter((entry) => entry.c1.cwd === cwd);
    }
    if (action === 'recover') {
      const fields = z.object({ ...recoveryFields, projectId: projectId.optional() }).parse(payload);
      const selectedId = id || projectId.parse(fields.projectId);
      const selected = project || loadProject(pathFor(selectedId));
      if (!identity?.cwd || realpathSync(identity.cwd) !== selected.c1.cwd) {
        throw new Error('Run recovery from the project’s Claude workspace.');
      }
      const next = {};
      if (identity.sessionId !== selected.c1.session) {
        if (fields.previousClaudeSession !== selected.c1.session) {
          throw new Error('Confirm the previous Claude session ID from bridge_projects before replacing it.');
        }
        if (liveClaudeIdentities(directory).some((record) => record.sessionId === selected.c1.session)) {
          throw new Error('The previous Claude lead is still live. Close it before replacing it.');
        }
        next.c1 = endpoint.parse({ session: identity.sessionId, cwd: selected.c1.cwd, title: identity.name });
      }
      if (fields.codexThreadId && fields.codexThreadId !== selected.x1.session) {
        if (fields.previousCodexThreadId !== selected.x1.session) {
          throw new Error('Confirm the current Codex lead’s thread ID before replacing it.');
        }
        next.x1 = (await catalog(selected.codexSocket)).find((thread) => thread.session === fields.codexThreadId && thread.cwd && !thread.archived);
        if (!next.x1) throw new Error('Choose a non-archived Codex thread with a workspace.');
        next.x1 = endpoint.parse({ ...next.x1, cwd: realpathSync(next.x1.cwd) });
      }
      checkAvailability(next, selectedId);
      const recovered = mailboxRead(selected, (mailbox) => mailbox.recoverBinding(selected, next, fields.transferIds));
      return { ...projectData(recovered.project, selectedId, runners.get(selectedId)), adopted: recovered.adopted,
        work: projectWork(recovered.project, selectedId, {}), setup: connectionInstructions(recovered.project) };
    }
    if (action === 'claude-sessions') return claudeSessions(directory);
    if (action === 'create-project') {
      const { name, threadId, automaticDelivery = false } = z.object({
        name: z.string().trim().min(1).max(120), ...pairThreadFields, automaticDelivery: z.boolean().optional(),
      }).parse(payload);
      const x1 = (await catalog()).find((row) => row.session === threadId && !row.archived && row.cwd);
      if (!x1) throw new Error('Choose a non-archived Codex thread with a workspace.');
      const c1 = endpoint.parse({ session: identity?.sessionId, cwd: identity?.cwd, title: identity?.name });
      checkAvailability({ c1, x1 });
      const projectId = randomUUID();
      const created = initialize(pathFor(projectId), { project: name, c1, x1 });
      mailboxRead(created, (mailbox) => {
        mailbox.announce(created);
        mailbox.setAutoWake(automaticDelivery);
      });
      if (automaticDelivery) runners.set(projectId, { enabled: true, active: false });
      return { ...projectData(created, projectId, runners.get(projectId)), setup: connectionInstructions(created) };
    }
    if (action === 'brief') {
      const { brief } = z.object({ brief: z.string().trim().max(8000) }).parse(payload);
      return { brief: mailboxRead(project, (mailbox) => mailbox.saveBrief(brief)) };
    }
    if (action === 'delivery') {
      const { enabled } = z.object({ enabled: z.boolean() }).parse(payload);
      const runner = runners.get(id) || { active: false };
      mailboxRead(project, (mailbox) => mailbox.setAutoWake(enabled));
      runner.enabled = enabled;
      runner.error = null;
      runner.waiting = false;
      runners.set(id, runner);
      return projectData(project, id, runner);
    }
    if (action === 'resolve') {
      const { messageId, state } = z.object({ messageId: uuid, state: z.enum(['pending', 'delivered']) }).parse(payload);
      if (runners.get(id)?.active) throw new Error('Wait for the current delivery to finish.');
      return mailboxRead(project, (mailbox) => view(mailbox.resolve(messageId, state)));
    }
    if (action === 'team-set') {
      const fields = z.object(teamSetFields).parse(payload);
      if (fields.threadId) {
        const thread = (await catalog(project.codexSocket)).find((item) => item.session === fields.threadId && item.cwd && !item.archived);
        if (!thread) throw new Error('Choose a non-archived local Codex worker thread.');
        const conflicts = listProjects().some((item) => item.id !== id &&
          (item.x1.session === fields.threadId || hasWorker(item.id, fields.threadId)));
        if (conflicts) throw new Error('This thread is assigned to a different project.');
      }
      return mailboxRead(project, (mailbox) => mailbox.setTeamAlias(project, fields));
    }
    if (action === 'team-remove') {
      const fields = z.object({ alias, expectedThreadId: uuid }).parse(payload);
      return mailboxRead(project, (mailbox) => mailbox.removeWorker(project, fields.alias, fields.expectedThreadId));
    }
    if (action === 'list') {
      const { query, offset = 0, limit = 25 } = z.object(listThreadFields).parse(payload);
      const projects = new Map(listProjects().map((item) => [item.x1.session, item]));
      const text = query?.toLowerCase();
      const threads = (await catalog(project?.codexSocket)).filter((item) => !text ||
        [item.title, item.cwd, item.session].join(' ').toLowerCase().includes(text));
      return {
        threads: threads.slice(offset, offset + limit).map((thread) => ({
          ...thread, link: threadLink(thread.session),
          pairedProject: projects.get(thread.session)?.name ?? null,
        })),
        total: threads.length,
        nextOffset: offset + limit < threads.length ? offset + limit : null,
        currentX1: project?.x1.session ?? null,
      };
    }
    if (action === 'message' || action === 'direct-status' || action === 'team-send') {
      const scope = id || `workspace:${identity?.cwd || identity?.sessionId}`;
      if (action === 'direct-status') {
        return direct.status(scope, z.object({ messageId: uuid }).parse(payload).messageId);
      }
      const worker = action === 'team-send' && z.object({ alias }).parse(payload).alias;
      const lookupWorker = () => mailboxRead(project, (mailbox) => mailbox.team(project)
        .find((person) => person.role === 'worker' && teamKey(person.alias) === teamKey(worker)));
      const assignee = worker ? lookupWorker() : null;
      if (worker && !assignee) throw new Error('This project has no worker with that alias.');
      const fields = z.object(sendThreadFields).parse(assignee ? { ...payload, threadId: assignee.session } : payload);
      const socket = codexHostSocket(project?.codexSocket);
      const thread = (await catalog(socket)).find((item) => item.session === fields.threadId && item.cwd && !item.archived);
      if (!thread) throw new Error('A non-archived local Codex thread with that ID was not found.');
      if (expectedC1 && loadProject(pathFor(id)).c1.session !== expectedC1) throw new Error('The project lead changed.');
      if (expectedX1 && loadProject(pathFor(id)).x1.session !== expectedX1) throw new Error('The Codex lead changed.');
      if (assignee && lookupWorker()?.session !== thread.session) throw new Error('The worker alias changed. Refresh before sending.');
      return direct.send(scope, thread, { ...fields, workerAlias: assignee?.alias }, socket);
    }
    if (action === 'pair') {
      if (!project) throw new Error('Choose a Relay Desk project first.');
      const { threadId } = z.object(pairThreadFields).parse(payload);
      const thread = (await catalog(project?.codexSocket)).find((row) => row.session === threadId && !row.archived && row.cwd);
      if (!thread) throw new Error('Choose a non-archived Codex thread with a workspace.');
      const updated = switchPair(id, 'x1', thread, expectedC1, project.x1.session);
      return { ...projectData(updated, id, runners.get(id)), link: threadLink(threadId) };
    }
    if (action === 'rename') {
      if (!project) throw new Error('Choose a Relay Desk project first.');
      const { title } = z.object(renameThreadFields).parse(payload);
      await renameCodexThread(project.x1, title, project.codexSocket);
      const current = loadProject(pathFor(id));
      if (current.x1.session === project.x1.session) {
        rebind(current, 'x1', { ...current.x1, title });
      }
      for (const row of operations.prepare('SELECT scope,request_key,result FROM thread_operations WHERE result IS NOT NULL').all()) {
        const result = JSON.parse(row.result);
        if (result.thread?.session !== project.x1.session) continue;
        result.thread.title = title;
        operations.prepare('UPDATE thread_operations SET result = ? WHERE scope = ? AND request_key = ?')
          .run(JSON.stringify(result), row.scope, row.request_key);
      }
      return { thread: { ...project.x1, title, link: threadLink(project.x1.session) } };
    }
    if (action !== 'create') throw new Error('Unknown Codex thread operation.');
    const { title, cwd = project?.c1.cwd, requestKey, pairAsX1 = false } = z.object(createThreadFields).parse(payload);
    if (!cwd) throw new Error('Choose a workspace for the new Codex thread.');
    if (pairAsX1 && !project) throw new Error('Choose a project to pair the new thread.');
    const scope = id || 'directory';
    const options = JSON.stringify({ title, cwd, pairAsX1 });
    const record = operations.prepare('SELECT options,result FROM thread_operations WHERE scope = ? AND request_key = ?');
    const before = record.get(scope, requestKey);
    if (before) {
      if (before.options !== options) throw new Error('That request key belongs to a different thread request.');
      if (before.result) return JSON.parse(before.result);
      throw new Error('A create request is in progress or its outcome is unknown. Run codex_threads before trying again.');
    }
    if (pairAsX1 && mailboxRead(project, (mailbox) => actors.some((key) => mailbox.dispatching(key)))) {
      throw new Error('Wait for the current handoff before changing X1.');
    }
    operations.prepare('INSERT INTO thread_operations (scope, request_key, options) VALUES (?, ?, ?)').run(scope, requestKey, options);
    const save = (result) => {
      operations.prepare('UPDATE thread_operations SET result = ? WHERE scope = ? AND request_key = ?')
        .run(JSON.stringify(result), scope, requestKey);
      return result;
    };
    let thread;
    let ready = false;
    try {
      thread = await createNamedCodexThread(cwd, title, (created) => {
        thread = created;
        save({ thread: created, paired: false, issue: 'Codex started the thread. Setup outcome is still being checked.' });
      }, project?.codexSocket);
      ready = true;
      if (pairAsX1) switchPair(id, 'x1', thread, expectedC1, project.x1.session);
      return save({ thread, paired: pairAsX1, ready });
    } catch (error) {
      if (thread) return save({ thread, paired: false, ready, issue: error.message });
      if (!/timed out|disconnected|connection closed|app server exited/i.test(error.message)) {
        operations.prepare('DELETE FROM thread_operations WHERE scope = ? AND request_key = ?').run(scope, requestKey);
      }
      throw error;
    }
  }

  for (const item of listProjects()) {
    const project = loadProject(pathFor(item.id));
    if (mailboxRead(project, (mailbox) => mailbox.autoWake())) {
      runners.set(item.id, { enabled: true, active: false });
    }
  }

  let live;
  try {
    live = await serveLive({
      directory,
      resolveProject: (id) => loadProject(pathFor(uuid.parse(id))),
      manageThread,
      projectWork,
      workerReceipt: (thread, message, token) => direct.acknowledge(
        uuid.parse(thread), uuid.parse(message), z.string().regex(/^[A-Za-z0-9_-]{32}$/).parse(token)),
      workerReport: (thread, message, token, disposition, body) => direct.report(
        uuid.parse(thread), uuid.parse(message), z.string().regex(/^[A-Za-z0-9_-]{32}$/).parse(token),
        z.enum(['completed', 'blocked']).parse(disposition), z.string().trim().min(1).max(24000).parse(body)),
      async projectStatus(project, id, doctor) {
        const status = mailboxRead(project, (mailbox) => ({
          ...projectData(project, id, runners.get(id)),
          relayVersion: mcpVersion,
          monitorReady: live.ready(project, id),
          monitor: live.monitorStatus(project, id),
          readiness: Object.fromEntries(actors.map((key) => [key, mailbox.readiness(key, project[key])])),
        }));
        if (!doctor) return status;
        const host = codexHostSocket(project.codexSocket) ? 'shared-socket' : 'local-profile';
        try {
          const thread = (await catalog(project.codexSocket)).find((row) => row.session === project.x1.session);
          const liveSteering = host === 'local-profile'
            ? { state: 'unavailable', reason: 'No shared Codex App Server socket is available to steer a Desktop turn.' }
            : { state: thread?.status ?? 'unknown', reason: null };
          return { ...status, codex: { host, found: !!thread, archived: thread?.archived ?? null,
            presence: thread?.presence ?? null, liveSteering } };
        } catch (error) {
          return { ...status, codex: { host, error: error.message } };
        }
      },
    });
  } catch (error) {
    operations.close();
    throw error;
  }

  async function pump(id, runner) {
    runner.active = true;
    try {
      const project = loadProject(pathFor(id));
      const next = mailboxRead(project, (mailbox) => mailbox.next('x1'));
      if (!next) return;
      const result = await deliverCodex(project, next.id);
      runner.waiting = result.state === 'busy';
      if (result.error) {
        runner.error = result.error;
        runner.enabled = false;
        mailboxRead(project, (mailbox) => mailbox.setAutoWake(false));
      } else if (result.state === 'busy') {
        runner.retryAt = Date.now() + 10000;
      }
    } catch (error) {
      runner.error = error.message;
      runner.enabled = false;
    } finally {
      runner.active = false;
    }
  }

  const claudePumps = new Set();
  const timer = setInterval(() => {
    for (const item of listProjects()) {
      if (claudePumps.has(item.id)) continue;
      const project = loadProject(pathFor(item.id));
      if (!live.ready(project, item.id)) continue;
      claudePumps.add(item.id);
      const task = live.deliverQueuedClaude(project, item.id)
        .catch((error) => { console.error(error.message); })
        .finally(() => claudePumps.delete(item.id));
      running.add(task);
      void task.finally(() => running.delete(task));
    }
    for (const [id, runner] of runners) {
      if (runner.enabled && !runner.active && !(runner.retryAt > Date.now())) {
        const task = pump(id, runner);
        running.add(task);
        void task.finally(() => running.delete(task));
      }
    }
  }, 2000);

  return {
    async close() {
      clearInterval(timer);
      await live.close();
      await Promise.allSettled(running);
      operations.close();
    },
  };
}
