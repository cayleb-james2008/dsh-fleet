# Fleet — Job and First-Screen Questions

Fleet is Cayleb's parallel coding-agent mission control board: the operator dispatches coding tasks into isolated git worktrees, supervises running CLI agents (`opencode`, `claude`, `codex`) without babysitting them, and merges work only after the repository's own check command passes and writes a verified receipt. First read is the Scan Strip and Latest Verified Receipt hero, followed immediately by the Three-Lane Board (`Needs you` · `Working` · `Done`); a generic project-management tool could never wear this screen because every card is anchored by a git worktree branch, a Rune policy check command, a diff stat, and an honest verification verdict.

1. What needs me now, and why did it stop?
2. What agents are running or verifying checks right now?
3. What came back verified done, and what receipt and diff did it produce?
4. How do I hand out the next task in its own git worktree?

## Real data shape (`/api/sessions`, `/api/inbox`, `/api/policy`, `/api/update`)

- `Session`: `id`, `task`, `project`, `status` (`queued` | `working` | `checking` | `done` | `needs-you` | `merged` | `archived`), `bucket` (`needs-you` | `working` | `done`), `branch`, `engine`, `agent`, `test_mode`, `reason`, `check_cmd`, `check_output`, `check_passed`, `check_ran`, `check_exit`, `queue_position`, `transcript` (capped at 2000 lines in memory, full log on disk), `diff`, `steer`, `successor`, `spawned_from`, `next_queue`, `merge_target`, `merge_error` (`{ message, detail }`).
- `Policy` (`policies.rn` via Rune): `agents` (`[{ name, found }]`), `max_parallel`, `timeout_secs`, `source`, `default_agent`, `default_agent_engine`, `model`.
- `UpdateState`: `current`, `latest`, `available`, `mode`, `can_apply`, `dev_build`, `staged`, `notes`, `release_url`, `error`, `checked_at`.
