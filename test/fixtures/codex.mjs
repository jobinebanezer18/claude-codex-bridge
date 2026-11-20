#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

if (process.argv[2] === 'queue' && process.env.FIXTURE_NATIVE_QUEUE) {
  appendFileSync(process.env.FIXTURE_NATIVE_QUEUE, process.argv[6]);
  process.exit(0);
}

const lines = createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const thread = (id) => ({ id, cwd: process.cwd(), status: { type: process.env.FIXTURE_CODEX_STATE || 'idle' } });
for await (const line of lines) {
  const { method, id, params } = JSON.parse(line);
  const respond = (result) => send({ id, result });
  if (process.env.FIXTURE_CATALOG && ['thread/list', 'thread/start', 'thread/inject_items', 'thread/name/set'].includes(method)) {
    const file = process.env.FIXTURE_CATALOG;
    const catalog = JSON.parse(readFileSync(file,'utf8'));
    if (method === 'thread/list') respond({ data: params.archived ? [] : catalog.filter((row) => !row.hidden), nextCursor: null });
    if (method === 'thread/start') {
      const created = { ...thread(randomUUID()), cwd: params.cwd, updatedAt: Date.now() / 1000, hidden: true };
      catalog.push(created);
      writeFileSync(file,JSON.stringify(catalog));
      respond({ thread: created });
    }
    if (method === 'thread/inject_items') respond({});
    if (method === 'thread/name/set') {
      catalog.find(row=>row.id===params.threadId).name = params.name;
      writeFileSync(file,JSON.stringify(catalog));
      respond({});
    }
    continue;
  }
  if (method === 'initialize') respond({});
  if (method === 'thread/resume' && process.env.FIXTURE_NATIVE_QUEUE) {
    send({ id, error: { message: 'thread already has an active writer' } });
  } else if (method === 'thread/read' || method === 'thread/resume') {
    respond({ thread: thread(params.threadId) });
  }
  if (method === 'thread/turns/list') {
    respond({ data: [{ id: 'test-turn', status: 'inProgress' }] });
  }
  if (method === 'turn/steer') {
    if (process.env.FIXTURE_STEER_LOG) appendFileSync(process.env.FIXTURE_STEER_LOG, 'steer\n');
    if (params.expectedTurnId !== 'test-turn' || !params.input[0].text.includes('LIVE-TEST')) {
      send({ id, error: { message: 'Wrong turn or input' } });
      continue;
    }
    respond({ turnId: 'test-turn' });
    send({ method: 'turn/completed', params: {
      threadId: params.threadId, turn: { id: 'test-turn', status: 'completed' },
    } });
  }
  if (method === 'turn/start') {
    const turnId = 'test-turn';
    if (!params.input[0].text.includes('Relay Desk handoff for')) {
      send({ id, error: { message: 'Missing bridge envelope' } });
      continue;
    }
    respond({ turn: { id: turnId } });
    if (process.env.FIXTURE_CODEX_LIVE) continue;
    send({ method: 'item/completed', params: {
      threadId: params.threadId, turnId, item: { type: 'agentMessage', phase: 'final_answer', text: 'Verified on the fixture commit.' },
    } });
    send({ method: 'turn/completed', params: {
      threadId: params.threadId, turn: { id: turnId, status: process.env.FIXTURE_TURN_STATE || 'completed' },
    } });
  }
}
