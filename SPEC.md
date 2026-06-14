# cpp_web_ui — 設計仕様書

C++ アプリケーションにブラウザ表示の 3D 地図 UI を埋め込む静的ライブラリ。

```
C++ プロセス
  MapServer::setSymbol()  ─┐
  ShmPublisher            ─┘→  MapServer (HTTP :9000)  →  ブラウザ (MapLibre GL JS)
```

---

## 公開 API (`include/`)

### `shared_types.h` — SHM バイナリレイアウト（両側で一致必須）

```c
constexpr const char* SHM_NAME = "/map_positions";
constexpr int MAX_SYMBOLS = 64;

struct Symbol {
    double lat, lon;
    char   label[32];
    char   type[16];   // "friendly" | "enemy" | "neutral" | "unknown"
    int    active;
};

struct SharedMapData {
    uint32_t version;  // 書き込みごとにインクリメント
    uint32_t count;
    Symbol   symbols[MAX_SYMBOLS];
};
```

### `MapServer` / `MapConfig`

`MapConfig` のフィールド（デフォルト値）:
- `port = 9000`
- `web_root` — 空 = 自動検出（`$CPP_WEB_UI_WEB_ROOT` → `/proc/self/exe` 隣の `web/` → install prefix）
- `shm_name` — 空 = SHM ポーリングなし
- `center_lat = 36.0`、`center_lon = 137.5`、`initial_zoom = 6`
- `tile_url = "/tiles/{z}/{x}/{y}.png"`、`tile_attribution = "Elevation: © JAXA AW3D30"`
- `min_zoom = 5`、`max_native_zoom = -1`（-1 = tiles/ を走査して自動検出、未検出時は 10）、`max_zoom = -1`（-1 = max_native_zoom に同じ）
- `overlay_url`、`overlay_attribution`、`overlay_opacity = 0.5`（http(s):// を指定するとコンストラクタ内で `/overlay-tiles/{z}/{x}/{y}` に書き換えてサーバーサイドプロキシ化）
- `title = "Map"`

`MapServer` のメソッド: `start()`、`stop()`、`wait()`、`isRunning()`、`port()`、`setSymbol(label, lat, lon, type="unknown")`、`removeSymbol(label)`、`clearSymbols()`、`addRoute(path, handler)` — すべてスレッドセーフ。`addRoute` は `start()` より前に呼ぶこと。pImpl パターンで実装する。

### `ShmPublisher`

`ShmPublisher(shm_name="/map_positions")` — `open()` で `shm_open(O_CREAT|O_RDWR)` + `ftruncate` + `mmap`。`setSymbol/removeSymbol/clearSymbols` は内部の `local` map を更新してから即 `flush()`。pImpl パターンで実装する。

---

## HTTP エンドポイント

| Method | Path | 説明 |
|--------|------|------|
| GET | `/api/config` | MapConfig を JSON で返す（`Cache-Control: no-cache`） |
| GET | `/api/positions` | シンボル全量を JSON 配列で返す |
| GET | `/events` | SSE ストリーム。**接続直後に現在のスナップショットを即送信**し、以後変更のたびに送信 |
| POST | `/api/symbols` | `{label, lat, lon, type}` でシンボル追加。label は 1〜31 文字 |
| DELETE | `/api/symbols` | 全シンボル削除 |
| DELETE | `/api/symbols/:label` | 指定ラベル削除 |
| POST | `/api/viewshed` | **通常モード**: `{lat, lon, height_agl, range_km, az_min, az_max, el_min, el_max, [az_step, el_step, ray_step_m]}` → `{vertices, triangles, meta:{n_vertices, n_triangles, n_az, n_el, full_circle}}` を返す。**`section_only: true` を追加すると断面図モード**: `{lat, lon, height_agl, range_km, az_min, az_max, el_min, el_max, [az_deg, ray_step_m]}` → `{section:{az_deg, radar_alt_m, range_km[], terrain_m[], min_vis_m[], max_cov_m[]}}` を返す（3D メッシュ計算なし・高速） |
| GET | `/overlay-tiles/{z}/{x}/{y}` | overlay_upstream が有効な場合のみ登録。優先順: ディスクキャッシュ → メモリキャッシュ（上限 2000 枚、超過で全消去）→ 上流フェッチ → 両キャッシュに保存 |
| GET | `/*` | 静的ファイル配信。`/tiles/` は `Cache-Control: public, max-age=300` + ETag。それ以外は `no-store` |

---

## 実装上の非自明な制約

### スレッドモデルとロック順序

- `server_thread`: httplib スレッドプール（最大 64）で HTTP を処理
- `shm_thread`: 100ms ごとに `pollShm()` を呼ぶ（`shm_name` が設定された場合のみ）
- **ロック取得順は必ず `sym_mu` → `sse.mu`**（逆順でデッドロック）
- `setSymbol/removeSymbol/clearSymbols` はすべて `sym_mu` 取得 → `broadcastSnapshot()` の順

