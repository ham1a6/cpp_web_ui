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

  const layers = [
    { id: 'base', type: 'raster', source: 'base-tiles' },
  ];

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

  const map = new maplibregl.Map({
    container: 'map',
    style: { version: 8, sources, layers },
    center:    [initLon, initLat],
    zoom:      cfg.zoom || 6,
    pitch:     45,
    bearing:   0,
    maxZoom:   cfg.max_zoom || 18,
    minZoom:   cfg.min_zoom || 5,
    attributionControl: false,
  });

  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

  // ----------------------------------------------------------------
  // ロード後: 3D地形 & スカイ有効化
  // ----------------------------------------------------------------
  let terrainEnabled = true;

  map.on('load', () => {
    map.setTerrain({ source: 'terrain-dem', exaggeration: 2.0 });
    map.setSky({
      'sky-color':         '#1a1a2e',
      'sky-horizon-blend':  0.5,
      'horizon-color':     '#1a3a60',
      'horizon-fog-blend':  0.5,
      'fog-color':         '#0d1526',
      'fog-ground-blend':   0.5,
    });
  });

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
      map.setTerrain({ source: 'terrain-dem', exaggeration: 2.0 });
      map.easeTo({ pitch: 45, duration: 500 });
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

})();
