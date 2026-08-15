# pi-tangent 設計資料 — 「worktree未満・steering以上」の会話フォーク&マージ

作成: 2026-08-15(v2: 自己完結アーキテクチャに全面改訂)。実装はPi環境で行う想定の設計書。

## 0. 依存方針(最重要)

- **pi-tangent は単体で完結する。** 前提とするのは Pi 本体(`@earendil-works/pi-coding-agent`)の文書化された機能のみ:
  - CLI: `--mode rpc`、`--fork <session>`、`-e <extension>`、`--no-session` 等
  - 拡張API: `registerCommand` / `registerShortcut` / `pi.on("input")` / `ctx.ui.setWidget` / `appendEntry` + `registerEntryRenderer` / `pi.sendMessage` / `ctx.sessionManager`
- **他拡張(pi-subagents 等)への依存は持たない。** この拡張だけを入れるユーザーで全機能が動くこと
- 他拡張との関係は「競合の回避」と「存在する場合の任意連携」のみ(§7)。連携が無くても機能は欠けない
- 既存機能は改変しない: Pi本体のセッションfork(別タブUI)、pi-subagents はそのまま。pi-tangent は純粋な追加

## 1. 目的と要件

メイン会話を汚さずに、脇道の調査・相談を並行して行い、最後に成果だけを合流させる。

1. **fork**: 分岐時点までのメイン会話の全文脈を子が共有する
2. **rally**: 子と何往復でもやり取りできる。この間メイン文脈には一切入らない。**入力は通常のプロンプトそのまま**(モード方式、per-messageコマンドなし)
3. **merge**: 「何をどうメインに入れるか」を子のモデルが構成し(指示があれば従う)、メイン文脈のきれいな境界に挿入される。**merge は子との会話の中で自然言語で頼めるのが本命**
4. **非破壊既定**: 子は既定で読み取り専用ツールのみ(バリアントで解除可)
5. 画面は切り替わらない。メインと tangent の行き来は TUI(ショートカット+インジケータ)で

## 2. アーキテクチャ(自己完結)

```
[メインPi + pi-tangent拡張]
  /tangent <依頼>
    │ 1. ctx.sessionManager で現行セッションをディスクへ保存(フラッシュ)
    │ 2. 子プロセスを spawn:
    │      pi --mode rpc --fork <現行セッションファイル> \
    │         -e <pkg>/child/merge-tool.ts [--tools read,grep,find,ls,...]
    │    → 子 = メイン全文脈を持つ独立Piプロセス(生かしたまま保持)
    ▼
[tangent子 (RPCプロセス)]
  rally: 親拡張が RPC `prompt` で入力を転送、イベントストリームで応答受信
  実行中の割り込み: RPC `steer`
  merge: 子モデルが merge_to_main ツールを呼ぶ(下記)
    │ 親は子のRPCイベントで tool_call(merge_to_main) を観測し content を取得
    ▼
[メイン文脈への挿入]
  pi.sendMessage({customType: "tangent-merge", content, display: true},
                 { deliverAs: "followUp" })
  → メインがアイドルになった境界で合流。走行中のメインを妨げない
```

- 子プロセスは tangent の寿命の間ずっと生存(rallyごとの再起動なし)。`/tangent-close` または merge 後の任意クローズで終了
- 子は普通の Pi なので、ユーザーの settings.json のスキル・拡張・テーマがそのまま効く(必要なら `--no-extensions` 等で絞る)
- 子の応答表示: RPC イベントを `appendEntry`(+`registerEntryRenderer`)で**TUI専用エントリ**としてメインのトランスクリプトに描画。メインの LLM 文脈には入らない

## 3. UXとコマンド(確定仕様)

- `/tangent <task>` — tangent を生成し **tangentモード**に入る
- **tangentモード**: 通常のプロンプト入力がすべて tangent へ。`pi.on("input")` で捕捉しメインへの配送をブロック(不可なら `CustomEditor` 方式へフォールバック)。ラリー中もメインは裏で実行継続可
- **TUI切替**: `pi.registerShortcut` の1キーで main ↔ tangent トグル(複数はサイクル)。エディタ上部の常設ウィジェットで `[main] [t1: 認証調査*]` のように入力先を常時明示。※枠色は zentui 等のエディタ系拡張が使う領域なので使わない(§7)
- **`merge_to_main(content, note?)` ツール(merge の本命)**: 同梱の子専用ミニ拡張(`-e` でロード)が提供。ラリー中に「これをメインに入れて」と頼むと子モデルが handoff を構成して呼ぶ
- `/tangent-merge [指示]` — merge の明示発火(フォールバック。どちらのモードからでも)
- `/tangent-rally <text>` — モードに入らず1発だけ投げる省略形
- `/tangent-exit`(エイリアス `/main`)、`/tangent-close [id]`、`/tangents`(一覧、appendEntry表示)
- コマンドは `tangent` 接頭辞の一家に統一(汎用名の衝突回避+補完でのグルーピング)

## 4. 非破壊性

