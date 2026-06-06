'use strict';

const TYPE_COLOR = {
  friendly: '#006fbd',
  enemy:    '#bd0000',
  neutral:  '#9a8000',
  unknown:  '#555555',
};

// Fallback config if /api/config is unavailable (server sets correct values)
const DEFAULT_CONFIG = {
  center:          [36.0, 137.5],
  zoom:            6,
  tile_url:        '/tiles/{z}/{x}/{y}.png',
  attribution:     'Elevation: © JAXA AW3D30',
  min_zoom:        5,
  max_zoom:        12,
  max_native_zoom: 12,
  title:           'Map',
};

(async () => {
  // ---- Load server configuration ------------------------------------------
  const cfg = await fetch('/api/config')
    .then(r => r.json())
    .catch(() => DEFAULT_CONFIG);

  document.title = cfg.title;
  const h2 = document.querySelector('#sidebar h2');
  if (h2) h2.textContent = cfg.title;

  // ---- Initialize Leaflet map ----------------------------------------------
  const map = L.map('map', {
    zoomControl:   true,
    preferCanvas:  true,
  }).setView(cfg.center, cfg.zoom);

  L.tileLayer(cfg.tile_url, {
    attribution:     cfg.attribution,
    minZoom:         cfg.min_zoom,
    maxZoom:         cfg.max_zoom,
    maxNativeZoom:   cfg.max_native_zoom,
    minNativeZoom:   cfg.min_zoom,
    updateWhenZooming: false,
    keepBuffer:      2,
    errorTileUrl:    'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  }).addTo(map);

  // ---- Symbol management --------------------------------------------------
  const markers = new Map();  // label -> L.Marker

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

    updateSidebar(symbols);
  }

  function updateSidebar(symbols) {
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

  // ---- Connection status --------------------------------------------------
  function setConnected(ok) {
    const dot   = document.getElementById('conn-indicator');
    const label = document.getElementById('conn-label');
    dot.className   = 'dot ' + (ok ? 'connected' : 'disconnected');
    label.textContent = ok ? 'SSE 接続中' : '再接続中...';
  }

  // ---- SSE connection -----------------------------------------------------
  function connect() {
    const es = new EventSource('/events');

    es.onopen = () => setConnected(true);

    es.onmessage = (e) => {
      try {
        updateSymbols(JSON.parse(e.data));
      } catch (err) {
        console.error('parse error', err);
      }
    };

    es.onerror = () => {
      setConnected(false);
      es.close();
      setTimeout(connect, 3000);
    };
  }

  connect();
})();
