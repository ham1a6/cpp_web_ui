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
  // ステータスパネル (右)
  // ----------------------------------------------------------------
  function updateStatus(symbols) {
    document.getElementById('count').textContent = symbols.length;

    const list = document.getElementById('symbol-list');
    list.innerHTML = '';

    const sorted = [...symbols].sort((a, b) => a.label.localeCompare(b.label));
    for (const sym of sorted) {
      const li = document.createElement('li');
      li.className = sym.type;
      li.innerHTML = `
        <div class="sym-label">${sym.label}</div>
        <div class="sym-coords">${sym.lat.toFixed(5)}, ${sym.lon.toFixed(5)}</div>`;
      li.addEventListener('click', () => {
        const m = markers.get(sym.label);
        if (m) { map.setView(m.getLatLng(), 11); m.openPopup(); }
      });
      list.appendChild(li);
    }
  }

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

})();
