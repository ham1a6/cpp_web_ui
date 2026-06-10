# フロントエンド解説（HTML/JS 入門者向け）

> **対象**: C++ は書けるが HTML/CSS/JavaScript が初めての方  
> C++ との対比を使いながら説明します。

---

## 1. ブラウザとサーバーの役割分担

C++ で書いた `map_server` は HTTP サーバーです。ブラウザはクライアントです。

```
[ブラウザ]                      [map_server (C++)]
  |                                    |
  |--- GET /index.html --------------->|
  |<-- HTML テキスト ------------------|   ← 骨格
  |                                    |
  |--- GET /style.css ---------------->|
  |<-- CSS テキスト -------------------|   ← 見た目
  |                                    |
  |--- GET /app.js ------------------->|
  |<-- JavaScript テキスト ------------|   ← 動作
  |                                    |
  |--- GET /api/config --------------->|
  |<-- JSON {"max_zoom":13, ...} ------|   ← データ
  |                                    |
  |--- GET /events (SSE, 維持) ------->|
  |<-- data: [...シンボル...] ---------|   ← リアルタイム更新（繰り返し）
```

C++ で言えば:

| Web | C++ 相当 |
|---|---|
| HTML | データ構造の宣言 (`struct`) |
| CSS | データの表示フォーマット |
| JavaScript | 処理ロジック (`main()` + 関数群) |
| `fetch()` | `curl` / TCP ソケット通信 |
| SSE | `read()` を非同期で待ち続けるスレッド |

---

## 2. `index.html` — ページの骨格

メニューバー + 3 列構成です。

```
┌─ #menubar ──────────────────────────── Z14  ● SSE接続中 ─┐
├────────────┬──────────────────────────┬────────────────────┤
│  #vab      │         #map             │   #status-panel    │
│  (VAB)     │       (地図エリア)         │      220px         │
│  220px     │        flex: 1           │                    │
└────────────┴──────────────────────────┴────────────────────┘
```

`Z14` はメニューバー右端のズームレベル表示（`#menubar-zoom`）です。地図をズームするたびに更新されます。

```html
<!DOCTYPE html>              <!-- HTML5 文書であることを宣言 -->
<html lang="ja">
<head>
  <!-- ページ設定（画面に表示されない） -->
  <meta charset="UTF-8">                              <!-- 文字コード -->
  <meta name="viewport" content="width=device-width"> <!-- スマホ対応 -->
  <title>Map</title>                                   <!-- タブに出るタイトル -->

  <!-- CSS ファイルを読み込む（#include に相当） -->
  <link rel="stylesheet" href="lib/maplibre-gl.css"/>
  <link rel="stylesheet" href="style.css"/>
</head>
<body>

  <!-- 左: VAB (Variable Action Bar) ─ C++ のメソッドをボタンで呼ぶ -->
  <div id="vab">
    <h2>VAB</h2>

    <!-- setSymbol() の入力フォーム -->
    <section class="vab-section">
      <h3>setSymbol()</h3>
      <label class="vab-row">
        <span>label</span>
        <input id="vab-label" type="text" placeholder="Alpha" maxlength="31">
      </label>
      <label class="vab-row">
        <span>lat</span>
        <input id="vab-lat" type="number" step="0.001" value="35.690">
      </label>
      <label class="vab-row">
        <span>lon</span>
        <input id="vab-lon" type="number" step="0.001" value="139.692">
      </label>
      <label class="vab-row">
        <span>type</span>
        <select id="vab-type">
          <option value="friendly">friendly</option>
          <option value="enemy">enemy</option>
          <option value="neutral">neutral</option>
          <option value="unknown">unknown</option>
        </select>
      </label>
      <button class="vab-btn" id="vab-set-btn">setSymbol()</button>
    </section>

    <!-- removeSymbol() の入力フォーム -->
    <section class="vab-section">
      <h3>removeSymbol()</h3>
      <label class="vab-row">
        <span>label</span>
        <input id="vab-rm-label" type="text" placeholder="Alpha" maxlength="31">
      </label>
      <button class="vab-btn vab-btn-danger" id="vab-rm-btn">removeSymbol()</button>
    </section>

    <!-- clearSymbols() ボタン -->
    <section class="vab-section">
      <button class="vab-btn vab-btn-danger" id="vab-clear-btn">clearSymbols()</button>
    </section>

    <div id="vab-feedback"></div>   <!-- 操作結果（OK / Error）を表示 -->
  </div>

  <!-- 中央: 地図エリア（MapLibre GL JS がここを使う） -->
  <div id="map"></div>

  <!-- 右: ステータスパネル -->
  <div id="status-panel">
    <h2>Status</h2>
    <div id="status-bar">
      <span id="conn-indicator" class="dot disconnected"></span>
      <span id="conn-label">接続中...</span>
    </div>
    <div id="symbol-count">シンボル数: <strong id="count">0</strong></div>
    <ul id="symbol-list"></ul>     <!-- JS が動的にリストを追加する -->
  </div>

  <!-- JS ファイルを読み込む（body の最後で読むのが定番） -->
  <script src="lib/maplibre-gl.js"></script>  <!-- MapLibre GL JS ライブラリ（先に読む） -->
  <script src="app.js"></script>              <!-- 自作コード（後に読む） -->
</body>
</html>
```

