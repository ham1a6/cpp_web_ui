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

画面は 3 列構成です。

```
┌────────────┬──────────────────────────┬────────────┐
│  #vab      │         #map             │ #status-   │
│  (VAB)     │       (地図エリア)         │  panel     │
│  220px     │        flex: 1           │  220px     │
└────────────┴──────────────────────────┴────────────┘
```

```html
<!DOCTYPE html>              <!-- HTML5 文書であることを宣言 -->
<html lang="ja">
<head>
  <!-- ページ設定（画面に表示されない） -->
  <meta charset="UTF-8">                              <!-- 文字コード -->
  <meta name="viewport" content="width=device-width"> <!-- スマホ対応 -->
  <title>Map</title>                                   <!-- タブに出るタイトル -->

  <!-- CSS ファイルを読み込む（#include に相当） -->
  <link rel="stylesheet" href="lib/leaflet.css"/>
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

  <!-- 中央: 地図エリア（Leaflet がここを使う） -->
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
  <script src="lib/leaflet.js"></script>   <!-- Leaflet ライブラリ（先に読む） -->
  <script src="app.js"></script>           <!-- 自作コード（後に読む） -->
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

3 カラムの配置イメージ:

```
body (display: flex)
├── #vab         (width: 220px)    ← 固定幅
├── #map         (flex: 1)         ← 残り全部
└── #status-panel (width: 220px)   ← 固定幅
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

### 4-6. Leaflet — 地図の操作

```js
// 地図を <div id="map"> に作成し、中心座標とズームを設定
const map = L.map('map', {
  preferCanvas: true,   // マーカーを Canvas で描画（大量マーカーで高速）
}).setView([36.0, 137.5], 6);

// タイル画像レイヤーを追加
L.tileLayer('/tiles/{z}/{x}/{y}.png', {
  maxZoom:       13,    // これ以上ズームできない
  maxNativeZoom: 13,    // この解像度のタイルが存在する上限
  keepBuffer:    2,     // 画面外 2 タイル分を事前に読み込む
}).addTo(map);
```

`{z}/{x}/{y}` はズーム・列・行に自動置換されます。  
例: ズーム 6 の日本中央付近 → `/tiles/6/57/25.png`

**マーカーの追加**

```js
const marker = L.marker([35.69, 139.69], { icon: myIcon })
  .bindPopup('<b>東京</b>')   // クリック時のポップアップ
  .addTo(map);               // 地図に追加

marker.setLatLng([35.70, 139.70]);  // 座標を動かす
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

```js
function updateSymbols(symbols) {
  const seen = new Set();

  // 受信したシンボルを処理
  for (const sym of symbols) {
    seen.add(sym.label);

    if (markers.has(sym.label)) {
      // 既存マーカー → 座標とアイコンだけ更新
      const m = markers.get(sym.label);
      m.setLatLng([sym.lat, sym.lon]);
      m.setIcon(makeIcon(sym));
    } else {
      // 新規マーカー → 作成して地図に追加
      const m = L.marker([sym.lat, sym.lon], { icon: makeIcon(sym) })
        .bindPopup(`<b>${sym.label}</b>`)
        .addTo(map);
      markers.set(sym.label, m);
    }
  }

  // 受信リストにいないマーカー → 削除
  for (const [label, m] of markers) {
    if (!seen.has(label)) {
      m.remove();
      markers.delete(label);
    }
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
            it->second.setPosition(sym.lat, sym.lon);
        } else {
            markers[sym.label] = createMarker(sym);
        }
    }
    for (auto it = markers.begin(); it != markers.end(); ) {
        if (!seen.count(it->first)) { it->second.remove(); it = markers.erase(it); }
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
  → cfg.max_native_zoom = 13
                           ──── GET /api/config ────►
                           ◄─── {"max_zoom":13,...} ─
                                L.tileLayer({maxZoom:13})
                                L.map().setView(...)

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
                                  → L.marker([35.69,139.69]).addTo(map)

C++ プロセスが setSymbol() 呼び出し:
  symbols["Tokyo"] = {...}
  sse.broadcast(json_array)
                           ◄─── data: [{"label":"Tokyo",...}]
                                es.onmessage → updateSymbols()
                                  → L.marker([35.69,139.69]).addTo(map)

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
