import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Mailbox } from './store.mjs';

export function createIdeWake(directory, readIdentity) {
  const inboxes = new Map();
  const routes = new Map();
  const folder = join(directory, 'ide-wake');
  const markerPath = (id, { session, pid }) => join(folder, `${id}-${session}-${pid}.signal`);

  function stored(project, id) {
    if (routes.has(id)) return routes.get(id);
    const mailbox = new Mailbox(project.dbPath, project);
    try {
      const value = mailbox.db.prepare("SELECT value FROM project_settings WHERE name = 'ide_wake_route'").get()?.value;
      const route = value ? JSON.parse(value) : null;
      routes.set(id, route);
      return route;
    } finally { mailbox.close(); }
  }

  function remember(project, id, route) {
    const mailbox = new Mailbox(project.dbPath, project);
    try {
      mailbox.db.prepare(`INSERT INTO project_settings VALUES ('ide_wake_route', ?)
        ON CONFLICT(name) DO UPDATE SET value = excluded.value`).run(JSON.stringify(route));
      routes.set(id, route);
    } finally { mailbox.close(); }
  }

  function current(project, id) {
    const route = stored(project, id);
    if (!route || route.session !== project.c1.session || !existsSync(markerPath(id, route))) return null;
    try {
      const who = readIdentity(route.pid);
      if (who.sessionId === route.session && who.procStart === route.procStart && who.entrypoint === 'claude-vscode') return route;
    } catch { /* The Claude process closed or replaced its session. */ }
    return null;
  }

  function pulse(id, route) {
    writeFileSync(markerPath(id, route), randomUUID(), { flag: 'r+', mode: 0o600 });
  }

  return {
    register(project, id, identity) {
      const previous = stored(project, id);
      const route = { session: identity.sessionId, pid: identity.pid, procStart: identity.procStart,
        startedAt: Date.now(), verifiedAt: null };
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const info = lstatSync(folder);
      if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) {
        throw new Error('Relay Desk requires a private IDE notification directory.');
      }
      const marker = markerPath(id, route);
      if (previous && markerPath(id, previous) !== marker) rmSync(markerPath(id, previous), { force: true });
      try { writeFileSync(marker, randomUUID(), { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const target = lstatSync(marker);
      if (!target.isFile() || target.uid !== process.getuid() || (target.mode & 0o077)) {
        throw new Error('Relay Desk requires a private IDE notification file.');
      }
      remember(project, id, route);
      // Verify that Claude actually registered the new watch before advertising it to X1.
      for (const delay of [300, 1000, 2500, 5000]) {
        const timer = setTimeout(() => {
          if (routes.get(id) !== route || route.verifiedAt) return;
          try { pulse(id, route); } catch { /* A later setup can recover a missing watch. */ }
        }, delay);
        timer.unref();
      }
      return marker;
    },

    status(project, id) {
      const route = current(project, id);
      if (!route || (!route.verifiedAt && Date.now() - route.startedAt > 8000)) return null;
      return { state: route.verifiedAt ? 'ready' : 'starting', mode: 'ide-hook', startedAt: route.startedAt, expiresAt: null };
    },

    drain(project, id, identity, file) {
      const route = current(project, id);
      if (!route || route.pid !== identity.pid || file !== markerPath(id, route)) return [];
      if (!route.verifiedAt) {
        route.verifiedAt = Date.now();
        remember(project, id, route);
      }
      const pending = inboxes.get(id);
      if (!pending) return [];
      const notifications = [];
      for (const event of pending.values()) {
        if (event.session !== route.session) continue;
        notifications.push(event.text);
        event.accept();
      }
      return notifications;
    },

    notify(project, id, messageId, text) {
      const route = current(project, id);
      if (!route?.verifiedAt) return Promise.reject(new Error('The Claude IDE notification route is offline.'));
      const pending = inboxes.get(id) || new Map();
      inboxes.set(id, pending);
      return new Promise((resolve, reject) => {
        function finish(error) {
          clearTimeout(timer);
          pending.delete(messageId);
          if (pending.size === 0) inboxes.delete(id);
          if (error) reject(error); else resolve();
        }
        const timer = setTimeout(() => {
          if (current(project, id) === route) {
            route.verifiedAt = null;
            try { remember(project, id, route); } catch { /* Keep the unverified route in memory. */ }
          }
          finish(new Error('The Claude IDE hook did not confirm the live notification.'));
        }, 6500);
        pending.set(messageId, { session: route.session, text, accept: () => finish(), reject: finish });
        try { pulse(id, route); } catch (error) { finish(error); }
      });
    },

    close() {
      for (const pending of inboxes.values()) {
        for (const event of pending.values()) event.reject(new Error('Relay Desk restarted before the IDE hook confirmed receipt.'));
      }
    },
  };
}
