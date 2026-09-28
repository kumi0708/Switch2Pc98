# Switch2Pc98 — Brewser (Nintendo Switch) で PC-98「同級生」を動かす

[Brewser](https://github.com/natureglass/Brewser)(Switch 用 Web ランタイム)の上で
[pc98EmulatorWeb](https://github.com/kumi0708/pc98EmulatorWeb)(純 JavaScript の PC-9801 エミュレータ)を
動かし、elf「同級生」(1992, PC-98 版) をプレイするためのアプリです。

Brewser を知ったきっかけの記事(参考):
- Adafruit Blog: [Driving 512 LEDs from a Nintendo Switch: ESP32, WS2812 and a 240fps…](https://blog.adafruit.com/2026/09/13/driving-512-leds-from-a-nintendo-switch-esp32-ws2812-and-a-240fps/)

## ディレクトリ構成

```
Switch2Pc98/
├─ Brewser/            natureglass/Brewser のクローン(参照用。ビルド不要)
├─ pc98EmulatorWeb/    kumi0708/pc98EmulatorWeb のクローン(エミュレータ本体の元)
├─ Doukyusei/          同級生の FDI イメージ(元ファイル。リポジトリには非収録)
├─ src/                ← 編集するのはここ
│  ├─ index.template.html   HTML の骨組み(__STYLE__ / __SCRIPT__ を差し込む)
│  ├─ style.css
│  ├─ app.js               Switch 向け UI(ディスク交換・ゲームパッド・タッチ・診断ログ)
│  └─ js/                  pc98EmulatorWeb のエミュレータコア(video.js のみ CG ROM 対応パッチ)
├─ app/
│  └─ com.kumi0708.pc98doukyusei/   ← SD カードにコピーするアプリ(ビルド成果物)
│     ├─ index.html   src/ から生成した自己完結 HTML(CSS・JS 全部インライン)
│     ├─ manifest.json
│     ├─ cgrom.bin    事前レンダリング済みフォント ROM(ANK 8x16 + JIS X 0208 16x16)
│     ├─ disks/       disk_a.bin … disk_i.bin(FDI をリネームしたもの。非収録)
│     └─ assets/appbanner.jpg
├─ tools/
│  ├─ build_app.py     src/ → app/<id>/index.html にバンドル
│  ├─ gen_cgrom.py     MS ゴシックから cgrom.bin を生成(Windows + Pillow)
│  ├─ make_zip.sh      app/ を配布用 zip にまとめる
│  └─ disasm16.py      デバッグ用 16bit 逆アセンブラ(capstone)
└─ dist/               make_zip.sh の出力
```

`src/` を編集したら必ずビルドしてください:

```bash
python tools/build_app.py
```

## Switch へのインストール

1. Switch に Atmosphère + Brewser を導入しておく
   (`brewser.nro` を `sd:/switch/brewser.nro` に置く。Brewser の README 参照)。
2. `app/com.kumi0708.pc98doukyusei/` フォルダを **まるごと** SD カードの
   `sd:/switch/brewser/apps/` にコピーする。

   ```
   sd:/switch/brewser/apps/com.kumi0708.pc98doukyusei/manifest.json
   sd:/switch/brewser/apps/com.kumi0708.pc98doukyusei/index.html
   sd:/switch/brewser/apps/com.kumi0708.pc98doukyusei/disks/disk_a.bin
   ...
   ```

   フォルダ名は manifest の `id`(`com.kumi0708.pc98doukyusei`)と一致している必要があります。
3. Brewser を起動(hbmenu で R を押しながらゲームを起動するフルメモリモード推奨)し、
   Apps / Downloads(インストール済み)の一覧から「PC-98 同級生」を選んで起動。
4. 起動すると自動で FDD1 = ディスクA、FDD2 = ディスクB がセットされ、電源 ON 状態で始まります。

## 操作(Switch)

| 操作 | 動作 |
|---|---|
| L スティック | マウス移動(倒し具合で速度が変わる) |
| R スティック | マウス微調整(低速) |
| A | 左クリック |
| B | 右クリック |
| 十字キー ← / → | FDD2 のディスクを前 / 次に交換(A〜I をループ) |
| 十字キー ↑ / ↓ | FDD1 のディスクを前 / 次に交換 |
| Y | ソフトウェアキーボードの表示切替(タッチ操作用) |
| + | アプリ終了(Brewser 標準) |
| タッチ(携帯モード) | ドラッグでマウス移動、タップで左クリック、2 本指タップで右クリック。右側パネルのボタンもタッチで操作可 |

ゲーム中に「ドライブ2に DISK C をいれてください」などと表示されたら、十字キー ← → で
FDD2 に該当ディスクをセットしてからクリックしてください(画面左上にトーストで現在のディスクが出ます)。

マウスカーソルはゲーム側が描画する矢印だけを使います(Brewser のソフトウェアカーソルは
manifest の `hideMouseDocked / hideMouseUndocked` で非表示)。実機 PC-98 と同じ相対移動です。

## PC のブラウザで試す

```bash
python tools/build_app.py
python -m http.server 8765 --directory app/com.kumi0708.pc98doukyusei
```

`http://localhost:8765/` を開く(`file://` では fetch が使えないので不可)。
マウス・キーボード・(ブラウザが対応していれば)ゲームパッドで操作できます。
DevTools のコンソールに `[pc98]` で始まる起動ログが出ます。

## Brewser 向けに変更した点

Brewser は自前の HTML/CSS/DOM エンジンなので、普通のブラウザで動くものがそのまま動くとは
限りません。実機で動かすまでに必要だった変更は以下の通りです。

### 描画は WebGL でないと 1 フレームしか出ない(最大の落とし穴)

Brewser はページを「要素ツリーをベイクしたキャッシュ」から合成していて、
**キャンバスに描き込んでもこのキャッシュは無効化されません**。そのため Canvas 2D で
描くと、最初に合成された 1 フレームが画面に貼り付いたまま、以降の描画がすべて捨てられます
(`fullscreen-canvas` モードでも同じ、`__swbRepaint()` を毎フレーム呼んでも変わらず)。

一方 **WebGL は共有 GL ブリッジ FBO から毎フレーム画面へ直接コピー**されます
(`Brewser/src/browser-shell.ts` の `copyBridgeToScreen` 周辺)。そこで `Video` の
「画面に出す」部分を差し替え可能にし、合成済みの 640×400 をテクスチャとして
アップロードして四角形で描画するようにしました(`src/app.js` の presenter)。
Canvas 2D は WebGL が無い環境用のフォールバックとして残してあります。

### キャンバスのサイズは HTML 属性で宣言する

```html
<canvas id="screen" width="1280" height="720">   <!-- 画面と同サイズ -->
```

JS で `canvas.width = 1280` と代入しても、**読み出すと 1280 が返るのに GL ブリッジ側は
HTML 属性のサイズのまま**でした。結果、描いたサイズとコピーされるサイズが食い違い、
画像の一部だけが拡大表示されます。属性で宣言し、実行時に再代入しないこと。

この 2 点は、同じ SD に入っていた動作実績のあるエミュレータ(pcengine / saturn)が
どちらも守っていた形です。迷ったら動いているアプリの `index.html` を読むのが一番早いです。

### その他

- **単一 HTML**: 公式ドキュメントはアプリを「1 枚の自己完結 HTML」で書く前提で、
  カタログの公開アプリもすべてその形。外部 `.js` を 12 個読む構成は、クラシックスクリプト間で
  `class` 宣言のレキシカルスコープが共有されることに依存しており、ランタイムがそれを保証すると
  ドキュメントに書かれていないため、`tools/build_app.py` で CSS/JS をすべてインライン化する。
  (Emscripten 製アプリが動くのは、グローバルを `var` で置くため。`class` は共有されない。)
- **ボタンの衝突**: シェル既定では Y=リロード、A/B=クリック、十字上下=スクロールに
  割り当てられている。`manifest.json` の `buttonMapping` で空文字にして無効化する
  (`hideMouseDocked` / `hideMouseUndocked` でソフトカーソルも消し、ゲーム側の矢印だけにする)。
- **ディスク読み込み**: `<input type="file">` ではなく、アプリ内の `disks/*.bin` を `fetch` で読む
  (`fetch` が無い環境向けに XHR フォールバックあり)。リソースローダは拡張子ホワイトリスト制で
  `.fdi` は 404 になるため `.bin` にリネーム(ファイル名に空白・括弧・日本語も不可)。
- **フォント**: 元実装はブラウザの日本語フォント + `TextDecoder('shift_jis')` で漢字を動的
  ラスタライズしていたが、Switch 側にその保証がないので `tools/gen_cgrom.py` で MS ゴシックから
  `cgrom.bin` を事前生成し、`js/video.js` の `_getGlyph` が `Video.cgrom` を優先して参照する。
- **初回描画前に重い処理をしない**: シェルは「DOM 構築 → ページスクリプト実行 → 初回描画」の
  順なので、起動処理を同期的に済ませると静的な HTML すら出ないまま固まって見える。
  段階ごとにフレームを譲り、ボタン類は `innerHTML` 一括生成 + イベント委譲にする。
- **描画の差分化**: `Video.render` が毎フレーム 640×400 を 4 プレーンから合成し直して
  いたので、`_dirty` フラグで変化した時だけ描くようにした(ADV では約 83% のフレームを省略)。
- **入力**: Gamepad API で L/R スティック → バスマウス相対移動、A/B → ボタン。タッチ対応。
  クリックは「移動キューが空になってから押す」「最低 70ms 押し続ける」ようにして、
  ゲームの 120Hz マウス割り込みポーリングで取りこぼさないようにした。
  大きなポインタ移動は 1 回のラッチあたり ±100 に分割して流す(8bit カウンタ対策)。
- **rAF ウォッチドッグ**: requestAnimationFrame が止まった環境でもタイマーから
  エミュレーションループを回す。

## デバッグ

`src/app.js` 冒頭の `DEBUG` を `true` にしてビルドし直すと、起動時のテストパターン
(スライドするカラーバー)と、画面左上・パネル下部の計測表示が出ます。

```
vp 1280x720 / buf 1280x720 / img 1120x700 @0,10
51 FPS  8.57 MHz
94CE:167B P:422 R FS-app
```

| 表示 | 意味 |
|---|---|
| `vp` | ページが認識している画面サイズ |
| `buf` | WebGL の描画バッファ(`vp` と一致すべき) |
| `img` | ゲーム画像を描いている矩形(幅×高さ @x,y) |
| MHz | エミュレートしている実クロック(実機 PC-98 は 10MHz) |
| CS:IP | エミュレータの実行位置。変化しなければ無限ループ |
| `P:` | 実際にキャンバスへ描き込んだ回数 |

**カラーバーが動くかどうかが描画経路の判定**になります。静止画だと「一度だけ届いた」
ことしか分からず、まさにそれが Canvas 2D 時代の症状でした。

なお実機のリリースビルドでは `console.log` は出力されません。ドキュメントには
`console.error` はログファイルに残るとありますが、実際には
`sdmc:/switch/nxjs-debug.log` にも出ませんでした。**画面表示が唯一の確実な診断手段**です。

## 実機でうまく動かないとき

| 症状 | 意味 |
|---|---|
| ランチャーにアプリが出ない | `manifest.json` の読み込み失敗(`id` とフォルダ名の不一致など) |
| ランチャーのまま戻る / 何も起きない | ページ読み込み中に固まっている。`configs/history.jsonl` に URL が残っていれば遷移はしている |
| 右のパネルは出るが画面が黒い | HTML/CSS は OK。描画経路(上記 WebGL の項)を疑う |
| 画像の一部だけが拡大表示 | キャンバスの属性サイズとバッファサイズの食い違い |
| 赤字でエラーとスタックが出る | その内容が原因(起動ログも一緒に表示される) |
| カーソルが動かない | Gamepad の A/B がシェルに消費されている(`buttonMapping`) |

SD カード上の参考になるファイル:

```
sdmc:/switch/nxjs-debug.log                    シェルの起動ログ、ボタン割り当て
sdmc:/switch/brewser/configs/history.jsonl     実際に開いた URL
sdmc:/atmosphere/crash_reports/                ホームブリューのクラッシュ
```

## 再生成・パッケージ

```bash
# src/ → app/<id>/index.html(編集後は毎回必要)
python tools/build_app.py

# フォント ROM(Windows / MS ゴシック必須)
python tools/gen_cgrom.py app/com.kumi0708.pc98doukyusei/cgrom.bin

# 配布用 zip(dist/com.kumi0708.pc98doukyusei.zip)
bash tools/make_zip.sh
```

## 注意

- ゲームのディスクイメージ(`Doukyusei/`、`app/*/disks/*.bin`)はこのリポジトリに **含まれていません**。手持ちの FDI を `app/com.kumi0708.pc98doukyusei/disks/disk_a.bin` 〜 `disk_i.bin` の名前で置いてください([disks/README.md](app/com.kumi0708.pc98doukyusei/disks/README.md))。
- `Brewser/`、`pc98EmulatorWeb/` は上記 GitHub リポジトリを clone して置く想定です(参照用。ビルドには不要)。
- Brewser のカタログ公開(brewser.io)には著作物を含むため向きません。ローカルアプリとして使ってください。
