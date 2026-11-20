import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { acknowledgeDirectCodex, readBridgeClaudeIdentity, reportDirectCodex, resolveWorkspaceC1 } from '../src/live.mjs';
import { addClaudeProfile } from '../src/claude-profiles.mjs';
import { directDispatches, readDirectReceipt } from '../src/dispatch.mjs';
import { createIdeWake } from '../src/ide-wake.mjs';
import { startBridge } from '../src/service.mjs';
import { deliverCodex, sendToCodexThread, steerCodex } from '../src/codex.mjs';
import { entry, initialize, loadProject, mcpCommand, rebind } from '../src/project.mjs';
import { Mailbox, view } from '../src/store.mjs';
import { codexRegistration } from '../src/setup.mjs';
import { verifySmoke } from '../src/smoke.mjs';

const assignment = { kind: 'assignment', subject: 'Backend changes', body: 'Implement the agreed change.', requestKey: 'backend-1' };
const audit = { kind: 'audit', subject: 'Backend audit', body: 'Review the fixture commit.', requestKey: 'audit-1' };

function temp(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'leader-bridge-test-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function pair(cwd, project = 'Fixture') {
  return { project, c1: { session: randomUUID(), cwd, title: 'Project Lead' }, x1: { session: randomUUID(), cwd } };
}

async function tool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text);
}

async function connect(project, actor, channel, configure) {
  const client = new Client({ name: 'bridge-test', version: '1.0.0' });
  configure?.(client);
  await client.connect(new StdioClientTransport({ ...mcpCommand(project, actor, channel), stderr: 'pipe' }));
  return client;
}

test('assignment, audit, reply, and recheck survive project separation and leader rotation', async (t) => {
  const directory = temp(t);
  const project = initialize(join(directory, 'main.json'), pair(directory));
  const second = initialize(join(directory, 'second.json'), pair(directory, 'Second'));
  const c1 = await connect(project, 'c1', false);
  const x1 = await connect(project, 'x1', false);
  const secondX1 = await connect(second, 'x1', false);
  try {
    await assert.rejects(tool(x1, 'bridge_send', assignment), /C1 assigns/);
    const local = new Mailbox(project.dbPath);
    local.saveBrief('Use the fixture checkout and report test evidence.');
    local.close();
    assert.match((await tool(x1, 'bridge_context')).brief, /fixture checkout/);
    const assigned = await tool(c1, 'bridge_send', assignment);
    const retried = await tool(c1, 'bridge_send', assignment);
    assert.equal(assigned.id, retried.id);
    await assert.rejects(tool(c1, 'bridge_send', { ...assignment, body: 'A changed request.' }), /different message/);
    assert.equal((await tool(x1, 'bridge_inbox'))[0].id, assigned.id);
    assert.deepEqual(await tool(secondX1, 'bridge_inbox'), []);

    const request = await tool(x1, 'bridge_send', { ...audit, parentId: assigned.id });
    await tool(c1, 'bridge_acknowledge', { id: request.id });
    await tool(c1, 'bridge_reply', { id: request.id, body: 'One finding, fixed in the next commit.', disposition: 'completed' });
    const result = (await tool(x1, 'bridge_status', { id: request.id })).related[0];
    assert.equal(result.kind, 'result');
    assert.equal(result.disposition, 'completed');

    const fresh = rebind(project, 'x1', { session: randomUUID(), cwd: directory });
    await assert.rejects(tool(x1, 'bridge_inbox'), /session was replaced/);
    const newX1 = await connect(fresh, 'x1', false);
    try {
      assert.match((await tool(newX1, 'bridge_context')).brief, /fixture checkout/);
      assert.equal((await tool(newX1, 'bridge_status', { id: request.id })).related[0].id, result.id);
      const recheck = await tool(newX1, 'bridge_send', { ...audit, kind: 'recheck', parentId: result.id, requestKey: 'recheck-1' });
      assert.equal((await tool(c1, 'bridge_inbox'))[0].id, recheck.id);
    } finally {
      await newX1.close();
    }
  } finally {
    await Promise.all([c1.close(), x1.close(), secondX1.close()]);
  }
});

test('workspace Claude registration requires the selected parent chat before recording a tool receipt', async (t) => {
  const directory = temp(t);
  const project = initialize(join(directory, 'identity.json'), pair(directory));
  mkdirSync(join(directory, 'sessions'));
  const registry = join(directory, 'sessions', `${process.pid}.json`);
  const setSession = (sessionId) => writeFileSync(registry, JSON.stringify({ pid: process.pid, sessionId }));
  setSession(randomUUID());
  const client = new Client({ name: 'bridge-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    ...mcpCommand(project, 'c1', false, true), env: { ...process.env, CLAUDE_CONFIG_DIR: directory }, stderr: 'pipe',
  }));
  const mailbox = new Mailbox(project.dbPath);
  try {
    await assert.rejects(tool(client, 'bridge_context'), /Only the Claude Code chat paired/);
    assert.equal(mailbox.readiness('c1', project.c1).verifiedAt, null);
    setSession(project.c1.session);
    assert.equal((await tool(client, 'bridge_context')).role, 'C1');
    assert.ok(mailbox.readiness('c1', project.c1).verifiedAt);
    setSession(randomUUID());
    await assert.rejects(tool(client, 'bridge_inbox'), /Only the Claude Code chat paired/);
  } finally {
    mailbox.close();
    await client.close();
  }
});

test('channel emits a notification with the message ID and tracks confirmation', async (t) => {
  const directory = temp(t);
  const project = initialize(join(directory, 'main.json'), pair(directory));
  const mailbox = new Mailbox(project.dbPath);
  const queued = mailbox.send('x1', audit);
  let notification;
  const c1 = await connect(project, 'c1', true, (client) => {
    client.setNotificationHandler(z.object({
      method: z.literal('notifications/claude/channel'),
      params: z.object({ content: z.string(), meta: z.record(z.string(), z.string()) }),
    }), (event) => { notification = event; });
  });
  try {
    for (let i = 0; i < 150 && !notification; ++i) await setTimeout(20);
    assert.equal(notification?.params.meta.message_id, queued.id);
    assert.match(notification.params.content, /Review the fixture commit/);
    assert.equal(mailbox.find(queued.id).state, 'notified');
    await tool(c1, 'bridge_acknowledge', { id: queued.id });
    assert.equal(mailbox.find(queued.id).state, 'delivered');
  } finally {
    await c1.close();
    mailbox.close();
  }
});

