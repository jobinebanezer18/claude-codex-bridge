import { z } from 'zod';
import { requestLive } from './live.mjs';
import { loadProject } from './project.mjs';
import { Mailbox } from './store.mjs';

export async function replyFromX1(file, id, disposition) {
  const project = loadProject(file);
  if (process.env.CODEX_THREAD_ID !== project.x1.session) {
    throw new Error('Run this command from the paired X1 Codex chat.');
  }
  const parentId = z.string().uuid().parse(id);
  const outcome = z.enum(['completed', 'blocked']).parse(disposition);
  let body = '';
  for await (const chunk of process.stdin.setEncoding('utf8')) {
    body += chunk;
    if (body.length > 24000) throw new Error('The reply exceeds 24,000 characters.');
  }
  body = z.string().trim().min(1, 'Write the reply on standard input.').parse(body);
  const mailbox = new Mailbox(project.dbPath, project);
  try {
    const parent = mailbox.find(parentId);
    if (parent?.recipient !== 'x1' || !['assignment', 'audit', 'recheck'].includes(parent.kind)) {
      throw new Error('Choose the ID of an assignment, audit, or recheck sent to X1.');
    }
    const verdict = mailbox.saveVerdict('x1', parentId, body, outcome, null, project.x1.session);
    try {
      return await requestLive(project, 'x1', project.x1.session, {
        kind: 'result', subject: parent.subject, body, parentId,
        requestKey: `result:${parentId}`, disposition: outcome,
      });
    } catch (error) {
      throw new Error(`${error.message} Verdict record: ${verdict.id}. Check bridge_status before retrying.`);
    }
  } finally {
    mailbox.close();
  }
}
