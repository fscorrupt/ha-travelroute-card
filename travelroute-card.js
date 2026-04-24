// travelroute-card.js
// Custom Lovelace card: Travel route from HA History + OSRM Routing + Leaflet Map

const CARD_VERSION = '1.0.0';

// ── Leaflet + CSS via CDN ─────────────────────────────────────────────────────
const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
const LEAFLET_JS  = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
const OSRM_BASE   = 'https://router.project-osrm.org/route/v1/driving';

// ── Haversine ─────────────────────────────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtDur(min) {
  if (min >= 60) {
    const h = Math.floor(min / 60), m = Math.round(min % 60);
    return h + ' h' + (m > 0 ? ' ' + m + ' min' : '');
  }
  return Math.round(min) + ' min';
}

function fmtLocal(date) {
  return date.toLocaleString('en-GB', {
    day: '2-digit', month: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
}

function toInputDate(date) {
  // Returns YYYY-MM-DD in local time
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 10);
}

// ── Load external script (deduplicated via document check) ────────────────────
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}
function loadCSS(href, root) {
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = href;
  root.appendChild(link);
}

// ── Main Card Element ─────────────────────────────────────────────────────────
class TravelrouteCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._map = null;
    this._routeLayer = null;
    this._markersLayer = null;
    this._leafletReady = false;
    this._loading = false;
    this._config = {};
  }

  setConfig(config) {
    let entity = config.entity;
    // Fallback: if user provided the same entity for both lat and lon
    if (!entity && config.lat_entity && config.lon_entity && config.lat_entity === config.lon_entity) {
      entity = config.lat_entity;
    }

    if (!entity && (!config.lat_entity || !config.lon_entity)) {
      throw new Error('Please provide either "entity" (with location attributes) OR both "lat_entity" and "lon_entity"');
    }
    this._config = {
      title:              config.title              || 'Travel Route',
      entity:             entity,
      lat_entity:         config.lat_entity,
      lon_entity:         config.lon_entity,
      default_days:       config.default_days       || 7,
      park_threshold_min: config.park_threshold_min || 15,
      map_height:         config.map_height         || '420px',
    };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    // Only auto-load on first hass assignment
    if (!this._initialLoaded) {
      this._initialLoaded = true;
      this._initLeafletAndLoad();
    }
  }

  // ── DOM skeleton ─────────────────────────────────────────────────────────────
  _render() {
    const cfg = this._config;
    const now   = new Date();
    const start = new Date(now.getTime() - cfg.default_days * 86400000);

    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        ha-card {
          font-family: var(--primary-font-family, sans-serif);
          overflow: hidden;
        }
        .card-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 16px 8px;
          flex-wrap: wrap;
          gap: 8px;
        }
        .card-title {
          font-size: 1.05rem;
          font-weight: 600;
          color: var(--primary-text-color);
          white-space: nowrap;
        }
        .controls {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
        }
        .controls label {
          font-size: 0.75rem;
          color: var(--secondary-text-color);
        }
        input[type=date] {
          font-size: 0.78rem;
          padding: 3px 6px;
          border: 1px solid var(--divider-color, #ccc);
          border-radius: 4px;
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color);
          cursor: pointer;
        }
        .btn {
          font-size: 0.75rem;
          padding: 3px 10px;
          border: 1px solid var(--divider-color, #ccc);
          border-radius: 12px;
          background: var(--card-background-color, #fff);
          color: var(--primary-text-color);
          cursor: pointer;
          white-space: nowrap;
          transition: background 0.15s;
        }
        .btn:hover { background: var(--secondary-background-color, #eee); }
        .btn-primary {
          background: var(--primary-color, #e94560);
          color: #fff;
          border-color: transparent;
        }
        .btn-primary:hover { opacity: 0.85; }
        .btn-default-days {
          background: var(--secondary-background-color, #eee);
        }
        #map-container {
          position: relative;
          width: 100%;
          height: ${cfg.map_height};
        }
        #rc-map {
          width: 100%; height: 100%;
        }
        .overlay {
          position: absolute; inset: 0;
          display: flex; align-items: center; justify-content: center;
          background: rgba(255,255,255,0.75);
          font-size: 0.9rem;
          color: var(--secondary-text-color);
          z-index: 1000;
          flex-direction: column;
          gap: 10px;
        }
        .spinner {
          width: 32px; height: 32px;
          border: 3px solid #ddd;
          border-top-color: var(--primary-color, #e94560);
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .card-footer {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          padding: 8px 16px 12px;
          gap: 12px;
          flex-wrap: wrap;
        }
        .stats {
          font-size: 0.78rem;
          color: var(--secondary-text-color);
          line-height: 1.7;
        }
        .stats strong { color: var(--primary-color, #e94560); }
        .stops-box {
          font-size: 0.75rem;
          color: var(--secondary-text-color);
          max-height: 120px;
          overflow-y: scroll;
          overscroll-behavior: contain;
          min-width: 180px;
          max-width: 240px;
          border-left: 2px solid var(--divider-color, #ddd);
          padding-left: 10px;
          scrollbar-width: thin;
          scrollbar-color: var(--primary-color, #e94560) transparent;
        }
        .stops-box::-webkit-scrollbar { width: 4px; }
        .stops-box::-webkit-scrollbar-thumb {
          background: var(--primary-color, #e94560); border-radius: 2px;
        }
        .stop-item {
          padding: 2px 0;
          border-bottom: 1px solid var(--divider-color, #eee);
          line-height: 1.5;
        }
        .stop-item:last-child { border-bottom: none; }
        .stop-label { font-weight: 600; color: var(--primary-text-color); }
        .error-msg {
          padding: 16px;
          color: var(--error-color, #c0253e);
          font-size: 0.85rem;
        }
      </style>
      <ha-card>
        <div class="card-header">
          <span class="card-title">${cfg.title}</span>
          <div class="controls">
            <label>From</label>
            <input type="date" id="rc-from" value="${toInputDate(start)}">
            <label>To</label>
            <input type="date" id="rc-to" value="${toInputDate(now)}">
            <button class="btn btn-default-days" id="rc-btn-default">Last ${cfg.default_days}d</button>
            <button class="btn btn-primary" id="rc-btn-load">Load <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-left:2px"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>
          </div>
        </div>
        <div id="map-container">
          <div id="rc-map"></div>
          <div class="overlay" id="rc-overlay"><div class="spinner"></div><span>Loading…</span></div>
        </div>
        <div class="card-footer">
          <div class="stats" id="rc-stats"></div>
          <div class="stops-box" id="rc-stops"></div>
        </div>
      </ha-card>
    `;

    // Button events
    this.shadowRoot.getElementById('rc-btn-load').addEventListener('click', () => this._load());
    this.shadowRoot.getElementById('rc-btn-default').addEventListener('click', () => {
      const now2   = new Date();
      const start2 = new Date(now2.getTime() - cfg.default_days * 86400000);
      this.shadowRoot.getElementById('rc-from').value = toInputDate(start2);
      this.shadowRoot.getElementById('rc-to').value   = toInputDate(now2);
      this._load();
    });
    // Prevent Leaflet consuming scroll events in the footer
    const footer = this.shadowRoot.querySelector('.card-footer');
    if (footer) {
      footer.addEventListener('wheel', e => e.stopPropagation(), { passive: true });
    }
  }

  // ── Init Leaflet then load data ───────────────────────────────────────────────
  async _initLeafletAndLoad() {
    if (!this.shadowRoot.getElementById('rc-map')) return;
    loadCSS(LEAFLET_CSS, this.shadowRoot);
    await loadScript(LEAFLET_JS);
    this._leafletReady = true;
    this._initMap();
    await this._load();
  }

  _initMap() {
    const mapEl = this.shadowRoot.getElementById('rc-map');
    if (!mapEl || this._map) return;
    this._map = window.L.map(mapEl, { zoomControl: true }).setView([52.0, 10.5], 6);
    window.L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '© OpenStreetMap © CARTO',
      maxZoom: 19
    }).addTo(this._map);
    this._routeLayer   = window.L.layerGroup().addTo(this._map);
    this._markersLayer = window.L.layerGroup().addTo(this._map);
  }

  // ── Load & process ────────────────────────────────────────────────────────────
  async _load() {
    if (!this._hass || !this._leafletReady || this._loading) return;
    this._loading = true;
    this._showOverlay('Fetching position data…');
    this._clearStats();

    let hasError = false;
    try {
      const fromVal = this.shadowRoot.getElementById('rc-from').value;
      const toVal   = this.shadowRoot.getElementById('rc-to').value;
      if (!fromVal || !toVal) throw new Error('Please select a From and To date');

      const startIso = new Date(fromVal + 'T00:00:00').toISOString();
      const endIso   = new Date(toVal   + 'T23:59:59').toISOString();

      let points = [];
      let rawHistoryCount = 0;
      if (this._config.entity) {
        // Single entity mode (device_tracker or geocoded location)
        const history = await this._fetchHistory(this._config.entity, startIso, endIso);
        rawHistoryCount = history.length;
        points = this._parseSingleEntityHistory(history);
      } else {
        // Dual entity mode
        const [latHistory, lonHistory] = await Promise.all([
          this._fetchHistory(this._config.lat_entity, startIso, endIso),
          this._fetchHistory(this._config.lon_entity,  startIso, endIso),
        ]);
        rawHistoryCount = Math.min(latHistory.length, lonHistory.length);
        points = this._mergeHistory(latHistory, lonHistory);
      }

      if (points.length < 2) {
        throw new Error(`Not enough data points in the selected time range. Found ${rawHistoryCount} raw history records, but only ${points.length} had valid coordinates.`);
      }

      // Detect park stops
      const stops = this._findStops(points, this._config.park_threshold_min);

      // Fetch OSRM road route
      this._showOverlay('Calculating road route…');
      const { coords, distanceKm } = await this._fetchOSRM(points);

      // Render map
      this._drawMap(coords, points, stops);

      // Show stats
      this._showStats(distanceKm, stops, points);

    } catch (err) {
      hasError = true;
      this._showError(err.message || String(err));
    } finally {
      this._loading = false;
      if (!hasError) this._hideOverlay();
    }
  }

  // ── HA History fetch ──────────────────────────────────────────────────────────
  async _fetchHistory(entityId, startIso, endIso) {
    const path = `history/period/${startIso}?filter_entity_id=${entityId}&end_time=${endIso}&significant_changes_only=false&minimal_response=false`;
    const res = await this._hass.callApi('GET', path);
    // Returns array of arrays; first inner array is the requested entity
    if (!res || !res[0]) return [];
    return res[0].filter(s => s.state !== 'unavailable' && s.state !== 'unknown');
  }

  // ── Parse single entity history with attributes ───────────────────────────────
  _parseSingleEntityHistory(history) {
    const all = [];
    let noAttrCount = 0;

    for (const s of history) {
      if (!s.attributes || Object.keys(s.attributes).length === 0) {
        noAttrCount++;
        continue;
      }
      let lat = null, lon = null;
      
      const latAttr = s.attributes.latitude !== undefined ? s.attributes.latitude : s.attributes.Latitude;
      const lonAttr = s.attributes.longitude !== undefined ? s.attributes.longitude : s.attributes.Longitude;
      const locAttr = s.attributes.location !== undefined ? s.attributes.location : s.attributes.Location;
      
      if (latAttr !== undefined && lonAttr !== undefined) {
        lat = parseFloat(latAttr);
        lon = parseFloat(lonAttr);
      } else if (locAttr !== undefined && locAttr !== null) {
        if (Array.isArray(locAttr) && locAttr.length >= 2) {
          lat = parseFloat(locAttr[0]);
          lon = parseFloat(locAttr[1]);
        } else {
          let locStr = String(locAttr).replace(/[()[\]\s]/g, '');
          const parts = locStr.split(',');
          if (parts.length >= 2) {
            lat = parseFloat(parts[0]);
            lon = parseFloat(parts[1]);
          }
        }
      }
      
      if (lat !== null && lon !== null && !isNaN(lat) && !isNaN(lon)) {
        all.push({ time: new Date(s.last_changed), lat, lon });
      }
    }

    if (all.length === 0 && history.length > 0) {
      console.warn("travelroute-card: No valid coordinates found in history. Total records:", history.length, "Records missing attributes:", noAttrCount);
      console.warn("travelroute-card: Example record:", history[0]);
    }

    // Remove identical consecutive positions
    const deduped = [];
    for (const p of all) {
      if (deduped.length === 0) { deduped.push(p); continue; }
      const prev = deduped[deduped.length - 1];
      if (Math.abs(p.lat - prev.lat) > 0.0001 || Math.abs(p.lon - prev.lon) > 0.0001) {
        deduped.push(p);
      }
    }
    return deduped.sort((a, b) => a.time - b.time);
  }

  // ── Merge lat/lon histories by matching timestamps ────────────────────────────
  _mergeHistory(latHistory, lonHistory) {
    const latEntries = latHistory.map(s => ({ t: new Date(s.last_changed), v: parseFloat(s.state) }));
    const lonEntries = lonHistory.map(s => ({ t: new Date(s.last_changed), v: parseFloat(s.state) }));

    const lats = latEntries.sort((a, b) => a.t - b.t);
    const lons = lonEntries.sort((a, b) => a.t - b.t);

    // Pair each lat entry with the closest lon entry (within 5 seconds)
    const all = [];
    for (const latE of lats) {
      let best = null, bestDiff = Infinity;
      for (const lonE of lons) {
        const diff = Math.abs(latE.t - lonE.t);
        if (diff < bestDiff) { bestDiff = diff; best = lonE; }
      }
      if (best && bestDiff < 5000 && !isNaN(latE.v) && !isNaN(best.v)) {
        all.push({ time: latE.t, lat: latE.v, lon: best.v });
      }
    }

    // Remove identical consecutive positions
    const deduped = [];
    for (const p of all) {
      if (deduped.length === 0) { deduped.push(p); continue; }
      const prev = deduped[deduped.length - 1];
      if (Math.abs(p.lat - prev.lat) > 0.0001 || Math.abs(p.lon - prev.lon) > 0.0001) {
        deduped.push(p);
      }
    }
    return deduped.sort((a, b) => a.time - b.time);
  }

  // ── Find park stops ───────────────────────────────────────────────────────────
  _findStops(points, thresholdMin) {
    const stops = [];
    for (let i = 0; i < points.length - 1; i++) {
      const diffMin = (points[i+1].time - points[i].time) / 60000;
      if (diffMin > thresholdMin) {
        stops.push({ point: points[i], next: points[i+1], dur: diffMin });
      }
    }
    return stops;
  }

  // ── OSRM route fetch (chunked to max 80 waypoints per request) ────────────────
  async _fetchOSRM(points) {
    const MAX_WP = 80;
    let allCoords = [];
    let totalDist = 0;

    const chunks = [];
    for (let i = 0; i < points.length; i += MAX_WP - 1) {
      const end = Math.min(i + MAX_WP, points.length);
      chunks.push(points.slice(i === 0 ? 0 : i, end));
      if (end >= points.length) break;
    }

    for (let ci = 0; ci < chunks.length; ci++) {
      const chunk = chunks[ci];
      const coords = chunk.map(p => `${p.lon},${p.lat}`).join(';');
      const url = `${OSRM_BASE}/${coords}?overview=full&geometries=geojson`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`OSRM error: ${res.status}`);
      const data = await res.json();
      if (!data.routes || !data.routes[0]) throw new Error('No route received from OSRM');
      const route = data.routes[0];
      totalDist += route.distance;
      // Convert [lon, lat] to [lat, lon] for Leaflet
      const segCoords = route.geometry.coordinates.map(c => [c[1], c[0]]);
      // Drop first point on subsequent chunks to avoid duplicating the junction
      if (ci > 0 && allCoords.length > 0) segCoords.shift();
      allCoords = allCoords.concat(segCoords);
    }

    return { coords: allCoords, distanceKm: totalDist / 1000 };
  }

  // ── Draw map ──────────────────────────────────────────────────────────────────
  _drawMap(routeCoords, points, stops) {
    const L = window.L;
    this._routeLayer.clearLayers();
    this._markersLayer.clearLayers();

    if (routeCoords.length < 2) return;

    // Route polyline
    const line = L.polyline(routeCoords, {
      color: '#e94560', weight: 3, opacity: 0.85,
      lineJoin: 'round', lineCap: 'round'
    }).addTo(this._routeLayer);

    // Intermediate waypoints
    points.forEach((p, i) => {
      if (i === 0 || i === points.length - 1) return;
      L.circleMarker([p.lat, p.lon], {
        radius: 5, fillColor: '#0288d1', color: '#01579b',
        weight: 1.5, fillOpacity: 0.9
      }).addTo(this._markersLayer)
        .bindPopup(`<b>Waypoint ${i}</b><br><small>${fmtLocal(p.time)}</small>`);
    });

    // Park stop markers
    const parkIcon = L.divIcon({
      html: `<div style="width:28px;height:28px;border-radius:50%;background:#f5a623;border:2px solid #fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:bold;color:#1a1a2e;box-shadow:0 1px 5px rgba(0,0,0,.4)">P</div>`,
      className: '', iconSize: [28,28], iconAnchor: [14,14]
    });
    stops.forEach((s, i) => {
      L.marker([s.point.lat, s.point.lon], { icon: parkIcon })
        .addTo(this._markersLayer)
        .bindPopup(
          `<b>Stop #${i+1}</b><br>` +
          `<small>Arrival: ${fmtLocal(s.point.time)}</small><br>` +
          `<small>Departure: ${fmtLocal(s.next.time)}</small><br>` +
          `Duration: <b>${fmtDur(s.dur)}</b>`
        );
    });

    // Start marker
    const startIcon = L.divIcon({
      html: `<div style="width:30px;height:30px;border-radius:50%;background:#00b377;border:2px solid #fff;display:flex;align-items:center;justify-content:center;font-size:13px;color:#fff;font-weight:bold;box-shadow:0 1px 5px rgba(0,0,0,.4)">S</div>`,
      className: '', iconSize: [30,30], iconAnchor: [15,15]
    });
    const sp = points[0];
    L.marker([sp.lat, sp.lon], { icon: startIcon })
      .addTo(this._markersLayer)
      .bindPopup(`<b>Start</b><br><small>${fmtLocal(sp.time)}</small>`);

    // End marker
    const endIcon = L.divIcon({
      html: `<div style="width:30px;height:30px;border-radius:50%;background:#e94560;border:2px solid #fff;display:flex;align-items:center;justify-content:center;font-size:12px;color:#fff;font-weight:bold;box-shadow:0 1px 5px rgba(0,0,0,.4)">E</div>`,
      className: '', iconSize: [30,30], iconAnchor: [15,15]
    });
    const ep = points[points.length - 1];
    L.marker([ep.lat, ep.lon], { icon: endIcon })
      .addTo(this._markersLayer)
      .bindPopup(`<b>End</b><br><small>${fmtLocal(ep.time)}</small>`);

    // Fit map to route bounds
    this._map.fitBounds(line.getBounds(), { padding: [30, 30] });
    // Force redraw after fitBounds (Shadow DOM timing fix)
    setTimeout(() => this._map.invalidateSize(), 100);
  }

  // ── Stats & stops list ────────────────────────────────────────────────────────
  _showStats(distKm, stops, points) {
    const statsEl = this.shadowRoot.getElementById('rc-stats');
    const stopsEl = this.shadowRoot.getElementById('rc-stops');
    if (!statsEl || !stopsEl) return;

    const span = points.length > 1
      ? `${fmtLocal(points[0].time)} – ${fmtLocal(points[points.length-1].time)}`
      : '';

    statsEl.innerHTML =
      `<strong>~${Math.round(distKm).toLocaleString()} km</strong> (OSRM)<br>` +
      `${points.length} GPS points · ${stops.length} stop${stops.length !== 1 ? 's' : ''} &gt;${this._config.park_threshold_min} min<br>` +
      `<span style="font-size:0.72rem">${span}</span>`;

    if (stops.length === 0) {
      stopsEl.innerHTML = '<span style="color:var(--secondary-text-color)">No stops</span>';
      return;
    }
    stopsEl.innerHTML = stops.map((s, i) =>
      `<div class="stop-item">
        <span class="stop-label">#${i+1} ${fmtDur(s.dur)}</span><br>
        from ${fmtLocal(s.point.time)}
      </div>`
    ).join('');
  }

  _clearStats() {
    const statsEl = this.shadowRoot.getElementById('rc-stats');
    const stopsEl = this.shadowRoot.getElementById('rc-stops');
    if (statsEl) statsEl.innerHTML = '';
    if (stopsEl) stopsEl.innerHTML = '';
  }

  // ── Overlay helpers ───────────────────────────────────────────────────────────
  _showOverlay(msg) {
    const o = this.shadowRoot.getElementById('rc-overlay');
    if (!o) return;
    o.innerHTML = `<div class="spinner"></div><span>${msg}</span>`;
    o.style.display = 'flex';
  }
  _hideOverlay() {
    const o = this.shadowRoot.getElementById('rc-overlay');
    if (o) o.style.display = 'none';
  }
  _showError(msg) {
    const o = this.shadowRoot.getElementById('rc-overlay');
    if (o) {
      o.innerHTML = `<span style="color:#c0253e;padding:12px;text-align:center">⚠ ${msg}</span>`;
      o.style.display = 'flex';
    }
  }

  // ── Lovelace card size hint ───────────────────────────────────────────────────
  getCardSize() { return 6; }

  static getStubConfig() {
    return {
      entity:             'device_tracker.your_vehicle',
      default_days:       7,
      park_threshold_min: 15,
      title:              'Travel Route',
    };
  }
}

customElements.define('travelroute-card', TravelrouteCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type:        'travelroute-card',
  name:        'Travel Route Card',
  description: "Displays a vehicle's travel route using HA position sensors, OSRM road routing, and Leaflet maps — with park stop detection.",
  preview:     false,
});

console.info(
  '%c TRAVELROUTE-CARD %c v' + CARD_VERSION + ' ',
  'background:#e94560;color:#fff;padding:2px 4px;border-radius:3px 0 0 3px',
  'background:#222;color:#fff;padding:2px 4px;border-radius:0 3px 3px 0'
);
