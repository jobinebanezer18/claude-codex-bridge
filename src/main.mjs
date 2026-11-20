import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readDirectReceipt } from './dispatch.mjs';
import { closeCodexClients } from './codex.mjs';
import { startBridge } from './service.mjs';
import { serveCodexCatalog, serveMcp } from './mcp.mjs';
import { acknowledgeDirectCodex, reportDirectCodex, runClaudeIdeHook, watchClaudeSession, watchInClaude } from './live.mjs';
import { replyFromX1 } from './x1-cli.mjs';
import { loadProject } from './project.mjs';
import { bridgeCli } from './setup.mjs';
import { verifySmoke } from './smoke.mjs';

process.umask(0o077);
const [command = 'daemon', file, actor, session, channel] = process.argv.slice(2);

try {
  if (['setup', 'doctor', 'smoke-check', 'monitor-install', 'profile-add'].includes(command)) {
    const data = process.env.BRIDGE_DATA_DIR || join(homedir(), 'Library/Application Support/Relay Desk');
    const result = command === 'smoke-check' ? await verifySmoke(process.argv.slice(3), data) :
      await bridgeCli(command, process.argv.slice(3), data);
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'codex-acknowledge') {
    if (!process.env.CODEX_THREAD_ID) throw new Error('Run this from the addressed Codex chat.');
    const threadId = process.env.CODEX_THREAD_ID;
    const token = session || readDirectReceipt(file, actor, threadId);
    console.log(JSON.stringify(await acknowledgeDirectCodex(file, threadId, actor, token)));
  } else if (command === 'codex-report') {
    if (!process.env.CODEX_THREAD_ID) throw new Error('Run this from the addressed Codex chat.');
    let body = '';
    for await (const chunk of process.stdin.setEncoding('utf8')) {
      body += chunk;
      if (body.length > 24000) throw new Error('The report exceeds 24,000 characters.');
    }
    const threadId = process.env.CODEX_THREAD_ID;
    const token = channel ? session : readDirectReceipt(file, actor, threadId);
    console.log(JSON.stringify(await reportDirectCodex(file, threadId, actor, token, channel || session, body)));
  } else if (command === 'x1-reply') {
    console.log(JSON.stringify(await replyFromX1(file, actor, session)));
  } else if (command === 'mcp-codex') {
    if (!file) throw new Error('Expected mcp-codex <Relay Desk data directory>.');
    await serveCodexCatalog(resolve(file));
  } else if (command === 'live-watch') {
    await watchInClaude(file, actor);
  } else if (command === 'live-watch-session') {
    await watchClaudeSession(file);
  } else if (command === 'ide-hook') {
    await runClaudeIdeHook(file);
  } else if (command === 'mcp') {
    if (!['c1', 'x1'].includes(actor) || !session || (channel && (actor !== 'c1' || channel !== '--channel'))) {
      throw new Error('Expected mcp <pair file> <c1|x1> <session> [--channel].');
    }
    const project = loadProject(file);
    await serveMcp(project, actor, session === 'current' ? project[actor].session : session, channel === '--channel', actor === 'c1' && session === 'current');
  } else if (command === 'daemon') {
    const directory = resolve(file || process.env.BRIDGE_DATA_DIR ||
      join(homedir(), 'Library/Application Support/Relay Desk'));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
    if (!process.env.BRIDGE_CODEX && existsSync(bundled)) process.env.BRIDGE_CODEX = bundled;
    process.env.PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', process.env.PATH || ''].join(':');
    const service = await startBridge({ directory: realpathSync(directory) });
    const stop = () => {
      closeCodexClients();
      void service.close().catch((error) => { console.error(error.message); process.exitCode = 1; });
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  } else {
    throw new Error('Relay Desk is managed through MCP. Use the configured bridge tools.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