### `<div>` と `id` について

`<div>` は「区切り」を意味するタグです（内容を持たない箱）。  
`id="map"` のように ID を付けると、JavaScript から `document.getElementById('map')` で取得できます。

```cpp
// C++ イメージ: id は変数名のようなもの
auto* map_div = document.getElementById("map");  // 要素を取得
```

### `<section>` と `<label>` について

`<section>` は関連する要素のグループを表すタグです。VAB では各メソッドのフォームを 1 つの section に入れています。

`<label>` は入力フィールドの説明文と対応する `<input>` をセットにします。ラベルをクリックすると対応する入力フィールドがフォーカスされます。

---

## 3. `style.css` — 見た目の定義

CSS は「どの要素をどう見せるか」を記述するルールファイルです。

```css
セレクタ {
  プロパティ: 値;
}
```

### セレクタの種類

```css
body   { ... }        /* タグ名: <body> 要素に適用 */
#map   { ... }        /* id: id="map" の要素に適用 */
.dot   { ... }        /* class: class="dot" の要素に適用 */
#sidebar h2 { ... }   /* 子孫: #sidebar の中の <h2> に適用 */
```

### レイアウト（Flexbox）

```css
body {
  display: flex;   /* 子要素を横並びにする */
  height: 100vh;   /* 画面の高さいっぱい (viewport height) */
}

/* 左・右パネルは固定幅 */
#vab, #status-panel {
  width: 220px;
  min-width: 220px;
}

/* 地図は残りの幅をすべて占有 */
#map {
  flex: 1;         /* 余ったスペースをすべて自分に割り当てる */
}
```

`display: flex` は「子要素を柔軟に配置するモード」です。  
`flex: 1` は「余ったスペースをすべて自分に割り当てる」という意味です。

レイアウトの全体像:

```
body (display: flex; flex-direction: column)
├── #menubar         (height: 30px; flex-shrink: 0)
└── #main            (display: flex; flex: 1)
    ├── #vab         (width: 220px)    ← 固定幅（リサイズ可）
    ├── .resize-handle                 ← ドラッグ境界線
    ├── #map         (flex: 1)         ← 残り全部
    ├── .resize-handle
    └── #status-panel (width: 220px)   ← 固定幅（リサイズ可）
```

### 接続状態インジケーター（丸いドット）

```css
.dot {
  width: 10px; height: 10px;
  border-radius: 50%;    /* 角を丸めて円にする（50% = 完全な円） */
}
.dot.connected    { background: #00ff88; box-shadow: 0 0 6px #00ff88; } /* 緑＋光 */
.dot.disconnected { background: #ff4444; }                              /* 赤 */
```

JavaScript から `dot.className = 'dot connected'` に書き換えると緑に変わります。

---

## 4. `app.js` — 処理ロジック

### 4-1. 厳格モード

```js
'use strict';
```

C++ の `-Wall -Wextra` に相当します。バグを引き起こしやすいあいまいな書き方をエラーにします。

---

### 4-2. 定数定義

```js
const TYPE_COLOR = {
  friendly: '#006fbd',
  enemy:    '#bd0000',
};
```

`const` は C++ の `const` と同じ（再代入不可）。  
`{ key: value }` はオブジェクト（C++ の `std::map<string, string>` に近い）。

