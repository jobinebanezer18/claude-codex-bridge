import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual, parseArgs, promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parse } from 'smol-toml';
import { entry, loadProject, mcpCommand, mcpName, mcpVersion } from './project.mjs';
import { requestProjectStatus } from './live.mjs';
import { Mailbox } from './store.mjs';
import { addClaudeProfile } from './claude-profiles.mjs';
import { projectId } from './thread-tools.mjs';

const exec = promisify(execFile);
export const catalogName = `${mcpName}-catalog`;
const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

export function setupCommand(project) {
  return [process.execPath, entry, 'setup', '--data', dirname(project.path), '--project', basename(project.path, '.json')].map(quote).join(' ');
}

async function installMonitor(project) {
  const id = basename(project.path, '.json');
  const marketplace = `relay-desk-local-${id}`;
  const plugin = 'relay-desk-monitor';
  const location = join(dirname(project.path), 'monitor-plugins', id);
  const pluginRoot = join(location, plugin);
  const manifest = (root, name, value) => {
    const parent = join(root, '.claude-plugin');
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    writeFileSync(join(parent, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  };
  manifest(pluginRoot, 'plugin.json', {
    name: plugin, displayName: 'Relay Desk Monitor', version: mcpVersion,
    description: 'Notifies the paired Claude Code IDE chat while it is open.', author: { name: 'Relay Desk' },
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: process.execPath, args: [entry, 'ide-hook', project.path], timeout: 12 }] }],
      FileChanged: [{ hooks: [{ type: 'command', command: process.execPath, args: [entry, 'ide-hook', project.path], timeout: 12, asyncRewake: true }] }],
    },
  });
  manifest(location, 'marketplace.json', {
    name: marketplace, owner: { name: 'Relay Desk' }, plugins: [{ name: plugin, source: `./${plugin}` }],
  });
  const run = (...args) => exec(process.env.BRIDGE_CLAUDE || 'claude', ['plugin', ...args], {
    cwd: project.c1.cwd, timeout: 30000,
  });
  await run('validate', pluginRoot);
  await run('install', plugin, '--marketplace', location, '--scope', 'local');
  await run('update', `${plugin}@${marketplace}`, '--scope', 'local');
  return { plugin: `${plugin}@${marketplace}`, scope: 'local', project: project.project,
    next: 'Reload plugins in the paired Claude Code IDE chat, then resume it or run /clear. Check bridge_doctor for monitor.mode=ide-hook and monitorReady=true.' };
}

function directory(path) {
  const absolute = realpathSync(path);
  if (!statSync(absolute).isDirectory()) throw new Error('Choose a workspace directory.');
  return absolute;
}

async function claudeRegistration(name, spec, cwd, install) {
  const cmd = process.env.BRIDGE_CLAUDE || 'claude';
  const run = (args) => exec(cmd, ['mcp', ...args], { cwd, timeout: 10000 });
  if (install) {
    try {
      await run(['add-json', '--scope', 'local', name, JSON.stringify({ type: 'stdio', ...spec })]);
    } catch (error) {
      if (!/already exists/i.test(`${error.stdout || ''}${error.stderr || ''}`)) {
        throw new Error(`Claude could not register ${name}. Check that the Claude Code CLI is available on PATH.`);
      }
    }
  }
  try {
    const { stdout } = await run(['get', name]);
    const lines = stdout.split(/\r?\n/).map((line) => line.trim());
    const matches = lines.includes(`Command: ${spec.command}`) && lines.includes(`Args: ${spec.args.join(' ')}`);
    const connected = lines.some((line) => line.startsWith('Status:') && /\bConnected\b/.test(line));
    if (install && !matches) throw new Error(`Claude server ${name} is already registered with different settings.`);
    return { name, matches, connected };
  } catch (error) {
    if (install) throw error;
    return { name, matches: false, connected: false };
  }
}