test('Codex adapter serializes delivery, reads the final result, and avoids blind retries', async (t) => {
  const directory = temp(t);
  const project = initialize(join(directory, 'main.json'), pair(directory));
  process.env.BRIDGE_CODEX = fileURLToPath(new URL('./fixtures/codex.mjs', import.meta.url));
  const mailbox = new Mailbox(project.dbPath);
  try {
    const sent = mailbox.send('c1', assignment);
    const later = mailbox.send('c1', { ...assignment, requestKey: 'second' });
    const [first, second] = await Promise.all([deliverCodex(project, sent.id), deliverCodex(project, later.id)]);
    assert.equal(first.state, 'turn-completed');
    assert.equal(second.state, 'busy');
    assert.equal(mailbox.status(sent.id).related[0].body, 'Verified on the fixture commit.');

    process.env.FIXTURE_CODEX_STATE = 'active';
    assert.equal((await deliverCodex(project, later.id)).state, 'busy');
    assert.equal(mailbox.find(later.id).state, 'pending');
    delete process.env.FIXTURE_CODEX_STATE;

    process.env.FIXTURE_TURN_STATE = 'failed';
    assert.equal((await deliverCodex(project, later.id)).state, 'uncertain');
    assert.equal(mailbox.status(later.id).related.length, 0);
    await assert.rejects(deliverCodex(project, later.id), /queued message/);
  } finally {
    delete process.env.BRIDGE_CODEX;
    delete process.env.FIXTURE_CODEX_STATE;
    delete process.env.FIXTURE_TURN_STATE;
    mailbox.close();
  }
});

test('Desktop-owned threads receive the pending handoffs in a single native inbox submission', async (t) => {
  const directory = temp(t);
  const project = initialize(join(directory, 'desktop.json'), pair(directory));
  const mailbox = new Mailbox(project.dbPath);
  process.env.BRIDGE_CODEX = fileURLToPath(new URL('./fixtures/codex.mjs', import.meta.url));
  process.env.FIXTURE_NATIVE_QUEUE = join(directory, 'submitted.txt');
  try {
    const first = mailbox.send('c1', assignment);
    const followup = mailbox.send('c1', audit);
    assert.equal((await deliverCodex(project, first.id)).state, 'codex-inbox');
    const submitted = readFileSync(process.env.FIXTURE_NATIVE_QUEUE, 'utf8');
    assert.ok(submitted.includes(first.id) && submitted.includes(followup.id));
    assert.equal(mailbox.find(followup.id).state, 'codex-inbox');
    assert.equal(mailbox.next('x1'), undefined);
  } finally {
    delete process.env.BRIDGE_CODEX;
    delete process.env.FIXTURE_NATIVE_QUEUE;
    mailbox.close();
  }
});

test('a live update steers the running Codex turn', async (t) => {
  const directory = temp(t);
  const project = initialize(join(directory, 'midturn.json'), pair(directory));
  const mailbox = new Mailbox(project.dbPath);
  process.env.BRIDGE_CODEX = fileURLToPath(new URL('./fixtures/codex.mjs', import.meta.url));
  process.env.FIXTURE_CODEX_LIVE = '1';
  try {
    const message = mailbox.send('c1', assignment);
    const turn = deliverCodex(project, message.id);
    let steered = false;
    for (let i = 0; i < 100 && !steered; ++i) {
      try { await steerCodex(project, 'LIVE-TEST'); steered = true; }
      catch (error) { if (!error.message.includes('cannot reach an active turn')) throw error; }
      if (!steered) await setTimeout(20);
    }
    assert.equal(steered, true);
    assert.equal((await turn).state, 'turn-completed');
  } finally {
    delete process.env.BRIDGE_CODEX;
    delete process.env.FIXTURE_CODEX_LIVE;
    mailbox.close();
  }
});