```cpp
// C++ 相当
const std::map<std::string, std::string> TYPE_COLOR = {
    {"friendly", "#006fbd"},
    {"enemy",    "#bd0000"},
};
```

---

### 4-3. 非同期 IIFE（即時実行関数）

```js
(async () => {
  // 処理
})();
```

`()` で囲んで末尾に `()` を付けると「定義と同時に実行」します。  
`async` を付けると関数内で `await`（待機）が使えます。

```cpp
// C++ イメージ
int main() {
    // ここに相当
}
```

---

### 4-4. `fetch` — HTTP 通信

```js
const cfg = await fetch('/api/config')
  .then(r => r.json())
  .catch(() => DEFAULT_CONFIG);
```

`fetch()` はブラウザ組み込みの HTTP クライアントです。

```
fetch('/api/config')      → GET /api/config をサーバーに送る
.then(r => r.json())      → 応答ボディを JSON としてパース
.catch(() => DEFAULT_CONFIG) → 失敗したらフォールバック値を使う
```

`await` は「この処理が終わるまで次の行に進まない」という指示です。  
C++ のブロッキング `recv()` に相当しますが、スレッドをブロックせずに待てます。

`.then()` と `.catch()` は Promise のメソッドです。Promise は「将来値が届く約束」を表すオブジェクトです。

```cpp
// C++ イメージ（擬似コード）
auto response = http_get("/api/config");
MapConfig cfg;
if (response.ok())
    cfg = json_parse(response.body());
else
    cfg = DEFAULT_CONFIG;
```

---

### 4-5. DOM 操作 — HTML 要素の書き換え

DOM (Document Object Model) は「HTML をツリー構造で操作するための API」です。

```js
document.title = cfg.title;                   // <title> を書き換え
const h2 = document.querySelector('#sidebar h2');  // 要素を取得
if (h2) h2.textContent = cfg.title;           // テキスト内容を書き換え
```

| DOM 操作 | 意味 |
|---|---|
| `document.getElementById('count')` | `id="count"` の要素を取得 |
| `document.querySelector('#sidebar h2')` | CSS セレクタで要素を取得 |
| `element.textContent = '...'` | 要素のテキストを書き換える |
| `element.innerHTML = '<b>...</b>'` | 要素の HTML を書き換える |
| `element.className = 'dot connected'` | `class` 属性を書き換える |
| `document.createElement('li')` | 新しい要素を作る |
| `parent.appendChild(child)` | 子要素として追加する |
| `element.remove()` | 要素を削除する |

```cpp
// C++ イメージ: DOM 操作 ≒ 画面上のウィジェットのプロパティ変更
label->setText(cfg.title);      // Qt 風に例えると
```

---

### 4-6. MapLibre GL JS — 地図の操作

Leaflet と異なり、MapLibre GL JS は WebGL で描画する地図ライブラリです。  
座標系が **[経度, 緯度]（Leaflet の逆順）** なので注意してください。

```js
// MapLibre のスタイルオブジェクトで sources と layers を定義する
const map = new maplibregl.Map({
  container: 'map',          // <div id="map">
  style: { version: 8, sources, layers },
  center: [139.69, 35.69],   // [lon, lat] ← Leaflet と逆順!
  zoom:   cfg.zoom || 6,
  pitch:  45,                // 初期傾き（度）— 3D 地形が見やすい
  bearing: 0,                // 方位（北向き）
});

// ロード後に 3D 地形を有効化
let terrainEnabled = true;
function applyTerrain() {
  if (terrainEnabled && map.getPitch() >= 5) {
    map.setTerrain({ source: 'terrain-dem', exaggeration: 2.0 });
  } else {
    map.setTerrain(null);  // pitch < 5°では 2D 平面表示
  }
}
map.on('load', applyTerrain);
map.on('pitchend', applyTerrain);  // ドラッグで傾けるたびに自動切替
```

**2 層 + 地形の構成:**

| 層 / ソース | タイルURL | 用途 |
|---|---|---|
| ベース | `/tiles/{z}/{x}/{y}.png` | JAXA カラーレリーフ（地形把握） |
| オーバーレイ | `/overlay-tiles/{z}/{x}/{y}.png` | 建物・道路の輪郭 |
| terrain-dem | `/terrain-rgb/{z}/{x}/{y}.png` | 3D 地形メッシュ（Terrarium エンコード） |

