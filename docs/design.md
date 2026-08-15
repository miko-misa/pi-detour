# tangent agent 設計資料 — 「worktree未満・steering以上」の会話ブランチ&マージ

作成: 2026-08-15。実装はPi環境(Codex実装+Claude敵対レビュー)で行う想定の設計書。

## 0. 用語と非目標(重要)

- 本設計の「fork」は **pi-subagents の起動オプション `context: fork`**(起動時に親の会話履歴を子のコンテキストへコピーする)を指す。**Pi本体のセッションfork(ダブルEsc/`--fork`、別タブに切り替わる機能)は一切使わない**。tangent は最初から最後まで「普通のasyncサブエージェント」として存在し、画面は切り替わらない
- **既存機能は改変しない**。Pi本体のfork、pi-subagentsのビルトインagent(scout/worker等)、subagentツールはそのまま残す。tangentは新規のagent定義1枚+新規の拡張1本の**純粋な追加**であり、依存するのは文書化された公開インターフェース(agent定義、delegation API、pi.sendMessage)のみ

## 1. 目的と要件

メイン会話を汚さずに、脇道の調査・相談を並行して行い、最後に成果だけを合流させる。

1. **fork**: 分岐時点までのメイン会話の全文脈を子が共有する
2. **rally**: 子と数往復のやり取りができる(質問・追加指示・結果の練り直し)。この間メイン文脈には一切入らない
3. **merge**: 最終的に「何をどうメインに入れるか」を子のモデルが構成し(指示があれば従い、なければ要点を自動選別)、メイン文脈のきれいな境界に挿入される
4. **統一的な枠組み**: 特殊なUIではなく「普通のサブエージェント」として見える。FleetView・`/subagents-fleet`インスペクタ・steer・Herdrペインメタデータにそのまま乗る
5. 非破壊バリアント: 読み取り専用ツールのみの分岐も選べる

## 2. 調査結果: 必要部品はほぼすべて pi-subagents に存在する

実装前に必ず以下のローカルドキュメントを読むこと(バージョン: pi-subagents v0.49系で確認):

- `~/.pi/agent/npm/node_modules/pi-subagents/docs/agents.md`
- `~/.pi/agent/npm/node_modules/pi-subagents/docs/extension-api.md`
- `~/.pi/agent/npm/node_modules/pi-subagents/docs/tool-reference.md`
- `~/.pi/agent/npm/node_modules/pi-subagents/docs/observability.md`

確認済みの既存機能と、要件との対応:

| 要件 | 既存機能 | 出典 |
|---|---|---|
| fork(文脈共有) | agent frontmatter の **`defaultContext: fork`**。launch側の `context: "fork" / "fresh"` も指定可 | agents.md「defaultContext: fork — Use forked session context when a launch omits context」 |
| rally(多ターン継続) | **retained children + `resume`**。完了した子は直近10件までrun IDで保持され、`resume: runId` で同じ子に追いタスクを投げて会話を継続できる | extension-api.md「Retained children」 |
| 実行中の子への指示 | fleet インスペクタの **steer(`s`キー)** | observability.md / configuration.md |
| 統一枠組みでの可視化 | async子は自動でFleetView・`/subagents-fleet`・Herdrペインメタデータに載る | observability.md |
| 拡張からのプログラム起動 | **Structured delegation API**(`pi-subagents/delegation` の REQUEST/RESPONSE イベント)。`agent`/`task`/`context`/`thinking`/構造化出力まで指定可 | extension-api.md「Structured delegation API」 |
| 非破壊性 | agent frontmatter の `tools:` 許可リスト | agents.md |
| スキル継承 | `inheritSkills: true`(ビルトインは false なので明示必須) | agents.md |
| merge(メイン文脈への挿入) | **存在しない唯一の部品**。Pi本体の `pi.sendMessage({content, deliverAs: "followUp"})` で自作する | Pi本体 docs/extensions.md「pi.sendMessage」 |

## 3. アーキテクチャ

```
[メインPi]
  /tangent <task>      ← 薄い自作拡張(pi-tangent)
     │ delegation API(または subagent tool)で起動
     ▼
[tangent子セッション]  ← agents/tangent.md 定義: defaultContext: fork
  = メイン会話の全文脈を持つ独立Piセッション(async)
  FleetView に「◉ tangent」として表示 / インスペクタで閲覧・steer
     │
  /rally <text>       ← resume: runId で同じ子に追いターン(rally何回でも)
     │
  /merge [指示]        ← 最終ターン: 「handoffを構成せよ」を resume で送る
     ▼
  handoff 出力(output: handoff.md / 構造化出力)
     │
[メインPi側の pi-tangent 拡張]
  handoff を読み、pi.sendMessage({ content, deliverAs: "followUp" }) で
  メインの作業の切れ目に挿入(customType: "branch-merge"、表示付き)
```

### Phase 1(コードゼロ、即日運用可能)

`agents/tangent.md` を置くだけで、拡張なしでも運用できる:

