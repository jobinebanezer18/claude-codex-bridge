import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { entry } from './project.mjs';
import { sendToCodexThread } from './codex.mjs';
import { threadLink } from './thread-tools.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const leaseMs = 120000;

const receiptDirectory = (directory) => join(directory, 'direct-receipts');
const receiptFile = (directory, id) => join(receiptDirectory(directory), `${id}.json`);
const validId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export function readDirectReceipt(directory, id, threadId) {
  if (typeof id !== 'string' || !validId.test(id)) throw new Error('Use the Relay Desk message ID.');
  const path = receiptFile(directory, id);
  const info = lstatSync(path);
  if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) {
    throw new Error('Relay Desk requires a private direct-receipt file.');
  }
  const receipt = JSON.parse(readFileSync(path, 'utf8'));
  if (receipt.threadId !== threadId) throw new Error('Run this from the addressed Codex chat.');
  return receipt.token;
}

export function directDispatches(db, directory) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS direct_dispatches (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      request_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      state TEXT NOT NULL,
      error TEXT,
      ack_hash TEXT NOT NULL,
      lease_until INTEGER,
      updated_at INTEGER NOT NULL,
      UNIQUE (scope, request_key)
    );
    CREATE TABLE IF NOT EXISTS direct_reports (
      dispatch_id TEXT PRIMARY KEY,
      disposition TEXT NOT NULL,
      report TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  for (const column of ['subject', 'worker_alias', 'accepted_state']) {
    if (!db.prepare('PRAGMA table_info(direct_dispatches)').all().some((row) => row.name === column)) {
      try { db.exec(`ALTER TABLE direct_dispatches ADD COLUMN ${column} TEXT`); }
      catch (error) {
        if (!db.prepare('PRAGMA table_info(direct_dispatches)').all().some((row) => row.name === column)) throw error;
      }
    }
  }

  const byId = db.prepare('SELECT * FROM direct_dispatches WHERE id = ?');
  const byKey = db.prepare('SELECT * FROM direct_dispatches WHERE scope = ? AND request_key = ?');
  function view(row) {
    return {
      id: row.id, threadId: row.thread_id, link: threadLink(row.thread_id), state: row.state,
      error: row.error, requestKey: row.request_key, updatedAt: row.updated_at,
      subject: row.subject, workerAlias: row.worker_alias,
      acceptedState: row.accepted_state, acknowledged: row.state === 'delivered',
      outcome: db.prepare('SELECT disposition, report, created_at FROM direct_reports WHERE dispatch_id = ?')
        .get(row.id) ?? null,
    };
  }

  function recover() {
    const now = Date.now();
    db.prepare(`
      UPDATE direct_dispatches SET state = 'uncertain', updated_at = ?, lease_until = NULL,
        error = 'The direct send ended without a host receipt. Check the target chat before retrying.'
      WHERE state = 'sending' AND lease_until <= ?
    `).run(now, now);
  }

  return {
    async send(scope, endpoint, { message, delivery, requestKey, workerAlias }, socket) {
      recover();
      const fingerprint = digest(JSON.stringify([endpoint.session, delivery, socket || null, message]));
      const key = requestKey || fingerprint;
      let id = randomUUID();
      const token = randomBytes(24).toString('base64url');
      const ackHash = digest(token);
      const now = Date.now();
      const inserted = db.prepare(`
        INSERT INTO direct_dispatches (id, scope, request_key, fingerprint, thread_id, state, ack_hash, lease_until, updated_at, subject, worker_alias)
        VALUES (?, ?, ?, ?, ?, 'sending', ?, ?, ?, ?, ?) ON CONFLICT(scope, request_key) DO NOTHING
      `).run(id, scope, key, fingerprint, endpoint.session, ackHash, now + leaseMs, now,
        message.split('\n', 1)[0].slice(0, 160), workerAlias ?? null);
      if (!inserted.changes) {
        const existing = byKey.get(scope, key);
        if (existing.fingerprint !== fingerprint) throw new Error('That request key was used for another direct send.');
        id = existing.id;
        const claimed = db.prepare(`UPDATE direct_dispatches SET state = 'sending', error = NULL,
          ack_hash = ?, updated_at = ?, lease_until = ? WHERE id = ? AND state = 'failed' AND accepted_state IS NULL`)
          .run(ackHash, now, now + leaseMs, id);
        if (!claimed.changes) return view(byId.get(id));
      }
      const folder = receiptDirectory(directory);
      const temporary = join(folder, `${randomUUID()}.tmp`);
      try {
        mkdirSync(folder, { mode: 0o700, recursive: true });
        const owner = lstatSync(folder);
        if (!owner.isDirectory() || owner.uid !== process.getuid() || (owner.mode & 0o077)) {
          throw new Error('Unsafe receipt directory.');
        }
        try {
          writeFileSync(temporary, JSON.stringify({ threadId: endpoint.session, token }), { mode: 0o600, flag: 'wx' });
          renameSync(temporary, receiptFile(directory, id));
        } finally { rmSync(temporary, { force: true }); }
      } catch {
        db.prepare(`
          UPDATE direct_dispatches SET state = 'failed', error = ?, updated_at = ?, lease_until = NULL
          WHERE id = ? AND state = 'sending' AND ack_hash = ?
        `).run('The private receipt file could not be created. Nothing was sent.', Date.now(), id, ackHash);
        return view(byId.get(id));
      }
      const command = (verb) => [process.execPath, entry, verb, directory, id].map(quote).join(' ');
      const envelope = [
        message,
        `Relay Desk message ID: ${id}`,
        `To acknowledge receipt in this Codex chat, run: ${command('codex-acknowledge')}`,
        `To report the outcome to the sender, run ${command('codex-report')} completed with the report on standard input. Use blocked for an unresolved blocker.`,
      ].join('\n\n');
      let state, error = null;
      try {
        state = (await sendToCodexThread(endpoint, envelope, delivery, socket)).state;
      } catch (cause) {
        const known = cause.code === 'CODEX_NO_ACTIVE_TURN';
        state = known ? 'failed' : 'uncertain';
        error = known
          ? 'The selected live route is unavailable. Nothing was queued.'
          : 'Codex did not confirm this direct send. Check the target chat or shared host before retrying.';
      }
      db.prepare(`
        UPDATE direct_dispatches SET accepted_state = ?,
          state = CASE WHEN state = 'sending' THEN ? ELSE state END,
          error = CASE WHEN state = 'sending' THEN ? ELSE error END,
          updated_at = ?, lease_until = NULL
        WHERE id = ? AND ack_hash = ?
      `).run(['live-accepted', 'codex-inbox'].includes(state) ? state : null, state, error, Date.now(), id, ackHash);
      return view(byId.get(id));
    },

    work(scope, { limit, workerBefore = Number.MAX_SAFE_INTEGER, includeClosed }) {
      recover();
      const rows = db.prepare(`SELECT d.rowid AS cursor, d.* FROM direct_dispatches d
        LEFT JOIN direct_reports r ON d.id = r.dispatch_id
        WHERE d.scope = ? AND d.rowid < ? AND (? OR r.disposition IS NULL OR r.disposition = 'blocked')
        ORDER BY d.rowid DESC LIMIT ?`).all(scope, workerBefore, Number(includeClosed), limit + 1);
      const items = rows.slice(0, limit).map((row) => ({ ...view(row), cursor: row.cursor }));
      return { items, nextBefore: rows.length > limit ? items.at(-1).cursor : null };
    },

    status(scope, id) {
      recover();
      const row = byId.get(id);
      if (!row || row.scope !== scope) throw new Error('Direct message was not found in this scope.');
      return view(row);
    },

    acknowledge(threadId, id, token) {
      const row = db.prepare(`
        UPDATE direct_dispatches SET state = 'delivered', updated_at = ?, error = NULL, lease_until = NULL
        WHERE id = ? AND thread_id = ? AND ack_hash = ?
        RETURNING *
      `).get(Date.now(), id, threadId, digest(token));
      if (!row) throw new Error('This receipt does not match the addressed Codex chat.');
      return view(row);
    },

    report(threadId, id, token, disposition, body) {
      const row = byId.get(id);
      if (!row || row.thread_id !== threadId || row.ack_hash !== digest(token)) {
        throw new Error('This report does not match the addressed Codex chat.');
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare(`
          INSERT INTO direct_reports VALUES (?, ?, ?, ?) ON CONFLICT(dispatch_id) DO NOTHING
        `).run(id, disposition, body, Date.now());
        const saved = db.prepare('SELECT disposition, report FROM direct_reports WHERE dispatch_id = ?').get(id);
        if (saved.disposition !== disposition || saved.report !== body) {
          throw new Error('This direct dispatch already has a different final report.');
        }
        db.prepare("UPDATE direct_dispatches SET state = 'delivered', error = NULL, lease_until = NULL, updated_at = ? WHERE id = ?")
          .run(Date.now(), id);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return view(byId.get(id));
    },
  };
}