**pitch とは何か:**

```
pitch = 0°  → 真上から見る（2D 地図と同じ見え方）
pitch = 45° → 斜め上から見る（3D 地形が立体的に見える）
pitch = 85° → 水平近く（建物の側面が見える）
```

pitch が 5° 未満のとき `setTerrain(null)` を呼んで地形を無効化します。  
これにより「真上から見たとき画像がゆがまない」を実現しています。

**マーカーの追加**

```js
// MapLibre のマーカー
const marker = new maplibregl.Marker({ element: iconElement })
  .setLngLat([139.69, 35.69])  // [lon, lat]
  .setPopup(new maplibregl.Popup().setHTML('<b>東京</b>'))
  .addTo(map);

marker.setLngLat([139.70, 35.70]);  // 座標を動かす
marker.remove();                    // 削除
```

---

### 4-7. `Map` と `Set` — JavaScript のコレクション

```js
const markers = new Map();   // label(文字列) → L.Marker のマッピング
const seen = new Set();      // 一意な文字列の集合
```

| JavaScript | C++ 相当 |
|---|---|
| `new Map()` | `std::unordered_map<K, V>` |
| `new Set()` | `std::unordered_set<T>` |
| `map.set(key, val)` | `map[key] = val` |
| `map.get(key)` | `map.at(key)` |
| `map.has(key)` | `map.count(key) > 0` |
| `map.delete(key)` | `map.erase(key)` |
| `set.add(val)` | `set.insert(val)` |
| `set.has(val)` | `set.count(val) > 0` |

---

### 4-8. アロー関数

```js
// 通常の関数
function add(a, b) { return a + b; }

// アロー関数（省略記法）
const add = (a, b) => a + b;
const add = (a, b) => { return a + b; };  // 複数行の場合
```

C++ のラムダ式 `[](int a, int b){ return a + b; }` に相当します。

---

### 4-9. テンプレートリテラル

```js
const label = 'Tokyo';
const lat = 35.69;

// 従来の文字列連結
'<b>' + label + '</b><br>' + lat.toFixed(5)

// テンプレートリテラル（バッククォート ` を使う）
`<b>${label}</b><br>${lat.toFixed(5)}`
```

C++ の `std::format("<b>{}</b><br>{:.5f}", label, lat)` に相当します。

---

### 4-10. `updateSymbols` — マーカーの差分更新

MapLibre GL JS のマーカーは `maplibregl.Marker` オブジェクト。  
座標の指定順が **[lon, lat]**（Leaflet の [lat, lon] と逆）なので注意。

```js
// markers: label → { marker: maplibregl.Marker, el: HTMLElement }
const markers = new Map();

function updateSymbols(symbols) {
  const seen = new Set();

  for (const sym of symbols) {
    seen.add(sym.label);

    if (markers.has(sym.label)) {
      // 既存マーカー → 座標とスタイルだけ更新
      const { marker, el } = markers.get(sym.label);
      marker.setLngLat([sym.lon, sym.lat]);  // ← [lon, lat] 順!
      el.className = `sym-icon ${sym.type}`; // CSS クラスで色を変える
      marker.getPopup().setHTML(popupHtml(sym));
    } else {
      // 新規マーカー → カスタム DOM 要素で作成
      const el = document.createElement('div');
      el.className = `sym-icon ${sym.type}`;
      el.textContent = sym.label.slice(0, 2).toUpperCase();  // イニシャル

      const popup = new maplibregl.Popup({ offset: 18 })
                      .setHTML(`<b>${sym.label}</b>`);
      const marker = new maplibregl.Marker({ element: el })
                       .setLngLat([sym.lon, sym.lat])  // ← [lon, lat] 順!
                       .setPopup(popup)
                       .addTo(map);
      markers.set(sym.label, { marker, el });
    }
  }

  // 受信リストにいないマーカー → 削除
  for (const [label, { marker }] of markers) {
    if (!seen.has(label)) { marker.remove(); markers.delete(label); }
  }
}
```

C++ STL で書くとこんなイメージです:

```cpp
void updateSymbols(const std::vector<Symbol>& symbols) {
    std::set<std::string> seen;
    for (const auto& sym : symbols) {
        seen.insert(sym.label);
        auto it = markers.find(sym.label);
        if (it != markers.end()) {
            it->second.marker.setLngLat(sym.lon, sym.lat);
        } else {
            markers[sym.label] = createMarker(sym.lon, sym.lat);
        }
    }
    for (auto it = markers.begin(); it != markers.end(); ) {
        if (!seen.count(it->first)) { it->second.marker.remove(); it = markers.erase(it); }
        else ++it;
    }
}
```

---

### 4-11. SSE（Server-Sent Events）接続

```js
function connect() {
  const es = new EventSource('/events');  // SSE 接続を開始

  es.onopen = () => setConnected(true);   // 接続成功時のコールバック

  es.onmessage = (e) => {                 // データ受信時のコールバック
    updateSymbols(JSON.parse(e.data));    // JSON → JS オブジェクト → 地図更新
  };

  es.onerror = () => {                    // 切断時のコールバック
    setConnected(false);
    es.close();
    setTimeout(connect, 3000);            // 3000ms 後に connect() を再呼び出し
  };
}
```

C++ の視点で説明すると:

```
EventSource('/events') を作る
  = TCP 接続を開き、GET /events を送り、コネクションを維持する

