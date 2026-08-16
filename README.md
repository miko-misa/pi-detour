# pi-detour

**Take a live detour, then merge it back.**

`pi-detour` keeps one main session and one detour session alive concurrently in
a single [Pi](https://pi.dev) process. Switching gives terminal ownership to the
selected session's real Pi `InteractiveMode`; it does not draw or project a
replacement transcript. The detour therefore uses Pi's normal editor,
message/tool renderers, commands, themes, and loaded extensions.

## Status

Version 0.2.0 targets Pi 0.84.2. The native terminal handoff is derived from
[`pi-parallel-sessions`](https://github.com/liushihao456/pi-sessions); see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

A real-terminal smoke test is required before publishing because the design
currently relies on Pi's private `InteractiveMode.ui.start()` / `stop()` /
`updateTerminalTitle()` surface, patches only the child instance's private
`shutdown()` / `registerSignalHandlers()` paths, and loads Pi's internal
`dist/extensions/index.js` for built-in provider parity.
See [docs/design.md](docs/design.md).

## Install

Pi 0.84.2 and Node.js 22.19 or newer are required.

```bash
pi install git:github.com/miko-misa/pi-detour
```

After an npm release, the equivalent source is `npm:pi-detour`. A persisted Pi
session and interactive TUI mode are required to open a detour.

## Commands

One universal command owns the public namespace:

```text
/detour <task>                    Create and focus a detour when none exists
/detour open <task>               Explicit equivalent
/detour                           Switch focus when a detour exists
/detour switch                    Explicit switch
/detour send <message>            Send/follow up without changing focus
/detour merge [instructions]      Merge one final handoff, then close
/detour close                     Close without merging
/detour status                    Show activity, lifecycle state, and focus
```

Inside the detour only, the contextual commands `/merge`, `/close`, and `/main`
are also available. They are not registered in main. There are no extension
hotkeys or legacy command aliases.

`/detour <task>` and switching remain available while the active agent is
working. A dedicated TUI indicator below the editor always shows `[MAIN]` or
`[DETOUR]` for the focused session.

## Mutation policy

The detour's built-in `bash`, `edit`, and `write` tool calls are blocked, and
native `!` / `!!` shell input returns a synthetic failure. Main is unrestricted.
Both sessions share the same repository and filesystem.

This is cooperative protection, not a sandbox: arbitrary extension commands or
custom tools may still have side effects, as may external editors and processes.

## Try locally

```bash
git clone https://github.com/miko-misa/pi-detour.git
cd pi-detour
npm install
pi -e ./src/index.ts
```

Do not use `--no-session`: opening a detour needs a persisted main session leaf.

## Development

```bash
npm install
npm run format
npm run check
npm pack --dry-run
```

## License

[MIT](LICENSE). The terminal handoff includes MIT-licensed work credited in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
