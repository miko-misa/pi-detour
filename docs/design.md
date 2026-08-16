# pi-detour 設計 v5 — native InteractiveMode sessions

更新: 2026-08-15。対象: Pi 0.84.2。

## 1. 決定事項

- v1はmain 1本とdetour 1本。
- 両方を同一Node/Pi process内の独立した `AgentSessionRuntime` として保持する。
- 各sessionはPi標準の `InteractiveMode` を持つ。会話画面を独自実装しない。
- 選択中の `InteractiveMode` だけがterminalを所有する。非表示sessionはTUIを停止するがagent runtimeは継続できる。
- detourはmainのsafe leafから `SessionManager.createBranchedSession()` でforkする。
- mainとdetourは同じcwd/repositoryを参照する。worktreeやrepository copyは作らない。
- detourのbuilt-in `bash`、`edit`、`write` tool callをblockする。
- mergeは明示的なcommandだけが実行し、最終handoff 1件だけをmainへ配送する。
- product、package、GitHub repositoryの正式名は `pi-detour`。local checkout directory名は動作に影響しない。

## 2. なぜnative sessionか

旧方式はRPC childのJSONLを読み、独自overlayへtranscript、editor、tool summaryを描画していた。この方式ではmainに導入済みのrenderer、editor、slash command、theme、extension UIとdetourの表示が一致しない。