es.onmessage = コールバック
  = C++ では別スレッドで recv() ループ → データ来たら関数呼び出し

setTimeout(connect, 3000)
  = usleep(3000000) してから connect() を呼ぶ（ただしノンブロッキング）
```

C++ サーバー側では `SseBroker::broadcast()` が呼ばれるたびに、  
接続中のすべてのブラウザの `es.onmessage` が発火します。

---

### 4-12. `JSON.parse` / `JSON.stringify`

```js
// JSON 文字列 → JS オブジェクト（C++ の nlohmann::json::parse() に相当）
const obj = JSON.parse('{"lat":35.69,"lon":139.69}');
console.log(obj.lat);  // 35.69

// JS オブジェクト → JSON 文字列（C++ の json.dump() に相当）
const str = JSON.stringify(obj);  // '{"lat":35.69,"lon":139.69}'
```

---

### 4-13. VAB — `apiCall()` ヘルパーとボタン

VAB（Variable Action Bar）は、ブラウザから C++ の `MapServer` メソッドを呼び出すためのパネルです。  
各ボタンが `fetch()` で REST API を叩き、C++ 側のメソッドが実行されます。

```
VAB ボタン           REST API              C++ メソッド
─────────────────────────────────────────────────────
setSymbol()    →  POST /api/symbols       →  MapServer::setSymbol()
removeSymbol() →  DELETE /api/symbols/:label → MapServer::removeSymbol()
clearSymbols() →  DELETE /api/symbols     →  MapServer::clearSymbols()
カスタム       →  POST /api/<任意のパス>   →  addRoute() で登録したラムダ
```

**カスタムエンドポイントの追加（C++ 側）**

`MapServer::addRoute()` を使うと、独自の POST エンドポイントを追加して任意の C++ ロジックを実行できます。

```cpp
// start() を呼ぶ前に登録する
server.addRoute("/api/alert", [&server](const std::string& /*body*/) {
    server.setSymbol("ALERT", 35.69, 139.69, "enemy");
    return std::string(R"({"ok": true, "msg": "alert activated"})");
});
```

**カスタムボタンの追加（ブラウザ側）**

HTML にボタンを追加し、JS で `apiCall()` を呼ぶだけです。

```html
<!-- index.html の VAB に追加 -->
<button class="vab-btn vab-btn-danger" id="alert-btn">アラート発令</button>
```

```js
// app.js に追加
document.getElementById('alert-btn').addEventListener('click', () => {
    apiCall('POST', '/api/alert');   // ボディなし
});
```

これで「ボタンクリック → JS が `fetch(POST /api/alert)` → C++ のラムダが実行される」という流れが完成します。

---

### 4-14. 4×4 カスタムボタングリッド

VAB の下部に B01〜B16 の 16 個のボタンが並んでいます。押すと `POST /api/btn/{n}` が送られます。

**JS 側 — ボタンを生成する**

```js
const grid = document.getElementById('btn-grid');
for (let n = 1; n <= 16; n++) {
  const btn = document.createElement('button');
  btn.className   = 'grid-btn';
  btn.textContent = `B${String(n).padStart(2, '0')}`;  // "B01", "B02", ...
  btn.addEventListener('click', () => apiCall('POST', `/api/btn/${n}`));
  grid.appendChild(btn);
}
```

`document.createElement('button')` で JS からボタン要素を動的に作り、  
`parent.appendChild(child)` でグリッドに追加しています。

`String(n).padStart(2, '0')` は C++ の `std::format("{:02d}", n)` に相当します。

**CSS 側 — 正方形グリッドを作る**

```css
#btn-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr); /* 4 列。各列の幅を均等分割 */
  gap: 4px;
}