### SHM ポーリング（`pollShm`）

- `memcpy` でローカルにコピーしてから処理（書き込み途中の読み取りを防止）
- `version` が前回と同じなら何もしない
- `shm_labels` で SHM 由来のラベルだけを管理し、`in-process API` で追加したシンボルを誤って削除しない
- `flush()` では全シンボルを書き込んだ後に `version++`（最後にインクリメントで変化通知）

### オーバーレイプロキシ

- `overlay_url` が `http`/`https` で始まる場合、**コンストラクタ内**で `/overlay-tiles/{z}/{x}/{y}` に書き換える
- `/api/config` が返す `overlay_url` はすでに書き換え済み（ブラウザは localhost しか知らない）

### `web_root` 自動検出順

1. `$CPP_WEB_UI_WEB_ROOT` 環境変数
2. `/proc/self/exe` の `../web`、`../../web`、`web/`
3. `CPP_WEB_UI_INSTALL_PREFIX/share/cpp_web_ui/web/`（CMake コンパイル定義）

---

## フロントエンドの非自明な仕様

### MapLibre の座標系

- MapLibre は `[lon, lat]` 順（Leaflet の `[lat, lon]` と逆）
- `map.center = [cfg.center_lon, cfg.center_lat]`

### Terrain-RGB（Terrarium エンコード）

- `elevation_m = R*256 + G + B/256 - 32768`
- MapLibre のソース定義に `encoding: 'terrarium'` を指定

### 3D 地形の自動 ON/OFF

- `pitch < 5°`（`TERRAIN_PITCH_THRESHOLD`）のとき `map.setTerrain(null)` — 真上から見るとパース歪みが発生するため
- `pitchend` イベントで再評価

### RadarCoverageLayer（WebGL カスタムレイヤー）

- `maplibregl.CustomLayerInterface` を実装（`type: 'custom'`、`renderingMode: '3d'`）
- 頂点を `maplibregl.MercatorCoordinate.fromLngLat([lon, lat], alt_m)` でメルカトル座標に変換して VBO に格納
- インデックスバッファは `Uint32Array`（65535 頂点超に対応するため `gl.UNSIGNED_INT`）
- `render()` で `gl.disable(CULL_FACE)` — 覆域内部からも見えるように裏面も描画
- `gl.depthMask(false)` + ブレンディングで半透明描画し、最後に `map.triggerRepaint()`
- **2 パス描画**: パス 1 = `gl.TRIANGLES`（塗りつぶし、alpha 0.35）、パス 2 = `gl.LINES`（エッジライン、alpha 0.90）。エッジラインは `onAdd()` で `_edgeIbo` を構築:
  - 上端エッジ (`j = n_el-1`): 全方位角のループ
  - 下端エッジ (`j = 0`): 全方位角のループ
  - 側面エッジ（`full_circle` でない場合のみ）: az=0 と az=n_az-1 の全仰角ライン
  横から見たときも覆域の輪郭が明確に見えるようにする

### オーバーレイ UI の動的追加

- `cfg.overlay_url` が存在する場合のみ View メニューに「表示切替」ボタンと「透過度スライダー」を動的追加

### GSI ベクタータイルオーバーレイ

- ソース: `optimal_bvmap-v1` PBF タイル、`maxzoom: 17`
- グリフ: `https://gsi-cyberjapan.github.io/gsimaps-vector-stylefiles/noto-font/pbfonts/{fontstack}/{range}.pbf`（漢字注記に NotoSansCJKjp-Regular）
- レイヤー一覧（`layers.push` 順、ベースより上・ラベルが最上位）:

| レイヤー ID | source-layer | タイプ | 用途 |
|---|---|---|---|
| `gsi-water` | `WA` | fill | 水域（河川・湖沼） |
| `gsi-building` | `BldA` | fill | 建築物輪郭（minzoom 13） |
| `gsi-road` | `RdEdg` | line | 道路縁 |
| `gsi-adm` | `AdmBdry` | line | 行政区画界（破線） |
| `gsi-rail` | `RailCL` | line | 鉄道中心線 |
| `gsi-label` | `Anno` | symbol | 地名注記（漢字） |

- `GSI_LAYERS` 配列で一括管理し、「GSI地図」トグルで `visibility: visible/none` を切り替え
- `type: 'fill'` を使って建物輪郭を描画する（`type: 'line'` では overzoom 時にタイル境界でクリッピングが発生するため）

### 地形陰影（ヒルシェード）

- ソース: `terrain-dem`（MapLibre `raster-dem`、ALOS Terrain-RGB タイル）
- レイヤー: `type: 'hillshade'`、`illumination-anchor: 'viewport'`（視点方向に連動）
- `hillshade-exaggeration: 0.45`（デフォルト）— View メニューの強度スライダーで動的変更
- `raster-resampling: 'nearest'` をベースレイヤーに設定（遠距離でのぼかしを防ぐ）

