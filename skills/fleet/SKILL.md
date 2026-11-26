---
name: fleet
description: Coordinate an Antigravity-native multi-agent swarm with structured plan tracking, isolated worktrees, cold verification gates, and live telemetry in the Fleet sidecar pane. Trigger with /fleet or when splitting multi-lane coding, audit, or verification work across swarm workers.
---

# Fleet — Antigravity Swarm Coordinator

Use Antigravity's native `swarm`, `post_message`, `read_board`, and `swarm_wait` tools to execute multi-agent work with clear ownership, zero silent stalls, and cold verification.

When the **Fleet** sidecar pane is enabled (`fleet/fleet_pane`), surface a single navigation pill once when launching a swarm:

```markdown
[Fleet](sidecar://fleet/fleet_pane/)
```

## Workflow

1. **Publish `plan.json` for live Fleet visibility.**
   Write `<appData>/brain/<coordinatorConversationId>/.system_generated/swarm/plan.json` (and keep it updated as waves advance):
   ```json
   {
     "title": "Short swarm goal",
     "goal": "One-sentence measurable outcome",
     "gate": "Exact verification command(s) required before ship",
     "workstreams": [
       { "id": "lane-1", "title": "Scoped module or feature", "owner": "worker-name", "status": "running" }
     ],
     "milestones": [
       { "title": "Implementation & self-tests pass", "status": "in_progress" },
       { "title": "Cold verifier signoff", "status": "pending" }
     ],
     "risks": []
   }
   ```
2. **Spawn focused workers with isolated workspaces.**
   - Call `swarm{action: "title", title: "..."}` to name the board clearly.
   - Writers/builders that edit code simultaneously MUST use `workspace: "share"` (or `"branch"` for independent clones) so files never collide.
   - Read-only verifiers and auditors keep the default `inherit` workspace.
   - Leave `model` unset so workers inherit the active coordinator model unless the user asks for a specific model.
   - For long multi-worker runs (3+ writers), optionally add a `monitor` worker with brief `"Run swarm_monitor"` so stalls surface automatically.
3. **Require crisp board handoffs.**
   - Builders hand off directly to `@verifier` (without CCing `@coordinator` on intermediate steps) and flag screenshots when UI changed:
     `Screenshot: /abs/path/under/appData/brain/shot.png | short caption`
   - Workers prefix final completion posts with `[done]` after the `@mention` (e.g. `@verifier [done] ...`).
   - Cold verifiers prefix signoff posts with `[verified]` (or `[blocked]` with exact reproducer).
4. **Land, verify, and clean up.**
   - Never kill a `share`/`branch` worker before landing or merging its changes.
   - Kill finished helpers (`swarm{action: "kill", name}`) and update `plan.json` statuses before posting the final response to the user.
   - Use Fleet's **Peek**, confirmation-gated **Unstick / Nudge** presets, **Open file** (`toggleAuxPane` `fileView`), and **Copy swarm digest** controls inside the sidecar pane to triage workers rapidly without switching contexts.

## Operator control directives

When the operator triggers an action from the Fleet sidecar pane, the sidecar sends the coordinator a message whose first line starts with `[fleet-operator:<op>]` and carries `opId=<opId>` (nudge messages carry `[opId=<opId>]` as well). Treat these directives as confirmed operator instructions and run them right away using your native swarm tools.

When you answer or confirm an operator directive on the board, include `[opId=<opId>]` in the resulting post so Fleet's `fleet_ops.json` ledger marks the command verified instead of timing out after 45 seconds:

- `[fleet-operator:board_post]`: Post the message body to the swarm board with `post_message`, keeping the requested channel, `#seq` citation, and `[opId=<opId>]` tag.
- `[fleet-operator:spawn_worker]`: Spawn the named worker with `swarm` (`action: "add"`) using the requested `workspace` mode (`inherit`, `share`, or `branch`), optional `model`, and optional `fork`, then post `[opId=<opId>]` if announcing readiness.
- `[fleet-operator:switch_model]`: Switch the named waiting, stopped, or errored worker (or a working worker when `allowWorking` was approved) to the requested model with `swarm` (`action: "model"`), keeping its conversation history intact, and tag `[opId=<opId>]` on any confirmation post.
- `[fleet-operator:kill_worker]`: Verify that the worker's `share` or `branch` workspace is merged or landed before calling `swarm` (`action: "kill"`), unless `forceUnmerged=true` is present in the header, and tag `[opId=<opId>]` if posting confirmation.
- `[fleet-operator:channel_op]`: Apply the requested `create`, `archive`, `subscribe`, or `unsubscribe` channel operation for the named channel and member, and tag `[opId=<opId>]` when confirming.
- `[fleet-operator:gate_verdict]`: Post the operator's `[verified]`, `[blocked]`, or `ship` verdict to the board referencing the target `#seq`, member, and `[opId=<opId>]`, then update `plan.json` if a workstream or milestone status changed.
