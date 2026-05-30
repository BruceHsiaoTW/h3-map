import { latLngToCell, cellToBoundary } from 'https://esm.sh/h3-js@4.1.0';

// ── Auth ───────────────────────────────────────────────────────────────────
const AUTH_USER = 'bruce';
const AUTH_HASH = '90fdf0644165a2e6ac512c080235d76e63a039ff80970f2371a51a0b1913ba67';
const SESSION_KEY = 'h3map_auth';

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function showApp() {
  document.getElementById('login-overlay').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
}

if (sessionStorage.getItem(SESSION_KEY) === '1') {
  showApp();
} else {
  const form   = document.getElementById('login-form');
  const errEl  = document.getElementById('login-error');
  const btn    = document.getElementById('login-submit');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    const user = document.getElementById('l-user').value.trim();
    const pass = document.getElementById('l-pass').value;
    const hash = await sha256(pass);
    if (user === AUTH_USER && hash === AUTH_HASH) {
      sessionStorage.setItem(SESSION_KEY, '1');
      showApp();
    } else {
      errEl.classList.remove('hidden');
      btn.disabled = false;
      document.getElementById('l-pass').value = '';
    }
  });
}

// ── Constants ──────────────────────────────────────────────────────────────
const PALETTE = [
  '#3b82f6', '#f59e0b', '#10b981', '#ef4444',
  '#8b5cf6', '#06b6d4', '#f97316', '#ec4899',
];
const RES_MIN = 3, RES_MAX = 11, RES_DEFAULT = 7;

// ── State ──────────────────────────────────────────────────────────────────
let resolution = RES_DEFAULT;
const datasets = new Map(); // id → { name, rows, color, visible, layerId, sourceId }
let nextId = 0;

// ── Map init ───────────────────────────────────────────────────────────────
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [121.5, 25.0],
  zoom: 7,
  attributionControl: false,
});

map.addControl(new maplibregl.NavigationControl(), 'bottom-right');
map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
window.__map = map; // expose for debugging

// ── UI refs ────────────────────────────────────────────────────────────────
const csvInput     = document.getElementById('csv-input');
const datasetList  = document.getElementById('dataset-list');
const resValue     = document.getElementById('res-value');
const tooltip      = document.getElementById('tooltip');
const sidebarEl    = document.getElementById('sidebar');
const toggleBtn    = document.getElementById('sidebar-toggle');

// ── Sidebar toggle ────────────────────────────────────────────────────────
toggleBtn.addEventListener('click', () => {
  sidebarEl.classList.toggle('closed');
});

// ── CSV upload ────────────────────────────────────────────────────────────
csvInput.addEventListener('change', (e) => {
  [...e.target.files].forEach(file => loadCsv(file));
  e.target.value = '';
});

function loadCsv(file) {
  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    async complete({ data, meta }) {
      if (!data.length) { alert(`"${file.name}" 無資料。`); return; }
      const headers = meta.fields || [];
      const cols = await showColumnModal(file.name, headers, data);
      if (!cols) return; // user cancelled

      const rows = data.filter(r => {
        const lat = parseFloat(r[cols.lat]);
        const lon = parseFloat(r[cols.lon]);
        return isFinite(lat) && isFinite(lon);
      });

      if (rows.length === 0) { alert(`"${file.name}" 中沒有有效座標資料。`); return; }

      const id = nextId++;
      const color = PALETTE[id % PALETTE.length];
      const ds = {
        id,
        name: file.name.replace(/\.csv$/i, ''),
        rows,
        cols,
        color,
        visible: true,
        sourceId: `h3-src-${id}`,
        layerId: `h3-layer-${id}`,
      };
      datasets.set(id, ds);
      addLayer(ds);
      renderSidebar();
    },
    error(err) { alert(`解析 "${file.name}" 時發生錯誤：${err.message}`); },
  });
}