.grid-btn {
  aspect-ratio: 1;   /* 幅と高さを同じにして正方形にする */
  font-family: monospace;
}
```

`display: grid` は Flexbox の兄弟格のレイアウトモードです。  
`repeat(4, 1fr)` は「4 列、それぞれ 1 等分 (fraction)」という意味です。

**C++ 側 — 処理を割り当てる**

```cpp
for (int n = 1; n <= 16; ++n) {
    server.addRoute("/api/btn/" + std::to_string(n),
                    [n](const std::string& /*body*/) {
        std::printf("B%02d pressed\n", n);
        return std::string(R"({"ok": true})");
    });
}
server.start();
```

登録しないボタンを押しても 404 が返るだけで、サーバーはクラッシュしません。

**`apiCall()` ヘルパー関数**

```js
async function apiCall(method, url, body) {
  try {
    const res = await fetch(url, {
      method,                                          // "POST" / "DELETE"
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body:    body ? JSON.stringify(body) : undefined, // JS オブジェクト → JSON 文字列
    });
    showFeedback(res.ok ? `OK ${method} ${url}` : `Error ${res.status}`, res.ok);
  } catch (e) {
    showFeedback(String(e), false);                    // ネットワークエラー
  }
}
```

- `method`: HTTP メソッド文字列 (`"POST"`, `"DELETE"`)
- `body`: 送るデータ。`undefined` のとき `fetch()` はボディなしのリクエストを送る
- `res.ok`: HTTP ステータスが 200–299 なら `true`

```cpp
// C++ イメージ（疑似コード）
void apiCall(const string& method, const string& url, const json& body) {
    auto res = http_client.request(method, url, body.dump());
    showFeedback(res.status_code == 200 ? "OK" : "Error", res.ok());
}
```

**`showFeedback()` — 操作結果の表示**

```js
function showFeedback(msg, ok) {
  feedback.textContent = msg;
  feedback.className   = ok ? 'ok' : 'err';  // CSS クラスで色を切り替え
  clearTimeout(feedback._t);
  feedback._t = setTimeout(() => {           // 3 秒後に消す
    feedback.textContent = '';
    feedback.className   = '';
  }, 3000);
}
```

`setTimeout(fn, ms)` は「ms ミリ秒後に fn を呼ぶ」非同期タイマーです。  
`clearTimeout()` で前回のタイマーをキャンセルして上書きしています。

**ボタンハンドラ**

```js
// setSymbol() ボタン
document.getElementById('vab-set-btn').addEventListener('click', () => {
  const label = document.getElementById('vab-label').value.trim();  // 前後の空白を除去
  const lat   = parseFloat(document.getElementById('vab-lat').value);
  const lon   = parseFloat(document.getElementById('vab-lon').value);
  const type  = document.getElementById('vab-type').value;

  if (!label) { showFeedback('label is required', false); return; }

  // POST /api/symbols に JSON ボディを送る
  apiCall('POST', '/api/symbols', { label, lat, lon, type });
  //                               ↑ { label: label, lat: lat, ... } の省略記法
});

// removeSymbol() ボタン
document.getElementById('vab-rm-btn').addEventListener('click', () => {
  const label = document.getElementById('vab-rm-label').value.trim();
  if (!label) { showFeedback('label is required', false); return; }

  // DELETE /api/symbols/Alpha — URL にラベルを埋め込む
  // encodeURIComponent() で特殊文字（スペース等）をエスケープ
  apiCall('DELETE', `/api/symbols/${encodeURIComponent(label)}`);
});

