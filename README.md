# pi-detour

**Take a live detour, then merge it back.**

`pi-detour` keeps one main session and one detour session alive concurrently in
a single [Pi](https://pi.dev) process. Switching gives terminal ownership to the
selected session's real Pi `InteractiveMode`; it does not draw or project a
replacement transcript. The detour therefore uses Pi's normal editor,
message/tool renderers, commands, themes, and loaded extensions.

## Status

Version 0.3.0 targets Pi 0.84.2. The native terminal handoff is derived from
[`pi-parallel-sessions`](https://github.com/liushihao456/pi-sessions); see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

A real-terminal smoke test is required before publishing because the design
currently relies on Pi's private `InteractiveMode.ui.start()` / `stop()` /
`updateTerminalTitle()` surface, patches only the child instance's private
`shutdown()` / `registerSignalHandlers()` paths, and loads Pi's internal
`dist/extensions/index.js` for built-in provider parity.
See [docs/design.md](docs/design.md).

## Install

Pi 0.84.2 and Node.js 22.19 or newer are required. Detours also require macOS
with the system `/usr/bin/sandbox-exec`, or Linux with an executable, usable
`bwrap` (bubblewrap) on `PATH`. Linux must permit bubblewrap's unprivileged user
namespace and mount setup; Ubuntu's AppArmor user-namespace restrictions may
require an administrator-approved bubblewrap configuration.

`/usr/bin/sandbox-exec` is currently available on macOS, but its profile
language is a deprecated, undocumented implementation detail with no compatibility
guarantee. Detour creation fails closed if the backend is unavailable or unusable.

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

The detour's built-in `edit` and `write` tools are blocked. Its built-in `bash`
remains available for investigation, but each command is run with a platform
fence that denies writes through the canonical workspace path for Bash and its
descendants. Reads remain available, and writes outside the workspace (including
temporary directories) remain available. An inside symlink to an outside target
is writable; an outside symlink into the workspace is not. Network access,
localhost binding, and local sockets are not intentionally restricted.

On macOS the fence uses the fixed `/usr/bin/sandbox-exec` and also protects the
workspace's ancestor directory entries from rename. On Linux it resolves
bubblewrap once to a canonical launcher whose executable and ancestor directories
are not user-writable, then applies the root bind, read-only workspace bind, and
finally a fresh PID namespace and `/proc`; networking is not unshared.

The first detour-only inline extension replaces the base built-in `bash` tool
with Pi's public `createBashTool` using custom process operations. Pi loads file
extensions before inline factories and uses the first extension registration for
each tool name, so detour creation fails closed if a user, project, or package
file extension registers `bash`. A final hidden inline guard also verifies the
current `bash` owner before every agent call and blocks if a dynamically registered
override displaced the fence. The base built-in Bash tool is not an extension
conflict and is overridden normally.

The custom operations spawn the native fence directly, with Pi's configured
command prefix and original command both inside the fence. Pi's selected shell
and arguments, `PI_*` environment, output accumulation, and renderer are
retained; timeout, abort, and post-exit stdio handling match Pi's Bash behavior.
Explicit user `!` / `!!` commands remain on Pi's normal unrestricted path. Main
registers no override and is completely unrestricted.

Fence availability is preflighted before the session fork is created. Unsupported
platforms, a missing backend, or an unusable backend fail closed with an
actionable error.

This is a pathname/mount accident-prevention fence, not a complete sandbox or an
inode/IPC security boundary. Pre-existing hard links, alternate mounts or aliases,
IPC to an unrestricted process, custom tools/extensions running in Pi's process,
and a concurrently running main session can still modify workspace data. External
editors and processes are also outside this policy.

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
