# Claude–Codex Bridge MCP

**`claude-codex-bridge` tracks handoffs between Claude Code in Antigravity and Codex Desktop.** Delegate to the chats you already use, see who acknowledged an assignment, and recover open work and saved verdicts when you start a fresh chat.

The bridge runs headlessly. MCP clients connect over standard input and output. The bridge starts its Node.js background service on demand and uses a private Unix socket for local communication.

## Quick start

### Requirements

- macOS.
- Claude Code and Codex installed and signed in on the same machine.
- Node.js 22.13 or newer.

Clone or extract the bridge to a location you plan to keep. From that directory, install its dependencies and register the catalog for your project workspace.

```sh
npm ci --omit=optional
npm run setup -- --workspace "/path/to/project"
```

Open an existing Claude Code conversation in that workspace and use `/mcp` to check the catalog. Ask Claude to call `codex_threads` to find Codex chats. Direct messages by exact thread ID work without a project pairing.

For tracked handoffs, call `bridge_project_create` from the Claude chat you want as overall lead. Run the returned `setupCommand` to register the scoped tools for both leads, then reopen the chats. You can also rerun setup from the bridge checkout. If Codex loads project configuration from a different folder, pass `--codex-workspace` with that folder.

```sh
npm run setup -- --project PROJECT_ID
npm run doctor -- --project PROJECT_ID
```

`doctor` checks the registrations, availability of the scoped server tools, the Codex host and paired chat, and Monitor status. Run `bridge_doctor` from the target chat to verify that it can call the tools. Existing manual registrations can continue to use their current aliases.

Steering a running Desktop turn requires the shared App Server socket for the host that owns the thread. `doctor` reports when it only has the local profile. In that mode you can still choose to send through the Codex inbox. Live sends never fall back to the inbox automatically.

### Pick a workflow

| Goal | Tool |
|---|---|
| Find local Codex threads | `codex_threads` |
| Create and name a Codex thread | `codex_create_thread` |
| Send directly to a thread by ID | `codex_send_thread` |
| Check a direct send, acknowledgment, or worker report | `codex_delivery_status` |
| Create a persistent project link | `bridge_project_create` |
| Recover open work or replace leads | `bridge_recover` |
| Register people by project alias | `bridge_team_set` |
| Delegate to a registered Codex worker | `bridge_team_send` |
| See owners, receipts, and saved verdicts | `bridge_work` |
| Check host routing and local configuration errors | `bridge_diagnostics` |

Both leads can delegate to a registered worker. The overall lead manages project aliases. A worker who receives a bridge dispatch can acknowledge and report using the commands the bridge includes in the message. Both leads see those reports in `bridge_work`. Workers can have any display name, and replacing a worker alias keeps past messages associated with the original recipient.

## Project handoffs and replies

1. **Set the brief.** Use `bridge_update_brief` to record scope and acceptance criteria. Both leads can read it with `bridge_context`.
2. **Send a handoff.** Use `bridge_send_now` for live delivery or `bridge_send` for an explicit queue. Link progress updates with `parentId` or a task reference.
3. **Acknowledge receipt.** The receiver calls `bridge_acknowledge`. `bridge_inbox` lists incoming work and `bridge_status` shows the message and its related replies.
4. **Save and send the outcome.** Call `bridge_save_verdict` when writing a result and attach an evidence path when useful. `bridge_send_saved_verdict` sends that record using the original handoff ID. `bridge_reply_now` saves the result and attempts live delivery in one call.

`bridge_setup` returns the exact scoped configuration and Codex shell fallback. Use the fallback from the addressed Codex lead chat if its MCP tools have yet to load.

## Delivery modes

| Mode or state | Meaning |
|---|---|
| `delivery: "live"` | Requires access to the target's active Codex turn. |
| `delivery: "inbox"` | Explicitly submits the message to the Codex inbox. |
| `live-accepted` | The live transport accepted the message. Acknowledgment is still pending. |
| `codex-inbox` | Codex accepted the message into its inbox. Acknowledgment is still pending. |
| `saved` | A verdict is recorded and can be delivered when the route is available. |
| `delivered` | The receiver acknowledged the message or a user confirmed receipt. |
| `uncertain` | Check the target chat before retrying. |

### Persistent Antigravity notifications

Install the local Claude Code plugin for the paired project, then load it in the C1 tab and resume the chat. If you use two Claude profiles, install it once in each profile.

```sh
npm run monitor-install -- --project PROJECT_ID
```

Claude watches a private local notification file. Relay Desk confirms the watcher before reporting it ready. It follows the paired chat across `/clear`, can wake the chat for handoffs, and stops when the chat's Claude process exits. Check for `monitorReady: true`, `monitor.mode: "ide-hook"`, and a null `expiresAt` with `bridge_doctor`.

If the extension cannot start the file watch, use `bridge_monitor_setup` and Claude Code's Monitor tool. A manual Monitor expires after 30 minutes. Verdicts stay saved when the live route is offline.

## Recovery and local state

- Reuse a request key when retrying the same direct send. Use a fresh key for a new assignment.
- A direct send that definitively never reached Codex can be retried with its original key. A retry of an accepted or acknowledged handoff returns its existing receipt. An uncertain send requires checking the receiving chat before retrying.
- A Monitor that has been prepared but has yet to connect reports `starting`. Repeated setup in the same Claude chat returns the same valid startup command. Wait for `monitorReady: true` before sending live replies.
- After `/clear` or a fresh Claude chat, use `bridge_projects` and `bridge_recover` from the catalog in the same workspace. Confirm the previous Claude session ID. To replace Codex, supply the current and new Codex thread IDs. Rerun the returned `setupCommand` if the Codex thread changed.
- Pass `transferIds` with the specific handoffs to adopt. Acknowledged work keeps its acknowledgment. Saved verdicts keep their record and evidence. Pending work you leave out stays held. Check receipts before resolving or attempting to transfer an uncertain send.
- `bridge_inbox` shows messages addressed to the current chat. `bridge_work`, `bridge_status`, and `bridge_history` show previous-session records and mark which ones can be transferred. To transfer a saved verdict, use the verdict's own ID in `transferIds`.
- Project data lives in `~/Library/Application Support/Relay Desk`. This release is designed for collaborators running under one local operating-system account.

If you use multiple Claude Code profiles on that account, register the additional configuration directory once. The bridge verifies live session identities across the registered profiles. If both profiles have a live chat with the same lead name in one workspace, close the old lead chat before switching the pairing.

```sh
npm run profile-add -- --claude-profile "/path/to/second-claude-config"
```

## Agent skills

Optional skills explain how each agent should acknowledge work, recover a session, and report delivery.

- [Claude Code skill](skills/relay-desk-claude/SKILL.md)
- [Codex skill and reply fallback](skills/relay-desk-codex/SKILL.md)

## Test

```sh
npm ci --omit=optional
npm test
```

Keep the checkout path stable when upgrading so existing MCP registrations can continue to find the server. Reopen affected conversations after changing the MCP configuration.

[Real-app release smoke test](docs/SMOKE.md)