// clearSymbols() ボタン
document.getElementById('vab-clear-btn').addEventListener('click', () => {
  apiCall('DELETE', '/api/symbols');  // ボディなし
});
```

`parseFloat()` は文字列を浮動小数点数に変換します。C++ の `std::stod()` に相当します。  
`encodeURIComponent('Hello World')` → `'Hello%20World'`（URL に安全な形式に変換）。

---

## 5. データの流れ（全体まとめ）

```
C++ (MapServer)                    ブラウザ (app.js)
─────────────────────────────────────────────────────
起動時:
  detectMaxNativeZoom()
  → cfg.max_native_zoom = 12
                           ──── GET /api/config ────►
                           ◄─── {"max_zoom":12,...} ─
                                new maplibregl.Map({...})
                                map.on('load', applyTerrain)

SSE 接続:
                           ──── GET /events ─────────►  (接続維持)
                           ◄─── data: [] ─────────── 初回スナップショット

VAB からシンボルを追加（ブラウザ → C++）:
                           ──── POST /api/symbols ──►
                                body: {"label":"Alpha","lat":35.69,...}
  symbols["Alpha"] = {...}
  sse.broadcast(json_array)
                           ◄─── data: [{"label":"Alpha",...}]
                                es.onmessage → updateSymbols()
                                  → new maplibregl.Marker(...).setLngLat([139.69, 35.69])

C++ プロセスが setSymbol() 呼び出し:
  symbols["Tokyo"] = {...}
  sse.broadcast(json_array)
                           ◄─── data: [{"label":"Tokyo",...}]
                                es.onmessage → updateSymbols()
                                  → marker.setLngLat([139.69, 35.69])

SHM 経由（shm_writer プロセス）:
  shm_ptr->symbols[0] = {...}
  shm_ptr->version++
  ↓ 100ms ポーリング
  pollShm() で変化を検知
  symbols 更新 → broadcast()
                           ◄─── data: [{"label":"Sapporo",...}, ...]
                                updateSymbols() → マーカー追加/移動/削除
```

---

## 6. よく使う JavaScript の概念チートシート

### 変数宣言

| 宣言 | 再代入 | スコープ | C++ 相当 |
|---|---|---|---|
| `const` | 不可 | ブロック | `const` |
| `let` | 可 | ブロック | 通常変数 |
| `var` | 可 | 関数 | （使わない） |

### 型

JavaScript は動的型付けです（実行時に型が決まる）。

```js
typeof 42          // "number"
typeof "hello"     // "string"
typeof true        // "boolean"
typeof null        // "object"  ← 歴史的バグ
typeof undefined   // "undefined"
typeof {}          // "object"
typeof []          // "object"  ← 配列もオブジェクト
```

### null チェック

```js
if (h2) h2.textContent = '...';   // null/undefined のとき falsy
if (h2 != null) ...               // 明示的チェック
h2?.textContent                   // オプショナルチェーン（null なら undefined）
```

### 配列操作

```js
const arr = [1, 2, 3];
arr.push(4);                       // 末尾追加
arr.filter(x => x > 1);           // [2, 3]
arr.map(x => x * 2);              // [2, 4, 6]
arr.sort((a, b) => a - b);        // ソート（破壊的）
[...arr]                           // コピー（スプレッド構文）
```

### イベントリスナー

```js
element.addEventListener('click', () => {
  // クリックされたときの処理
});
```

C++ の Qt シグナル/スロットやコールバック登録に相当します。

---

### 4-15. レーダー覆域（3D Viewshed）

VAB の Radar セクションから、指定した地点のレーダー探知可能領域（覆域）を 3D メッシュで表示できます。

**全体の流れ**

```
ブラウザ (app.js)                        C++ (MapServer)              Python
───────────────────────────────────────────────────────────────────────────
POST /api/viewshed  ──────────────────►  runPython()
{lat, lon, ...}                          ↓
                                         python3 compute_viewshed.py
                                         ← stdin: パラメータ JSON
                                         → stdout: メッシュ JSON
