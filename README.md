# pi-tangent

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

- `/tangent <task>` — spawn a context-forked tangent subagent and enter
  tangent mode: plain prompts now route to the tangent, leaving the main
  context untouched. A persistent indicator shows where input goes, and a
  single shortcut toggles main <-> tangent(s)
- Ask the tangent to merge in plain language — it composes the handoff and
  calls its `merge_to_main` tool, injecting it into the main conversation
  at a clean boundary
- `/tangent-merge [instructions]` — explicit merge trigger (fallback)
- `/tangent-rally <text>` — one-shot message without entering the mode
- `/tangent-exit` (alias `/main`), `/tangents` — exit mode / list tangents
