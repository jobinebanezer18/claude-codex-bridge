import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const allowedTools = new Set([
  'bridge_context', 'bridge_connection_status', 'bridge_doctor', 'bridge_work', 'bridge_inbox', 'bridge_status',
  'bridge_acknowledge', 'bridge_send_now', 'bridge_reply_now',
  'bridge_save_verdict', 'bridge_send_saved_verdict', 'bridge_team_send',
]);

function pairedProject(data, threadId, loadProject) {
  const matches = readdirSync(data)
    .filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name))
    .map((name) => join(data, name))
    .filter((path) => {
      try { return loadProject(path).x1?.session === threadId; }
      catch { return false; }
    });
  if (matches.length !== 1) throw new Error('This Codex thread needs exactly one Relay Desk pairing as the Codex lead to use the fallback.');
  return matches[0];
}

async function argumentsFromStdin() {
  let input = '';
  for await (const chunk of process.stdin.setEncoding('utf8')) {
    input += chunk;
    if (input.length > 65536) throw new Error('Tool arguments exceed 65,536 characters.');
  }
  const value = JSON.parse(input || '{}');
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Pass a JSON object on standard input.');
  }
  return value;
}

try {
  const name = process.argv[2];
  if (!allowedTools.has(name)) throw new Error('Choose a supported Relay Desk tool for the paired Codex chat.');
  const threadId = process.env.CODEX_THREAD_ID;
  if (!threadId) throw new Error('Run this from a Codex shell with its native CODEX_THREAD_ID.');
  const data = resolve(process.env.RELAY_DESK_DATA_DIR || process.env.BRIDGE_DATA_DIR ||
    join(homedir(), 'Library', 'Application Support', 'Relay Desk'));
  const source = resolve(process.env.CLAUDE_CODEX_BRIDGE_DIR || join(data, 'source'));
  const entry = join(source, 'src', 'main.mjs');
  if (!existsSync(entry)) throw new Error('Set CLAUDE_CODEX_BRIDGE_DIR to the installed bridge source directory.');
  const { loadProject } = await import(pathToFileURL(join(source, 'src', 'project.mjs')).href);
  const pair = pairedProject(data, threadId, loadProject);
  const args = await argumentsFromStdin();
  const sdk = join(source, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client');
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import(pathToFileURL(join(sdk, 'index.js')).href),
    import(pathToFileURL(join(sdk, 'stdio.js')).href),
  ]);
  const client = new Client({ name: 'relay-desk-codex-skill', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [entry, 'mcp', pair, 'x1', threadId],
      stderr: 'ignore',
    }));
    const response = await client.callTool({ name, arguments: args });
    const output = response.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n');
    if (response.isError) throw new Error(output || 'Relay Desk rejected the tool call.');
    console.log(output);
  } finally {
    await client.close();
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
