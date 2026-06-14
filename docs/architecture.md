# C++ バックエンド解説

> **対象**: cpp_web_ui の内部実装を読んだり拡張したりしたい方  
> MapServer と ShmPublisher の設計・スレッドモデル・データフローを解説します。

---

## 1. 全体構成

```
cpp_web_ui::MapServer
├── httplib::Server      (server_thread — リクエスト受付)
├── SseBroker            (接続中ブラウザへの一斉配信)
├── symbols              (シンボルテーブル — 唯一の正本)
├── SHM ポーラー         (shm_thread — 100ms 間隔で version を監視)
└── オーバーレイプロキシ (外部タイルを中継してディスクキャッシュ)
```

`MapServer` 本体はヘッダ公開クラス。内部実装はすべて `MapServer::Impl` (pImpl パターン) に隠蔽されています。

**pImpl パターンとは:**  
ヘッダに実装詳細を露出しないために `unique_ptr<Impl>` を使う C++ イディオムです。`MapServer.hpp` を `#include` しても httplib や nlohmann::json の定義は不要 — ビルド時間短縮とバイナリ安定性を両立します。

---

## 2. スレッドモデル

```
main thread
  └─ MapServer::start()
        ├─ server_thread    ← httplib::Server::listen("0.0.0.0", port)
        │                      リクエストごとにスレッドプール (最大 64) に委譲
        └─ shm_thread       ← shmPollerLoop() — 100ms ごとに pollShm()
```

### 2-1. server_thread

`httplib::Server::listen()` は内部でスレッドプールを持ちます (`CPPHTTPLIB_THREAD_POOL_COUNT 64`)。  
各 HTTP リクエスト / SSE クライアントは独立したスレッドで処理されます。

SSE エンドポイント (`/events`) はリクエストスレッドが `while (sink.is_writable())` でループしており、クライアントが切断するまでスレッドを占有します。

### 2-2. shm_thread

`MapConfig::shm_name` が設定されていれば起動時に生成されます。  
100ms ごとに `pollShm()` を呼んで `SharedMapData::version` を確認し、変化があればシンボルテーブルを更新して SSE ブロードキャストを発火します。

### 2-3. スレッドセーフティ

```cpp
std::mutex sym_mu;                          // シンボルテーブルの排他制御
std::map<std::string, json> symbols;        // label → {lat,lon,type}

// 書き込みパターン（どのスレッドも同じ）
{ std::lock_guard lk(sym_mu);
  symbols[label] = {...}; }
broadcastSnapshot();                        // SSE に全量配信
```

`setSymbol()` / `removeSymbol()` / `clearSymbols()` は全て `sym_mu` を取得してから書き込み、その後 `broadcastSnapshot()` を呼びます。`broadcastSnapshot()` は内部で一度 `sym_mu` を取得して JSON 文字列を作り、その後 `SseBroker::broadcast()` を呼びます。

> **注意**: `sym_mu` と `SseBroker::mu` は別の mutex です。  
> 順序は常に `sym_mu` → `sse.mu` なので、デッドロックは発生しません。

---

## 3. SseBroker — Server-Sent Events の仕組み

```cpp
struct SseBroker {
    std::mutex mu;
    std::set<httplib::DataSink*> clients;

    void broadcast(const std::string& payload) {
        std::string msg = "data: " + payload + "\n\n";
        std::lock_guard lk(mu);
        for (auto* s : clients) s->write(msg.c_str(), msg.size());
    }
};
```

`httplib::DataSink` は「SSE の書き込み口」です。ブラウザが `/events` に接続するたびに httplib がリクエストスレッドを割り当て、そのスレッドの `DataSink` が `clients` に登録されます。

### 接続直後のスナップショット送信

ブラウザが接続した瞬間に現在のシンボルをすべて送信します。  
これにより「ページリロード後もシンボルが即表示される」を実現しています。