◄──────────────────────────────────────  {vertices, triangles, meta}
new RadarCoverageLayer(id, mesh, color)
map.addLayer(layer)
```

**`compute_viewshed.py` — レイトレーシングの仕組み**

```
レーダー位置 (lat0, lon0, h_asl0)
  │
  ├── Az 0° ─ 360°（az_step_deg 刻み）
  │     └── El el_min° ─ el_max°（el_step_deg 刻み）
  │           └── trace_ray(): 地平線まで ray を飛ばす
  │                 h_ray = h0 + r·sin(el) − r²/(2·R_eff)
  │                              └─ 大気屈折補正（実効地球半径 R_eff = 4/3·R_earth）
  │                 地形タイル(Terrarium)で標高を取得
  │                 地形より ray が低くなったら打ち切り → terrain_hit
  └── (n_az × n_el) の格子点 → 三角形メッシュ化（外表面のみ）
```

**大気屈折補正の意味**

平坦な大地でも電波は地表に沿って曲がる（標準大気でほぼ 4/3 倍に見える）。  
`R_eff = (4/3) × 6,371km ≈ 8,493km` を使うことで、実際の探知距離に近い値が得られます。

```python
R_EFF = R_EARTH * 4.0 / 3.0   # 8493000 m
h_ray = h0 + r * sin(el) - r**2 / (2 * R_EFF)
```

C++ の物理計算で言えば「等価地球半径モデル」の実装です。

**`RadarCoverageLayer` — WebGL カスタムレイヤー**

MapLibre GL JS の `CustomLayerInterface` を実装したクラスです。  
C++ の「純粋仮想関数を持つ基底クラスを継承する」感覚に相当します。

```js
class RadarCoverageLayer {
  constructor(id, meshData, color) {
    this.id   = id;
    this.type = 'custom';
    this.renderingMode = '3d';   // MapLibre に 3D レイヤーだと伝える
  }

  onAdd(map, gl) {
    // シェーダーをコンパイル
    // 頂点を MercatorCoordinate に変換して VBO に格納
    // インデックスを IBO に格納
  }

  render(gl, matrix) {
    // drawElements(TRIANGLES, ...) で描画
  }
}
```

**MercatorCoordinate — 3D 描画用の座標変換**

```js
const mc = maplibregl.MercatorCoordinate.fromLngLat([lon, lat], altMeters);
// mc.x, mc.y, mc.z が WebGL の model 座標系に対応
```

MapLibre は内部で Mercator 座標（0〜1 の正規化）を使います。  
高度は `altInMeters` を指定すると自動でスケール変換されます。

**メッシュの構造（開いたシェル + シャドウゾーン除去）**

```
n_az 方位 × n_el 仰角 の格子点をすべて頂点にする。
隣接する格子点を 2 つの三角形（クワッド）で繋ぐ。
閉じた面（頂点に向かうファン、底面、上面）は作らない。

地形シャドウ境界クワッドはスキップ:
  - クワッドの4頂点に「地形ヒット（短距離）」と「最大射程到達」が混在し
  - かつ最大距離 / 最小距離 > 1.5 の場合は三角形を生成しない
  → 山の影になる領域にメッシュを張らないのでシャドウゾーンが可視化される
```

この処理がないと覆域メッシュが山越しに「回り込み」、地形で見えないはずの
領域（山頂など）が覆域内に含まれて見えてしまう。

**レイマーチの精度パラメータ**

| パラメータ | デフォルト | 説明 |
|---|---|---|
| `ray_step_m` | 500 m | 1 ステップの距離。小さいほど精度高・計算遅 |
| `az_step` | 2° | 方位角ステップ |
| `el_step` | 1° | 仰角ステップ |

`ray_step_m=500m` は地形タイル zoom=12 の解像度（約156m/pixel）に対して適切な値。
狭い尾根（幅 1km 未満）を 1000m ステップで飛び越えていたバグを修正。

**複数レーダーの表示**

```js
const radarLayers = new Map();   // layerId → { layer, color }
const RADAR_COLORS = ['#00ffff', '#ff8800', ...];  // 最大 6 色

function addRadar(params) {
  const res  = await apiCall('POST', '/api/viewshed', params);
  const lid  = `radar-${Date.now()}`;
  const color = RADAR_COLORS[radarLayers.size % RADAR_COLORS.length];
  const layer = new RadarCoverageLayer(lid, res, color);
  map.addLayer(layer);
  radarLayers.set(lid, { layer, color });
}

function removeRadar(lid) {
  map.removeLayer(lid);
  radarLayers.delete(lid);
}
```

各レーダーは独立した WebGL レイヤーとして追加されます。  
`Date.now()` をレイヤー ID に使うことで一意性を保証しています。
