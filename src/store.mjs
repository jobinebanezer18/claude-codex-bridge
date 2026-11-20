import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const leaseMs = 120000;

export const actors = ['c1', 'x1'];
export const kinds = ['assignment', 'audit', 'recheck', 'update'];
export const other = (actor) => actor === 'c1' ? 'x1' : 'c1';
export const teamKey = (alias) => alias.normalize('NFKC').toLowerCase();

function canTransfer(message) {
  return (message.state === 'held' && message.error?.startsWith('Held when the recipient changed from ')) ||
    (message.kind === 'result' && ['saved', 'live-failed'].includes(message.state)) ||
    (message.state === 'delivered' && ['assignment', 'audit', 'recheck'].includes(message.kind));
}

function assertSamePayload(message, { kind, subject, body, parentId = null, disposition = null, reference = null }) {
  if (message.kind !== kind || message.subject !== subject || message.body !== body ||
      message.parent_id !== parentId || message.disposition !== disposition || message.task_reference !== reference) {
    throw new Error('That request key was used for a different message.');
  }
}

export class Mailbox {
  constructor(path, project) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        body TEXT NOT NULL,
        parent_id TEXT REFERENCES messages(id),
        request_key TEXT NOT NULL,
        disposition TEXT,
        task_reference TEXT,
        verdict_label TEXT,
        evidence_path TEXT,
        state TEXT NOT NULL DEFAULT 'pending',
        attempt TEXT,
        error TEXT,
        recipient_session TEXT,
        lease_until INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (sender, request_key)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_result_per_request
        ON messages(parent_id) WHERE kind = 'result';
      CREATE INDEX IF NOT EXISTS inbox ON messages(recipient, state, created_at);
      CREATE TABLE IF NOT EXISTS project_binding (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_settings (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS team_aliases (
        alias_key TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        role TEXT NOT NULL,
        thread_id TEXT UNIQUE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_alias_per_lead ON team_aliases(role) WHERE role <> 'worker';
      CREATE TABLE IF NOT EXISTS connections (
        actor TEXT NOT NULL,
        session TEXT NOT NULL,
        mode TEXT NOT NULL,
        seen_at INTEGER NOT NULL,
        PRIMARY KEY (actor, session, mode)
      );
    `);

    const columns = () => new Set(this.db.prepare('PRAGMA table_info(messages)').all().map((row) => row.name));
    const known = columns();
    const unbound = project && !this.binding();
    const additions = ['lease_until', 'recipient_session', 'task_reference', 'verdict_label', 'evidence_path'];
    if (additions.some((column) => !known.has(column)) || unbound) {
      this.transaction(() => {
        const current = columns();
        for (const column of additions) {
          if (!current.has(column)) this.db.exec(`ALTER TABLE messages ADD COLUMN ${column} ${column === 'lease_until' ? 'INTEGER' : 'TEXT'}`);
        }
        if (project && !this.binding()) {
          const { c1, x1, codexSocket, project: name } = project;
          this.db.prepare('INSERT INTO project_binding VALUES (1, ?)').run(JSON.stringify({ c1, x1, codexSocket, project: name }));
          this.db.prepare(`
            UPDATE messages SET state = 'held', error = 'Legacy queue entry had no verified recipient session.', updated_at = ?
            WHERE state = 'pending' AND recipient_session IS NULL
          `).run(Date.now());
        }
      });
    }
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS require_pinned_recipient
      BEFORE INSERT ON messages
      WHEN NEW.recipient_session IS NULL AND EXISTS (SELECT 1 FROM project_binding WHERE id = 1)
      BEGIN SELECT RAISE(ABORT, 'Relay Desk updated. Reconnect this MCP server before sending.'); END;
    `);

  }

  transaction(fn) {
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  binding() {
    const row = this.db.prepare('SELECT data FROM project_binding WHERE id = 1').get();
    return row && JSON.parse(row.data);
  }

  updateBinding(project, actor, endpoint, { announce = false } = {}) {
    return this.transaction(() => {
      const stored = this.binding();
      if (actors.some((role) => stored?.[role].session !== project[role].session)) {
        throw new Error('The project pairing changed. Refresh it before retrying.');
      }
      const updated = { ...stored, [actor]: endpoint };
      if (actor === 'x1' && this.db.prepare('SELECT 1 FROM team_aliases WHERE thread_id = ?').get(endpoint.session)) {
        throw new Error('Remove the worker alias for this thread before making it the Codex lead.');
      }
      if (stored[actor].session !== endpoint.session) {
        this.recoverExpired();
        if (actors.some((role) => this.dispatching(role))) {
          throw new Error('Wait for the current handoff before changing the pairing.');
        }
        this.db.prepare(`
          UPDATE messages SET state = 'held', error = ?, updated_at = ?
          WHERE recipient = ? AND kind <> 'connection' AND state = 'pending'
        `).run(`Held when the recipient changed from ${stored[actor].title || stored[actor].session}.`, Date.now(), actor);
      }
      this.db.prepare('UPDATE project_binding SET data = ? WHERE id = 1').run(JSON.stringify(updated));
      if (announce) this.announce(updated);
      return updated;
    });
  }

  recoverBinding(project, replacements, transferIds) {
    return this.transaction(() => {
      this.recoverExpired();
      let current = this.binding();
      if (actors.some((role) => current[role].session !== project[role].session)) {
        throw new Error('The project pairing changed. Refresh before recovering it.');
      }
      for (const role of actors) {
        if (replacements[role]) current = this.updateBinding(current, role, replacements[role]);
      }
      const adopted = [...new Set(transferIds)].map((id) => {
        const row = this.find(id);
        if (!row || row.kind === 'connection' || !row.recipient_session) throw new Error(`Message ${id} cannot be transferred.`);
        const session = current[row.recipient].session;
        if (session === row.recipient_session) return row;
        const held = row.state === 'held' && row.error?.startsWith('Held when the recipient changed from ');
        const saved = row.kind === 'result' && ['saved', 'live-failed'].includes(row.state);
        if (!canTransfer(row)) throw new Error(`Message ${id} is ${row.state}. Reconcile it before transferring.`);
        return this.db.prepare(`
          UPDATE messages SET recipient_session = ?, state = ?, error = NULL, updated_at = ?
          WHERE id = ? RETURNING *
        `).get(session, held ? 'pending' : saved ? 'saved' : row.state, Date.now(), id);
      });
      if (actors.some((role) => current[role].session !== project[role].session)) this.announce(current);
      return { project: { ...project, ...current }, adopted: adopted.map((message) => view(message, current)) };
    });
  }

  team(project) {
    const rows = this.db.prepare('SELECT * FROM team_aliases ORDER BY alias_key').all();
    const leader = (role, endpoint) => ({
      role, alias: rows.find((row) => row.role === role)?.label ?? null, ...endpoint,
    });
    return [leader('project-lead', project.c1), leader('codex-lead', project.x1),
      ...rows.filter((row) => row.role === 'worker').map((row) => ({ role: row.role, alias: row.label, session: row.thread_id }))];
  }

  setTeamAlias(project, { alias, role, threadId, expectedThreadId }) {
    return this.transaction(() => {
      if (this.binding().c1.session !== project.c1.session || this.binding().x1.session !== project.x1.session) {
        throw new Error('The project pairing changed. Refresh the roster.');
      }
      const key = teamKey(alias);
      const row = this.db.prepare('SELECT * FROM team_aliases WHERE alias_key = ?').get(key);
      if (row && row.role !== role) throw new Error('That alias belongs to another role.');
      if (role === 'worker') {
        if (!threadId || threadId === project.x1.session) throw new Error('Choose a Codex worker thread distinct from the lead.');
        if (row?.thread_id !== threadId && (row?.thread_id || expectedThreadId) && row?.thread_id !== expectedThreadId) {
          throw new Error('Confirm the previous worker thread ID before replacing this alias.');
        }
        const duplicate = this.db.prepare('SELECT label FROM team_aliases WHERE thread_id = ? AND alias_key <> ?').get(threadId, key);
        if (duplicate) throw new Error(`That worker already uses the alias ${duplicate.label}.`);
      } else {
        if (threadId || expectedThreadId) throw new Error('Lead aliases follow the paired chat. Use bridge_recover to replace it.');
        this.db.prepare('DELETE FROM team_aliases WHERE role = ?').run(role);
      }
      this.db.prepare(`INSERT INTO team_aliases VALUES (?, ?, ?, ?) ON CONFLICT(alias_key) DO UPDATE
        SET label = excluded.label, thread_id = excluded.thread_id`).run(key, alias, role, threadId ?? null);
      return this.team(project);
    });
  }

  removeWorker(project, alias, expectedThreadId) {
    return this.transaction(() => {
      if (this.binding().c1.session !== project.c1.session) throw new Error('The project lead changed.');
      const removed = this.db.prepare("DELETE FROM team_aliases WHERE alias_key = ? AND role = 'worker' AND thread_id = ?")
        .run(teamKey(alias), expectedThreadId);
      if (!removed.changes) throw new Error('The worker alias and expected thread ID did not match.');
      return this.team(project);
    });
  }

  work({ limit, before = Number.MAX_SAFE_INTEGER, includeClosed }) {
    this.recoverExpired();
    const binding = this.binding();
    const rows = this.db.prepare(`
      SELECT request.rowid AS cursor, request.*, result.id AS outcome_id
      FROM messages request LEFT JOIN messages result ON result.parent_id = request.id AND result.kind = 'result'
      WHERE request.kind IN ('assignment', 'audit', 'recheck') AND request.rowid < ?
        AND (? OR result.id IS NULL OR result.state <> 'delivered' OR result.disposition = 'blocked')
      ORDER BY request.rowid DESC LIMIT ?
    `).all(before, Number(includeClosed), limit + 1);
    const items = rows.slice(0, limit).map(({ outcome_id, ...request }) => ({
      ...view(request, binding), ownerSession: request.recipient_session,
      acknowledged: request.state === 'delivered',
      outcome: outcome_id ? view(this.find(outcome_id), binding) : null,
    }));
    return { items, nextBefore: rows.length > limit ? items.at(-1).cursor : null };
  }

  recoverExpired(now = Date.now()) {
    return this.db.prepare(`
      UPDATE messages
      SET state = CASE WHEN state = 'sending-now' THEN 'live-uncertain' ELSE 'uncertain' END,
          updated_at = ?, error = 'Delivery attempt ended without a receipt. Reconcile before retrying.',
          attempt = NULL, lease_until = NULL
      WHERE state IN ('dispatching', 'sending-now') AND (lease_until IS NULL OR lease_until <= ?)
    `).run(now, now).changes;
  }

  renew(message, now = Date.now()) {
    return this.db.prepare(`
      UPDATE messages SET lease_until = ?
      WHERE id = ? AND attempt = ? AND state = 'dispatching' AND lease_until > ?
    `).run(now + leaseMs, message.id, message.attempt, now).changes === 1;
  }

  close() {
    this.db.close();
  }

  brief() {
    return this.db.prepare("SELECT value FROM project_settings WHERE name = 'brief'").get()?.value || '';
  }

  saveBrief(brief) {
    this.db.prepare(`
      INSERT INTO project_settings VALUES ('brief', ?)
      ON CONFLICT (name) DO UPDATE SET value = excluded.value
    `).run(brief);
    return brief;
  }

  installReceipt(actor, cwd) {
    this.db.prepare(`
      INSERT INTO project_settings VALUES (?, ?)
      ON CONFLICT (name) DO UPDATE SET value = excluded.value
    `).run(`installed:${actor}`, cwd);
  }

  recordToolUse(actor, session) {
    this.db.prepare(`
      INSERT INTO project_settings VALUES (?, ?)
      ON CONFLICT (name) DO UPDATE SET value = excluded.value
    `).run(`verified:${actor}:${session}`, String(Date.now()));
  }

  readiness(actor, endpoint) {
    const value = (key) => this.db.prepare('SELECT value FROM project_settings WHERE name = ?').get(key)?.value;
    const notice = this.db.prepare(`
      SELECT state FROM messages WHERE recipient = ? AND kind = 'connection'
        AND state <> 'superseded' ORDER BY rowid DESC LIMIT 1
    `).get(actor);
    return {
      installed: value(`installed:${actor}`) === endpoint.cwd,
      verifiedAt: Number(value(`verified:${actor}:${endpoint.session}`)) || null,
      notice: notice?.state ?? null,
    };
  }

  autoWake() {
    return this.db.prepare("SELECT value FROM project_settings WHERE name = 'wake_x1'").get()?.value === 'true';
  }

  setAutoWake(enabled) {
    this.db.prepare(`
      INSERT INTO project_settings VALUES ('wake_x1', ?)
      ON CONFLICT (name) DO UPDATE SET value = excluded.value
    `).run(String(enabled));
  }

  announce(project) {
    this.transaction(() => {
      this.db.prepare(`
        UPDATE messages SET state = 'superseded', attempt = NULL, updated_at = ?
        WHERE kind = 'connection' AND state IN ('pending', 'notified', 'uncertain', 'codex-inbox')
      `).run(Date.now());
      const insert = this.db.prepare(`
        INSERT INTO messages (id, sender, recipient, kind, subject, body, request_key, created_at, updated_at, recipient_session)
        VALUES (?, 'relay', ?, 'connection', 'Relay Desk connection', ?, ?, ?, ?, ?)
      `);
      for (const actor of actors) {
        const peer = other(actor);
        const lead = actor === 'c1' ? 'You are the overall project lead.' : 'You lead the Codex workstream and report to the project lead.';
        const route = actor === 'c1'
          ? 'Use the Relay Desk MCP inbox in Antigravity. A Claude Code Channels connection can deliver messages to you automatically.'
          : 'Use the Relay Desk MCP inbox. When enabled, Relay Desk can start a turn in this Codex thread.';
        const instruction = [
          `Relay Desk paired this session for ${project.project}.`,
          lead,
          `Your peer is ${project[peer].title || (peer === 'c1' ? 'the project lead' : 'the Codex lead')}.`,
          route,
          'Use bridge_context for the human’s project brief, bridge_send for handoffs, bridge_inbox to receive them, and bridge_reply to report back. Acknowledge receipt of this notice. Continue with your existing project instructions.',
        ].join(' ');
        const id = randomUUID();
        const now = Date.now();
        insert.run(id, actor, instruction, id, now, now, project[actor].session);
      }
    });
  }

  touch(actor, session, mode) {
    this.db.prepare(`
      INSERT INTO connections VALUES (?, ?, ?, ?)
      ON CONFLICT (actor, session, mode) DO UPDATE SET seen_at = excluded.seen_at
    `).run(actor, session, mode, Date.now());
  }

  connections() {
    return this.db.prepare('SELECT * FROM connections WHERE seen_at >= ?').all(Date.now() - 12000);
  }

  history(limit = 50, before = Number.MAX_SAFE_INTEGER) {
    this.recoverExpired();
    return this.db.prepare(`
      SELECT rowid AS cursor, * FROM messages WHERE rowid < ? ORDER BY rowid DESC LIMIT ?
    `).all(before, limit);
  }

  dispatching(actor) {
    this.recoverExpired();
    return this.db.prepare("SELECT id FROM messages WHERE recipient = ? AND state IN ('dispatching', 'sending-now')").get(actor);
  }

  find(id) {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  }

  liveReceipt(sender, fields, expectedSession) {
    const binding = this.binding();
    if (binding && binding[sender].session !== expectedSession) throw new Error('The sender pairing changed.');
    const row = this.db.prepare(`SELECT * FROM messages WHERE sender = ? AND request_key = ?
      AND state IN ('live-accepted', 'delivered')`).get(sender, fields.requestKey);
    if (row) assertSamePayload(row, fields);
    return row;
  }

  send(sender, fields, initialState = 'pending', expectedSender, expectedRecipient) {
    return this.transaction(() => this.insertSend(sender, fields, initialState, expectedSender, expectedRecipient));
  }

  insertSend(sender, { kind, subject, body, parentId = null, requestKey, disposition = null, reference = null }, initialState, expectedSender, expectedRecipient) {
    const linked = this.binding();
    if (expectedSender && linked && linked[sender]?.session !== expectedSender) throw new Error('The sender pairing changed.');
    const recipient = other(sender);
    const recipientSession = linked?.[recipient].session ?? null;
    if (expectedRecipient && linked && recipientSession !== expectedRecipient) {
      throw new Error('The recipient pairing changed before delivery.');
    }
    if (kind === 'assignment' && sender !== 'c1') {
      throw new Error('C1 assigns cross-team work. X1 can request an audit or send an update.');
    }
    const parent = parentId && this.find(parentId);
    if (parentId && !parent) throw new Error('Referenced message was not found in this project.');
    if (kind === 'recheck' && !parent) throw new Error('A recheck must reference an earlier message.');
    if (kind === 'update' && !parent && !reference?.trim()) {
      throw new Error('Add parentId for a Relay Desk handoff, or reference with its task ID or subject.');
    }
    if (kind === 'result' && parent?.kind === 'result') {
      throw new Error('Use bridge_send_now for a live follow-up or bridge_send for inbox delivery. Set kind to update and parentId to the result ID.');
    }
    if (kind === 'result' && (!parent || !['assignment', 'audit', 'recheck'].includes(parent.kind) ||
        parent.recipient !== sender || (parent.recipient_session && parent.recipient_session !== linked?.[sender].session))) {
      throw new Error('Reply to a request addressed to you.');
    }

    const now = Date.now();
    const insertion = this.db.prepare(`
      INSERT INTO messages (id, sender, recipient, kind, subject, body, parent_id,
        request_key, disposition, created_at, updated_at, state, recipient_session, lease_until, task_reference)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `).run(randomUUID(), sender, recipient, kind, subject, body, parentId,
      requestKey, disposition, now, now, initialState, recipientSession, initialState === 'sending-now' ? now + leaseMs : null, reference);
    const sent = this.db.prepare('SELECT * FROM messages WHERE sender = ? AND request_key = ?')
      .get(sender, requestKey);
    if (!sent) throw new Error('This request already has a reply. Check its status.');
    assertSamePayload(sent, { kind, subject, body, parentId, disposition, reference });
    if (sent.recipient_session !== recipientSession) {
      if (sent.kind === 'result' && canTransfer(sent)) {
        throw new Error(`Verdict ${sent.id} is assigned to a previous chat. Transfer the saved verdict with bridge_recover before sending it.`);
      }
      throw new Error('This request key belongs to the previous recipient. Use a fresh assignment.');
    }
    if (initialState === 'saved') return sent;
    if (initialState === 'pending') {
      if (['live-failed', 'saved'].includes(sent.state)) {
        return this.db.prepare(`
          UPDATE messages SET state = 'pending', error = NULL, updated_at = ?
          WHERE id = ? AND state IN ('live-failed', 'saved') RETURNING *
        `).get(now, sent.id) || this.find(sent.id);
      }
      if (['live-uncertain', 'sending-now'].includes(sent.state)) {
        throw new Error('A live delivery has an unresolved outcome. Check its status before queueing.');
      }
      return sent;
    }
    if (['live-failed', 'saved'].includes(sent.state)) {
      const retry = this.db.prepare(`
        UPDATE messages SET state = 'sending-now', error = NULL, updated_at = ?, lease_until = ?
        WHERE id = ? AND state IN ('live-failed', 'saved') RETURNING *
      `).get(now, now + leaseMs, sent.id);
      return { message: retry || this.find(sent.id), created: !!retry };
    }
    return { message: sent, created: insertion.changes === 1 };
  }

  saveVerdict(actor, id, body, disposition, metadata, expectedSender) {
    return this.transaction(() => {
      const parent = this.find(id);
      if (!parent || parent.recipient !== actor) throw new Error('Incoming request was not found.');
      const result = this.insertSend(actor, {
        kind: 'result', subject: parent.subject, body, parentId: id,
        requestKey: `result:${id}`, disposition,
      }, 'saved', expectedSender);
      const label = metadata?.verdict ?? result.verdict_label;
      const path = metadata?.evidencePath ?? result.evidence_path;
      if ((result.verdict_label && result.verdict_label !== label) || (result.evidence_path && result.evidence_path !== path)) {
        throw new Error('This handoff already has a saved verdict with different evidence.');
      }
      return this.db.prepare(`
        UPDATE messages SET verdict_label = ?, evidence_path = ? WHERE id = ? RETURNING *
      `).get(label, path, result.id);
    });
  }

  savedVerdict(actor, id) {
    const outcome = this.db.prepare("SELECT * FROM messages WHERE sender = ? AND parent_id = ? AND kind = 'result'").get(actor, id);
    if (!outcome) throw new Error('Save the verdict for this handoff first with bridge_save_verdict.');
    return outcome;
  }

  finishLive(id, state, error = null) {
    return this.db.prepare(`
      UPDATE messages SET state = ?, error = ?, updated_at = ?, lease_until = NULL
      WHERE id = ? AND state = 'sending-now' RETURNING *
    `).get(state, error, Date.now(), id) || this.find(id);
  }

  reply(actor, id, body, disposition, expectedSender) {
    return this.transaction(() => this.insertReply(actor, id, body, disposition, expectedSender));
  }

  insertReply(actor, id, body, disposition, expectedSender) {
    const parent = this.find(id);
    if (!parent || parent.recipient !== actor) throw new Error('Incoming request was not found.');
    const result = this.send(actor, {
      kind: 'result', subject: parent.subject, body, parentId: id,
      requestKey: `result:${id}`, disposition,
    }, 'pending', expectedSender);
    this.db.prepare(`
      UPDATE messages SET state = 'delivered', error = NULL, updated_at = ?, lease_until = NULL
      WHERE id = ? AND state IN ('pending', 'notified', 'uncertain', 'live-accepted', 'live-uncertain', 'codex-inbox', 'turn-completed')
    `).run(Date.now(), id);
    return result;
  }

  status(id) {
    this.recoverExpired();
    const message = this.find(id);
    if (!message) throw new Error('Message was not found.');
    const related = this.db.prepare('SELECT * FROM messages WHERE parent_id = ? ORDER BY created_at')
      .all(id);
    return { ...message, related };
  }

  inbox(actor, limit = 20, session = this.binding()?.[actor]?.session ?? null) {
    this.recoverExpired();
    return this.db.prepare(`
      SELECT * FROM messages WHERE recipient = ? AND state <> 'superseded'
        AND (? IS NULL OR recipient_session = ?)
        AND (kind <> 'connection' OR rowid = (
          SELECT max(rowid) FROM messages WHERE recipient = ? AND kind = 'connection' AND state <> 'superseded'
            AND (? IS NULL OR recipient_session = ?)
        ))
      ORDER BY CASE
        WHEN state IN ('pending', 'saved', 'notified', 'live-accepted', 'codex-inbox', 'turn-completed') THEN 0
        WHEN state IN ('uncertain', 'live-uncertain') THEN 1
        ELSE 2 END,
        created_at DESC, rowid DESC LIMIT ?
    `).all(actor, session, session, actor, session, session, limit);
  }

  next(actor) {
    this.recoverExpired();
    const session = this.binding()?.[actor]?.session ?? null;
    return this.db.prepare(`
      SELECT * FROM messages WHERE recipient = ? AND state = 'pending'
        AND (? IS NULL OR recipient_session = ?)
      ORDER BY created_at, rowid LIMIT 1
    `).get(actor, session, session);
  }

  claim(id, recipientSession) {
    this.recoverExpired();
    const now = Date.now();
    const attempt = randomUUID();
    return this.db.prepare(`
      UPDATE messages SET state = 'dispatching', attempt = ?, updated_at = ?, lease_until = ?
      WHERE id = ? AND state = 'pending' AND (? IS NULL OR recipient_session = ?)
        AND NOT EXISTS (
          SELECT 1 FROM messages AS active
          WHERE active.recipient = messages.recipient AND active.state = 'dispatching'
        )
      RETURNING *
    `).get(attempt, now, now + leaseMs, id, recipientSession ?? null, recipientSession ?? null);
  }

  claimFollowing(message) {
    const candidates = this.db.prepare(`
      SELECT * FROM messages WHERE recipient = 'x1' AND state = 'pending' AND recipient_session IS ?
      ORDER BY created_at, rowid LIMIT 4
    `).all(message.recipient_session);
    let bytes = Buffer.byteLength(message.body);
    const batch = [message];
    for (const candidate of candidates) {
      bytes += Buffer.byteLength(candidate.body);
      if (bytes > 55000) break;
      const held = this.db.prepare(`
        UPDATE messages SET state = 'dispatching', attempt = ?, updated_at = ?, lease_until = ?
        WHERE id = ? AND state = 'pending' RETURNING *
      `).get(message.attempt, Date.now(), Date.now() + leaseMs, candidate.id);
      if (held) batch.push(held);
    }
    return batch;
  }

  complete(message, state, { error = null, result = null } = {}) {
    this.transaction(() => {
      const { changes } = this.db.prepare(`
        UPDATE messages SET state = ?, attempt = NULL, error = ?, updated_at = ?, lease_until = NULL
        WHERE id = ? AND state = 'dispatching' AND attempt = ?
      `).run(state, error, Date.now(), message.id, message.attempt);
      if (!changes) {
        if (this.find(message.id)?.state === 'delivered') return;
        throw new Error('Delivery changed while it was running.');
      }
      const replied = this.db.prepare("SELECT id FROM messages WHERE parent_id = ? AND kind = 'result'")
        .get(message.id);
      if (result && !replied && ['assignment', 'audit', 'recheck'].includes(message.kind)) {
        this.reply(message.recipient, message.id, result, 'reported');
      }
    });
  }

  acknowledge(actor, id, session) {
    const message = this.db.prepare(`
      UPDATE messages SET state = 'delivered', error = NULL, updated_at = ?, lease_until = NULL
      WHERE id = ? AND recipient = ? AND (? IS NULL OR recipient_session IS NULL OR recipient_session = ?) AND state IN ('pending', 'saved', 'notified', 'uncertain', 'delivered', 'sending-now', 'live-accepted', 'live-uncertain', 'codex-inbox', 'turn-completed')
      RETURNING *
    `).get(Date.now(), id, actor, session ?? null, session ?? null);
    if (!message) {
      const row = this.find(id);
      if (session && row?.recipient === actor && row.recipient_session && row.recipient_session !== session) {
        throw new Error(canTransfer(row) ? 'This message belongs to a previous chat. Transfer it with bridge_recover before acknowledging it.' :
          'This message belongs to a previous chat. See its receipt in bridge_history.');
      }
      throw new Error('Message was not found in your inbox or is actively dispatching.');
    }
    return message;
  }

  resolve(id, state) {
    this.recoverExpired();
    const message = this.find(id);
    if (!message) throw new Error('Message was not found.');
    const linked = this.binding();
    if (state === 'pending' && linked && message?.recipient_session !== linked[message.recipient]?.session) {
      throw new Error('The original recipient is no longer paired. Send a fresh assignment.');
    }
    if (state === 'pending' && this.db.prepare(
      "SELECT 1 FROM messages WHERE parent_id = ? AND kind = 'result'"
    ).get(id)) throw new Error('This request already has a result.');
    const resolved = this.db.prepare(`
      UPDATE messages SET state = ?, attempt = NULL, error = NULL, updated_at = ?, lease_until = NULL
      WHERE id = ? AND state IN ('uncertain', 'notified', 'live-uncertain', 'codex-inbox', 'turn-completed')
      RETURNING *
    `).get(state, Date.now(), id);
    if (!resolved) throw new Error('Only uncertain or already accepted deliveries can be resolved.');
    return resolved;
  }
}

export const deliveryStates = {
  saved: 'Verdict saved in Relay Desk. Delivery has not been requested.',
  pending: 'Queued. The receiving chat has not accepted it.',
  dispatching: 'Relay Desk is attempting delivery.',
  'sending-now': 'Relay Desk is attempting live delivery.',
  'codex-inbox': 'Codex accepted it into its inbox. The receiving chat has not acknowledged it.',
  'live-accepted': 'The live transport accepted it. The receiving chat has not acknowledged it.',
  notified: 'Relay Desk notified the receiving chat. The chat has not acknowledged it.',
  'turn-completed': 'The Codex turn finished. An explicit acknowledgment is still missing.',
  delivered: 'The receiving chat acknowledged receipt or a user confirmed it.',
  'live-failed': 'Live delivery was unavailable.',
  uncertain: 'The delivery outcome is unknown. Reconcile before retrying.',
  'live-uncertain': 'The live delivery outcome is unknown. Reconcile before retrying.',
  held: 'Held for review because the recipient could not be verified.',
  superseded: 'An earlier connection notice was replaced.',
};

export function view(message, binding) {
  const { attempt, request_key, lease_until, ...visible } = message;
  visible.stateMeaning = deliveryStates[message.state] || 'Check this state against the target chat.';
  const current = binding?.[message.recipient]?.session;
  if (current) {
    visible.recipientBinding = !message.recipient_session ? 'unverified' :
      message.recipient_session === current ? 'current-session' : 'previous-session';
    visible.needsTransfer = visible.recipientBinding === 'previous-session' && !!canTransfer(message);
  }
  if (visible.related) visible.related = visible.related.map((row) => view(row, binding));
  return visible;
}
