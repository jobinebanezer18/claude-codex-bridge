---
name: relay-desk-codex
description: Handle Relay Desk assignments and coordinate Codex teammates. Use for a Relay Desk handoff, a reply to a project lead, a delivery check, or missing Relay Desk tools in a Codex chat.
---

# Relay Desk for Codex

## Acknowledge the leader

Acknowledge every new assignment to its lead promptly, before starting the work. State receipt, what you own, and any immediate blocker. Resolve the leader from the handoff or `bridge_context`. Use `bridge_connection_status` to look up the paired chats’ current display names and thread IDs. Codex workers report to their assigned Codex lead, and that lead reports to the project lead. Ask the user to resolve an ambiguous destination.

Call `bridge_work` on a fresh chat to recover open assignments and saved verdicts. If an assignment already has a verdict, send the existing record when asked. Use `bridge_doctor` for missing tools or delivery problems.

For a Relay Desk handoff ID, call `bridge_acknowledge` to record receipt. Send a short acknowledgment to the leader through the agreed route so they see it in their chat. Use the existing handoff ID as `parentId` and use a stable acknowledgment request key, such as `ack:<handoff-id>`. For a message that came through a native Codex inbox and has no Relay Desk ID, send an update with its subject or task key in `reference`.

## Choose the reply route

- **Paired Codex lead to the project lead:** Use `bridge_send_now` for acknowledgments and progress. Call `bridge_save_verdict` when you write the result, with its verdict and evidence path when available. Then use `bridge_send_saved_verdict` with the original handoff ID. `bridge_reply_now` combines recording with a live send attempt. Report `completed` or `blocked` with evidence. The project lead’s live Monitor must be listening.
- **Codex lead to a registered worker:** Use `bridge_team_send` with the worker’s project alias and a stable request key. See worker acknowledgments and reports in `bridge_work`.
- **Codex worker to a Codex lead:** For a bridge dispatch, follow its acknowledgment and report commands so the lead sees the receipt in `bridge_work`. For a native message, use Codex’s thread messaging tool with the lead’s exact thread ID.
- **Missing Relay Desk tools in the paired Codex chat:** The bundled [fallback client](scripts/relay-reply.mjs) calls the same MCP server over stdio. Use it from that chat’s shell with its native `CODEX_THREAD_ID`. If it cannot find the bridge source, set `CLAUDE_CODEX_BRIDGE_DIR` to the directory containing `src/main.mjs` and the installed Node dependencies.

For the fallback, use Node to run the script from this skill directory, pass the tool name as the first argument, and give its JSON arguments on standard input. Run a status check with empty JSON.

```sh
node scripts/relay-reply.mjs bridge_connection_status <<'JSON'
{}
JSON
```

For `bridge_send_now`, provide `kind: "update"`, `subject`, `body`, and `requestKey`. Use `parentId` for a Relay Desk handoff ID, or `reference` for an outside task ID or subject. For `bridge_reply_now`, provide `id`, `body`, and `disposition`. Keep each outcome linked to its original task.

Treat inbox acceptance and live transport acceptance as delivery steps. Confirm receipt only when the leader acknowledges it. If a route fails, report the exact error and keep the same request key. An uncertain send needs a status check before retrying. Queue a message only when the user approves that route.