// ── Column mapping modal ──────────────────────────────────────────────────
function showColumnModal(filename, headers, data) {
  return new Promise((resolve) => {
    const modal    = document.getElementById('col-modal');
    const backdrop = document.getElementById('col-backdrop');
    const selLat   = document.getElementById('col-lat');
    const selLon   = document.getElementById('col-lon');
    const selName  = document.getElementById('col-name');
    const selValue = document.getElementById('col-value');
    const btnOk    = document.getElementById('col-confirm');
    const btnCancel= document.getElementById('col-cancel');
    const fnEl     = document.getElementById('col-filename');
    const preview  = document.getElementById('col-preview');

    fnEl.textContent = filename;

    // Auto-detect helpers
    const norm = s => s.toLowerCase().trim();
    const guess = (keys) => headers.find(h => keys.includes(norm(h))) || '';
    const latGuess = guess(['lat','latitude','y']);
    const lonGuess = guess(['lon','lng','longitude','x']);

    // Build select options
    function fillSelect(el, withEmpty) {
      el.innerHTML = '';
      if (withEmpty) el.innerHTML = '<option value="">— 不使用 —</option>';
      headers.forEach(h => {
        const opt = document.createElement('option');
        opt.value = h; opt.textContent = h;
        el.appendChild(opt);
      });
    }
    fillSelect(selLat, false);
    fillSelect(selLon, false);
    fillSelect(selName, true);
    fillSelect(selValue, true);

    if (latGuess) selLat.value = latGuess;
    if (lonGuess) selLon.value = lonGuess;

    // Preview table (first 3 rows)
    const previewRows = data.slice(0, 3);
    preview.innerHTML =
      `<thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>` +
      `<tbody>${previewRows.map(r =>
        `<tr>${headers.map(h => `<td>${r[h] ?? ''}</td>`).join('')}</tr>`
      ).join('')}</tbody>`;

    modal.classList.remove('hidden');

    function close(result) {
      modal.classList.add('hidden');
      btnOk.removeEventListener('click', onOk);
      btnCancel.removeEventListener('click', onCancel);
      backdrop.removeEventListener('click', onCancel);
      resolve(result);
    }

    function onOk() {
      if (!selLat.value || !selLon.value) {
        selLat.style.borderColor = selLat.value ? '' : '#f87171';
        selLon.style.borderColor = selLon.value ? '' : '#f87171';
        return;
      }
      close({
        lat:   selLat.value,
        lon:   selLon.value,
        name:  selName.value  || null,
        value: selValue.value || null,
      });
    }
    function onCancel() { close(null); }

    btnOk.addEventListener('click', onOk);
    btnCancel.addEventListener('click', onCancel);
    backdrop.addEventListener('click', onCancel);
  });
}

