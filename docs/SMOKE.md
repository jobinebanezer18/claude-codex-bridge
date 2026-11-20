# Real-app release smoke test

Use two temporary macOS workspaces and dedicated chats in Claude Code in Antigravity and Codex Desktop. Use an isolated data directory and pass it as `--data` when running setup. The checks below use neutral fixture work. Keep automatic queued delivery disabled for these projects.

1. **Check setup in both apps.** Register the catalog in each workspace, create a bridge project from each Claude tab, and run its `setupCommand`. Reopen both leads. In each project, call `bridge_doctor` from Claude and Codex. In the first project start the Claude Monitor and confirm `monitorReady`.
2. **Send to an active Codex turn.** Register a disposable worker with `bridge_team_set`. While that Codex chat is working on a harmless task, send an update with `bridge_team_send` and `delivery: "live"`. Record the dispatch ID and require the worker to acknowledge it. Verify `live-accepted` before the acknowledgment or in `acceptedState` afterward.
3. **Send to an idle Codex chat.** When that worker is idle, send a fresh message with `delivery: "inbox"`. Require acknowledgment and record its dispatch ID. Verify `acceptedState: "codex-inbox"`. Check the second project's `bridge_work` while both projects are open. It should contain neither dispatch.
4. **Save a verdict.** In the first project, send two queued assignments to the Codex lead using `bridge_send`. Let the lead read them with `bridge_inbox`. Acknowledge one and record a saved verdict with `bridge_save_verdict`. Leave the other assignment pending. Record the acknowledged assignment ID, the verdict ID, the other assignment ID, and both current lead IDs.
5. **Recover after `/clear` and a fresh Codex chat.** Clear the project lead’s Claude tab. Use the catalog’s `bridge_recover`, confirming the previous Claude session and both Codex thread IDs. Explicitly transfer the acknowledged assignment and the saved verdict. Run the returned `setupCommand`, reopen the replacement Codex chat, and start the replacement Claude Monitor from the returned prompt. Verify the acknowledged assignment and the saved verdict in `bridge_work` before taking further action. Verify that the other assignment is held and pinned to the old Codex lead.
6. **Send the existing verdict.** From the replacement Codex lead, use `bridge_send_saved_verdict` with the original assignment ID. Acknowledge the live reply from Claude. Check that the verdict ID stayed the same and that the second project still has its own separate work.

Save the observed IDs as JSON using the following keys. Replace the example strings with the actual UUIDs.

```json
{
  "project": "first project ID",
  "secondProject": "second project ID",
  "previousClaudeSession": "old Claude lead session ID",
  "previousCodexThread": "old Codex lead thread ID",
  "liveDispatch": "busy turn dispatch ID",
  "inboxDispatch": "idle inbox dispatch ID",
  "assignment": "acknowledged assignment ID",
  "verdict": "saved verdict ID",
  "held": "unselected assignment ID"
}
```

Run the read-only receipt checker from the bridge checkout while the replacement Monitor is live.

```sh
npm run smoke-check -- --data "/path/to/smoke-data" --evidence "/path/to/smoke-evidence.json"
```
