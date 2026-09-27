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

- **単一 HTML**: Brewser の公式ドキュメントはアプリを「1 枚の自己完結 HTML」で書く前提で、
  カタログの公開アプリもすべてその形。外部 `.js` を 12 個読む構成は、クラシックスクリプト間で
  `class` 宣言のグローバルレキシカルスコープが共有されることに依存していて、ランタイムが
  それを保証しているとはドキュメントに書かれていないため、`tools/build_app.py` で
  CSS/JS をすべて `index.html` にインライン化する。
- **ディスク読み込み**: `<input type="file">` ではなく、アプリ内の `disks/*.bin` を `fetch` で読む
  (`fetch` が無い環境向けに XHR フォールバックあり)。Brewser のリソースローダは拡張子
  ホワイトリスト制で `.fdi` は 404 になるため `.bin` にリネーム(ファイル名に空白・括弧・日本語も不可)。
- **フォント**: 元実装はブラウザの日本語フォント + `TextDecoder('shift_jis')` で漢字を動的ラスタライズしていたが、
  Switch 側にその保証がないので `tools/gen_cgrom.py` で MS ゴシックから `cgrom.bin` を事前生成し、
  `js/video.js` の `_getGlyph` が `Video.cgrom` を優先して参照するようにパッチ。
- **入力**: Gamepad API で L/R スティック → バスマウス相対移動、A/B → ボタン。タッチ対応。
  クリックは「移動キューが空になってから押す」「最低 70ms 押し続ける」ようにして、
  ゲームの 120Hz マウス割り込みポーリングで取りこぼさないようにした。
  大きなポインタ移動は 1 回のラッチあたり ±100 に分割して流す(8bit カウンタ対策)。
- **rAF ウォッチドッグ**: requestAnimationFrame が止まった場合はタイマーからエミュレーションループを回す。
- **レイアウト**: ビューポート追従(`position:fixed; inset:0`)。画面領域に 640×400 を
  アスペクト比維持でフィットさせ、右 160px にディスク交換パネル。
- **診断ログ**: リリースビルドの Brewser では `console.log` は出力されず `console.error` だけが
  ログファイルに残るので、起動の各段階を `console.error('[pc98] ...')` で記録し、
  例外時は画面にもスタックと起動ログを表示する。

## 実機でうまく動かないとき

画面に何も出ない場合、どこまで進んだかで切り分けられます。

| 症状 | 意味 |
|---|---|
| ランチャーにアプリが出ない | `manifest.json` の読み込み失敗(`id` とフォルダ名の不一致など) |
| 右側のパネルと「起動中...」が出る | HTML/CSS は OK。JS かリソース読み込みで失敗 |
| 赤字でエラーとスタックが出る | その内容が原因(起動ログも一緒に表示される) |
| 画面は出るがカーソルが動かない | Gamepad の A/B が Brewser 側に消費されている |

ログは SD カードの以下に出ます(`console.error` の `[pc98]` 行を探す):

```
sdmc:/switch/nxjs-debug.log
sdmc:/switch/brewser/logs/
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
