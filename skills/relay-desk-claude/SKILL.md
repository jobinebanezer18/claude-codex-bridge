---
name: relay-desk-claude
description: Coordinate a project from Claude Code using Relay Desk MCP. Use when the user asks Claude to delegate to Codex, check acknowledgments or handoffs, or recover a live reply route.
---

# Relay Desk for Claude Code

## Acknowledge the leader

Acknowledge every new assignment to the leader named in the handoff. When acting as overall lead, confirm the user’s brief in the Claude chat. Give each worker a clear next action when accepting their report.

Read `bridge_context` for the current project and roles. Use names supplied by the user or the assignment and look up exact thread IDs in Relay Desk. When a Relay Desk handoff or result arrives, read it using `bridge_status` if needed, then call `bridge_acknowledge` for its exact ID. Acknowledge the sender in their chat when they need confirmation, using the agreed route. For a Codex workstream, workers acknowledge their Codex lead, and the Codex lead acknowledges the project lead.

## Delegate and collect

1. Use `codex_threads` to find the project’s existing Codex chats. Match workspace and title, then use the exact returned IDs. Ask the user if a role has multiple candidates.
2. Use `codex_send_thread` to assign work to each chosen chat. Project pairing is optional for direct Codex messages. Use live delivery for active-turn steering. Use inbox delivery when the user approves it.
3. Give each lead their role, the same branch or commit and acceptance criteria, and a clear report destination. When the user asks to conserve Claude usage, keep Claude on coordination and delegate auditing and testing to Codex leads and their own subagents. Assign a single owner for shared long-running test suites.
4. Track inbox acceptance separately from the worker’s acknowledgment. Ask each worker for one report with findings, checked evidence, and blockers. A Codex workstream lead can consolidate the worker reports before returning one result to the project lead. Ask them to call `bridge_save_verdict` when they write the evidence file and `bridge_send_saved_verdict` when ready to send.

Use `codex_create_thread` when the user asks for a new named thread. Use `codex_pair_thread` when the user asks to change the persistent link to their Codex lead. For a fresh assignment, preserve the agreed scope and use a new handoff ID.

Use `bridge_team_set` to register worker aliases and display names for the two lead roles. Use `bridge_team_send` to delegate by alias and `bridge_work` to see owners, acknowledgments, saved verdicts, and worker reports. Keep a stable request key when retrying. For an intentional lead change, use `bridge_recover` and transfer only the work IDs the user selects.

## Receive live replies in Antigravity

In the paired project-lead tab, call `bridge_monitor_setup` and run the one-time command it returns using Claude Code’s **Monitor** tool. Verify `monitorReady` with `bridge_connection_status`. When Relay Desk warns the Monitor is expiring, use fresh setup with `takeover: true` if live replies are still needed. If the server returns a stale-session error, reconnect the configured MCP server in that Antigravity tab and call `bridge_context` again.

After `/clear` or a new chat, use the catalog’s `bridge_projects` and `bridge_recover` if the scoped tools reject that chat. Recovery returns open work and a replacement Monitor prompt when needed. Use `bridge_doctor` to verify both routes. A saved verdict remains available in `bridge_work` while the Monitor is offline.

If a send fails, give the user the exact error and the destination. Use the existing handoff for retries. Treat a live transport receipt as accepted, and the receiving lead’s acknowledgment as proof they saw it.