```markdown
---
name: tangent
description: Context-forked side conversation. Investigates, discusses, and
  proposes without touching the main context; produces a handoff on request.
defaultContext: fork
inheritSkills: true
inheritProjectContext: true
tools: read, grep, find, ls, web_search, fetch_content, get_search_content, intercom
thinking: medium
output: handoff.md
---
You are a side-conversation branch forked from the main session. You share its
full history. Work on the requested tangent: investigate, answer questions,
develop proposals. Multi-turn: expect follow-up instructions via resume/steer.
When asked to merge, compose a concise handoff for the main conversation:
include only what the main thread needs (decisions, findings, proposals,
concrete diffs/snippets), following the user's merge instructions if given.
```

運用(すべて既存機能):
- 起動: メインに「`Run branch async (context fork): <調査依頼>`」
- rally: 実行中は fleet インスペクタで `s`(steer)。完了後は「`Resume the branch run <id>: <追い質問>`」(=subagentツールの `resume`)
- 閲覧: FleetView展開(`↓`)→ Enter、または `/subagents-fleet`(メイン文脈に入れずトランスクリプトを読める)
- merge: 「`Resume the branch: compose the handoff (…の部分だけ)`」→ メインで `subagent_wait` → 結果がツール結果としてメイン文脈に入る = マージ完了

Phase 1 の制約: rally/mergeの指示文がメイン会話に1行ずつ載る(subagentツール呼び出しのため)。

### Phase 2(薄い拡張 `pi-tangent` — メイン文脈を一切経由しないUX)

dotagents の `extensions/` に追加。`/usage-report` 拡張と同じ作法(registerCommand + appendEntry)。

- `/tangent <task>` — delegation API で `agent: "branch", context: "fork"` を投入。メインLLM不関与
- `/rally [id] <text>` — 保持中の子へ `resume` で追いターン投入。子が1つなら id 省略
- `/merge [id] [指示]` — merge構成ターンを投入 → 完了後 handoff を取得 → `pi.sendMessage({customType: "branch-merge", content, display: true}, { deliverAs: "followUp" })` でメイン文脈に挿入
- `/tangents` — 保持中の branch 一覧を TUI 専用エントリで表示(appendEntry)

## 4. 要検証項目(実装時に最初に潰すこと)

1. **delegation API の対応範囲**: docsは「foreground leaf agent」と記載。**async起動とresumeがdelegation APIで可能か**を確認。不可なら代替: (a) `/rally`等の拡張コマンドから `pi.sendMessage` でメインに極小の指示を送る(Phase1と同等のメイン負荷)、(b) workflowScript(`runs.run` は resume 対応が明記済み)をdelegation経由で使う
2. **`/run` スラッシュコマンドの構文**: `/run branch[...] "task"` が resume/context を受けるか(受けるならPhase 2の大半が不要になる可能性)
3. **fork スナップショットのタイミング**: fork は起動時点の親文脈を写す。rally 中に親が進んでも子には反映されない(仕様として明記する)
4. **resume 保持数の上限**: retained children は直近10件。長寿命の branch 運用での挙動
5. **コスト**: fork = 親の全 prefix を子の各ターンで再送。Codex はキャッシュが効くが(ログの cacheRead で確認可能)、巨大セッションからの fork は1ターンあたりのトークンが大きい。`/tangent` 時に FleetView のトークン表示で監視
6. **handoff の受け渡し形式**: `output: handoff.md` のファイル経由か、構造化出力(delegation の `result.kind: "structured"`)か。Phase 2 では構造化出力が堅い

## 5. 非破壊性について

上記 `tools:` には bash / edit / write を含めない(output ファイルは output 機構が扱う)。
コードを書ける branch が欲しくなったら `tangent-rw.md` を別名で定義(tools に edit/write/bash を追加)し、
使い分ける。既定は非破壊版。

## 6. 実装ステップ

1. Phase 1: `agents/tangent.md` を dotagents に追加、bootstrap で `~/.pi/agent/agents/` へ配置(配置先ディレクトリは agents.md の「Custom agents」節で確認すること)。1日使って運用感を評価
2. 要検証項目 1〜2 を潰す(pi-subagents のソース読解含む)
3. Phase 2: `extensions/pi-tangent.ts` を実装。/branch → /rally → /merge の順で1コマンドずつ
4. Claude敵対レビュー(claude-adversarial-review / AskClaude)を通す
5. dotagents に載せて全マシン配布

## 7. 参考: 本設計の前提となった検証済み事実

- pi-subagents の scout は `tools: read, grep, find, ls, bash, write, intercom` で**厳密には非破壊ではない**(だからこそ branch.md を別定義する)
- ビルトインは `inheritSkills: false`(スキルを使わせたいので branch は true)
- 親の usage 集計・FleetView・Herdr メタデータは async 子に対して自動で機能することを確認済み
- `pi.sendMessage` の followUp 配送は「エージェントがアイドルになった後」に処理される(Pi本体 extensions.md)ため、走行中のメインを妨げない