```cpp
// /events ハンドラ内
sse.add(sink);
// ↓ ここで現在状態を即送信
{ std::lock_guard lk(sym_mu); msg = "data: " + snapshotJsonLocked() + "\n\n"; }
sink.write(msg.c_str(), msg.size());

while (sink.is_writable())          // 接続が切れるまで待機
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
sse.remove(sink);
```

### SSE フレーム形式

HTTP の SSE プロトコルは単純です:

```
data: [{"label":"Alpha","lat":35.69,"lon":139.69,"type":"friendly"}]

```

各フレームは `data: <内容>\n\n` の形式です（改行 2 つで終端）。  
ブラウザ側では `es.onmessage = (e) => { JSON.parse(e.data); }` で受信します。

---

## 4. シンボルテーブルの設計

```cpp
std::map<std::string, json> symbols;   // label → シンボルオブジェクト
std::set<std::string>       shm_labels; // SHM 由来のラベルのみを追跡
```

### なぜ shm_labels が必要か?

SHM と in-process API の両方からシンボルが来る場合を考えてください:

```
setSymbol("Tokyo", ...)          ← in-process API で追加
ShmPublisher::setSymbol("Osaka") ← SHM 経由で追加
ShmPublisher::removeSymbol("Osaka") ← SHM から削除
```

SHM ポーラーは「SHM に存在しないラベル = SHM 側で削除された」として `symbols` から削除します。このとき "Tokyo" まで消えないよう、`shm_labels` で SHM 由来のラベルだけを管理しています。

```cpp
// pollShm() 内の削除処理
for (auto it = shm_labels.begin(); it != shm_labels.end(); ) {
    if (!seen.count(*it)) {
        symbols.erase(*it);          // シンボルテーブルから削除
        it = shm_labels.erase(it);   // shm_labels からも削除
    } else ++it;
}
// in-process API で追加した "Tokyo" は shm_labels にないので消えない
```

---

## 5. SHM ポーリング

```
ShmPublisher (書き込み側プロセス)
  └─ flush()
       ├─ symbols[] を SHM に書き込む
       └─ version++ (uint32_t)

MapServer::Impl::pollShm() (読み込み側 / 100ms ごと)
  ├─ openShm()       — shm_open + mmap (初回のみ)
  ├─ memcpy(&local, shm_ptr, sizeof)   ← アトミックなスナップショット取得
  ├─ local.version == shm_last_ver?    ← 変化なし → return
  ├─ シンボルテーブル更新
  └─ broadcastSnapshot()
```

### memcpy によるスナップショット

SHM は共有メモリなので、読んでいる最中に書き込み側が更新すると不整合が起きます。  
`memcpy` で一気にローカルバッファにコピーすることで、処理中の変化を防いでいます（完全なアトミック性ではありませんが、64 シンボルの小さな構造体では実用上十分です）。

### SHM が存在しない場合

`openShm()` は `shm_open(O_RDONLY)` が失敗したら `false` を返すだけです。  
`shm_writer` が起動していなくても `MapServer` はクラッシュしません — 次の 100ms で再試行します。

---

## 6. オーバーレイタイルプロキシ

`overlay_url` に `http://` または `https://` で始まる URL を設定すると、コンストラクタが自動でプロキシを有効化します。

```cpp
// コンストラクタ内
auto& ou = config.overlay_url;
if (!ou.empty() && ou.rfind("http", 0) == 0) {
    overlay_upstream = parseUrl(ou);
    if (overlay_upstream.valid)
        ou = "/overlay-tiles/{z}/{x}/{y}";   // URL を差し替える
}
```

`/api/config` から返る `overlay_url` はすでに `/overlay-tiles/...` に書き換えられているので、ブラウザはローカルサーバーしか知りません。

### タイル解決の優先順位

