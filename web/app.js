'use strict';

const DEFAULT_CONFIG = {
  center:          [36.0, 137.5],
  zoom:            6,
  tile_url:        '/tiles/{z}/{x}/{y}.png',
  attribution:     'Elevation: © JAXA AW3D30',
  min_zoom:        5,
  max_zoom:        13,
  max_native_zoom: 13,
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
  // 地図初期化
  // ----------------------------------------------------------------
  const map = L.map('map', {
    zoomControl:  true,
    preferCanvas: true,
  }).setView(cfg.center, cfg.zoom);

  L.tileLayer(cfg.tile_url, {
    attribution:       cfg.attribution,
    minZoom:           cfg.min_zoom,
    maxZoom:           cfg.max_zoom,
    maxNativeZoom:     cfg.max_native_zoom,
    minNativeZoom:     cfg.min_zoom,
    updateWhenZooming: false,
    keepBuffer:        2,
    errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  }).addTo(map);

  // ----------------------------------------------------------------
  // オーバーレイレイヤー (GSI 等) — C++ の overlay_url が設定されていれば追加
  // ----------------------------------------------------------------
  let overlayLayer = null;
  if (cfg.overlay_url) {
    overlayLayer = L.tileLayer(cfg.overlay_url, {
      attribution:       cfg.overlay_attribution || '',
      opacity:           cfg.overlay_opacity ?? 0.5,
      maxNativeZoom:     18,
      maxZoom:           cfg.max_zoom,
      updateWhenZooming: false,
      keepBuffer:        2,
    }).addTo(map);

    // View メニューにトグル項目を動的追加
    const li  = document.createElement('li');
    const btn = document.createElement('button');
    btn.id          = 'menu-toggle-overlay';
    btn.textContent = 'オーバーレイ を隠す';
    li.appendChild(btn);
    document.getElementById('view-menu-dropdown').appendChild(li);

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      document.querySelectorAll('.menu-item.open').forEach(el => el.classList.remove('open'));
      if (map.hasLayer(overlayLayer)) {
        map.removeLayer(overlayLayer);
        this.textContent = 'オーバーレイ を表示';
      } else {
        map.addLayer(overlayLayer);
        this.textContent = 'オーバーレイ を隠す';
      }
    });
  }

  // ----------------------------------------------------------------
  // シンボル管理
  // ----------------------------------------------------------------
  const markers = new Map();   // label → L.Marker

  function makeIcon(sym) {
    const initials = sym.label.slice(0, 2).toUpperCase();
    return L.divIcon({
      className:   '',
      html:        `<div class="sym-icon ${sym.type}">${initials}</div>`,
      iconSize:    [32, 32],
      iconAnchor:  [16, 16],
      popupAnchor: [0, -18],
    });
  }

  function updateSymbols(symbols) {
    const seen = new Set();

    for (const sym of symbols) {
      seen.add(sym.label);
      const latlng = [sym.lat, sym.lon];

      if (markers.has(sym.label)) {
        const m = markers.get(sym.label);
        m.setLatLng(latlng);
        m.setIcon(makeIcon(sym));
      } else {
        const m = L.marker(latlng, { icon: makeIcon(sym) })
          .bindPopup(`<b>${sym.label}</b><br>種別: ${sym.type}<br>${sym.lat.toFixed(5)}, ${sym.lon.toFixed(5)}`)
          .addTo(map);
        markers.set(sym.label, m);
      }
    }

    for (const [label, m] of markers) {
      if (!seen.has(label)) { m.remove(); markers.delete(label); }
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
        const m = markers.get(sym.label);
        if (m) { map.setView(m.getLatLng(), 11); m.openPopup(); }
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
        if (x >= vr.left && x <= vr.right)         return 'vab';
        if (x >= sr.left && x <= sr.right)          return 'status';
        return null;
      }

      function onMove(e) {
        const target = panelAt(e.clientX);
        vab.classList.toggle('drop-hover',   target === 'vab');
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
        map.invalidateSize();   // Leaflet に地図サイズの変化を通知
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

  makeResizable(
    document.getElementById('handle-left'),
    document.getElementById('vab'),
    'left'
  );
  makeResizable(
    document.getElementById('handle-right'),
    document.getElementById('status-panel'),
    'right'
  );

  // ----------------------------------------------------------------
  // メニューバー — プルダウン開閉
  // ----------------------------------------------------------------
  // クリックで .open を付け外し
  document.querySelectorAll('.menu-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const item    = btn.closest('.menu-item');
      const wasOpen = item.classList.contains('open');
      document.querySelectorAll('.menu-item.open').forEach(el => el.classList.remove('open'));
      if (!wasOpen) item.classList.add('open');
    });
  });

  // メニュー外クリックで全閉じ
  document.addEventListener('click', () => {
    document.querySelectorAll('.menu-item.open').forEach(el => el.classList.remove('open'));
  });

  // ドロップダウン項目クリック後に閉じる
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
    map.invalidateSize();
  }

  document.getElementById('menu-toggle-vab').addEventListener('click', function () {
    togglePanel('vab', 'handle-left', this, 'VAB を隠す', 'VAB を表示');
  });

  document.getElementById('menu-toggle-status').addEventListener('click', function () {
    togglePanel('status-panel', 'handle-right', this, 'Status を隠す', 'Status を表示');
  });

  // Symbols > 全シンボル削除
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

  // setSymbol(label, lat, lon, type)
  document.getElementById('vab-set-btn').addEventListener('click', () => {
    const label = document.getElementById('vab-label').value.trim();
    const lat   = parseFloat(document.getElementById('vab-lat').value);
    const lon   = parseFloat(document.getElementById('vab-lon').value);
    const type  = document.getElementById('vab-type').value;
    if (!label) { showFeedback('label is required', false); return; }
    apiCall('POST', '/api/symbols', { label, lat, lon, type });
  });

  // removeSymbol(label)
  document.getElementById('vab-rm-btn').addEventListener('click', () => {
    const label = document.getElementById('vab-rm-label').value.trim();
    if (!label) { showFeedback('label is required', false); return; }
    apiCall('DELETE', `/api/symbols/${encodeURIComponent(label)}`);
  });

  // clearSymbols()
  document.getElementById('vab-clear-btn').addEventListener('click', () => {
    apiCall('DELETE', '/api/symbols');
  });

  // ----------------------------------------------------------------
  // 4×4 カスタムボタングリッド
  // 各ボタンは POST /api/btn/{n} を送る。
  // C++ 側で server.addRoute("/api/btn/1", handler) を登録すれば動く。
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