既定の子は `--tools read,grep,find,ls,web_search,fetch_content,get_search_content`(+merge_to_main)で起動。
`/tangent --rw <task>` で書き込み可バリアント。web系ツールはユーザーが該当拡張を入れている場合のみ存在する
(無ければ Pi が単に無視するか、起動時に利用可能ツールへ絞る — 要検証9)。

## 5. 実装ステップ

1. 骨格: `/tangent` → 子spawn(--fork)→ RPC prompt/イベント受信 → appendEntry 表示(モードなし、/tangent-rally 相当のみ)
2. tangentモード: input捕捉+ブロック、切替ショートカット、インジケータウィジェット
3. merge: 子ミニ拡張 merge_to_main + 親の tool_call 観測 + sendMessage(followUp)
4. 複数tangent、/tangents、/tangent-close、クラッシュ/孤児プロセス処理
5. Claude敵対レビュー → dotagents の packages.txt へ追加して配布(作者環境)

## 6. 要検証項目(着手順)

1. **`--fork` の対象**: 実行中セッションのファイルを fork できるか。`ctx.sessionManager` に「現在のセッションパス取得」「明示保存(フラッシュ)」があるか(Pi本体 docs/extensions.md の SessionManager 節)。fork はスナップショットであり、以後の親の進行は子に反映されない(仕様として明記)
2. **RPCモードの実際**: `pi --mode rpc` の起動フラグ併用(`--fork` / `-e` / `--tools` / `--no-session`?)、イベントストリームの形式、tool_call イベントから引数(merge content)を取れるか(Pi本体 docs/rpc.md)
3. **input イベントのブロック可否**: tangentモードの成立条件。`pi.on("input")` がハンドラから入力の消費/抑止を返せるか。Ponytail の実装が参考(`~/.pi/agent/npm/node_modules/@dietrichgebert/ponytail/pi-extension/index.js`)。不可なら CustomEditor
4. **ショートカットとウィジェット**: キー選定(Ctrl+T=thinking、Ctrl+P=モデル巡回等と衝突しないこと)。`ctx.ui.setWidget` で常設タブ表示が成立するか
5. **子の資源**: tangent 1つ = Pi プロセス1つ。メモリ/起動時間の実測、孤児プロセス防止(親終了時のkill、セッション再開時の再接続 or 破棄)
6. **子のセッション永続化**: 子を `--no-session` にするか、保存して「後から tangent を再開」を許すか(v1 は揮発でよい)
7. **merge の冪等性**: sendMessage(followUp) がメイン走行中に積まれた場合の配送タイミング確認(アイドル後、と本体docsに明記あり)
8. **コスト**: fork = 親全文の prefix を子の各ターンで再送。プロバイダーのキャッシュで緩和されることをログ(cacheRead)で確認。巨大セッションからの fork には警告表示を検討
9. **--tools と拡張ツールの関係**: 許可リストに存在しないツール名を指定した場合の挙動

## 7. 他拡張との棲み分け(依存ではなく共存)

| 拡張 | 関係 | 方針 |
|---|---|---|
| pi-subagents | 同種の子実行系を持つが**別システム**。コマンド名・ツール名は衝突しない(subagent / *-fleet 系 vs tangent-*) | 併存可。任意連携(FleetView への表示登録)は**将来のオプション**とし、v1 では行わない |
| zentui / エディタ系 | 入力欄の枠色・装飾を所有 | tangentモードの表示は枠色を使わず、独自ウィジェット+ステータスで行う |
| tool-display | ツール行の描画を所有 | tangent の表示は appendEntry(独自エントリ型)なので干渉しない |
| atelier / フッター系 | フッター/サイドバー | 使用しない。将来、サイドバーパネル(公開プロトコル)への任意表示をオプションで検討 |
| herdr | ペイン状態 | 依存しない。子プロセスは親 Pi の中で完結する |

## 8. 参考(確認済みの一次情報)

- Pi RPC モード: `prompt`(streamingBehavior: steer/followUp 指定可)、`steer`、`follow_up`、`abort`、`new_session`、`get_state`、`get_messages` — Pi本体 docs/rpc.md で確認済み
- `pi --fork <path|id>` は Pi 本体の公開 CLI フラグ(--help で確認済み)
- `pi.sendMessage` の followUp 配送は「エージェントがアイドルになった後」に処理(docs/extensions.md)
- `pi.on("input")` は Ponytail が使用実績あり(ブロック可否のみ未確認)
- appendEntry + registerEntryRenderer で「LLM文脈に入らないTUI専用の恒久表示」が可能(作者の別拡張で実証済み)

## 付録: pi-subagents を使った先行プロトタイプ(任意)

作者環境には pi-subagents が入っているため、製品実装前の**体験検証**としては同フレームワークの
`defaultContext: fork` + retained children `resume` + steer で近い体験を数分で試せる
(agents/*.md 1枚。詳細は pi-subagents docs/agents.md, extension-api.md)。
ただしこれはプロトタイプ専用であり、**製品の pi-tangent は上記の自己完結アーキテクチャで実装する**。