test('send-now reaches the verified Claude monitor and fails with no queue when it is unavailable', async (t) => {
  const directory = temp(t);
  const id = randomUUID();
  const project = initialize(join(directory, `${id}.json`), pair(directory));
  const registry = join(directory, 'sessions');
  mkdirSync(registry);
  writeFileSync(join(registry, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: project.c1.session, name: 'Project Lead', cwd: directory }));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = directory;
  const service = await startBridge({ directory });
  const x1 = await connect(project, 'x1', false);
  const send = (key) => tool(x1, 'bridge_send_now', {
    kind: 'update', reference: 'fixture task', subject: 'LIVE-TEST', body: 'Live test', requestKey: key,
  });
  let monitor;
  const c1 = new Client({ name: 'monitor-grant-test', version: '1.0.0' });
  await c1.connect(new StdioClientTransport({
    ...mcpCommand(project, 'c1', false, true), env: { ...process.env }, stderr: 'pipe',
  }));
  try {
    await assert.rejects(send('missing'), /Nothing was queued/);
    const mailboxBefore = new Mailbox(project.dbPath);
    const offlineHandoff = mailboxBefore.send('c1', { ...audit, requestKey: 'offline-verdict' });
    mailboxBefore.close();
    const verdictArgs = {
      id: offlineHandoff.id, body: 'Focused audit complete.', disposition: 'completed',
      verdict: 'GO WITH NOTES', evidencePath: 'docs/audit.md',
    };
    await assert.rejects(tool(x1, 'bridge_reply_now', verdictArgs), /Verdict record:/);
    const offline = await tool(c1, 'bridge_status', { id: offlineHandoff.id });
    assert.equal(offline.related[0].state, 'saved');
    assert.equal(offline.related[0].verdict_label, 'GO WITH NOTES');
    assert.equal(offline.related[0].evidence_path, 'docs/audit.md');
    const { prompt, monitor: starting } = await tool(c1, 'bridge_monitor_setup');
    assert.equal(starting.state, 'starting');
    assert.ok(starting.setupExpiresAt > Date.now());
    const repeated = await tool(c1, 'bridge_recover');
    assert.equal(repeated.monitorPrompt, prompt);
    assert.equal(repeated.monitor.setupExpiresAt, starting.setupExpiresAt);
    assert.equal((await tool(x1, 'bridge_connection_status')).monitorReady, false);
    await assert.rejects(send('not-ready-yet'), /Monitor is starting.*Nothing was queued/);
    const grant = prompt.match(/'([^']+monitor-grants[^']+[.]json)'\. Run it promptly/)[1];
    const token = JSON.parse(readFileSync(grant, 'utf8')).token;
    assert.equal(statSync(grant).mode & 0o777, 0o600);
    assert.ok(!prompt.includes(token));
    const monitorEnv = { ...process.env, CLAUDE_CONFIG_DIR: join(directory, 'missing-registry') };
    monitor = spawn(process.execPath, [entry, 'live-watch', project.path, grant], { env: monitorEnv });
    let received = '';
    monitor.stdout.on('data', (data) => { received += data; });
    monitor.stderr.resume();
    for (let i = 0; i < 100; ++i) {
      if ((await tool(c1, 'bridge_connection_status')).monitorReady) break;
      await setTimeout(25);
    }
    const duplicate = spawn(process.execPath, [entry, 'live-watch', project.path, grant], { env: monitorEnv });
    let refused = '';
    duplicate.stderr.on('data', (chunk) => { refused += chunk; });
    await new Promise((resolve) => duplicate.once('close', resolve));
    assert.match(refused, /expired or was already used/);
    const liveVerdict = await tool(x1, 'bridge_send_saved_verdict', { id: offlineHandoff.id });
    assert.equal(liveVerdict.id, offline.related[0].id);
    assert.equal(liveVerdict.state, 'live-accepted');
    assert.equal((await tool(c1, 'bridge_acknowledge', { id: liveVerdict.id })).state, 'delivered');
    await assert.rejects(tool(c1, 'bridge_reply', { id: liveVerdict.id, body: 'follow-up', disposition: 'completed' }),
      /kind to update and parentId to the result ID/);
    await assert.rejects(tool(x1, 'bridge_send', { kind: 'update', body: 'orphan', subject: 'orphan', requestKey: 'orphan' }),
      /Add parentId/);
    const accepted = await send('live');
    assert.equal(accepted.state, 'live-accepted');
    for (let i = 0; i < 50 && !received.includes(accepted.id); ++i) await setTimeout(20);
    assert.match(received, new RegExp(accepted.id));
    const mailbox = new Mailbox(project.dbPath);
    try {
      assert.equal(mailbox.next('c1'), undefined);
      assert.equal(mailbox.acknowledge('c1', accepted.id).state, 'delivered');
      const handoff = mailbox.send('c1', audit);
      const reply = spawn(process.execPath, [entry, 'x1-reply', project.path, handoff.id, 'completed'], {
        env: { ...process.env, CODEX_THREAD_ID: project.x1.session },
      });
      let stdout = '';
      reply.stdout.on('data', (chunk) => { stdout += chunk; });
      reply.stderr.resume();
      reply.stdin.end('Focused audit complete.');
      await new Promise((resolve, reject) => {
        reply.once('error', reject);
        reply.once('close', (code) => code === 0 ? resolve() : reject(new Error('X1 fallback command failed')));
      });
      const receipt = JSON.parse(stdout);
      assert.equal(receipt.parent_id, handoff.id);
      assert.equal(receipt.state, 'live-accepted');

      const queued = mailbox.send('c1', { ...audit, requestKey: 'queued-claude-test' });
      const report = mailbox.reply('x1', queued.id, 'Queued report', 'completed');
      for (let i = 0; i < 130 && !received.includes(report.id); i++) await setTimeout(25);
      assert.ok(received.includes(report.id));
      assert.equal(mailbox.find(report.id).state, 'notified');

      let replacementSession = randomUUID();
      writeFileSync(join(registry, `${process.pid}.json`), JSON.stringify({
        pid: process.pid, sessionId: replacementSession, name: 'Project Lead', cwd: directory,
      }));
      const stale = await tool(c1, 'bridge_connection_status');
      assert.equal(stale.monitorReady, false);
      assert.equal(stale.monitor.state, 'stale');
      assert.ok(stale.monitor.expiresAt);
      const retry = await tool(x1, 'bridge_send_saved_verdict', { id: offlineHandoff.id });
      assert.equal(retry.id, liveVerdict.id);
      assert.equal(retry.state, 'delivered');
      assert.equal(retry.recipientBinding, 'previous-session');
      const { prompt: abandoned } = await tool(c1, 'bridge_monitor_setup');
      const abandonedGrant = abandoned.match(/'([^']+monitor-grants[^']+[.]json)'\. Run it promptly/)[1];
      replacementSession = randomUUID();
      writeFileSync(join(registry, `${process.pid}.json`), JSON.stringify({
        pid: process.pid, sessionId: replacementSession, name: 'Project Lead', cwd: directory,
      }));
      const { prompt: replacement } = await tool(c1, 'bridge_monitor_setup');
      assert.throws(() => statSync(abandonedGrant), /ENOENT/);
      const nextGrant = replacement.match(/'([^']+monitor-grants[^']+[.]json)'\. Run it promptly/)[1];
      const oldMonitor = monitor;
      monitor = spawn(process.execPath, [entry, 'live-watch', project.path, nextGrant], { env: monitorEnv });
      monitor.stdout.resume();
      monitor.stderr.resume();
      for (let i = 0; i < 100; i++) {
        if ((await tool(c1, 'bridge_connection_status')).monitorReady) break;
        await setTimeout(25);
      }
      assert.equal((await tool(c1, 'bridge_connection_status')).monitorReady, true);
      assert.equal(loadProject(project.path).c1.session, replacementSession);
      if (oldMonitor.exitCode === null) oldMonitor.kill();
      const current = await tool(c1, 'bridge_connection_status');
      await assert.rejects(tool(c1, 'bridge_monitor_setup'), /already active until/);
      const { prompt: takeoverPrompt } = await tool(c1, 'bridge_monitor_setup', { takeover: true });
      const takeoverGrant = takeoverPrompt.match(/'([^']+monitor-grants[^']+[.]json)'\. Run it promptly/)[1];
      const beforeTakeover = monitor;
      monitor = spawn(process.execPath, [entry, 'live-watch', project.path, takeoverGrant], { env: monitorEnv });
      monitor.stdout.resume();
      monitor.stderr.resume();
      let takenOver;
      for (let i = 0; i < 100; i++) {
        takenOver = await tool(c1, 'bridge_connection_status');
        if (takenOver.monitorReady && takenOver.monitor.startedAt > current.monitor.startedAt) break;
        await setTimeout(25);
      }
      if (beforeTakeover.exitCode === null) beforeTakeover.kill();
      assert.equal(takenOver.monitorReady, true);
      assert.ok(takenOver.monitor.startedAt > current.monitor.startedAt);
      const advance = t.mock.method(Date, 'now', () => takenOver.monitor.expiresAt + 1);
      try {
        const expired = await tool(x1, 'bridge_connection_status');
        assert.equal(expired.monitorReady, false);
        assert.equal(expired.monitor.state, 'expired');
        await assert.rejects(send('after-clock-jump'), /Nothing was queued/);
      } finally { advance.mock.restore(); }
    } finally {
      mailbox.close();
    }
  } finally {
    monitor?.kill();
    await Promise.all([c1.close(), x1.close()]);
    await service.close();
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

test('verified C1 manages threads and project controls through MCP', async (t) => {
  const directory = temp(t);
  const pidDirectory = join(directory, 'sessions');
  mkdirSync(pidDirectory);
  const id = randomUUID();
  const project = initialize(join(directory, `${id}.json`), pair(directory));
  const registry = join(pidDirectory, `${process.pid}.json`);
  const setClaude = (sessionId) => writeFileSync(registry, JSON.stringify({ pid: process.pid, sessionId }));
  const catalog = join(directory, 'catalog.json');
  const original = { id: project.x1.session, cwd: directory, name: 'Previous X1', updatedAt: 1 };
  writeFileSync(catalog, JSON.stringify([original]));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = directory;
  process.env.BRIDGE_CODEX = fileURLToPath(new URL('./fixtures/codex.mjs', import.meta.url));
  process.env.FIXTURE_CATALOG = catalog;
  const service = await startBridge({ directory });
  const client = new Client({ name: 'bridge-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    ...mcpCommand(project, 'c1', false, true), env: { ...process.env }, stderr: 'pipe',
  }));
  try {
    setClaude(randomUUID());
    await assert.rejects(tool(client, 'codex_threads'), /Only the Claude Code chat paired/);
    setClaude(project.c1.session);
    const before = await tool(client, 'codex_threads');
    assert.equal(before.threads[0].link, `codex://threads/${original.id}`);
    assert.equal(before.threads[0].pairedProject, project.project);

    const options = { title: 'New X1', pairAsX1: true, requestKey: 'user-request' };
    const created = await tool(client, 'codex_create_thread', options);
    assert.equal(created.paired, true);
    assert.equal((await tool(client, 'codex_create_thread', options)).thread.session, created.thread.session);
    assert.equal(JSON.parse(readFileSync(catalog)).length, 2);

    const status = await tool(client, 'bridge_connection_status');
    assert.equal(status.x1.session, created.thread.session);
    assert.equal(status.x1.title, 'New X1');
    const listing = await tool(client, 'codex_threads', { query: 'New X1' });
    assert.equal(listing.threads[0].session, created.thread.session);
    assert.equal(listing.threads[0].pairedProject, project.project);

    assert.equal((await tool(client, 'codex_rename_x1', { title: 'Renamed X1' })).thread.title, 'Renamed X1');
    assert.equal((await tool(client, 'codex_threads', { query: 'Renamed X1' })).threads[0].title, 'Renamed X1');
    const pending = await tool(client, 'bridge_send', assignment);
    assert.equal((await tool(client, 'codex_pair_thread', { threadId: original.id })).x1.session, original.id);
    assert.equal((await tool(client, 'bridge_status', { id: pending.id })).state, 'held');
    assert.equal((await tool(client, 'bridge_update_brief', { brief: 'Check the same commit.' })).brief, 'Check the same commit.');
    assert.equal((await tool(client, 'bridge_context')).brief, 'Check the same commit.');
    assert.equal((await tool(client, 'bridge_context')).x1.session, original.id);

    const freshC1 = randomUUID();
    writeFileSync(registry, JSON.stringify({ pid: process.pid, sessionId: freshC1, name: 'Project Lead', cwd: directory }));
    assert.equal((await tool(client, 'codex_threads')).currentX1, original.id);
    assert.equal(loadProject(project.path).c1.session, freshC1);

    const independent = new Client({ name: 'catalog-test', version: '1.0.0' });
    const capture = join(directory, 'standalone-inbox.txt');
    process.env.FIXTURE_NATIVE_QUEUE = capture;
    await independent.connect(new StdioClientTransport({
      command: process.execPath, args: [entry, 'mcp-codex', directory], env: { ...process.env }, stderr: 'pipe',
    }));
    try {
      const input = { threadId: created.thread.session, message: 'Unpaired worker test',
        delivery: 'inbox', requestKey: 'worker-assignment' };
      const result = await tool(independent, 'codex_send_thread', input);
      assert.equal(result.threadId, created.thread.session);
      assert.equal(result.state, 'codex-inbox');
      const captured = readFileSync(capture, 'utf8');
      assert.match(captured, /^Unpaired worker test/);
      assert.ok(captured.includes(result.id));
      const repeat = await tool(independent, 'codex_send_thread', input);
      assert.equal(repeat.id, result.id);
      assert.equal(readFileSync(capture, 'utf8'), captured);
      await assert.rejects(tool(independent, 'codex_send_thread', { ...input, message: 'Other payload' }), /another direct send/);
      const receiptPath = join(directory, 'direct-receipts', `${result.id}.json`);
      const token = JSON.parse(readFileSync(receiptPath, 'utf8')).token;
      assert.equal(statSync(receiptPath).mode & 0o777, 0o600);
      assert.ok(!captured.includes(token));
      await assert.rejects(acknowledgeDirectCodex(directory, original.id, result.id, token), /does not match/);
      const receipt = await acknowledgeDirectCodex(directory, created.thread.session, result.id, token);
      assert.equal(receipt.state, 'delivered');
      assert.equal((await tool(independent, 'codex_delivery_status', { messageId: result.id })).state, 'delivered');
      const outcome = await reportDirectCodex(directory, created.thread.session, result.id, token, 'completed', 'Worker verified the fixture.');
      assert.equal(outcome.outcome.report, 'Worker verified the fixture.');
      await assert.rejects(reportDirectCodex(directory, created.thread.session, result.id, token, 'blocked', 'Different outcome'), /different final report/);
      assert.equal((await tool(independent, 'codex_delivery_status', { messageId: result.id })).outcome.disposition, 'completed');
      assert.equal(loadProject(project.path).x1.session, original.id);
    } finally {
      delete process.env.FIXTURE_NATIVE_QUEUE;
      await independent.close();
    }
  } finally {
    await client.close();
    await service.close();
    delete process.env.FIXTURE_CATALOG;
    delete process.env.BRIDGE_CODEX;
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

test('recovery rotates both leads, transfers only selected work, and keeps worker reports scoped', async (t) => {
  const directory = temp(t);
  const secondFolder = join(directory, 'second');
  mkdirSync(secondFolder);
  const projectId = randomUUID();
  const secondId = randomUUID();
  const project = initialize(join(directory, `${projectId}.json`), pair(directory));
  const second = initialize(join(directory, `${secondId}.json`), pair(secondFolder));
  const registry = join(directory, 'sessions');
  mkdirSync(registry);
  const claude = (sessionId, name, cwd = directory) => writeFileSync(join(registry, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId, name, cwd }));
  claude(project.c1.session, 'Lead');
  const [replacement, firstWorker, nextWorker] = Array.from({ length: 3 }, () => randomUUID());
  const catalogPath = join(directory, 'catalog.json');
  writeFileSync(catalogPath, JSON.stringify([replacement, firstWorker, nextWorker, project.x1.session, second.x1.session]
    .map((id) => ({ id, cwd: directory, name: `Fixture ${id}`, updatedAt: 1 }))));
  const environment = {
    CLAUDE_CONFIG_DIR: directory, BRIDGE_CODEX: fileURLToPath(new URL('./fixtures/codex.mjs', import.meta.url)),
    FIXTURE_CATALOG: catalogPath, FIXTURE_NATIVE_QUEUE: join(directory, 'queue.txt'),
    BRIDGE_CODEX_SOCKET: join(directory, 'shared-codex.sock'), FIXTURE_CODEX_STATE: 'active',
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const service = await startBridge({ directory });
  const connectMcp = async (spec) => {
    const client = new Client({ name: 'recovery-fixture', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ ...spec, env: { ...process.env }, stderr: 'pipe' }));
    t.after(() => client.close());
    return client;
  };
  let monitor;
  try {
    const c1 = await connectMcp(mcpCommand(project, 'c1', false, true));
    const x1 = await connectMcp(mcpCommand(project, 'x1'));
    const catalog = await connectMcp({ command: process.execPath, args: [entry, 'mcp-codex', directory] });
    const queued = await tool(c1, 'bridge_send', assignment);
    const retained = await tool(c1, 'bridge_send', { ...assignment, requestKey: 'leave-behind' });
    const done = await tool(c1, 'bridge_send', audit);
    await tool(x1, 'bridge_acknowledge', { id: done.id });
    const outcome = await tool(x1, 'bridge_save_verdict', { id: done.id, body: 'Passed.', disposition: 'completed' });
    const mailbox = new Mailbox(project.dbPath);
    const uncertain = mailbox.send('c1', { ...assignment, requestKey: 'uncertain' }, 'sending-now').message;
    mailbox.finishLive(uncertain.id, 'live-uncertain');
    mailbox.close();

    await tool(c1, 'bridge_team_set', { alias: 'Review Lead', role: 'codex-lead' });
    await tool(c1, 'bridge_team_set', { alias: 'Release QA', role: 'worker', threadId: firstWorker });
    await assert.rejects(tool(c1, 'bridge_team_set', { alias: 'Release QA', role: 'worker', threadId: nextWorker }), /previous worker/);
    const liveDispatch = await tool(x1, 'bridge_team_send', { alias: 'release qa', message: 'LIVE-TEST', delivery: 'live', requestKey: 'qa-live' });
    assert.equal(liveDispatch.acceptedState, 'live-accepted');
    const liveToken = JSON.parse(readFileSync(join(directory, 'direct-receipts', `${liveDispatch.id}.json`))).token;
    await acknowledgeDirectCodex(directory, firstWorker, liveDispatch.id, liveToken);
    const dispatch = await tool(x1, 'bridge_team_send', { alias: 'release qa', message: 'Verify the fixture.', delivery: 'inbox', requestKey: 'qa' });
    const token = JSON.parse(readFileSync(join(directory, 'direct-receipts', `${dispatch.id}.json`))).token;
    await reportDirectCodex(directory, firstWorker, dispatch.id, token, 'blocked', 'Missing fixture data.');
    assert.equal((await tool(c1, 'bridge_work')).workers.items[0].outcome.disposition, 'blocked');
    await tool(c1, 'bridge_team_set', { alias: 'Release QA', role: 'worker', threadId: nextWorker, expectedThreadId: firstWorker });

    const freshClaude = randomUUID();
    claude(freshClaude, 'Renamed lead', secondFolder);
    assert.deepEqual((await tool(catalog, 'bridge_projects')).map((item) => item.name), [second.project]);
    await assert.rejects(tool(catalog, 'bridge_recover', { projectId }), /project’s Claude workspace/);
    claude(freshClaude, 'Renamed lead');
    const recovery = { projectId, previousClaudeSession: project.c1.session,
      codexThreadId: replacement, previousCodexThreadId: project.x1.session };
    await assert.rejects(tool(catalog, 'bridge_recover', { ...recovery, transferIds: [queued.id, uncertain.id] }), /Reconcile/);
    assert.equal(loadProject(project.path).x1.session, project.x1.session);
    const missing = await tool(catalog, 'bridge_recover', { ...recovery, transferIds: [queued.id, done.id, outcome.id] });
    assert.match(missing.monitorPrompt, /Monitor/);
    assert.deepEqual(missing.adopted.map((item) => item.state), ['pending', 'delivered', 'saved']);
    assert.equal(missing.c1.session, freshClaude);
    assert.equal(missing.x1.session, replacement);
    assert.equal((await tool(catalog, 'bridge_recover', { ...recovery, transferIds: [queued.id, done.id, outcome.id], prepareMonitor: false })).adopted.length, 3);
    await assert.rejects(tool(x1, 'bridge_work'), /session was replaced/);

    const freshX1 = await connectMcp(mcpCommand(loadProject(project.path), 'x1'));
    const work = await tool(freshX1, 'bridge_work');
    assert.equal(work.team.find((member) => member.alias === 'Review Lead').session, replacement);
    assert.equal(work.team.find((member) => member.alias === 'Release QA').session, nextWorker);
    assert.equal(work.workers.items[0].threadId, firstWorker);
    assert.equal(work.handoffs.items.find((item) => item.id === done.id).outcome.id, outcome.id);
    assert.equal(work.handoffs.items.find((item) => item.id === retained.id).state, 'held');
    assert.equal((await tool(freshX1, 'bridge_doctor')).codex.found, true);
    assert.deepEqual((await tool(await connectMcp(mcpCommand(second, 'x1')), 'bridge_work')).workers.items, []);
    const grant = missing.monitorPrompt.match(/'([^']+monitor-grants[^']+[.]json)'\. Run it promptly/)[1];
    monitor = spawn(process.execPath, [entry, 'live-watch', project.path, grant], { env: { ...process.env } });
    monitor.stdout.resume();
    monitor.stderr.resume();
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await tool(c1, 'bridge_connection_status')).monitorReady) break;
      await setTimeout(25);
    }
    assert.equal((await tool(c1, 'bridge_connection_status')).monitorReady, true);
    assert.equal((await tool(freshX1, 'bridge_send_saved_verdict', { id: done.id })).id, outcome.id);
    await tool(c1, 'bridge_acknowledge', { id: outcome.id });
    const evidence = join(directory, 'evidence.json');
    writeFileSync(evidence, JSON.stringify({ project: projectId, secondProject: secondId,
      previousClaudeSession: project.c1.session, previousCodexThread: project.x1.session,
      liveDispatch: liveDispatch.id, inboxDispatch: dispatch.id, assignment: done.id, verdict: outcome.id, held: retained.id }));
    assert.equal((await verifySmoke(['--evidence', evidence], directory)).passed, true);
  } finally {
    monitor?.kill();
    await service.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Codex setup keeps unrelated TOML and safely updates a rotated project registration', (t) => {
  const directory = temp(t);
  const project = initialize(join(directory, `${randomUUID()}.json`), pair(directory));
  const folder = join(directory, '.codex');
  mkdirSync(folder);
  const file = join(folder, 'config.toml');
  const original = 'model = "example"\n\n[mcp_servers.other]\ncommand = "/usr/bin/true"\n';
  writeFileSync(file, original);
  assert.equal(codexRegistration(project, directory, false).matches, false);
  assert.equal(codexRegistration(project, directory, true).matches, true);
  const first = readFileSync(file, 'utf8');
  assert.ok(first.startsWith(original));
  codexRegistration(project, directory, true);
  assert.equal(readFileSync(file, 'utf8'), first);
  const fresh = rebind(project, 'x1', { ...project.x1, session: randomUUID() });
  codexRegistration(fresh, directory, true);
  const changed = readFileSync(file, 'utf8');
  assert.ok(changed.startsWith(original));
  assert.ok(changed.includes(fresh.x1.session));
  assert.ok(!changed.includes(project.x1.session));

  const malformed = original + '\nmarker = """\n';
  writeFileSync(file, malformed);
  assert.throws(() => codexRegistration(fresh, directory, true));
  assert.equal(readFileSync(file, 'utf8'), malformed);
});

test('session Monitor follows the verified IDE tab across clear and stops when that tab goes away', async (t) => {
  const directory = temp(t);
  const id = randomUUID();
  const project = initialize(join(directory, `${id}.json`), pair(directory));
  const primary = join(directory, 'primary-profile');
  const second = join(directory, 'second-profile');
  const sessions = join(second, 'sessions');
  mkdirSync(join(primary, 'sessions'), { recursive: true });
  mkdirSync(sessions, { recursive: true });
  const path = join(sessions, `${process.pid}.json`);
  const identity = (sessionId) => writeFileSync(path, JSON.stringify({
    pid: process.pid, sessionId, cwd: directory, kind: 'interactive', entrypoint: 'claude-vscode', procStart: 'same IDE process',
  }));
  identity(project.c1.session);
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = primary;
  assert.throws(() => readBridgeClaudeIdentity(directory, process.pid), /could not uniquely verify/);
  assert.equal(addClaudeProfile(directory, second).registeredProfiles, 2);
  assert.equal(readBridgeClaudeIdentity(directory, process.pid).sessionId, project.c1.session);
  const conflict = join(primary, 'sessions', `${process.pid}.json`);
  writeFileSync(conflict, JSON.stringify({ pid: process.pid, sessionId: randomUUID() }));
  assert.throws(() => readBridgeClaudeIdentity(directory, process.pid), /could not uniquely verify/);
  rmSync(conflict);
  const service = await startBridge({ directory });
  const x1 = await connect(project, 'x1', false);
  const monitor = spawn(process.execPath, [entry, 'live-watch-session', project.path], { env: { ...process.env } });
  const exited = once(monitor, 'exit');
  let received = '';
  monitor.stdout.on('data', (data) => { received += data; });
  monitor.stderr.resume();
  const waitFor = async (read, matches) => {
    for (let wait = 0; wait < 160; wait++) {
      const state = await read();
      if (matches(state)) return state;
      await setTimeout(25);
    }
    throw new Error('The session Monitor did not reach the expected state.');
  };
  const status = () => tool(x1, 'bridge_connection_status');
  try {
    const before = await waitFor(status, (value) => value.monitorReady);
    assert.equal(before.monitor.mode, 'session');
    assert.equal(before.monitor.expiresAt, null);
    const unrelated = initialize(join(directory, `${randomUUID()}.json`), {
      ...pair(directory), c1: { session: randomUUID(), cwd: directory, title: 'Other lead' },
    });
    const wrongTab = spawn(process.execPath, [entry, 'live-watch-session', unrelated.path], { env: { ...process.env } });
    wrongTab.stdout.resume();
    wrongTab.stderr.resume();
    assert.equal((await once(wrongTab, 'exit'))[0], 0);
    assert.notEqual(loadProject(unrelated.path).c1.session, project.c1.session);
    const fresh = randomUUID();
    identity(fresh);
    const after = await waitFor(status, (value) => value.monitorReady && value.c1.session === fresh);
    assert.equal(after.monitor.expiresAt, null);
    const update = await tool(x1, 'bridge_send_now', {
      kind: 'update', subject: 'After clear', body: 'Synthetic notice', reference: 'test', requestKey: 'monitor-after-clear',
    });
    await waitFor(() => received, (value) => value.includes(update.id));
    assert.equal(update.recipient_session, fresh);
    rmSync(path);
    await waitFor(status, (value) => !value.monitorReady);
    assert.equal((await exited)[0], 0);
  } finally {
    monitor.kill();
    await x1.close();
    await service.close();
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

test('a standalone Claude catalog creates an optional project from its verified chat', async (t) => {
  const directory = temp(t);
  const registry = join(directory, 'sessions');
  mkdirSync(registry);
  const session = randomUUID();
  const target = randomUUID();
  const catalog = join(directory, 'codex-catalog.json');
  writeFileSync(join(registry, `${process.pid}.json`), JSON.stringify({
    pid: process.pid, sessionId: session, name: 'c1', cwd: directory,
  }));
  writeFileSync(catalog, JSON.stringify([{ id: target, cwd: directory, name: 'X1', updatedAt: 1 }]));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = directory;
  process.env.FIXTURE_CATALOG = catalog;
  process.env.BRIDGE_CODEX = fileURLToPath(new URL('./fixtures/codex.mjs', import.meta.url));
  const service = await startBridge({ directory });
  const client = new Client({ name: 'standalone-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [entry, 'mcp-codex', directory], env: { ...process.env }, stderr: 'pipe',
  }));
  try {
    writeFileSync(join(directory, `${randomUUID()}.json`), '{ broken project');
    assert.deepEqual(await tool(client, 'bridge_projects'), []);
    assert.equal((await tool(client, 'bridge_diagnostics')).invalidProjects.length, 1);
    const result = await tool(client, 'bridge_project_create', { name: 'MCP-only project', threadId: target });
    assert.equal(result.c1.session, session);
    assert.equal(result.x1.session, target);
    assert.match(result.setup.claudeCommand, /mcp add-json/);
    assert.equal(result.setup.claudeName, 'claude-codex-bridge');
    assert.equal((await tool(client, 'bridge_projects'))[0].id, result.id);
    await assert.rejects(tool(client, 'bridge_project_create', { name: 'Duplicate', threadId: target }), /already assigned/);
  } finally {
    await client.close();
    await service.close();
    delete process.env.FIXTURE_CATALOG;
    delete process.env.BRIDGE_CODEX;
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});


test('a killed delivery is reconciled as uncertain and never replays automatically', async (t) => {
  const directory = temp(t);
  const project = initialize(join(directory, 'leases.json'), pair(directory));
  const mailbox = new Mailbox(project.dbPath);
  try {
    const first = mailbox.send('c1', audit);
    const next = mailbox.send('c1', { ...assignment, requestKey: 'next-after-crash' });
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { Mailbox } from ${JSON.stringify(new URL('../src/store.mjs', import.meta.url).href)};
      const box = new Mailbox(process.argv[1]);
      const claimed = box.claim(process.argv[2]);
      box.send('x1', { kind:'update', reference:'fixture task', subject:'live', body:'synthetic payload', requestKey:'live-cut' }, 'sending-now');
      console.log(claimed.id);
      setInterval(() => {}, 1000);
    `, project.dbPath, first.id]);
    let resolved = false;
    try {
      await new Promise((resolve, reject) => {
        child.stdout.once('data', (data) => {
          if (data.toString().trim() === first.id) { resolved = true; resolve(); }
          else reject(new Error('Fixture failed to claim the handoff.'));
        });
        child.once('error', reject);
        child.once('close', () => { if (!resolved) reject(new Error('Fixture exited early.')); });
      });
      await new Promise((resolve) => { child.once('close', resolve); child.kill('SIGKILL'); });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    assert.equal(mailbox.claim(next.id), undefined);
    const live = mailbox.history().find((item) => item.request_key === 'live-cut');
    assert.equal(mailbox.recoverExpired(Date.now() + 121000), 2);
    assert.equal(mailbox.find(first.id).state, 'uncertain');
    assert.equal(mailbox.find(live.id).state, 'live-uncertain');
    assert.ok(mailbox.claim(next.id));
    assert.equal(mailbox.resolve(live.id, 'delivered').state, 'delivered');
    assert.equal(mailbox.find(first.id).state, 'uncertain');
  } finally { mailbox.close(); }
});

test('pair binding and pending handoff isolation commit or roll back together', (t) => {
  const project = initialize(join(temp(t), 'atomic.json'), pair(process.cwd()));
  const mailbox = new Mailbox(project.dbPath);
  try {
    const pending = mailbox.send('c1', audit);
    const replacement = { ...project.x1, session: randomUUID() };
    const sql = new DatabaseSync(project.dbPath);
    try {
      sql.exec(`CREATE TRIGGER rollback_pair_change BEFORE UPDATE ON messages
        WHEN NEW.state = 'held' BEGIN SELECT RAISE(ABORT, 'interrupted swap fixture'); END;`);
      assert.throws(() => rebind(project, 'x1', replacement, { announce: true }), /interrupted swap/);
      assert.equal(loadProject(project.path).x1.session, project.x1.session);
      assert.equal(mailbox.find(pending.id).state, 'pending');
      sql.exec('DROP TRIGGER rollback_pair_change');
    } finally { sql.close(); }
    const updated = rebind(project, 'x1', replacement, { announce: true });
    assert.equal(updated.x1.session, replacement.session);
    assert.equal(loadProject(project.path).x1.session, replacement.session);
    assert.equal(mailbox.find(pending.id).state, 'held');
    assert.equal(mailbox.find(pending.id).recipient_session, project.x1.session);
    assert.equal(mailbox.claim(pending.id, replacement.session), undefined);
    assert.throws(() => mailbox.send('c1', audit), /previous recipient/);
  } finally { mailbox.close(); }
});

test('unread live and Codex items survive a full inbox and known live failures can queue', (t) => {
  const mailbox = new Mailbox(join(temp(t), 'unread.sqlite'));
  try {
    const live = mailbox.send('x1', audit, 'sending-now').message;
    mailbox.finishLive(live.id, 'live-accepted');
    for (let i = 0; i < 25; i++) {
      const next = mailbox.send('x1', { kind: 'update', reference: 'fixture task', subject: 'Newer receipt', body: 'fixture', requestKey: String(i) });
      mailbox.acknowledge('c1', next.id);
    }
    assert.ok(mailbox.inbox('c1').some((item) => item.id === live.id));
    const queuedRequest = { kind: 'update', reference: 'fixture task', subject: 'Known failure', body: 'fixture', requestKey: 'fallback' };
    const failed = mailbox.send('x1', queuedRequest, 'sending-now').message;
    mailbox.finishLive(failed.id, 'live-failed', 'No live route');
    const queued = mailbox.send('x1', queuedRequest);
    assert.equal(queued.id, failed.id);
    assert.equal(mailbox.next('c1').id, failed.id);
  } finally { mailbox.close(); }
});

test('switching C1 keeps saved verdict transfers distinct from previous acknowledgments', (t) => {
  const directory = temp(t);
  const project = initialize(join(directory, 'switch.json'), pair(directory));
  const mailbox = new Mailbox(project.dbPath);
  try {
    const open = mailbox.send('c1', audit);
    const closed = mailbox.send('c1', { ...audit, requestKey: 'acknowledged' });
    const saved = mailbox.saveVerdict('x1', open.id, 'Saved fixture verdict', 'completed', {}, project.x1.session);
    const received = mailbox.saveVerdict('x1', closed.id, 'Read fixture verdict', 'completed', {}, project.x1.session);
    mailbox.acknowledge('c1', received.id, project.c1.session);
    const next = rebind(project, 'c1', { ...project.c1, session: randomUUID() });
    assert.deepEqual(mailbox.inbox('c1'), []);
    const activeWork = mailbox.work({ limit: 10, includeClosed: true }).items;
    const oldSaved = activeWork.find((row) => row.id === open.id).outcome;
    const oldReceived = activeWork.find((row) => row.id === closed.id).outcome;
    assert.equal(oldSaved.recipientBinding, 'previous-session');
    assert.equal(oldSaved.needsTransfer, true);
    assert.equal(oldReceived.needsTransfer, false);
    assert.equal(oldReceived.state, 'delivered');
    assert.throws(() => mailbox.acknowledge('c1', saved.id, next.c1.session), /Transfer it with bridge_recover/);
    assert.throws(() => mailbox.acknowledge('c1', received.id, next.c1.session), /receipt in bridge_history/);
    const { adopted } = mailbox.recoverBinding(next, {}, [saved.id]);
    assert.equal(adopted[0].id, saved.id);
    assert.equal(view(mailbox.inbox('c1')[0], mailbox.binding()).needsTransfer, false);
    assert.equal(mailbox.acknowledge('c1', saved.id, next.c1.session).state, 'delivered');
    assert.equal(mailbox.find(received.id).recipient_session, project.c1.session);
  } finally { mailbox.close(); }
});

test('two live Claude profiles cannot silently take over the same lead role', async (t) => {
  const directory = temp(t);
  const primary = join(directory, 'primary');
  const secondary = join(directory, 'secondary');
  mkdirSync(join(primary, 'sessions'), { recursive: true });
  mkdirSync(join(secondary, 'sessions'), { recursive: true });
  const project = initialize(join(directory, `${randomUUID()}.json`), pair(directory));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = primary;
  const replacement = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const exited = once(replacement, 'exit');
  try {
    addClaudeProfile(directory, secondary);
    const earlier = join(primary, 'sessions', `${process.pid}.json`);
    writeFileSync(earlier, JSON.stringify({ pid: process.pid, sessionId: project.c1.session, name: project.c1.title, cwd: directory }));
    const next = randomUUID();
    writeFileSync(join(secondary, 'sessions', `${replacement.pid}.json`),
      JSON.stringify({ pid: replacement.pid, sessionId: next, name: project.c1.title, cwd: directory }));
    assert.throws(() => resolveWorkspaceC1(project.path, replacement.pid), /More than one C1/);
    assert.equal(loadProject(project.path).c1.session, project.c1.session);
    rmSync(earlier);
    assert.equal(resolveWorkspaceC1(project.path, replacement.pid).c1.session, next);
  } finally {
    replacement.kill();
    await exited;
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  }
});

test('IDE notification readiness requires the paired file hook and survives a bridge restart', async (t) => {
  const directory = temp(t);
  const id = randomUUID();
  const project = initialize(join(directory, `${id}.json`), pair(directory));
  let identity = { sessionId: project.c1.session, pid: process.pid, procStart: 'fixture launch', entrypoint: 'claude-vscode' };
  const getIdentity = () => identity;
  let wake = createIdeWake(directory, getIdentity);
  t.after(() => wake.close());
  const file = wake.register(project, id, identity);
  assert.equal(wake.status(project, id).state, 'starting');
  assert.deepEqual(wake.drain(project, id, identity, join(directory, 'unrelated')), []);
  assert.equal(wake.status(project, id).state, 'starting');
  assert.deepEqual(wake.drain(project, id, identity, file), []);
  assert.equal(wake.status(project, id).expiresAt, null);
  wake.close();
  wake = createIdeWake(directory, getIdentity);
  assert.equal(wake.status(project, id).state, 'ready');
  const first = wake.notify(project, id, randomUUID(), 'First wake');
  const second = wake.notify(project, id, randomUUID(), 'Second wake');
  assert.deepEqual(wake.drain(project, id, { ...identity, pid: identity.pid + 1 }, file), []);
  assert.deepEqual(wake.drain(project, id, identity, file), ['First wake', 'Second wake']);
  await Promise.all([first, second]);
  assert.deepEqual(wake.drain(project, id, identity, file), []);
  identity = { ...identity, sessionId: randomUUID() };
  assert.equal(wake.status(project, id), null);
  const reattached = rebind(project, 'c1', { ...project.c1, session: identity.sessionId });
  const nextFile = wake.register(reattached, id, identity);
  assert.notEqual(file, nextFile);
  assert.deepEqual(wake.drain(reattached, id, identity, file), []);
  wake.drain(reattached, id, identity, nextFile);
  assert.equal(wake.status(reattached, id).state, 'ready');
  identity = null;
  assert.equal(wake.status(reattached, id), null);
});

test('direct sends retry a known no-send once and leave uncertain attempts alone', async (t) => {
  const directory = temp(t);
  const db = new DatabaseSync(':memory:');
  const host = join(directory, 'fixture-codex.sock');
  const log = join(directory, 'steering.log');
  const settings = { BRIDGE_CODEX: fileURLToPath(new URL('./fixtures/codex.mjs', import.meta.url)),
    FIXTURE_STEER_LOG: log, FIXTURE_CODEX_STATE: 'idle' };
  const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  Object.assign(process.env, settings);
  const direct = directDispatches(db, directory);
  const target = { session: randomUUID(), cwd: directory };
  const args = { message: 'LIVE-TEST', requestKey: 'direct', delivery: 'live' };
  try {
    const failed = await direct.send('fixture', target, args, host);
    assert.equal(failed.state, 'failed');
    const oldReceipt = readDirectReceipt(directory, failed.id, target.session);
    process.env.FIXTURE_CODEX_STATE = 'active';
    const [first, concurrent] = await Promise.all([direct.send('fixture', target, args, host), direct.send('fixture', target, args, host)]);
    assert.equal(first.id, failed.id);
    assert.equal(first.state, 'live-accepted');
    assert.equal(concurrent.id, first.id);
    assert.equal(readFileSync(log, 'utf8'), 'steer\n');
    assert.throws(() => direct.acknowledge(target.session, first.id, oldReceipt), /does not match/);
    const token = readDirectReceipt(directory, first.id, target.session);
    assert.equal(direct.acknowledge(target.session, first.id, token).state, 'delivered');
    assert.equal((await direct.send('fixture', target, args, host)).state, 'delivered');
    const unconfirmed = { ...args, requestKey: 'unconfirmed', message: 'Simulate a host error' };
    const uncertain = await direct.send('fixture', target, unconfirmed, host);
    assert.equal(uncertain.state, 'uncertain');
    assert.equal((await direct.send('fixture', target, unconfirmed, host)).id, uncertain.id);
    assert.equal(readFileSync(log, 'utf8'), 'steer\nsteer\n');
  } finally {
    db.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Codex inbox delivery forwards the selected shared host', async (t) => {
  const directory = temp(t);
  const socket = join(directory, 'configured.sock');
  const target = randomUUID();
  const command = join(directory, 'codex-check');
  writeFileSync(command, `#!${process.execPath}
if (process.argv[process.argv.indexOf('--remote')+1] !== ${JSON.stringify('unix://' + socket)}) process.exit(3);
if (process.argv[process.argv.indexOf('--thread')+1] !== ${JSON.stringify(target)}) process.exit(4);
`, { mode: 0o700 });
  const previous = process.env.BRIDGE_CODEX;
  process.env.BRIDGE_CODEX = command;
  try {
    assert.equal((await sendToCodexThread({ cwd: directory, session: target }, 'Synthetic request', 'inbox', socket)).state, 'codex-inbox');
  } finally {
    if (previous === undefined) delete process.env.BRIDGE_CODEX;
    else process.env.BRIDGE_CODEX = previous;
  }
});

test('an old unpinned handoff is held during migration and history is retained', (t) => {
  const directory = temp(t);
  const source = join(directory, 'legacy.json');
  const prepared = pair(directory);
  writeFileSync(source, JSON.stringify(prepared));
  const storage = loadProject(source);
  const before = new Mailbox(storage.dbPath);
  const pending = before.send('c1', audit);
  const done = before.send('c1', { ...assignment, requestKey: 'old-delivered' });
  before.acknowledge('x1', done.id);
  before.close();

  const after = new Mailbox(storage.dbPath, storage);
  try {
    assert.equal(after.binding().x1.session, prepared.x1.session);
    assert.equal(after.find(pending.id).state, 'held');
    assert.equal(after.next('x1'), undefined);
    assert.equal(after.find(done.id).state, 'delivered');
  } finally { after.close(); }
});