```
ブラウザ → GET /overlay-tiles/{z}/{x}/{y}
  ↓
  1. web/overlay-tiles/{z}/{x}/{y}.png  ← ディスクキャッシュ (最優先)
     ヒット → Cache-Control: public, max-age=300 でレスポンス
  ↓ ミス
  2. overlay_tile_cache[path]            ← メモリキャッシュ (最大 2000 枚)
     ヒット → レスポンス
  ↓ ミス
  3. 上流 HTTP(S) フェッチ               ← httplib::Client / SSLClient
     成功 → ディスク保存 + メモリキャッシュ保存 → レスポンス
     失敗 → 404 (ブラウザは透明タイルで補完)
```

ディスクキャッシュはサーバー再起動後も残るので、一度アクセスしたエリアは完全オフライン化されます。

### メモリキャッシュの退避

```cpp
if (overlay_tile_cache.size() >= OVERLAY_CACHE_MAX)   // 2000 枚
    overlay_tile_cache.clear();   // 全消去（シンプルな eviction policy）
```

最大 2000 枚を超えたら全消去します。LRU ではなく、シンプルな実装を優先しています。

---

## 7. 起動フロー

```
MapServer::MapServer(cfg)           ← コンストラクタ
  ├─ detectWebRoot()                ← $CPP_WEB_UI_WEB_ROOT → /proc/self/exe → install prefix
  ├─ detectMaxNativeZoom()          ← web/tiles/ を走査して最大 zoom を検出
  │    → max_native_zoom=-1 の場合のみ実行 (フォールバック: 10)
  └─ parseUrl(overlay_url)          ← http:// なら overlay_upstream を設定

MapServer::start()
  ├─ setupRoutes()                  ← httplib にルートを登録 (start() より前は登録不可)
  ├─ server_thread = listen(port)   ← ここからリクエスト受付開始
  └─ shm_thread = shmPollerLoop()   ← shm_name が設定されている場合のみ
```

**`addRoute()` を `start()` より前に呼ぶ理由:**  
`setupRoutes()` の中でカスタムルートを httplib に登録します。`listen()` 後に登録すると httplib の内部状態によっては反映されない可能性があります。

### web_root の自動検出順

| 優先度 | 検出方法 |
|--------|----------|
| 1 | `$CPP_WEB_UI_WEB_ROOT` 環境変数 |
| 2 | `/proc/self/exe` の親・祖父ディレクトリの `web/` |
| 3 | `CPP_WEB_UI_INSTALL_PREFIX/share/cpp_web_ui/web/` (CMake インストール時) |

検出に失敗しても起動はしますが、静的ファイルリクエストに `503` を返します。

---

## 8. 静的ファイル配信とキャッシュ制御

```cpp
bool isTile = path.compare(0, 7, "/tiles/") == 0;
serveFile(req, res, file, isTile);
```

| パス | Cache-Control | ETag |
|------|--------------|------|
| `/tiles/...` | `public, max-age=300, must-revalidate` | ファイルサイズ + mtime で生成 |
| それ以外 (`/`, `app.js`, `style.css` 等) | `no-store` | なし |

タイルは 5 分間ブラウザにキャッシュされます。ETag による検証でタイルが変わっていない場合は 304 Not Modified を返してネットワーク転送を省略します。  
HTML/CSS/JS は `no-store` で毎回フェッチします。開発中に `app.js` を変更してもリロードで即反映されます。

---

## 9. ShmPublisher の設計

`ShmPublisher` は書き込み専用のシンプルなクラスです。

```
ShmPublisher::Impl
  ├─ local: std::map<string, Entry>   ← プロセスローカルな正本
  ├─ fd: int                          ← shm_open() のファイルディスクリプタ
  ├─ ptr: SharedMapData*              ← mmap() の書き込み先
  └─ ver: uint32_t                    ← 次に書き込む version 番号
```

`setSymbol()` は `local` を更新してから `flush()` を呼びます。  
`flush()` は `local` の全エントリを `ptr->symbols[]` に書き込み、`version` をインクリメントします。