### 断面図フローティングウィンドウ

- DOM 要素: `#section-float`（`position: fixed`、デフォルト 400×340px、最小 280×230px）
- 8 方向リサイズ: `.sf-rz[data-dir=n/ne/e/se/s/sw/w/nw]` — `mousedown` → `mousemove` でウィンドウ座標と寸法をリアルタイム更新、`min` クランプあり
- Canvas バッファ管理: `ResizeObserver` が CSS サイズ変化を検知 → `sfResync()` がバッファを更新して `drawSection()` を再実行（`sfLastSection` にキャッシュ）
- `sfFetch()`: `POST /api/viewshed` に `section_only: true` と `az_deg` を含む全パラメータを送信。`az_min/az_max/el_min/el_max` は C++ バリデーション通過用に必須で送るが Python 側の断面図モードでは無視される
- `drawSection(canvas, sec)`: Canvas 2D API でグリッド・陰影ゾーン（暗赤）・覆域上限（シアン）・地形断面（茶色）・レーダー点を描画。軸ラベルは `_niceStep()` で「きりのよい」目盛り間隔を自動計算

### SSE 再接続

- `es.onerror` で `es.close()` → `setTimeout(connect, 3000)` でリトライ

---

## `compute_viewshed.py` の I/O 仕様

C++ から `python3 scripts/compute_viewshed.py < tmp_in > tmp_out` として呼ばれる。

**依存**: `numpy`、`python3-gdal`

**地形データ**: `web/terrain-rgb/{z}/{x}/{y}.png`（zoom=12、Terrarium エンコード）

**物理モデル**:
- 実効地球半径: `R_eff = (4/3) * 6,371,000 m`（標準大気屈折）
- 距離 r での光線高度: `h = h0 + r*sin(el) - r² / (2*R_eff)`

### 通常モード（3D メッシュ）

`section_only` が指定されない（または `false`）場合。

**アルゴリズム**: 各 `(az, el)` 方向にレイマーチング。地形と交差した点または最大射程点がレイ端点。全端点でサーフェスメッシュを構築。

**出力フォーマット**:
```json
{
  "vertices":  [[lon, lat, alt_m], ...],
  "triangles": [[i, j, k], ...],
  "meta": {
    "n_vertices": int, "n_triangles": int,
    "n_az": int, "n_el": int, "full_circle": bool
  }
}
```

`meta.n_az / n_el / full_circle` は `RadarCoverageLayer` がエッジラインのインデックスバッファ（`_edgeIbo`）を構築するために使用する。

### 断面図モード（`section_only: true`）

3D メッシュを計算しない軽量モード。`compute_section()` 関数を呼ぶ。

**アルゴリズム（水平線角スキャン）**:
各射程ステップで地形の仰角 `el_ter` を計算し、これまでの最大水平線角 `max_el_hor` と比較する。
- `el_ter > max_el_hor`: 直視可能 → `min_vis = ter`、`max_el_hor` を更新
- それ以外: 陰影ゾーン → `min_vis = max(ter, h_hor)` ただし `h_hor = h0 + r*sin(max_el_hor) - r²/(2*R_eff)`

**出力フォーマット**:
```json
{
  "section": {
    "az_deg":      float,
    "radar_alt_m": float,
    "range_km":    [float, ...],
    "terrain_m":   [float, ...],
    "min_vis_m":   [float, ...],
    "max_cov_m":   [float, ...]
  }
}
```

| フィールド | 説明 |
|---|---|
| `terrain_m` | 各射程の地形標高 (m ASL) |
| `min_vis_m` | 直視可能な最低高度（陰影ゾーンでは地平線延長線） |
| `max_cov_m` | `el_max` ビームの上端高度（覆域上限） |

---

## ビルドシステム要点

- C++20、STATIC ライブラリ、alias `cpp_web_ui::cpp_web_ui`
- リンク: `Threads`、`rt`（SHM 用）、OpenSSL（任意、HTTPS プロキシ有効化）
- PUBLIC インクルード: `include/`、`third_party/`（httplib.h、json.hpp を同梱）
- `CPP_WEB_UI_INSTALL_PREFIX` をコンパイル定義として埋め込み（`web_root` 自動検出に使用）
- オプション `CPP_WEB_UI_BUILD_EXAMPLES=OFF`

---

## サードパーティ

| ライブラリ | 格納場所 |
|-----------|---------|
| [cpp-httplib](https://github.com/yhirose/cpp-httplib) v0.14+ | `third_party/httplib.h` |
| [nlohmann/json](https://github.com/nlohmann/json) v3.11+ | `third_party/json.hpp` |
| [MapLibre GL JS](https://maplibre.org/) v4.x | `web/lib/maplibre-gl.{js,css}` |