// ── H3 layer management ───────────────────────────────────────────────────
function computeGeoJSON(rows, res, cols) {
  const cells = new Map(); // cellId → { count, valueSum, names }
  for (const row of rows) {
    const lat = parseFloat(row[cols.lat]);
    const lon = parseFloat(row[cols.lon]);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    const cell = latLngToCell(lat, lon, res);
    if (!cells.has(cell)) cells.set(cell, { count: 0, valueSum: 0, names: [] });
    const c = cells.get(cell);
    c.count++;
    if (cols.value) {
      const v = parseFloat(row[cols.value]);
      if (isFinite(v)) c.valueSum += v;
    }
    if (cols.name) {
      const n = String(row[cols.name] ?? '').trim();
      if (n) c.names.push(n);
    }
  }

  const metricFn = cols.value ? c => c.valueSum : c => c.count;
  const max = Math.max(...[...cells.values()].map(metricFn), 1);

  const features = [];
  for (const [cell, c] of cells) {
    const boundary = cellToBoundary(cell);
    // Deduplicate and join names
    const namesStr = cols.name
      ? [...new Set(c.names)].slice(0, 8).join(', ')
      : '';
    features.push({
      type: 'Feature',
      properties: {
        cell,
        count: c.count,
        valueSum: cols.value ? +c.valueSum.toFixed(4) : 0,
        names: namesStr,
        opacity: 0.25 + 0.6 * (metricFn(c) / max),
      },
      geometry: {
        type: 'Polygon',
        coordinates: [[...boundary.map(([la, lo]) => [lo, la]), [boundary[0][1], boundary[0][0]]]],
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

function addLayer(ds) {
  if (!map.isStyleLoaded()) {
    map.once('load', () => addLayer(ds));
    return;
  }
  const geojson = computeGeoJSON(ds.rows, resolution, ds.cols);
  map.addSource(ds.sourceId, { type: 'geojson', data: geojson });
  map.addLayer({
    id: ds.layerId,
    type: 'fill',
    source: ds.sourceId,
    paint: {
      'fill-color': ds.color,
      'fill-opacity': ['get', 'opacity'],
      'fill-outline-color': ds.color,
    },
  });

  // Hover tooltip
  map.on('mousemove', ds.layerId, (e) => {
    map.getCanvas().style.cursor = 'pointer';
    const p = e.features[0].properties;
    let html = `<strong>${ds.name}</strong><br>點數: ${p.count}`;
    if (ds.cols.value) html += `<br>加總 (${ds.cols.value}): ${p.valueSum.toLocaleString()}`;
    if (ds.cols.name && p.names) html += `<br>名稱: ${p.names}`;
    tooltip.innerHTML = html;
    tooltip.classList.remove('hidden');
  });
  map.on('mouseleave', ds.layerId, () => {
    map.getCanvas().style.cursor = '';
    tooltip.classList.add('hidden');
  });
  map.on('mousemove', (e) => {
    tooltip.style.left = `${e.point.x + 14}px`;
    tooltip.style.top  = `${e.point.y - 10}px`;
  });
}

function removeLayer(ds) {
  if (map.getLayer(ds.layerId))  map.removeLayer(ds.layerId);
  if (map.getSource(ds.sourceId)) map.removeSource(ds.sourceId);
}

function rebuildAllLayers() {
  for (const ds of datasets.values()) {
    if (map.getSource(ds.sourceId)) {
      map.getSource(ds.sourceId).setData(computeGeoJSON(ds.rows, resolution, ds.cols));
    }
  }
}

function setLayerVisibility(ds) {
  if (map.getLayer(ds.layerId)) {
    map.setLayoutProperty(ds.layerId, 'visibility', ds.visible ? 'visible' : 'none');
  }
}

// ── Sidebar render ─────────────────────────────────────────────────────────
function renderSidebar() {
  datasetList.innerHTML = '';
  for (const ds of datasets.values()) {
    const row = document.createElement('div');
    row.className = 'dataset-row';
    row.innerHTML = `
      <span class="ds-dot" style="background:${ds.color}"></span>
      <div class="ds-info">
        <div class="ds-name" title="${ds.name}">${ds.name}</div>
        <div class="ds-count">${ds.rows.length.toLocaleString()} 筆${ds.cols.value ? ` · Σ ${ds.cols.value}` : ''}${ds.cols.name ? ` · ${ds.cols.name}` : ''}</div>
      </div>
      <div class="ds-actions">
        <button class="ds-btn vis-btn ${ds.visible ? '' : 'hidden-ds'}" data-id="${ds.id}" title="${ds.visible ? '隱藏' : '顯示'}">
          ${ds.visible ? '👁' : '🚫'}
        </button>
        <button class="ds-btn del-btn" data-id="${ds.id}" title="刪除">🗑</button>
      </div>`;
    datasetList.appendChild(row);
  }

  datasetList.querySelectorAll('.vis-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const ds = datasets.get(Number(btn.dataset.id));
      ds.visible = !ds.visible;
      setLayerVisibility(ds);
      renderSidebar();
    });
  });

  datasetList.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.id);
      const ds = datasets.get(id);
      removeLayer(ds);
      datasets.delete(id);
      renderSidebar();
    });
  });
}

// ── Shift + scroll → change resolution ────────────────────────────────────
map.getCanvas().addEventListener('wheel', (e) => {
  if (!e.shiftKey) return;
  e.preventDefault();
  e.stopPropagation();
  const delta = e.deltaY > 0 ? -1 : 1;
  const newRes = Math.min(RES_MAX, Math.max(RES_MIN, resolution + delta));
  if (newRes === resolution) return;
  resolution = newRes;
  resValue.textContent = resolution;
  rebuildAllLayers();
}, { passive: false });