### 書き込みパターン

```cpp
void flush() {
    uint32_t i = 0;
    for (const auto& [lbl, e] : local) {
        if (i >= MAX_SYMBOLS) break;
        auto& s = ptr->symbols[i++];
        s.lat    = e.lat;
        s.lon    = e.lon;
        s.active = 1;
        strncpy(s.label, lbl.c_str(), sizeof(s.label) - 1);
        strncpy(s.type,  e.type.c_str(), sizeof(s.type)  - 1);
    }
    for (; i < MAX_SYMBOLS; ++i) ptr->symbols[i].active = 0;  // 残りを無効化
    ptr->count   = local.size();
    ptr->version = ++ver;   // MapServer のポーラーに変化を通知
}
```

`version` は最後にインクリメントします。ポーラーは `version` を見て変化を検知するので、中途半端な状態のまま読まれるリスクを最小化しています（完全なメモリバリアではありませんが、実用上十分です）。

---

## 10. 拡張ポイント

| やりたいこと | 方法 |
|---|---|
| 独自の POST エンドポイント | `server.addRoute("/api/xxx", handler)` |
| GET エンドポイント | `MapServer::Impl::svr.Get(...)` を直接呼ぶ（内部APIのため非推奨） |
| シンボル以外のデータをブラウザへ push | `SseBroker::broadcast()` は汎用 — JSON 形式なら何でも送れる |
| SHM 構造を変える | `include/shared_types.h` の `Symbol` / `SharedMapData` を変更 |
| タイルサーバーを外部に変える | `MapConfig::tile_url` に外部 URL を設定 |

---

## 11. C# バックエンド (`csharp/MapServer/`)

C++ の `MapServer` と HTTP API レベルで互換な **ASP.NET Core 8** 製スタンドアロンサーバー。  
Linux / Windows 両方で動作します。

### 11-1. アーキテクチャ

```
ASP.NET Core (Kestrel)
├── SymbolTable          ← ConcurrentDictionary + Channel<string> による SSE 配信
├── ShmPoller            ← BackgroundService (100ms ポーリング)
│     Linux: P/Invoke shm_open + mmap
│     Windows: MemoryMappedFile.OpenExisting
└── ViewshedComputer     ← C# 移植 (SixLabors.ImageSharp で Terrarium PNG デコード)
```

### 11-2. SHM バイナリ互換性

C# 側では `BitConverter` でバイト列をそのままパースします。  
C++ 側のアライメントパディングに注意:

```
Symbol のメモリレイアウト (sizeof = 72):
  offset  0 : double lat         (8 bytes)
  offset  8 : double lon         (8 bytes)
  offset 16 : char   label[32]   (32 bytes)
  offset 48 : char   type[16]    (16 bytes)
  offset 64 : int    active      (4 bytes)
  offset 68 : [padding]          (4 bytes — double の 8 バイトアライメント)

SharedMapData のメモリレイアウト (sizeof = 4616):
  offset  0 : uint32 version     (4 bytes)
  offset  4 : uint32 count       (4 bytes)
  offset  8 : Symbol[64]         (64 × 72 = 4608 bytes)
```

### 11-3. SSE 実装の違い

C++ 版は `httplib::DataSink` の生ポインタを `set<DataSink*>` で管理しますが、  
C# 版は `System.Threading.Channels` の `Channel<string>` (1 クライアント = 1 チャネル) を使います。  
ブラウザから見たプロトコル (`data: [...]\n\n`) は同一です。

### 11-4. 起動

```bash
# リポジトリ直下から (web_root を自動検出)
cd csharp/MapServer
dotnet run

# web_root を環境変数で明示
CPP_WEB_UI_WEB_ROOT=/path/to/web dotnet run

# 本番用パブリッシュ (単一 exe)
dotnet publish -c Release -r linux-x64 --self-contained true
```
