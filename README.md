# DopaCopa

Copilot の作業イベントを、パチンコ風の演出と効果音で眺める実験的な Canvas 拡張です。
A pachinko-inspired live Copilot Canvas with event-driven visual effects and sound.

## インストール

GitHub Copilot App **1.0.94-3 / macOS** で開発しています。拡張 SDK は実験的なため、別のバージョンや OS での動作は未確認です。

1. [Releases](https://github.com/07JP27/DopaCopa/releases) から `DopaCopa-v0.1.0.zip` と `SHA256SUMS` をダウンロードします。GitHub が自動生成する「Source code」ZIP ではなく、この配布用 ZIP を使ってください。
2. ダウンロード先で `shasum -a 256 -c SHA256SUMS` を実行し、ZIP のチェックサムを確認します。
3. ZIP を展開し、中の `copilot-arcade/` フォルダを `$COPILOT_HOME/extensions/copilot-arcade/` に配置します。`COPILOT_HOME` 未設定時は `~/.copilot/extensions/copilot-arcade/` です。既存の拡張がある場合はバックアップしてから置き換えてください。二重に `copilot-arcade/copilot-arcade/` を作らないようにします。
4. Copilot に「拡張機能を再読み込みして」と依頼します（`extensions_reload`）。続けて「DopaCopa を開いて」と依頼してください。

インストール後の配置:

```text
extensions/copilot-arcade/
  extension.mjs
  events.mjs
  stage.mjs
  renderer.html
  sounds/                 # 同梱の MP3 16 個
  LICENSE
  README.md
  THIRD_PARTY_NOTICES.md
```

別の開発サーバーや npm パッケージのインストールは不要です。`@github/copilot-sdk` は Copilot が提供します。表示名は DopaCopa ですが、Canvas ID・拡張フォルダ名・保存用名前空間は既存の `copilot-arcade` を維持しています。

## 何が表示されるか

現在の Copilot セッションで拡張に届く、読み取り・検索・編集・シェル・モデル・サブエージェント・コンパクション・権限要求・エラーなどのイベントを演出します。App 全体のイベントを特権的に取得する仕組みではなく、別セッションの作業は対象外です。

トークン合計は、受信した使用量イベントの **入力 + 出力** です。**RUSH** は、新しいユーザーメッセージ以降に受信したツール実行開始の回数です。音声のオン・オフと演出の停止・再開は Canvas 内のコントロールで切り替えられます。OS の「視差効果を減らす」設定にも対応します。自動再生が許可されない場合は、音声ボタンを押して再生を許可してください。

## ローカルデータとプライバシー

履歴はローカルに、セッションごとに保存されます。メッセージ本文・推論本文・コマンド引数は履歴に保持しませんが、ファイルパスやツール名は保存される場合があります。個人の履歴、セッション JSON、ログ、認証トークンはこのリポジトリや配布 ZIP に含めません。実行時の通信はループバック上で行い、認証トークンは実行時に生成します。

## ソースから確認・パッケージする

Node.js と Python 3 が必要です（検証環境: Node.js 22.23.1、Python 3.13.3）。外部依存パッケージの追加は不要です。

```sh
node --test events.test.mjs stage.test.mjs
node --check extension.mjs
node --check events.mjs
node --check stage.mjs
python3 scripts/package.py
```

配布対象を明示したスクリプトが `dist/DopaCopa-v0.1.0.zip` と `dist/SHA256SUMS` を生成します。ZIP は `copilot-arcade/` をトップレベルに持ち、テスト・スクリプト・履歴・ログ・Git 管理情報は含めません。ファイル順序・日時・権限を固定し、圧縮しないことで同じ入力から同じ ZIP を再生成できます。`dist/` は Git 管理対象外です。

## ライセンス

コードは [MIT License](LICENSE) です。**`sounds/*.mp3` は MIT の対象ではありません。** 効果音は効果音ラボの著作物で、アプリ内の操作・イベントのフィードバックとして同梱しています。音素材集としての抽出・再配布、AI 学習、Content ID 登録には使わないでください。利用条件と出典は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照してください。
