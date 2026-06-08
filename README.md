# cpp_web_ui

C++ アプリケーションにブラウザ表示の地図UIを埋め込むライブラリです。  
POSIX 共有メモリ (SHM) または直接API経由でシンボル（移動体）を登録すると、ブラウザ上の地図にリアルタイムで反映されます。

```
┌──────────────────────┐  POSIX SHM or        ┌──────────────────────┐
│  Your C++ Process    │  direct API call      │     MapServer        │
│                      │ ─────────────────────►│  (HTTP :9000)        │
│  server.setSymbol(…) │                       │                      │
│                      │                       │  /api/config  (JSON) │
└──────────────────────┘                       │  /api/positions      │
                                               │  /events  (SSE)      │
                                               │  /tiles/…  (PNG)     │
                                               └──────────┬───────────┘
                                                          │ HTTP / SSE
                                                          ▼
                                               ┌──────────────────────┐
                                               │  Browser             │
                                               │  Leaflet.js + JAXA   │
                                               │  elevation tiles     │
                                               └──────────────────────┘
```

---

## 目次

1. [特徴](#特徴)
2. [クイックスタート](#クイックスタート)
3. [ビルド](#ビルド)
4. [ライブラリとして使う](#ライブラリとして使う)
5. [API リファレンス](#api-リファレンス)
6. [HTTP エンドポイント](#http-エンドポイント)
7. [POSIX 共有メモリ プロトコル](#posix-共有メモリ-プロトコル)
8. [タイルデータ](#タイルデータ)
9. [フロントエンド](#フロントエンド)
10. [依存ライブラリとライセンス](#依存ライブラリとライセンス)
11. [ディレクトリ構成](#ディレクトリ構成)

---

## 特徴

- **ゼロ依存の埋め込み地図** — ヘッダオンリーの httplib / nlohmann-json を同梱。外部サービス不要でオフライン動作可能
- **2 種類のデータ注入**
  - **in-process**: `MapServer::setSymbol()` を呼ぶだけ（SHM・別プロセス不要）
  - **out-of-process**: `ShmPublisher` で POSIX SHM に書き込み → `map_server` が自動検知
- **サーバー送信イベント (SSE)** によるリアルタイム配信 — ポーリング不要、接続直後に現在状態を即送信
- **C++ から地図を完全制御** — 初期中心座標・ズーム・タイルURL・タイトルをコードで設定
- **CMake ネイティブ** — `add_subdirectory` / `FetchContent` / `find_package` のいずれでも統合可能

---

## クイックスタート

```bash
# ビルド
cmake -S . -B build && cmake --build build -j

# ターミナル 1: HTTP サーバー起動
./build/map_server
# → http://localhost:9000 が開く

# ターミナル 2: シンボルを5Hzで書き込む (デモ)
./build/shm_writer
```

ブラウザで `http://localhost:9000` を開くと、日本全国を移動するシンボルが表示されます。

---

## ビルド

### 要件

| ツール / OS | バージョン |
|---|---|
| C++ コンパイラ | C++20 対応 (GCC 10+, Clang 14+) |
| CMake | 3.20 以上 |
| OS | Linux (POSIX SHM / `rt` ライブラリが必要) |

### ビルド手順

```bash
cmake -S . -B build
cmake --build build -j$(nproc)
```

生成物:

| ファイル | 内容 |
|---|---|
| `build/libcpp_web_ui.a` | スタティックライブラリ本体 |
| `build/map_server` | スタンドアロン HTTP サーバー実行ファイル |
| `build/shm_writer` | SHM 書き込みデモ |

### オプション

```bash
# examples/ もビルドする
cmake -S . -B build -DCPP_WEB_UI_BUILD_EXAMPLES=ON
cmake --build build -j
```

### インストール

```bash
cmake --install build --prefix /usr/local
```

インストール先:

```
/usr/local/lib/libcpp_web_ui.a
/usr/local/include/cpp_web_ui/MapServer.hpp
/usr/local/include/cpp_web_ui/ShmPublisher.hpp
/usr/local/include/shared_types.h
/usr/local/share/cpp_web_ui/web/       ← Web アセット (HTML / JS / タイル)
/usr/local/lib/cmake/cpp_web_ui/       ← find_package サポートファイル
/usr/local/bin/map_server
/usr/local/bin/shm_writer
```

---

## ライブラリとして使う

### パターン A — add_subdirectory

```cmake
add_subdirectory(third_party/cpp_web_ui)
target_link_libraries(my_app PRIVATE cpp_web_ui::cpp_web_ui)
```

### パターン B — FetchContent

```cmake
include(FetchContent)
FetchContent_Declare(cpp_web_ui
    GIT_REPOSITORY https://github.com/your-org/cpp_web_ui
    GIT_TAG        main
)
FetchContent_MakeAvailable(cpp_web_ui)
target_link_libraries(my_app PRIVATE cpp_web_ui::cpp_web_ui)
```

### パターン C — find_package (インストール済みの場合)

```cmake
find_package(cpp_web_ui 1.0 REQUIRED)
target_link_libraries(my_app PRIVATE cpp_web_ui::cpp_web_ui)
```

### 最小サンプル

```cpp
#include <cpp_web_ui/MapServer.hpp>
#include <thread>
#include <chrono>

int main() {
    cpp_web_ui::MapConfig cfg;
    cfg.port         = 9000;
    cfg.title        = "My Tracker";
    cfg.center_lat   = 35.690;
    cfg.center_lon   = 139.692;
    cfg.initial_zoom = 10;

    cpp_web_ui::MapServer server(cfg);
    server.start();

    // シンボルの追加・更新 — 即座にブラウザへ SSE 配信される
    double lat = 35.690, lon = 139.692;
    while (true) {
        server.setSymbol("Alpha", lat, lon, "friendly");
        lat += 0.001;
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
    }
}
```

### 別プロセスから SHM 経由で書き込む場合

```cpp
#include <cpp_web_ui/ShmPublisher.hpp>

int main() {
    cpp_web_ui::ShmPublisher pub;   // デフォルト SHM 名: /map_positions
    pub.open();

    pub.setSymbol("Drone-1", 35.69, 139.69, "friendly");
    pub.setSymbol("Drone-2", 34.69, 135.50, "neutral");
    pub.removeSymbol("Drone-2");
}
```

別ターミナルで `map_server` (または `shm_name` を設定した `MapServer`) を起動しておけば、書き込みは即座にブラウザへ反映されます。

---

## API リファレンス

### `MapConfig` 構造体

`#include <cpp_web_ui/MapServer.hpp>`

| フィールド | 型 | デフォルト | 説明 |
|---|---|---|---|
| `port` | `int` | `9000` | HTTP サーバーのポート番号 |
| `web_root` | `string` | `""` | `web/` ディレクトリのパス。空の場合は実行ファイルの位置から自動検出、または環境変数 `$CPP_WEB_UI_WEB_ROOT` を使用 |
| `shm_name` | `string` | `""` | 監視する POSIX SHM セグメント名 (例: `"/map_positions"`)。空の場合は SHM ポーリング無効 |
| `center_lat` | `double` | `36.0` | 地図の初期中心緯度 |
| `center_lon` | `double` | `137.5` | 地図の初期中心経度 |
| `initial_zoom` | `int` | `6` | 地図の初期ズームレベル |
| `tile_url` | `string` | `"/tiles/{z}/{x}/{y}.png"` | Leaflet タイル URL テンプレート |
| `tile_attribution` | `string` | `"Elevation: © JAXA AW3D30"` | 地図の著作権表示 |
| `min_zoom` | `int` | `5` | 最小ズームレベル |
| `max_zoom` | `int` | `11` | 最大ズームレベル (UI 操作上限) |
| `max_native_zoom` | `int` | `10` | タイルが実在する最大ズームレベル。`max_zoom` を超えた場合このレベルのタイルを拡大表示 |
| `title` | `string` | `"Map"` | ページタイトルとサイドバー見出し |

**外部タイルサーバーを使う例:**

```cpp
cfg.tile_url        = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
cfg.tile_attribution = "© <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a>";
cfg.min_zoom        = 3;
cfg.max_zoom        = 19;
cfg.max_native_zoom = 19;
```

---

### `MapServer` クラス

`#include <cpp_web_ui/MapServer.hpp>`

#### コンストラクタ / デストラクタ

```cpp
explicit MapServer(MapConfig config = {});
~MapServer();  // stop() を自動呼び出し
```

#### ライフサイクル

```cpp
void start();   // バックグラウンドスレッドで HTTP サーバーを開始
                // すでに起動中の場合 std::runtime_error を送出
void stop();    // サーバー停止 + スレッド join (デストラクタからも呼ばれる)
void wait();    // サーバースレッドが終了するまでブロック (CLI binary 向け)
bool isRunning() const;
int  port() const;
```

#### シンボル操作 (スレッドセーフ)

```cpp
// シンボルを追加または更新。type は "friendly" / "enemy" / "neutral" / "unknown"
void setSymbol(const std::string& label, double lat, double lon,
               const std::string& type = "unknown");

// シンボルを削除
void removeSymbol(const std::string& label);

// 全シンボルを削除
void clearSymbols();
```

すべての操作は内部 mutex で保護され、変更直後に全 SSE クライアントへブロードキャストされます。

#### カスタム POST エンドポイント

```cpp
// ブラウザのボタン（または curl）から呼べる POST エンドポイントを追加する。
// start() を呼ぶ前に登録すること。
using PostHandler = std::function<std::string(const std::string& body_json)>;
void addRoute(const std::string& path, PostHandler handler);
```

`handler` は **リクエストボディ (JSON 文字列)** を受け取り、**レスポンス JSON 文字列** を返します。  
ハンドラ内から `setSymbol()` など他のメソッドを呼び出せます。

```cpp
// 例: /api/alert に POST が来たらシンボルを追加
server.addRoute("/api/alert", [&server](const std::string& /*body*/) {
    server.setSymbol("ALERT", 35.69, 139.69, "enemy");
    return std::string(R"({"ok": true})");
});

// ブラウザ側から呼ぶ
// fetch('/api/alert', { method: 'POST' });

// curl から呼ぶ
// curl -X POST http://localhost:9000/api/alert
```

---

### `ShmPublisher` クラス

`#include <cpp_web_ui/ShmPublisher.hpp>`

別プロセスから `map_server` (または `shm_name` を設定した `MapServer`) に位置データを供給するためのクラスです。

```cpp
explicit ShmPublisher(const std::string& shm_name = "/map_positions");
~ShmPublisher();   // close() を自動呼び出し

bool open();       // SHM セグメントを作成 / 開く。失敗時 false を返す
void close();
bool isOpen() const;

// シンボルを追加・更新して SHM に即時書き込み
void setSymbol(const std::string& label, double lat, double lon,
               const std::string& type = "unknown");

// シンボルを削除して SHM に即時書き込み
void removeSymbol(const std::string& label);

// 全シンボルを削除して SHM に即時書き込み
void clearSymbols();
```

> **Note**: `ShmPublisher` はプロセスローカルの `std::map` を正とし、書き込みのたびに SHM 全体を上書きします。  
> MAX_SYMBOLS (64) を超えた分は無視されます。

---

## HTTP エンドポイント

| Method | パス | 説明 |
|---|---|---|
| `GET` | `/` | `index.html` にリダイレクト |
| `GET` | `/api/config` | `MapConfig` の地図設定を JSON で返す。`app.js` が起動時に取得 |
| `GET` | `/api/positions` | 現在のシンボル一覧を JSON 配列で返す (一発取得用) |
| `GET` | `/events` | Server-Sent Events ストリーム。シンボル変更のたびに全量をプッシュ |
| `POST` | `/api/symbols` | `setSymbol(label, lat, lon, type)` を呼び出す。ボディ: `{"label":"Alpha","lat":35.69,"lon":139.69,"type":"friendly"}` |
| `DELETE` | `/api/symbols` | `clearSymbols()` を呼び出す（全削除） |
| `DELETE` | `/api/symbols/:label` | `removeSymbol(label)` を呼び出す |
| `GET` | `/tiles/{z}/{x}/{y}.png` | タイル PNG。`Cache-Control: public, max-age=300` + ETag |
| `GET` | `/<その他>` | `web/` 以下の静的ファイルを返す。`Cache-Control: no-store`（常に最新版を配信） |

### `/api/config` レスポンス例

```json
{
  "center": [35.69, 139.7],
  "zoom": 14,
  "tile_url": "/tiles/{z}/{x}/{y}.png",
  "attribution": "Elevation: © JAXA AW3D30",
  "min_zoom": 5,
  "max_zoom": 18,
  "max_native_zoom": 13,
  "overlay_url": "https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png",
  "overlay_attribution": "国土地理院",
  "overlay_opacity": 0.75,
  "title": "Map"
}
```

### `/api/positions` / SSE データ形式

```json
[
  {"lat": 43.065, "lon": 141.358, "label": "Sapporo",  "type": "friendly"},
  {"lat": 35.693, "lon": 139.695, "label": "Tokyo",    "type": "friendly"},
  {"lat": 34.698, "lon": 135.507, "label": "Osaka",    "type": "enemy"}
]
```

`/events` は `text/event-stream` で同じ JSON 配列を `data:` フィールドとして配信します。

```
data: [{"lat":43.065,"lon":141.358,"label":"Sapporo","type":"friendly"},...]

data: [...]
```

接続直後に現在の全シンボルを即送信します。

---

## POSIX 共有メモリ プロトコル

SHM セグメント名はデフォルト `/map_positions`。`MapConfig::shm_name` または `ShmPublisher` のコンストラクタ引数で変更できます。

### データ構造 (`include/shared_types.h`)

```cpp
constexpr int MAX_SYMBOLS = 64;

struct Symbol {
    double  lat;        // 緯度
    double  lon;        // 経度
    char    label[32];  // シンボル識別子 (NUL 終端)
    char    type[16];   // "friendly" / "enemy" / "neutral" / "unknown"
    int     active;     // 1 = 有効エントリ
};

struct SharedMapData {
    uint32_t version;           // 書き込みのたびにインクリメント
    uint32_t count;             // 有効シンボル数
    Symbol   symbols[MAX_SYMBOLS];
};
// sizeof(SharedMapData) == 4360 bytes
```

### 動作フロー

1. **書き込み側** (`ShmPublisher` または任意のプロセス) が `SharedMapData` を更新し `version` をインクリメント
2. **`MapServer`** のポーラースレッドが 100ms 毎に `version` を確認
3. 変更を検知したら SHM を `memcpy` でローカルコピーし、内部シンボルテーブルを更新
4. 差分（追加・更新・削除）を計算し、全 SSE クライアントへブロードキャスト

### 生の SHM を直接操作する場合

`ShmPublisher` を使わず生ポインタで操作するプロセスは、`SharedMapData::version` のインクリメントを忘れると `MapServer` が変更を検知しないので注意してください。

---

## タイルデータ

### 概要

`web/tiles/` 以下に JAXA AW3D30 (30m メッシュ数値標高モデル) から生成した陰影起伏図タイルを収録しています。  
タイル形式は **XYZ / Slippy map** (Web Mercator / EPSG:3857)。

### 収録範囲・枚数

| ズームレベル | タイル数 | サイズ | 地理的範囲 (概算) |
|---|---|---|---|
| 5 | 20 | 416 KB | 112.5°E–157.5°E / 11°N–56°N |
| 6 | 48 | 1.5 MB | 118°E–152°E / 17°N–52°N |
| 7 | 168 | 5.9 MB | 118°E–152°E / 19°N–50°N |
| 8 | 616 | 24 MB | 120°E–150°E / 19°N–50°N |
| 9 | 2,376 | 95 MB | 120°E–150°E / 20°N–50°N |
| 10 | 9,202 | 389 MB | 120°E–150°E / 20°N–50°N |
| **合計** | **12,430** | **514 MB** | |

> **注意**: ズームレベル 5 のみ遠隔離島（東端 ~157°E）まで広くカバーしています。ズーム 6 以上では日本本土・近海を中心とした範囲になります。

### 元データ (JAXA AW3D30)

```
map/
  N020E120_N025E125/   ← 5°×5° ブロック (32 ブロック、計 1,170 GeoTIFF ファイル)
  N020E125_N025E130/
  ...
  N045E145_N050E150/
    ALPSMLC30_N0xxEyyy_DSM.tif   ← 数値標高モデル (1°×1°)
    ALPSMLC30_N0xxEyyy_MSK.tif   ← マスク
    ALPSMLC30_N0xxEyyy_STK.tif   ← スタック
```

元データはJAXA地球観測研究センターから取得: https://www.eorc.jaxa.jp/ALOS/en/alos-3/a3_dataset.htm

### ズームレベルと解像度

| ズームレベル | 地上分解能 (35°N) | 備考 |
|---|---|---|
| 5–10 | ~125 m/px | 既存タイル (OSM から取得) |
| 11 | ~63 m/px | JAXA ネイティブに接近 |
| **12** | **~31 m/px** | **← JAXA AW3D30 ネイティブ解像度** |
| 13–14 | <16 m/px | センサー以上 (Leaflet が zoom 12 タイルを拡大表示) |

`max_native_zoom` は **サーバー起動時に `web/tiles/` を走査して自動検出**されます。  
zoom 11-12 タイルを生成して `map_server` を再起動すると `/api/config` の `max_native_zoom` が自動的に更新されます。

### zoom 11-12 タイル生成

```bash
# 必要パッケージ (Ubuntu/Debian)
sudo apt install gdal-bin python3-gdal python3-numpy

# 生成計画を確認 (実行なし)
python3 scripts/generate_tiles.py --dry-run

# zoom 11 のみ (~1.5 GB, ~30 分)
cmake --build build --target generate_tiles_11
# または直接:
python3 scripts/generate_tiles.py 11 11

# zoom 11-12 (~8 GB, ~2 時間)
cmake --build build --target generate_tiles_12
# または直接:
python3 scripts/generate_tiles.py 11 12

# 生成後: サーバーを再起動すると max_native_zoom が自動更新
./build/map_server
# → cpp_web_ui: tiles detected max_native_zoom=12  max_zoom=14
```

スクリプトは既存タイルを削除しません (`--resume`)。  
zoom 5-10 の既存タイルをそのまま保持しつつ zoom 11-12 を追加します。

### 生成パイプライン

GDAL による全 Japan シームレス陰影起伏タイルの生成手順:

```
DSM (1°×1° GeoTIFF × 390)
  └─ gdalbuildvrt      → merged_dsm.vrt  (VRT: データコピーなし)
  └─ gdal_calc.py      → masked_dsm.tif  (MSK bit 0x03 → nodata -9999)
  └─ gdaldem hillshade → hillshade.tif   (陰影起伏, z=1.5, az=315, alt=45)
  └─ gdaldem color-relief → color_relief.tif (scripts/color_table.txt)
  └─ gdal_calc.py      → blend_b{1,2,3}.tif (C × √(H/255), 海域はフラット)
  └─ gdalbuildvrt -separate → shaded_relief.vrt (RGB 結合)
  └─ gdal2tiles.py --xyz --resume → web/tiles/{z}/{x}/{y}.png
```

### OSM タイルのダウンロード (代替)

ローカルタイルの代わりに OpenStreetMap タイルを使う場合:

```bash
# カバレッジ確認 (dry-run)
python3 scripts/download_tiles.py --dry-run

# 実ダウンロード (OSM タイル使用ポリシーを遵守してください)
python3 scripts/download_tiles.py
```

スクリプトのデフォルト設定:

| パラメータ | 値 |
|---|---|
| バウンディングボックス | 20°N–46°N / 122°E–155°E (南鳥島を含む日本全域) |
| ズームレベル | 5–10 |
| タイルサーバー | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` |

---

## フロントエンド

### 画面レイアウト

メニューバー + 3 カラム構成です。

```
┌─ View ▾ ─ Symbols ▾ ─────────────────── Z14  ● SSE接続中 ─┐
├────────────┬──────────────────────────┬────────────────────┤
│   VAB      │          Map             │      Status        │
│  (220px)   │        (flex:1)          │      (220px)       │
│            │  JAXA 陰影起伏            │  ● SSE接続中       │
│ setSymbol  │  + 国土地理院 淡色地図    │  15 symbols        │
│ removeSymbol│  (オーバーレイ 75%)     │  [シンボルテーブル] │
│ clearSymbols│                         │                    │
│ [B01〜B16] │                          │                    │
└────────────┴──────────────────────────┴────────────────────┘
```

- **メニューバー右端**: 現在のズームレベル (`Z14` 等) と SSE 接続状態を常時表示
- **View メニュー**: VAB / Status の表示切替、オーバーレイ透過度スライダー
- **パネル境界**: ドラッグでリサイズ可能 (120px〜480px)

### 構成

```
web/
  index.html      ← 3 カラムレイアウト (VAB | Map | Status)
  app.js          ← Leaflet 初期化 + SSE クライアント + VAB ハンドラ
  style.css       ← Flexbox レイアウト・シンボルスタイル
  lib/
    leaflet.js    ← Leaflet 1.9.4 (バンドル)
    leaflet.css
  tiles/          ← ローカルタイル PNG
```

### 起動フロー

```
index.html 読み込み
    └─ app.js 実行 (async IIFE)
           ├─ GET /api/config         ← MapConfig の地図設定を取得
           ├─ L.map().setView(…)      ← 地図を初期化
           ├─ L.tileLayer(…).addTo()  ← タイルレイヤーを追加
           ├─ VAB ボタンイベント登録  ← POST/DELETE /api/symbols
           └─ connect()
                └─ new EventSource('/events')
                       ├─ onopen    → "SSE 接続中" 表示
                       ├─ onmessage → シンボルを地図に反映
                       └─ onerror   → 3 秒後に再接続
```

### VAB（Variable Action Bar）

左パネルから直接 C++ API メソッドを呼び出せます。

| VAB ボタン | 呼び出す REST API | C++ メソッド相当 |
|---|---|---|
| `setSymbol()` | `POST /api/symbols` | `MapServer::setSymbol()` |
| `removeSymbol()` | `DELETE /api/symbols/:label` | `MapServer::removeSymbol()` |
| `clearSymbols()` | `DELETE /api/symbols` | `MapServer::clearSymbols()` |
| B01〜B16 グリッド | `POST /api/btn/1`〜`POST /api/btn/16` | `addRoute()` で登録したラムダ |

グリッドボタンへの処理割り当て:

```cpp
// C++ 側で addRoute() を登録するだけ
server.addRoute("/api/btn/1", [](const std::string& /*body*/) {
    std::printf("B01 pressed!\n");
    return std::string(R"({"ok": true})");
});

// ループでまとめて登録することもできる
for (int n = 1; n <= 16; ++n) {
    server.addRoute("/api/btn/" + std::to_string(n),
                    [n](const std::string& /*body*/) {
        std::printf("B%02d pressed\n", n);
        return std::string(R"({"ok": true})");
    });
}
```

### シンボル種別とスタイル

| `type` | 色 | 用途例 |
|---|---|---|
| `friendly` | 青 `#006fbd` | 味方 |
| `enemy` | 赤 `#bd0000` | 敵 |
| `neutral` | 黄 `#9a8000` | 中立 |
| `unknown` | 灰 `#555555` | 不明 |

シンボルは `label` 先頭 2 文字のイニシャルを円形アイコンで表示します。

### ステータスパネル

- 接続状態インジケーター（SSE 接続中 / 再接続中）
- シンボル総数カウント
- シンボルリスト（アルファベット順）— クリックでズーム & ポップアップ

---

## 依存ライブラリとライセンス

### ランタイム依存（バイナリに組み込まれるもの）

| ライブラリ | バージョン | ライセンス | 形式 | 著作権者 |
|---|---|---|---|---|
| [cpp-httplib](https://github.com/yhirose/cpp-httplib) | 0.46.1 | MIT | ヘッダオンリー (`third_party/httplib.h`) | Yuji Hirose |
| [nlohmann/json](https://github.com/nlohmann/json) | 3.12.0 | MIT | ヘッダオンリー (`third_party/json.hpp`) | Niels Lohmann |
| [Leaflet.js](https://leafletjs.com/) | 1.9.4 | BSD-2-Clause | バンドル (`web/lib/`) | Vladimir Agafonkin, CloudMade |

システムライブラリ（リンク時依存）:

| ライブラリ | 用途 | ライセンス |
|---|---|---|
| `librt` | POSIX SHM (`shm_open`, `mmap`) | LGPL-2.1 (glibc) |
| `libpthread` | スレッド | LGPL-2.1 (glibc) |

### ビルドツール（バイナリには含まれない）

| ツール | 用途 | ライセンス |
|---|---|---|
| [GDAL](https://gdal.org/) | `scripts/generate_tiles.py` によるタイル生成 | MIT/X |
| Python 3 + numpy | 同上 | PSF / BSD |

### データ

| データ | ライセンス |
|---|---|
| [JAXA AW3D30 v4.1](https://www.eorc.jaxa.jp/ALOS/en/alos-3/a3_dataset.htm) | [JAXA データポリシー](https://earth.jaxa.jp/en/data/policy/) — 研究・商用利用無償、帰属表示必須、生データの再配布不可 |

---

### 著作権表示

#### cpp-httplib

```
Copyright (c) 2026 Yuji Hirose. All rights reserved.
MIT License
```

#### nlohmann/json

```
SPDX-FileCopyrightText: 2013-2026 Niels Lohmann <https://nlohmann.me>
SPDX-License-Identifier: MIT
```

#### Leaflet.js

```
Copyright (c) 2010-2023 Vladimir Agafonkin
Copyright (c) 2010-2011 CloudMade
BSD 2-Clause License
```

---

### ライセンス全文

#### MIT License（cpp-httplib・nlohmann/json 共通）

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

#### BSD 2-Clause License（Leaflet.js）

```
Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
```

---

## ディレクトリ構成

```
cpp_web_ui/
├── include/
│   ├── cpp_web_ui/
│   │   ├── MapServer.hpp      ← 公開 API: MapConfig / MapServer
│   │   └── ShmPublisher.hpp   ← 公開 API: ShmPublisher
│   └── shared_types.h         ← SHM レイアウト定義 (SharedMapData / Symbol)
├── src/
│   ├── MapServer.cpp          ← HTTP サーバー + SSE ブローカー実装
│   ├── ShmPublisher.cpp       ← SHM 書き込み実装
│   ├── map_server.cpp         ← スタンドアロンバイナリの main()
│   └── shm_writer.cpp         ← デモ: 15 シンボルを 5Hz で更新
├── examples/
│   └── simple_usage.cpp       ← 最小利用例
├── third_party/
│   ├── httplib.h              ← cpp-httplib v0.46.1
│   └── json.hpp               ← nlohmann/json v3.12.0
├── web/
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   ├── lib/                   ← Leaflet 1.9.4
│   └── tiles/                 ← タイル PNG (zoom 5-10 既存, 11-12 は generate_tiles.py で生成)
├── map/                       ← 元の GeoTIFF 標高データ (32 ブロック)
├── scripts/
│   ├── generate_tiles.py      ← JAXA GeoTIFF → PNG タイル生成 (zoom 11-12)
│   ├── download_tiles.py      ← OSM タイルダウンロードスクリプト (zoom 5-10)
│   ├── build_japan_tiles.sh   ← bash 版タイル全量生成スクリプト
│   └── color_table.txt        ← gdaldem color-relief カラーランプ
├── cmake/
│   └── cpp_web_ui-config.cmake.in
└── CMakeLists.txt
```