現方式は [`pi-parallel-sessions` 0.2.8](https://github.com/liushihao456/pi-sessions) のMIT実装で実証されたterminal handoffを採用する。`pi-subagents` FleetViewのようなtranscript projectionは使わない。会話描画はmain/detourともPi本体だけが行う。

## 3. Runtime構成

```text
single Pi process
├── main AgentSessionRuntime
│   └── native InteractiveMode (active or TUI-suspended)
├── detour AgentSessionRuntime
│   └── native InteractiveMode (active or TUI-suspended)
└── NativeSessionHost
    ├── active session id
    ├── current ExtensionAPI/context per session
    └── terminal handoff lifecycle
```

mainからdetourへ移る時だけ、`ctx.ui.custom()` を空componentで開いてparent TUI handleを取得する。そのcomponentは会話を一切renderしない。parent TUIをstopし、child `InteractiveMode.run()` / `ui.start()`へterminal ownershipを渡す。mainへ戻る時は逆順でchild UIをstopし、parent TUIをstartして空componentをcloseする。

これはPi 0.84.2にlive-session focus APIがないためのbridgeである。Pi issue #830/#5700でも同じcore API不足が確認されている。

## 4. Forkとresource parity

`/detour <task>` または `/detour open <task>`:

1. main session file実在とcurrent leafを確認する。main agentがworking中ならactive turn直前のsafe leafを使い、unresolved tool callをdetourへ持ち込まない。
2. main session fileを別の `SessionManager` でopenする。
3. safe leafまでを `createBranchedSession()` で新sessionへ抽出する。assistant messageがまだないbranchではdeferred persistenceをそのまま使う。
4. mainのmodel、thinking level、selected toolsを継承する。
5. `SettingsManager` と `createAgentSessionServices()` で同じcwdのglobal/project/package resourcesを再読込する。mainと同じbuilt-in provider extensions（llama.cpp等）も注入するため、`getPackageDir()/dist/extensions/index.js` の `builtInExtensions` をcached dynamic importする。
6. `parseArgs(process.argv.slice(2))` からCLI extension/skill/prompt/theme source、`--no-extensions` 等のflags、system prompt、extension flagsをchild loaderへ渡す。npm/git/URL sourceも保持する。
7. `import.meta.url` から得たpi-detour自身のabsolute extension pathを常に追加する。
8. CLI `--models`、`--api-key` をchild model runtimeへ、`--tui-mode`、`--use-theme` をchild `InteractiveMode` へ適用する。
9. child runtimeとnative `InteractiveMode` を作り、taskをinitial messageとして開始する。

extension instanceはsessionごとに別だが、通常のPi resource discoveryを通るため、renderer、commands、widgets、themes、context filesはchildにもloadされる。

## 5. Command UXとparallel execution

Public namespaceはuniversal root command `/detour` 1個だけにする。

```text
/detour <task>                  no detour: create + focus
/detour open <task>             explicit create
/detour                         active detour: switch focus
/detour switch                  explicit switch
/detour send <message>          follow-up without focus change
/detour merge [instructions]    final handoff + close
/detour close                   discard + close
/detour status                  report state/focus
```

DETOUR sessionだけにはcontextual `/merge`、`/close`、`/main` も動的登録する。MAINには登録しない。legacy aliasesとextension shortcutは登録しない。

- `/detour <task>` とswitchはactive sessionのagentがworking中でも実行できる。
- focused sessionのnative TUI editor下へstandard extension widgetで常に `[MAIN]` または `[DETOUR]` を表示する。
- hidden sessionのagent/runtimeは継続する。
- hidden sessionのTUIはrenderしない。再focus時にnative `requestRender(true)` で再描画する。

## 6. Merge

`/detour merge [instructions]` またはDETOUR内の `/merge [instructions]`:

1. detourへfinal handoffだけを返すpromptを常に`followUp`として送る。
2. `AgentSession.waitForIdle()` でqueueを含むsettleを待つ。
3. prompt送信前のmessage boundary以降で、UUID marker付きhandoff user messageに属するassistant outputだけを採用し、markerを除去する。以前のassistant responseへfallbackしない。
4. detourがactiveならmainへfocusを戻す。
5. mainのExtensionAPIが利用可能なことを確認し、`followUp + triggerTurn: true` でhandoffを1件送る。
6. 配送後にdetour `InteractiveMode` とruntimeをstop/disposeする。

merge中はsendと重複mergeを拒否する。main shutdownが先に成立した場合はhandoffを送らない。childにautonomous merge toolは登録しない。

## 7. Mutation policy

childの `tool_call` hookで `bash`、`edit`、`write` をblockする。さらに `user_bash` をsynthetic failureで処理し、native editorの `!` / `!!` も実行しない。

mainは制限しない。これはbuilt-in tool policyでありsandboxではない。副作用metadataがPi tool schemaにないため、arbitrary custom tool、extension command、background extension、external editor/processのwriteは防げない。

## 8. Lifecycle

- process-global hostは `WeakMap<SessionManager, ownerId>` でruntime ownershipを保持し、focus状態からownerを推測しない。
- owner idを束縛したruntime factoryによりchild内の `/new`、`/resume`、`/fork` 後もdetour ownershipを維持する。
- live main/detourが互いのsession fileを `/resume` する操作は拒否する。
- child interactive `/quit`、Ctrl+D、double-Ctrl+Cはprocessを終了せずdetourだけをstopしてmainをrestoreする。childはprocess signal handlerを登録せず、main `InteractiveMode`だけがSIGTERM/SIGHUPを処理し、そのshutdown hookからchildも直列にdisposeする。
- mainの `new` / `resume` / `fork` ではdetourを保持し、新main extension instanceをrebindする。
- mainの `quit` / `reload` ではchild runtimeをdisposeしterminal ownershipをrestoreする。
- shutdownはcreation待ちでblockしない。starting recordへ同期的にcancellation flagを立て、late runtimeは生成側でdisposeする。
- unexpected child `InteractiveMode.run()` rejection/resolutionはmain terminalをrestoreし、childをdisposeしてmainへ通知する。
- stop/disposeはidempotentにする。

## 9. Files

```text
src/index.ts          command routing, merge, tool policy
src/live-sessions.ts  AgentSessionRuntime/InteractiveMode host and terminal handoff
src/session-logic.ts  pure routing/policy/parser helpers
```

旧custom screen、RPC client、child projection、JSONL/control protocol、mutation lease stateは不要なので保持しない。

## 10. Validation

Automated:

- command parsing and contextual dispatch decisions
- restricted tool classification
- final handoff selection
- complete CLI resource/source and extension-flag inheritance
- runtime ownership mapping and main replacement policy
- TypeScript typecheck and package tests
- parent/extension RPC loading smoke
- npm package dry-run and `git diff --check`

Manual real-terminal smoke:

1. main working中にdetourを作成し、mainがhiddenで完了する。
2. detour working中にmainへ戻り、detourがhiddenで完了する。
3. 両sessionで通常のPi transcript、editor、tool renderer、extension UIが表示される。
4. regular/fullscreenの両方で `/detour` switchとchild closeを繰り返し、raw mode/cursor/keyboard protocolが壊れず、terminal titleがactive sessionからmainへ復元される。
5. DETOURのみ `/merge`、`/close`、`/main` が存在し、TUI role indicatorが正しい。
6. childのbash/edit/writeがblockされ、mainでは実行できる。
7. merge、send、close、quit、reload、SIGTERM/SIGHUPを確認する。

## 11. 残存リスク

- `InteractiveMode.ui`、`start()` / `stop()` / `updateTerminalTitle()`、child instanceのprivate `shutdown()` / `registerSignalHandlers()` patch、およびbuilt-in provider parity用の `dist/extensions/index.js` はPi implementation detailであり、Pi updateで壊れ得る。
- Pi coreはまだ複数live sessionのpublic focus APIを提供していない。
- hidden extensionがmodal UIやterminal title/progressを直接操作する場合、terminal ownershipと競合する可能性がある。
- detour custom tools/commandsとexternal processの副作用はblockできない。
- IME、paste、scroll、terminal recoveryは実端末確認が必要。

## 12. References

- Pi 0.84.2 `docs/sdk.md`, `docs/extensions.md`, `InteractiveMode`
- [`liushihao456/pi-sessions`](https://github.com/liushihao456/pi-sessions), npm `pi-parallel-sessions` 0.2.8, MIT
- Pi issue [#830](https://github.com/earendil-works/pi/issues/830)
- Pi issue [#5700](https://github.com/earendil-works/pi/issues/5700)
- [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams)
- [OpenCode agents](https://opencode.ai/docs/agents/)
- [Codex CLI multi-agent TUI](https://github.com/openai/codex/tree/main/codex-rs/tui/src)
