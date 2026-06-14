'use strict';

const DEFAULT_CONFIG = {
  center:          [36.0, 137.5],
  zoom:            6,
  tile_url:        '/tiles/{z}/{x}/{y}.png',
  attribution:     'Elevation: &copy; JAXA AW3D30',
  min_zoom:        5,
  max_zoom:        18,
  max_native_zoom: 12,
  title:           'Map',
};

(async () => {

  // ----------------------------------------------------------------
  // 設定取得
  // ----------------------------------------------------------------
  const cfg = await fetch('/api/config')
    .then(r => r.json())
    .catch(() => DEFAULT_CONFIG);

  document.title = cfg.title;

  // ----------------------------------------------------------------
  // MapLibre スタイル構築
  // MapLibre の座標系は [lon, lat]  (Leaflet は [lat, lon])
  // ----------------------------------------------------------------
  const sources = {
    'base-tiles': {
      type:        'raster',
      tiles:       [cfg.tile_url],
      tileSize:    256,
      maxzoom:     cfg.max_native_zoom || 12,
      attribution: cfg.attribution || '',
    },
    'terrain-dem': {
      type:     'raster-dem',
      tiles:    ['/terrain-rgb/{z}/{x}/{y}.png'],
      tileSize: 256,
      encoding: 'terrarium',
      maxzoom:  12,
    },
  };

  const HILLSHADE_DEFAULT = 0.45;

  const layers = [
    { id: 'base', type: 'raster', source: 'base-tiles', paint: {
        'raster-resampling':    'nearest',
        'raster-fade-duration':  0,
    }},
    // 地形陰影: terrain-dem ソースを 2D レンダリングで陰影化する。
    // illumination-anchor: 'viewport' により照明方向は常に画面上部を基準とし、
    // 地図の回転・ピッチに追従して影が更新される。
    { id: 'hillshade', type: 'hillshade', source: 'terrain-dem', paint: {
        'hillshade-illumination-direction': 335,          // 画面左上から照らす
        'hillshade-illumination-anchor':    'viewport',   // 視点連動
        'hillshade-exaggeration':           HILLSHADE_DEFAULT,
        'hillshade-shadow-color':           '#1a2a3a',
        'hillshade-highlight-color':        '#f0f0f0',
        'hillshade-accent-color':           '#1a2a3a',
    }},
  ];

  // ----------------------------------------------------------------
  // 国土地理院ベクタータイルオーバーレイ
  // 背景ポリゴンを持たないベクター形式のため、ALOS地形画像が透けて見える。
  // ----------------------------------------------------------------
  sources['gsi-vector'] = {
    type:        'vector',
    tiles:       ['https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/{z}/{x}/{y}.pbf'],
    maxzoom:     17,
    attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>',
  };

  const W = (zoom8, zoom15) =>
    ['interpolate', ['linear'], ['zoom'], 8, zoom8, 15, zoom15];

  layers.push(
    // 水域（河川・湖沼）
    { id: 'gsi-water', type: 'fill', source: 'gsi-vector', 'source-layer': 'WA',
      paint: { 'fill-color': '#2a4a72', 'fill-opacity': 0.75 } },
    // 道路縁
    { id: 'gsi-road', type: 'line', source: 'gsi-vector', 'source-layer': 'RdEdg',
      paint: { 'line-color': '#c09050', 'line-opacity': 0.85, 'line-width': W(0.5, 2.5) } },
    // 行政区画界（破線）
    { id: 'gsi-adm', type: 'line', source: 'gsi-vector', 'source-layer': 'AdmBdry',
      paint: { 'line-color': '#ffffff', 'line-opacity': 0.55, 'line-width': 0.9,
               'line-dasharray': [4, 3] } },
    // 鉄道中心線
    { id: 'gsi-rail', type: 'line', source: 'gsi-vector', 'source-layer': 'RailCL',
      paint: { 'line-color': '#e06080', 'line-opacity': 0.9, 'line-width': W(0.8, 1.5) } },
    // 建築物（ズーム13から表示、fill はoverzoom でも安定して描画される）
    { id: 'gsi-building', type: 'fill', source: 'gsi-vector', 'source-layer': 'BldA',
      minzoom: 13,
      paint: {
        'fill-color':         '#c8b460',
        'fill-opacity':       ['interpolate', ['linear'], ['zoom'], 13, 0.10, 17, 0.28],
        'fill-outline-color': '#e0cc70',
      } },
    // 地名注記（漢字）
    { id: 'gsi-label', type: 'symbol', source: 'gsi-vector', 'source-layer': 'Anno',
      layout: {
        'text-field':     ['get', 'knj'],
        'text-font':      ['NotoSansCJKjp-Regular'],
        'text-size':      W(10, 13),
        'text-max-width': 6,
        'text-anchor':    'center',
        'text-allow-overlap': false,
      },
      paint: {
        'text-color':       '#f0f0e8',
        'text-halo-color':  '#1a2030',
        'text-halo-width':  1.5,
      } },
  );

  if (cfg.overlay_url) {
    sources['overlay'] = {
      type:        'raster',
      tiles:       [cfg.overlay_url],
      tileSize:    256,
      maxzoom:     18,
      attribution: cfg.overlay_attribution || '',
    };
    layers.push({
      id:    'overlay',
      type:  'raster',
      source: 'overlay',
      paint: { 'raster-opacity': cfg.overlay_opacity ?? 0.75 },
    });
  }

  // ----------------------------------------------------------------
  // 地図初期化
  // ----------------------------------------------------------------
  const [initLat, initLon] = cfg.center;

  // WebGL サポート確認
  const map = new maplibregl.Map({
    container: 'map',
    style: {
      version: 8,
      // 日本語フォント（GSIベクタータイルの地名注記に必要）
      glyphs: 'https://gsi-cyberjapan.github.io/gsimaps-vector-stylefiles/noto-font/pbfonts/{fontstack}/{range}.pbf',
      sources,
      layers,
    },
    center:    [initLon, initLat],
    zoom:      cfg.zoom || 6,
    pitch:     45,
    bearing:   0,
    maxPitch:  85,
    maxZoom:   cfg.max_zoom || 18,
    minZoom:   cfg.min_zoom || 5,
    fadeDuration: 0,       // タイル読み込み時のフェード全体を無効化
    attributionControl: false,
  });

  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

  // ----------------------------------------------------------------
  // 3D地形 & スカイ
  // pitch < TERRAIN_PITCH_THRESHOLD のときは terrain を無効化して
  // 真上から見たときのパース歪みを防ぐ。
  // ----------------------------------------------------------------
  let terrainEnabled = true;
  const TERRAIN_PITCH_THRESHOLD = 5;

  function applyTerrain() {
    if (terrainEnabled && map.getPitch() >= TERRAIN_PITCH_THRESHOLD) {
      map.setTerrain({ source: 'terrain-dem', exaggeration: 2.0 });
    } else {
      map.setTerrain(null);
    }
  }

  map.on('load', () => {
    applyTerrain();
    map.setSky({
      'sky-color':         '#1a1a2e',
      'sky-horizon-blend':  0.5,
      'horizon-color':     '#1a3a60',
      'horizon-fog-blend':  0.5,
      'fog-color':         '#0d1526',
      'fog-ground-blend':   0.5,
    });
  });

  map.on('pitchend', applyTerrain);

  // ----------------------------------------------------------------
  // オーバーレイ: View メニューにトグル & 透過度スライダーを動的追加
  // ----------------------------------------------------------------
  if (cfg.overlay_url) {
    const dropdown = document.getElementById('view-menu-dropdown');

    const liToggle = document.createElement('li');
    const btnToggle = document.createElement('button');
    btnToggle.id          = 'menu-toggle-overlay';
    btnToggle.textContent = 'オーバーレイ を隠す';
    liToggle.appendChild(btnToggle);
    dropdown.insertBefore(liToggle, dropdown.firstChild);

    let overlayVisible = true;
    btnToggle.addEventListener('click', function (e) {
      e.stopPropagation();
      document.querySelectorAll('.menu-item.open').forEach(el => el.classList.remove('open'));
      overlayVisible = !overlayVisible;
      map.setLayoutProperty('overlay', 'visibility', overlayVisible ? 'visible' : 'none');
      this.textContent = overlayVisible ? 'オーバーレイ を隠す' : 'オーバーレイ を表示';
    });

    const liSlider = document.createElement('li');
    liSlider.innerHTML = `
      <label class="menu-slider-row">
        <span>透過度</span>
        <input id="overlay-opacity-slider" type="range"
               min="0" max="1" step="0.05"
               value="${cfg.overlay_opacity ?? 0.75}">
        <span id="overlay-opacity-val">${Math.round((cfg.overlay_opacity ?? 0.75) * 100)}%</span>
      </label>`;
    dropdown.insertBefore(liSlider, liToggle.nextSibling);

    liSlider.addEventListener('click',     e => e.stopPropagation());
    liSlider.addEventListener('mousedown', e => e.stopPropagation());

    document.getElementById('overlay-opacity-slider').addEventListener('input', function () {
      const v = parseFloat(this.value);
      map.setPaintProperty('overlay', 'raster-opacity', v);
      document.getElementById('overlay-opacity-val').textContent = Math.round(v * 100) + '%';
    });
  }

  // ----------------------------------------------------------------
  // 3D地形トグル / 北向きリセット
  // ----------------------------------------------------------------
  document.getElementById('menu-toggle-terrain').addEventListener('click', function () {
    terrainEnabled = !terrainEnabled;
    if (terrainEnabled) {
      map.easeTo({ pitch: 45, duration: 500 });  // pitchend fires applyTerrain
      this.textContent = '3D地形 を無効化';
    } else {
      map.setTerrain(null);
      map.easeTo({ pitch: 0, duration: 500 });
      this.textContent = '3D地形 を有効化';
    }
    document.querySelectorAll('.menu-item.open').forEach(el => el.classList.remove('open'));
  });

  document.getElementById('menu-reset-north').addEventListener('click', () => {
    map.easeTo({ bearing: 0, pitch: 0, duration: 500 });
    document.querySelectorAll('.menu-item.open').forEach(el => el.classList.remove('open'));
  });

  // GSIベクタータイルトグル
  const GSI_LAYERS = ['gsi-water', 'gsi-building', 'gsi-road', 'gsi-adm', 'gsi-rail', 'gsi-label'];
  let gsiVisible = true;
  document.getElementById('menu-toggle-gsi').addEventListener('click', function () {
    gsiVisible = !gsiVisible;
    const vis = gsiVisible ? 'visible' : 'none';
    GSI_LAYERS.forEach(id => map.setLayoutProperty(id, 'visibility', vis));
    this.textContent = gsiVisible ? 'GSI地図 を隠す' : 'GSI地図 を表示';
    document.querySelectorAll('.menu-item.open').forEach(el => el.classList.remove('open'));
  });

  // 地形陰影トグル
  let hillshadeVisible = true;
  document.getElementById('menu-toggle-hillshade').addEventListener('click', function () {
    hillshadeVisible = !hillshadeVisible;
    map.setLayoutProperty('hillshade', 'visibility', hillshadeVisible ? 'visible' : 'none');
    this.textContent = hillshadeVisible ? '地形陰影 を隠す' : '地形陰影 を表示';
    document.querySelectorAll('.menu-item.open').forEach(el => el.classList.remove('open'));
  });

  // 陰影強度スライダー
  const hillshadeSlider = document.getElementById('hillshade-intensity');
  const hillshadeVal    = document.getElementById('hillshade-intensity-val');
  hillshadeSlider.addEventListener('input', function () {
    map.setPaintProperty('hillshade', 'hillshade-exaggeration', parseFloat(this.value));
    hillshadeVal.textContent = Math.round(this.value * 100) + '%';
  });
  // スライダーのクリックがメニューを閉じないよう伝播を止める
  hillshadeSlider.closest('li').addEventListener('click',     e => e.stopPropagation());
  hillshadeSlider.closest('li').addEventListener('mousedown', e => e.stopPropagation());

  // ----------------------------------------------------------------
  // シンボル管理
  // ----------------------------------------------------------------
  // markers: label → { marker: maplibregl.Marker, el: HTMLElement }
  const markers = new Map();

  function makeEl(sym) {
    const el = document.createElement('div');
    el.className   = `sym-icon ${sym.type}`;
    el.textContent = sym.label.slice(0, 2).toUpperCase();
    return el;
  }

  function popupHtml(sym) {
    return `<b>${sym.label}</b><br>種別: ${sym.type}<br>${sym.lat.toFixed(5)}, ${sym.lon.toFixed(5)}`;
  }

  function updateSymbols(symbols) {
    const seen = new Set();

    for (const sym of symbols) {
      seen.add(sym.label);
      if (markers.has(sym.label)) {
        const { marker, el } = markers.get(sym.label);
        marker.setLngLat([sym.lon, sym.lat]);
        el.className   = `sym-icon ${sym.type}`;
        el.textContent = sym.label.slice(0, 2).toUpperCase();
        marker.getPopup().setHTML(popupHtml(sym));
      } else {
        const el     = makeEl(sym);
        const popup  = new maplibregl.Popup({ offset: 18, closeButton: true })
                         .setHTML(popupHtml(sym));
        const marker = new maplibregl.Marker({ element: el })
                         .setLngLat([sym.lon, sym.lat])
                         .setPopup(popup)
                         .addTo(map);
        markers.set(sym.label, { marker, el });
      }
    }

    for (const [label, { marker }] of markers) {
      if (!seen.has(label)) { marker.remove(); markers.delete(label); }
    }

    updateStatus(symbols);
  }

  // ----------------------------------------------------------------
  // シンボルテーブル更新
  // ----------------------------------------------------------------
  function updateStatus(symbols) {
    document.getElementById('count').textContent = symbols.length;

    const tbody = document.getElementById('symbol-tbody');
    tbody.innerHTML = '';

    const sorted = [...symbols].sort((a, b) => a.label.localeCompare(b.label));
    for (const sym of sorted) {
      const tr = document.createElement('tr');
      tr.className = sym.type;
      tr.innerHTML = `
        <td>${sym.label}</td>
        <td class="sym-type ${sym.type}">${sym.type}</td>
        <td class="sym-num">${sym.lat.toFixed(3)}</td>
        <td class="sym-num">${sym.lon.toFixed(3)}</td>`;
      tr.addEventListener('click', () => {
        const entry = markers.get(sym.label);
        if (entry) {
          map.flyTo({ center: [sym.lon, sym.lat], zoom: 12, duration: 800 });
          entry.marker.togglePopup();
        }
      });
      tbody.appendChild(tr);
    }
  }

  // ----------------------------------------------------------------
  // ウィジェット ドラッグ移動 (VAB ⇔ Status)
  // ----------------------------------------------------------------
  (function () {
    const widget      = document.getElementById('symbol-table-widget');
    const dragHandle  = widget.querySelector('.widget-drag-handle');
    const vab         = document.getElementById('vab');
    const statusPanel = document.getElementById('status-panel');

    dragHandle.addEventListener('mousedown', e => {
      e.preventDefault();
      document.body.style.cursor = 'grabbing';
      vab.classList.add('drop-target');
      statusPanel.classList.add('drop-target');

      function panelAt(x) {
        const vr = vab.getBoundingClientRect();
        const sr = statusPanel.getBoundingClientRect();
        if (x >= vr.left && x <= vr.right) return 'vab';
        if (x >= sr.left && x <= sr.right) return 'status';
        return null;
      }

      function onMove(e) {
        const target = panelAt(e.clientX);
        vab.classList.toggle('drop-hover',         target === 'vab');
        statusPanel.classList.toggle('drop-hover', target === 'status');
      }

      function onUp(e) {
        document.body.style.cursor = '';
        vab.classList.remove('drop-target', 'drop-hover');
        statusPanel.classList.remove('drop-target', 'drop-hover');
        const target = panelAt(e.clientX);
        if (target === 'vab') {
          widget.classList.replace('in-status', 'in-vab');
          vab.appendChild(widget);
        } else if (target === 'status') {
          widget.classList.replace('in-vab', 'in-status');
          statusPanel.appendChild(widget);
        }
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });
  })();

  // ----------------------------------------------------------------
  // ズームレベル表示
  // ----------------------------------------------------------------
  const zoomDisplay = document.getElementById('menubar-zoom');
  function updateZoomDisplay() {
    zoomDisplay.textContent = `Z${Math.round(map.getZoom())}`;
  }
  map.on('zoom', updateZoomDisplay);
  updateZoomDisplay();

  function setConnected(ok) {
    document.getElementById('conn-indicator').className = 'dot ' + (ok ? 'connected' : 'disconnected');
    document.getElementById('conn-label').textContent   = ok ? 'SSE 接続中' : '再接続中...';
  }

  // ----------------------------------------------------------------
  // SSE 接続
  // ----------------------------------------------------------------
  function connect() {
    const es = new EventSource('/events');
    es.onopen    = () => setConnected(true);
    es.onmessage = (e) => { try { updateSymbols(JSON.parse(e.data)); } catch {} };
    es.onerror   = () => { setConnected(false); es.close(); setTimeout(connect, 3000); };
  }
  connect();

  // ----------------------------------------------------------------
  // リサイズハンドル — パネル幅をドラッグで変更
  // ----------------------------------------------------------------
  function makeResizable(handle, panel, side) {
    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = panel.offsetWidth;
      handle.classList.add('dragging');
      document.body.style.cursor     = 'col-resize';
      document.body.style.userSelect = 'none';

      function onMove(e) {
        const dx = e.clientX - startX;
        const w  = Math.max(120, Math.min(480,
                     side === 'left' ? startW + dx : startW - dx));
        panel.style.width    = w + 'px';
        panel.style.minWidth = w + 'px';
        map.resize();
      }
      function onUp() {
        handle.classList.remove('dragging');
        document.body.style.cursor     = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });
  }

  makeResizable(document.getElementById('handle-left'),  document.getElementById('vab'),          'left');
  makeResizable(document.getElementById('handle-right'), document.getElementById('status-panel'), 'right');

  // ----------------------------------------------------------------
  // メニューバー — プルダウン開閉
  // ----------------------------------------------------------------
  document.querySelectorAll('.menu-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const item    = btn.closest('.menu-item');
      const wasOpen = item.classList.contains('open');
      document.querySelectorAll('.menu-item.open').forEach(el => el.classList.remove('open'));
      if (!wasOpen) item.classList.add('open');
    });
  });

  document.addEventListener('click', () => {
    document.querySelectorAll('.menu-item.open').forEach(el => el.classList.remove('open'));
  });

  document.querySelectorAll('.menu-dropdown button').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      document.querySelectorAll('.menu-item.open').forEach(el => el.classList.remove('open'));
    });
  });

  // View > パネル表示切替
  function togglePanel(panelId, handleId, btnEl, labelHide, labelShow) {
    const panel   = document.getElementById(panelId);
    const handle  = document.getElementById(handleId);
    const visible = panel.style.display !== 'none';
    panel.style.display  = visible ? 'none' : '';
    handle.style.display = visible ? 'none' : '';
    btnEl.textContent    = visible ? labelShow : labelHide;
    map.resize();
  }

  document.getElementById('menu-toggle-vab').addEventListener('click', function () {
    togglePanel('vab', 'handle-left', this, 'VAB を隠す', 'VAB を表示');
  });

  document.getElementById('menu-toggle-status').addEventListener('click', function () {
    togglePanel('status-panel', 'handle-right', this, 'Status を隠す', 'Status を表示');
  });

  document.getElementById('menu-clear-symbols').addEventListener('click', () => {
    apiCall('DELETE', '/api/symbols');
  });

  // ----------------------------------------------------------------
  // VAB — C++ API 呼び出しヘルパー
  // ----------------------------------------------------------------
  const feedback = document.getElementById('vab-feedback');

  function showFeedback(msg, ok) {
    feedback.textContent = msg;
    feedback.className   = ok ? 'ok' : 'err';
    clearTimeout(feedback._t);
    feedback._t = setTimeout(() => { feedback.textContent = ''; feedback.className = ''; }, 3000);
  }

  async function apiCall(method, url, body) {
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body:    body ? JSON.stringify(body) : undefined,
      });
      showFeedback(res.ok ? `OK ${method} ${url}` : `Error ${res.status}`, res.ok);
    } catch (e) {
      showFeedback(String(e), false);
    }
  }

  // ----------------------------------------------------------------
  // VAB ボタン
  // ----------------------------------------------------------------
  document.getElementById('vab-set-btn').addEventListener('click', () => {
    const label = document.getElementById('vab-label').value.trim();
    const lat   = parseFloat(document.getElementById('vab-lat').value);
    const lon   = parseFloat(document.getElementById('vab-lon').value);
    const type  = document.getElementById('vab-type').value;
    if (!label) { showFeedback('label is required', false); return; }
    apiCall('POST', '/api/symbols', { label, lat, lon, type });
  });

  document.getElementById('vab-rm-btn').addEventListener('click', () => {
    const label = document.getElementById('vab-rm-label').value.trim();
    if (!label) { showFeedback('label is required', false); return; }
    apiCall('DELETE', `/api/symbols/${encodeURIComponent(label)}`);
  });

  document.getElementById('vab-clear-btn').addEventListener('click', () => {
    apiCall('DELETE', '/api/symbols');
  });

  // ----------------------------------------------------------------
  // 4×4 カスタムボタングリッド
  // ----------------------------------------------------------------
  const grid = document.getElementById('btn-grid');
  for (let n = 1; n <= 16; n++) {
    const btn = document.createElement('button');
    btn.className   = 'grid-btn';
    btn.textContent = `B${String(n).padStart(2, '0')}`;
    btn.addEventListener('click', () => apiCall('POST', `/api/btn/${n}`));
    grid.appendChild(btn);
  }

  // ================================================================
  // レーダー覆域 — 3D WebGL カスタムレイヤー
  // ================================================================

  // --- RadarCoverageLayer ----------------------------------------
  // MapLibre の CustomLayerInterface を実装した 3D メッシュレイヤー
  class RadarCoverageLayer {
    constructor(id, meshData, color) {
      this.id            = id;
      this.type          = 'custom';
      this.renderingMode = '3d';
      this._mesh  = meshData;  // { vertices:[[lon,lat,alt],...], triangles:[[i,j,k],...] }
      this._color = color;     // [r, g, b, a]  0-1 range
    }

    onAdd(map, gl) {
      this._map = map;

      const vs = `
        attribute vec3 a_pos;
        uniform mat4 u_matrix;
        void main() { gl_Position = u_matrix * vec4(a_pos, 1.0); }`;
      const fs = `
        precision mediump float;
        uniform vec4 u_color;
        void main() { gl_FragColor = u_color; }`;

      const compile = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        return sh;
      };
      this._prog = gl.createProgram();
      gl.attachShader(this._prog, compile(gl.VERTEX_SHADER,   vs));
      gl.attachShader(this._prog, compile(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(this._prog);

      // Convert (lon, lat, alt) → Mercator (x, y, z) and pack into Float32Array
      const verts = new Float32Array(this._mesh.vertices.length * 3);
      this._mesh.vertices.forEach(([lon, lat, alt], i) => {
        const mc = maplibregl.MercatorCoordinate.fromLngLat([lon, lat], alt);
        verts[i * 3]     = mc.x;
        verts[i * 3 + 1] = mc.y;
        verts[i * 3 + 2] = mc.z;
      });

      this._vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

      // Index buffer — Uint32Array supports meshes with >65535 vertices
      const idxArr = new Uint32Array(this._mesh.triangles.flat());
      this._ibo = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idxArr, gl.STATIC_DRAW);
      this._nIdx = idxArr.length;

      this._posLoc = gl.getAttribLocation(this._prog,  'a_pos');
      this._matLoc = gl.getUniformLocation(this._prog, 'u_matrix');
      this._colLoc = gl.getUniformLocation(this._prog, 'u_color');

      // --- 境界エッジインデックスバッファ ----------------------------
      // el_max 境界（上端）・el_min 境界（下端）・方位角境界（セクタのみ）を
      // gl.LINES で描画するためのインデックス列を構築する。
      // 頂点グリッド: (i=az方向, j=el方向)  フラットインデックス = i*n_el + j
      const m = this._mesh.meta;
      this._nEdge = 0;
      if (m && m.n_az > 0 && m.n_el > 0) {
        const { n_az, n_el, full_circle } = m;
        const vi      = (i, j) => i * n_el + j;
        const azLast  = full_circle ? n_az : n_az - 1;
        const edgeArr = [];

        for (let i = 0; i < azLast; i++) {
          const ni = full_circle ? (i + 1) % n_az : i + 1;
          edgeArr.push(vi(i, n_el - 1), vi(ni, n_el - 1));  // el_max 上端
          edgeArr.push(vi(i, 0),        vi(ni, 0));           // el_min 下端
        }
        if (!full_circle) {
          // 方位角の両境界面（セクタ側面の上下ライン）
          for (let j = 0; j < n_el - 1; j++) {
            edgeArr.push(vi(0,       j), vi(0,       j + 1));
            edgeArr.push(vi(n_az-1, j), vi(n_az-1, j + 1));
          }
        }

        this._edgeIbo = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._edgeIbo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(edgeArr), gl.STATIC_DRAW);
        this._nEdge = edgeArr.length;
      }
    }

    render(gl, matrix) {
      gl.useProgram(this._prog);
      gl.uniformMatrix4fv(this._matLoc, false, matrix);

      gl.bindBuffer(gl.ARRAY_BUFFER, this._vbo);
      gl.enableVertexAttribArray(this._posLoc);
      gl.vertexAttribPointer(this._posLoc, 3, gl.FLOAT, false, 0, 0);

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);   // 裏面も描画（覆域内部からも見えるように）

      // パス 1: 塗り（半透明メッシュ）
      gl.uniform4fv(this._colLoc, this._color);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._ibo);
      gl.drawElements(gl.TRIANGLES, this._nIdx, gl.UNSIGNED_INT, 0);

      // パス 2: 境界エッジ（不透明ラインで輪郭を強調）
      if (this._nEdge > 0) {
        const [r, g, b] = this._color;
        gl.uniform4fv(this._colLoc, [r, g, b, 0.90]);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._edgeIbo);
        gl.drawElements(gl.LINES, this._nEdge, gl.UNSIGNED_INT, 0);
      }

      gl.depthMask(true);
      gl.disable(gl.BLEND);
      map.triggerRepaint();
    }
  }

  // --- 断面図描画 -----------------------------------------------
  function _niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / p;
    if (n < 1.5) return p;
    if (n < 3.5) return 2 * p;
    if (n < 7.5) return 5 * p;
    return 10 * p;
  }

  function drawSection(canvas, sec) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const PL = 38, PB = 18, PT = 4, PR = 4;
    const pw = W - PL - PR, ph = H - PT - PB;
    const n = sec.range_km.length;
    if (n === 0) return;

    const maxR = sec.range_km[n - 1];

    // Altitude extents
    let minA = sec.radar_alt_m, maxA = sec.radar_alt_m;
    for (let i = 0; i < n; i++) {
      if (sec.terrain_m[i] < minA) minA = sec.terrain_m[i];
      if (sec.max_cov_m[i] > maxA) maxA = sec.max_cov_m[i];
    }
    const pad = Math.max(50, (maxA - minA) * 0.06);
    minA -= pad; maxA += pad;
    const altSpan = maxA - minA;

    const toX = r => PL + (r / maxR) * pw;
    const toY = a => PT + ph - ((a - minA) / altSpan) * ph;

    // Background
    ctx.fillStyle = '#080f1e';
    ctx.fillRect(0, 0, W, H);

    // Horizontal grid lines
    const altStep = _niceStep(altSpan / 4);
    const aStart  = Math.ceil(minA / altStep) * altStep;
    ctx.strokeStyle = '#1a2a45';
    ctx.lineWidth = 1;
    for (let a = aStart; a <= maxA + 0.01; a += altStep) {
      const yy = toY(a);
      ctx.beginPath();
      ctx.moveTo(PL, yy);
      ctx.lineTo(PL + pw, yy);
      ctx.stroke();
    }

    // Shadow zones: terrain → min_vis
    ctx.fillStyle = 'rgba(90,30,30,0.55)';
    for (let i = 0; i < n - 1; i++) {
      const mv0 = sec.min_vis_m[i],   t0 = sec.terrain_m[i];
      const mv1 = sec.min_vis_m[i+1], t1 = sec.terrain_m[i+1];
      if (mv0 > t0 + 1 || mv1 > t1 + 1) {
        ctx.beginPath();
        ctx.moveTo(toX(sec.range_km[i]),   toY(t0));
        ctx.lineTo(toX(sec.range_km[i+1]), toY(t1));
        ctx.lineTo(toX(sec.range_km[i+1]), toY(mv1));
        ctx.lineTo(toX(sec.range_km[i]),   toY(mv0));
        ctx.closePath();
        ctx.fill();
      }
    }

    // Coverage region: max(terrain,min_vis) → max_cov, split by gaps
    const hasCov = i => sec.max_cov_m[i] > Math.max(sec.terrain_m[i], sec.min_vis_m[i]);
    ctx.fillStyle   = 'rgba(0,180,255,0.20)';
    ctx.strokeStyle = 'rgba(0,200,255,0.55)';
    ctx.lineWidth = 1;

    let segStart = null;
    for (let i = 0; i <= n; i++) {
      const cov = i < n && hasCov(i);
      if (cov && segStart === null) {
        segStart = i;
      } else if (!cov && segStart !== null) {
        ctx.beginPath();
        for (let j = segStart; j < i; j++) {
          const xj = toX(sec.range_km[j]), yj = toY(sec.max_cov_m[j]);
          j === segStart ? ctx.moveTo(xj, yj) : ctx.lineTo(xj, yj);
        }
        for (let j = i - 1; j >= segStart; j--) {
          ctx.lineTo(toX(sec.range_km[j]),
                     toY(Math.max(sec.terrain_m[j], sec.min_vis_m[j])));
        }
        ctx.closePath();
        ctx.fill();
        // Top boundary line
        ctx.beginPath();
        for (let j = segStart; j < i; j++) {
          const xj = toX(sec.range_km[j]), yj = toY(sec.max_cov_m[j]);
          j === segStart ? ctx.moveTo(xj, yj) : ctx.lineTo(xj, yj);
        }
        ctx.stroke();
        segStart = null;
      }
    }

    // Terrain fill
    ctx.fillStyle = '#3a2008';
    ctx.beginPath();
    ctx.moveTo(PL, PT + ph);
    for (let i = 0; i < n; i++)
      ctx.lineTo(toX(sec.range_km[i]), toY(sec.terrain_m[i]));
    ctx.lineTo(toX(maxR), PT + ph);
    ctx.closePath();
    ctx.fill();

    // Terrain outline
    ctx.strokeStyle = '#7a5025';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const xi = toX(sec.range_km[i]), yi = toY(sec.terrain_m[i]);
      i === 0 ? ctx.moveTo(xi, yi) : ctx.lineTo(xi, yi);
    }
    ctx.stroke();

    // Radar marker
    ctx.fillStyle = '#00d4ff';
    ctx.beginPath();
    ctx.arc(PL, toY(sec.radar_alt_m), 3.5, 0, Math.PI * 2);
    ctx.fill();

    // Axes
    ctx.strokeStyle = '#2a3a55';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PL, PT); ctx.lineTo(PL, PT + ph);
    ctx.lineTo(PL + pw, PT + ph);
    ctx.stroke();

    // Y labels (altitude)
    ctx.fillStyle = '#5a7a9a';
    ctx.font = '8px monospace';
    ctx.textAlign = 'right';
    for (let a = aStart; a <= maxA + 0.01; a += altStep) {
      const label = Math.abs(a) >= 1000
        ? (a / 1000).toFixed(1) + 'k'
        : Math.round(a).toString();
      ctx.fillText(label, PL - 3, toY(a) + 3);
    }

    // X labels (range in km)
    ctx.textAlign = 'center';
    const xStep = _niceStep(maxR / 4);
    for (let r = 0; r <= maxR + 0.001; r += xStep)
      ctx.fillText(r.toFixed(0), toX(r), PT + ph + 11);
    ctx.textAlign = 'right';
    ctx.fillText('km', W - 1, PT + ph + 11);
  }

  // --- 覆域管理 ------------------------------------------------
  // RADAR_COLORS: 複数レーダーを色で区別
  const RADAR_COLORS = [
    [0.0, 0.8, 1.0, 0.28],   // シアン
    [1.0, 0.45, 0.0, 0.28],  // オレンジ
    [0.4, 1.0, 0.2, 0.28],   // グリーン
    [1.0, 0.2, 0.7, 0.28],   // ピンク
    [1.0, 1.0, 0.0, 0.28],   // イエロー
    [0.6, 0.2, 1.0, 0.28],   // パープル
  ];

  const radarLayers = new Map();   // layerId → { marker, colorIdx, params }
  let radarSerial = 0;

  function radarColorCss(colorArr) {
    const [r, g, b] = colorArr.map(v => Math.round(v * 255));
    return `rgb(${r},${g},${b})`;
  }

  function updateRadarList() {
    const list = document.getElementById('radar-list');
    list.innerHTML = '';
    for (const [lid, { colorIdx, params }] of radarLayers) {
      const row  = document.createElement('div');
      row.className = 'radar-list-row';
      const swatch = document.createElement('span');
      swatch.className = 'radar-swatch';
      swatch.style.background = radarColorCss(RADAR_COLORS[colorIdx % RADAR_COLORS.length]);
      const label  = document.createElement('span');
      label.textContent = `R${radarLayers.size > 1 ? lid.split('-')[1] : ''}  `
                        + `${params.range_km}km`;
      const rmBtn  = document.createElement('button');
      rmBtn.textContent = '✕';
      rmBtn.className   = 'radar-rm-btn';
      rmBtn.onclick     = () => removeRadar(lid);
      row.append(swatch, label, rmBtn);
      list.appendChild(row);
    }
    sfSyncSelect();
  }

  function removeRadar(lid) {
    const entry = radarLayers.get(lid);
    if (!entry) return;
    if (map.getLayer(lid)) map.removeLayer(lid);
    entry.marker.remove();
    radarLayers.delete(lid);
    updateRadarList();
  }

  function addRadar(params) {
    const colorIdx = radarSerial % RADAR_COLORS.length;
    const color    = RADAR_COLORS[colorIdx];
    const lid      = `radar-${++radarSerial}`;

    showFeedback('覆域計算中...（数十秒かかります）', true);

    fetch('/api/viewshed', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(params),
    })
    .then(r => r.json())
    .then(data => {
      if (data.error) { showFeedback('Error: ' + data.error, false); return; }

      const layer = new RadarCoverageLayer(lid, data, color);
      // シンボル層より下に挿入（シンボルが隠れないように）
      map.addLayer(layer);

      // レーダー位置のマーカー
      const el  = document.createElement('div');
      el.className = 'radar-icon';
      el.style.borderColor = radarColorCss(color);
      el.title = `R${radarSerial}  ${params.range_km}km`;
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([params.lon, params.lat])
        .setPopup(new maplibregl.Popup({ offset: 14 })
          .setHTML(`<b>Radar R${radarSerial}</b><br>`
                 + `高度 ${params.height_agl}m AGL<br>`
                 + `射程 ${params.range_km}km<br>`
                 + `Az ${params.az_min}°–${params.az_max}°<br>`
                 + `El ${params.el_min}°–${params.el_max}°`))
        .addTo(map);

      radarLayers.set(lid, { marker, colorIdx, params });
      updateRadarList();

      // Auto-open section window at center azimuth on first add
      if (data.section) sfAutoOpen(lid, data.section);

      const m = data.meta;
      showFeedback(
        `R${radarSerial} 追加 (${m.n_vertices}頂点 / ${m.n_triangles}三角形)`, true);
    })
    .catch(e => showFeedback('Error: ' + e, false));
  }

  // --- クリックで位置設定 ------------------------------------
  let _placingRadar = false;

  document.getElementById('r-place-btn').addEventListener('click', () => {
    _placingRadar = true;
    map.getCanvas().style.cursor = 'crosshair';
    showFeedback('地図をクリックしてレーダー位置を指定', true);
  });

  map.on('click', (e) => {
    if (!_placingRadar) return;
    document.getElementById('r-lat').value = e.lngLat.lat.toFixed(5);
    document.getElementById('r-lon').value = e.lngLat.lng.toFixed(5);
    _placingRadar = false;
    map.getCanvas().style.cursor = '';
    showFeedback('位置を設定しました', true);
  });

  // --- 覆域追加ボタン ----------------------------------------
  document.getElementById('r-add-btn').addEventListener('click', () => {
    const params = {
      lat:        parseFloat(document.getElementById('r-lat').value),
      lon:        parseFloat(document.getElementById('r-lon').value),
      height_agl: parseFloat(document.getElementById('r-hagl').value),
      range_km:   parseFloat(document.getElementById('r-range').value),
      az_min:     parseFloat(document.getElementById('r-az-min').value),
      az_max:     parseFloat(document.getElementById('r-az-max').value),
      el_min:     parseFloat(document.getElementById('r-el-min').value),
      el_max:     parseFloat(document.getElementById('r-el-max').value),
    };
    if (isNaN(params.lat) || isNaN(params.lon)) {
      showFeedback('lat / lon を入力してください', false);
      return;
    }
    if (params.az_max <= params.az_min && (params.az_max - params.az_min) < 360) {
      showFeedback('Az 終了 > Az 開始 にしてください', false);
      return;
    }
    addRadar(params);
  });

  document.getElementById('r-clear-btn').addEventListener('click', () => {
    for (const lid of [...radarLayers.keys()]) removeRadar(lid);
  });

  // ================================================================
  // 断面図フローティングウィンドウ
  // ================================================================
  const sfFloat  = document.getElementById('section-float');
  const sfCanvas = document.getElementById('sf-canvas');
  const sfStatus = document.getElementById('sf-status');
  const sfSel    = document.getElementById('sf-radar-sel');
  const sfAzIn   = document.getElementById('sf-az');

  // 最後に描画した断面データ（リサイズ時に再描画するためキャッシュ）
  let sfLastSection = null;

  // キャンバスの CSS 表示サイズに描画バッファを合わせて再描画
  function sfResync() {
    const cw = sfCanvas.clientWidth;
    const ch = sfCanvas.clientHeight;
    if (cw < 40 || ch < 40) return;
    if (sfCanvas.width !== cw || sfCanvas.height !== ch) {
      sfCanvas.width  = cw;
      sfCanvas.height = ch;
    }
    if (sfLastSection) drawSection(sfCanvas, sfLastSection);
  }

  // キャンバスの CSS サイズ変化を監視（リサイズ後に自動再描画）
  new ResizeObserver(sfResync).observe(sfCanvas);

  // レーダーセレクトを radarLayers と同期
  function sfSyncSelect() {
    const prev = sfSel.value;
    sfSel.innerHTML = '';
    for (const [lid, { params }] of radarLayers) {
      const opt = document.createElement('option');
      opt.value = lid;
      const n = lid.split('-')[1];
      opt.textContent = `R${n}  ${params.lat.toFixed(3)}, ${params.lon.toFixed(3)}  ${params.range_km}km`;
      sfSel.appendChild(opt);
    }
    if (prev && sfSel.querySelector(`[value="${prev}"]`)) sfSel.value = prev;
  }

  // 断面図を取得して描画
  async function sfFetch() {
    const lid = sfSel.value;
    if (!lid) { sfStatus.textContent = 'レーダーを追加してください'; return; }
    const entry = radarLayers.get(lid);
    if (!entry) return;
    const p  = entry.params;
    const az = parseFloat(sfAzIn.value);
    if (isNaN(az)) { sfStatus.textContent = '方位角を入力してください'; return; }

    sfStatus.textContent = '計算中...';
    try {
      // az_min / az_max / el_min は C++ の必須フィールド検証を通過するために含める
      // (section_only モードでは Python 側で無視される)
      const res = await fetch('/api/viewshed', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lat:          p.lat,
          lon:          p.lon,
          height_agl:   p.height_agl,
          range_km:     p.range_km,
          az_min:       p.az_min,
          az_max:       p.az_max,
          el_min:       p.el_min,
          el_max:       p.el_max,
          section_only: true,
          az_deg:       ((az % 360) + 360) % 360,
        }),
      });
      const data = await res.json();
      if (data.error)    { sfStatus.textContent = 'Error: ' + data.error; return; }
      if (!data.section) { sfStatus.textContent = '断面データなし'; return; }
      sfLastSection = data.section;
      sfResync();
      sfStatus.textContent =
        `Az=${data.section.az_deg}°  射程 ${p.range_km} km  El≤${p.el_max}°`;
    } catch (e) {
      sfStatus.textContent = 'Error: ' + e;
    }
  }

  // 覆域追加直後に自動表示（中心方位の断面）
  function sfAutoOpen(lid, section) {
    sfLastSection = section;
    sfSyncSelect();
    sfSel.value  = lid;
    sfAzIn.value = section.az_deg;
    sfFloat.style.display = '';
    sfResync();
    const p = radarLayers.get(lid)?.params;
    sfStatus.textContent = p
      ? `Az=${section.az_deg}°  射程 ${p.range_km} km  El≤${p.el_max}°`
      : `Az=${section.az_deg}°`;
  }

  // 開く / 更新 / 閉じる
  document.getElementById('r-section-btn').addEventListener('click', () => {
    sfSyncSelect();
    sfFloat.style.display = '';
    if (sfSel.value) sfFetch();
  });
  document.getElementById('sf-update-btn').addEventListener('click', sfFetch);
  document.getElementById('sf-close-btn').addEventListener('click', () => {
    sfFloat.style.display = 'none';
  });
  sfAzIn.addEventListener('keydown', e => { if (e.key === 'Enter') sfFetch(); });

  // --- タイトルバードラッグで移動 ----------------------------------
  document.getElementById('section-float-hdr').addEventListener('mousedown', e => {
    if (e.target.id === 'sf-close-btn') return;
    e.preventDefault();
    const rect = sfFloat.getBoundingClientRect();
    const offX = e.clientX - rect.left;
    const offY = e.clientY - rect.top;
    sfFloat.style.right = 'auto';
    sfFloat.style.left  = rect.left + 'px';
    sfFloat.style.top   = rect.top  + 'px';
    function onMove(e) {
      sfFloat.style.left = (e.clientX - offX) + 'px';
      sfFloat.style.top  = (e.clientY - offY) + 'px';
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });

  // --- 8方向リサイズハンドル ---------------------------------------
  const SF_MIN_W = 280, SF_MIN_H = 230;

  sfFloat.querySelectorAll('.sf-rz').forEach(handle => {
    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      e.stopPropagation();
      const dir    = handle.dataset.dir;
      const startX = e.clientX, startY = e.clientY;
      const r = sfFloat.getBoundingClientRect();
      sfFloat.style.right  = 'auto';
      sfFloat.style.bottom = 'auto';
      sfFloat.style.left   = r.left   + 'px';
      sfFloat.style.top    = r.top    + 'px';
      sfFloat.style.width  = r.width  + 'px';
      sfFloat.style.height = r.height + 'px';
      const sl = r.left, st = r.top, sw = r.width, sh = r.height;

      function onMove(e) {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        let nl = sl, nt = st, nw = sw, nh = sh;
        if (dir.includes('e')) nw = Math.max(SF_MIN_W, sw + dx);
        if (dir.includes('s')) nh = Math.max(SF_MIN_H, sh + dy);
        if (dir.includes('w')) { nw = Math.max(SF_MIN_W, sw - dx); nl = sl + sw - nw; }
        if (dir.includes('n')) { nh = Math.max(SF_MIN_H, sh - dy); nt = st + sh - nh; }
        sfFloat.style.left   = nl + 'px';
        sfFloat.style.top    = nt + 'px';
        sfFloat.style.width  = nw + 'px';
        sfFloat.style.height = nh + 'px';
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });
  });

})();
