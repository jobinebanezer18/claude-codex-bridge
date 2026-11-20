import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { projectId } from './thread-tools.mjs';
import { loadProject } from './project.mjs';
import { requestProjectStatus, requestProjectWork } from './live.mjs';
import { Mailbox } from './store.mjs';

export async function verifySmoke(args, defaultData) {
  const { values } = parseArgs({ args, options: { data: { type: 'string' }, evidence: { type: 'string' } } });
  if (!values.evidence) throw new Error('Pass --evidence with your saved smoke-test IDs. See docs/SMOKE.md.');
  const proof = z.object({ project: projectId, secondProject: projectId, previousClaudeSession: projectId,
    previousCodexThread: projectId, liveDispatch: projectId, inboxDispatch: projectId,
    assignment: projectId, verdict: projectId, held: projectId }).parse(JSON.parse(readFileSync(values.evidence, 'utf8')));
  if (proof.project === proof.secondProject) throw new Error('Use two separate fixture projects.');
  const data = resolve(values.data || defaultData);
  const project = loadProject(join(data, `${proof.project}.json`));
  const second = loadProject(join(data, `${proof.secondProject}.json`));
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  check(project.c1.cwd !== second.c1.cwd, 'Use two separate workspace directories.');
  check(project.c1.session !== proof.previousClaudeSession && project.x1.session !== proof.previousCodexThread,
    'Both recorded lead sessions must have been replaced.');
  const [status, firstWork, secondWork] = await Promise.all([
    requestProjectStatus(project, 'x1', project.x1.session, true),
    requestProjectWork(project, 'x1', project.x1.session, { limit: 100, includeClosed: true }),
    requestProjectWork(second, 'x1', second.x1.session, { limit: 100, includeClosed: true }),
  ]);
  check(status.monitorReady && status.codex?.found && !status.codex.archived, 'The replacement Monitor and Codex route must be ready.');
  for (const [id, route] of [[proof.liveDispatch, 'live-accepted'], [proof.inboxDispatch, 'codex-inbox']]) {
    const receipt = firstWork.workers.items.find((item) => item.id === id);
    check(receipt?.acceptedState === route && receipt.state === 'delivered', `Missing acknowledged ${route} receipt for ${id}.`);
    check(!secondWork.workers.items.some((item) => item.id === id), 'A worker receipt appeared in the second project.');
  }
  const mailbox = new Mailbox(project.dbPath, project);
  try {
    const assignment = mailbox.status(proof.assignment);
    const verdict = assignment.related.find((item) => item.id === proof.verdict && item.kind === 'result');
    const held = mailbox.status(proof.held);
    check(assignment.state === 'delivered' && assignment.recipient_session === project.x1.session,
      'The acknowledged assignment was not transferred to the replacement Codex lead.');
    check(verdict?.state === 'delivered' && verdict.recipient_session === project.c1.session,
      'The original verdict was not acknowledged by the replacement Claude lead.');
    check(held.state === 'held' && held.recipient_session === proof.previousCodexThread,
      'The unselected assignment did not stay with the previous Codex lead.');
  } finally { mailbox.close(); }
  check(!secondWork.handoffs.items.some((item) => item.id === proof.assignment), 'A handoff appeared in the second project.');
  return { passed: true, checks: ['busy turn delivery', 'idle chat inbox delivery', 'lead replacement', 'verdict receipt', 'unselected work held', 'project isolation'] };
}