export function codexRegistration(project, workspace, install) {
  const name = `${mcpName}-${basename(project.path, '.json')}`;
  const spec = mcpCommand(project, 'x1');
  const folder = join(workspace, '.codex');
  const path = join(folder, 'config.toml');
  const start = `# Begin generated ${name}`;
  const end = `# End generated ${name}`;
  const block = `${start}\n[mcp_servers.${name}]\ncommand = ${JSON.stringify(spec.command)}\nargs = ${JSON.stringify(spec.args)}\n${end}`;
  if (existsSync(path) && !lstatSync(path).isFile()) throw new Error('Use a regular project Codex configuration file.');
  const original = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const before = parse(original);
  for (const [alias, entry] of Object.entries(before.mcp_servers ?? {})) {
    if (entry?.enabled !== false && entry.command === spec.command && isDeepStrictEqual(entry.args, spec.args)) {
      return { name: alias, path, matches: true };
    }
  }
  const first = original.indexOf(start);
  const last = original.indexOf(end);
  const hasBlock = first >= 0 && last > first && original.indexOf(start, first + 1) < 0 && original.indexOf(end, last + 1) < 0;
  const oldBlock = hasBlock ? original.slice(first, last + end.length) : '';
  const matches = oldBlock === block;
  if (!install || matches) return { name, path, matches };
  const generated = oldBlock.split('\n');
  const registrationOnly = generated.length === 5 && generated[1] === `[mcp_servers.${name}]` &&
    generated[2].startsWith('command = ') && generated[3].startsWith('args = ');
  if (first >= 0 || last >= 0) {
    if (!hasBlock || !registrationOnly) throw new Error(`Review the modified Codex block for ${name} before retrying.`);
  } else if (original.includes(name)) {
    throw new Error(`Codex already uses ${name} in this workspace. Review that entry before retrying.`);
  }
  const updated = hasBlock ? original.slice(0, first) + block + original.slice(last + end.length) :
    `${original}${original ? '\n\n' : ''}${block}\n`;
  const after = parse(updated);
  const expected = parse(block).mcp_servers[name];
  if (!isDeepStrictEqual(after.mcp_servers?.[name], expected)) throw new Error('The generated Codex registration would not load from this file.');
  before.mcp_servers ??= Object.create(null);
  before.mcp_servers[name] = expected;
  if (!isDeepStrictEqual(before, after)) throw new Error('Setup would modify unrelated Codex settings.');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const temp = join(folder, `.bridge-${randomUUID()}.toml`);
  try {
    writeFileSync(temp, updated, { flag: 'wx', mode: existsSync(path) ? statSync(path).mode & 0o777 : 0o600 });
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    if (current !== original) throw new Error('The Codex configuration changed. Run setup again.');
    renameSync(temp, path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
  return { name, path, matches: true };
}

async function checkTools(spec, expected) {
  const client = new Client({ name: `${mcpName}-doctor`, version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({ ...spec, stderr: 'ignore' }), { timeout: 7000 });
    const { tools } = await client.listTools({}, { timeout: 7000 });
    return expected.every((name) => tools.some((tool) => tool.name === name));
  } finally {
    await client.close();
  }
}

export async function bridgeCli(action, args, defaultData) {
  const { values } = parseArgs({ args, options: {
    data: { type: 'string' }, project: { type: 'string' }, workspace: { type: 'string' },
    'codex-workspace': { type: 'string' }, 'claude-profile': { type: 'string' },
  } });
  const data = resolve(values.data || defaultData);
  if (action === 'profile-add') {
    if (!values['claude-profile']) throw new Error('Pass --claude-profile with the Claude configuration directory.');
    return addClaudeProfile(data, values['claude-profile']);
  }
  const project = values.project ? loadProject(join(data, `${projectId.parse(values.project)}.json`)) : null;
  if (action === 'monitor-install') {
    if (!project) throw new Error('Pass --project with the paired project ID.');
    return installMonitor(project);
  }
  if (project && values.workspace) throw new Error('The project determines the Claude workspace.');
  const workspace = project?.c1.cwd || directory(values.workspace || process.cwd());
  const install = action === 'setup';
  const spec = { command: process.execPath, args: [entry, 'mcp-codex', data] };
  const catalog = await claudeRegistration(catalogName, spec, workspace, install);
  if (!project) return { workspace, catalog,
    next: install ? 'Reopen Claude Code in this workspace. Use bridge_project_create for tracked handoffs or codex_threads for direct messaging.' :
      'Use --project with a project ID to check paired routes and recent in-chat receipts.' };
  const scoped = mcpCommand(project, 'c1', false, true);
  const legacy = await claudeRegistration(mcpName, scoped, workspace, false);
  const claude = legacy.matches ? legacy : await claudeRegistration(`${mcpName}-${values.project}`, scoped, workspace, install);
  const codexWorkspace = directory(values['codex-workspace'] || project.x1.cwd);
  const codex = codexRegistration(project, codexWorkspace, install);
  if (install) {
    const mailbox = new Mailbox(project.dbPath, project);
    try {
      mailbox.transaction(() => {
        const binding = mailbox.binding();
        if (binding.c1.session !== project.c1.session || binding.x1.session !== project.x1.session) {
          throw new Error('The paired chats changed during setup. Run setup again for the current pair.');
        }
        mailbox.installReceipt('c1', project.c1.cwd);
        mailbox.installReceipt('x1', project.x1.cwd);
      });
    } finally { mailbox.close(); }
    return { workspace, catalog, claude, codex,
      next: 'Reopen the paired chats, call bridge_doctor, and use bridge_recover in Claude if you need the live Monitor.' };
  }
  const codexToolsAvailable = await checkTools(mcpCommand(project, 'x1'), ['bridge_doctor', 'bridge_work']);
  const status = await requestProjectStatus(project, 'x1', project.x1.session, true);
  return { workspace, catalog, claude, codex: { ...codex, toolsAvailable: codexToolsAvailable }, status };
}
