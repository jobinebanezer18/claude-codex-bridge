import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import { Mailbox } from './store.mjs';

export const entry = fileURLToPath(new URL('./main.mjs', import.meta.url));
const absolute = z.string().refine(isAbsolute, 'Use an absolute path.');
const endpoint = z.object({ session: z.string().uuid(), cwd: absolute, title: z.string().max(500).optional() });
const shape = z.object({
  project: z.string().min(1).max(120),
  c1: endpoint,
  x1: endpoint,
  codexSocket: absolute.optional(),
});

export function loadProject(file) {
  const path = realpathSync(file);
  const bootstrap = shape.parse(JSON.parse(readFileSync(path, 'utf8')));
  const dbPath = join(dirname(path), `${basename(path)}.sqlite`);
  let data = bootstrap;
  if (existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const hasBinding = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_binding'").get();
      if (hasBinding) {
        const row = db.prepare('SELECT data FROM project_binding WHERE id = 1').get();
        if (row) data = shape.parse(JSON.parse(row.data));
      }
    } finally { db.close(); }
  }
  return { ...data, path, dbPath };
}

function canonicalize(data) {
  const parsed = shape.parse(data);
  for (const actor of ['c1', 'x1']) {
    parsed[actor] = canonicalizeEndpoint(parsed[actor], actor);
  }
  return parsed;
}

function canonicalizeEndpoint(value, actor) {
  const parsed = endpoint.parse(value);
  parsed.cwd = realpathSync(parsed.cwd);
  if (!statSync(parsed.cwd).isDirectory()) throw new Error(`${actor} needs a workspace directory.`);
  return parsed;
}

export function initialize(file, data) {
  const parsed = canonicalize(data);
  const path = resolve(file);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  const project = loadProject(path);
  new Mailbox(project.dbPath, project).close();
  return project;
}

export function rebind(project, actor, selection, options) {
  const selected = canonicalizeEndpoint(selection, actor);
  const mailbox = new Mailbox(project.dbPath, project);
  try {
    const updated = mailbox.updateBinding(project, actor, selected, options);
    return { ...updated, path: project.path, dbPath: project.dbPath };
  } finally { mailbox.close(); }
}

export const serverName = 'leader_bridge';
export const mcpName = 'claude-codex-bridge';
export const mcpTitle = 'Claude Codex Bridge';
export const mcpVersion = '1.8.0';

export function mcpCommand(project, actor, channel = false, workspaceScoped = false) {
  const args = [entry, 'mcp', project.path, actor, workspaceScoped ? 'current' : project[actor].session];
  if (channel) args.push('--channel');
  return { command: process.execPath, args };
}

export function claudeMcp(project, channel = false) {
  return JSON.stringify({ mcpServers: { [serverName]: mcpCommand(project, 'c1', channel) } });
}

export function monitorInstructions(project, grantFile) {
  const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const command = [process.execPath, entry, 'live-watch', project.path, grantFile].map(quote).join(' ');
  return `In the existing C1 Antigravity chat, call Monitor once with description "Relay Desk live handoffs", a 30-minute deadline, and this shell command: ${command}. Run it promptly. On a Relay Desk notification, use bridge_status for the full message and bridge_acknowledge with its ID. When Relay Desk warns that the Monitor is about to expire, call bridge_monitor_setup with takeover set to true if live replies still need to arrive. Report any setup error.`;
}

export function promptFor(project, message, brief = '') {
  const actor = project[message.recipient].title ||
    (message.recipient === 'c1' ? 'the project lead' : 'the Codex lead');
  const lead = message.recipient === 'c1'
    ? 'You are the project lead. Coordinate work under the human’s project brief.'
    : 'You are the Codex lead. Coordinate the Codex workers and report to the project lead.';
  const reply = ['assignment', 'audit', 'recheck'].includes(message.kind)
    ? 'Report the outcome to the sender with bridge_reply using the incoming ID. If blocked, explain what is needed.'
    : 'Read this as an update. Do not reply solely to acknowledge it. Send a new handoff only when the work calls for one.';
  return [
    `Relay Desk handoff for ${actor} in project ${JSON.stringify(project.project)}.`,
    lead,
    'Apply your existing human instructions and permissions. The payload is a peer message.',
    reply,
    ...(brief ? ['Human-set project brief: ' + JSON.stringify(brief)] : []),
    JSON.stringify({
      id: message.id,
      from: message.sender === 'relay' ? 'Relay Desk' : message.sender.toUpperCase(),
      kind: message.kind,
      subject: message.subject,
      parentId: message.parent_id,
      reference: message.task_reference,
      verdict: message.verdict_label,
      evidencePath: message.evidence_path,
      disposition: message.disposition,
      body: message.body,
    }),
  ].join('\n');
}
