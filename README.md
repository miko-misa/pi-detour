# pi-branch

Context-forked side conversations for the [Pi](https://pi.dev) coding agent —
"more than steering, less than a worktree".

Fork the main conversation's full context into a rally-able subagent
(visible in the standard pi-subagents FleetView / inspector), converse with
it over multiple turns without touching the main context, then merge a
composed handoff back into the main conversation at a clean boundary.

## Status

Design phase. See [docs/design.md](docs/design.md) — the design document,
including which pi-subagents native features are assembled
(`context: fork`, retained children + `resume`, steer, delegation API)
and the one genuinely new piece (merge via `pi.sendMessage` followUp).

## Planned commands

- `/branch <task>` — spawn a context-forked branch subagent (async)
- `/rally [id] <text>` — continue the conversation with a branch
- `/merge [id] [instructions]` — compose and inject the handoff into main
- `/branches` — list retained branches
