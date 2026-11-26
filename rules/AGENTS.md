# Fleet Swarm Plugin Rules

- Keep `plan.json` under `<appData>/brain/<coordinatorConv>/.system_generated/swarm/plan.json` accurate when coordinating multi-worker tasks so the Fleet sidecar Triage view reflects live workstreams and verification gates.
- Writers modifying files in parallel must run in `workspace: "share"` or `workspace: "branch"`; land or merge their changes before killing them.
- Start final worker deliverable posts with `[done]` after `@mention` and cold verification signoffs with `[verified]` or `[blocked]`.
- When capturing UI screenshots for verification, post `Screenshot: /abs/path/under/appData/brain/file.png | caption` on its own line so Fleet surfaces it in the media strip cleanly.
- Never poll `read_board` in a tight loop; always park with `swarm_wait` using the highest sequence number read.
- Handle `[fleet-operator:<op>]` messages sent to the coordinator right away using native `swarm` and `post_message` tools (`board_post`, `spawn_worker`, `switch_model`, `kill_worker`, `channel_op`, and `gate_verdict`). Verify work is landed or `forceUnmerged=true` is set before killing a `share` or `branch` worker.
