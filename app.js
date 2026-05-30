import { latLngToCell, cellToBoundary } from 'https://esm.sh/h3-js@4.1.0';

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
    complete({ data, meta }) {
      const cols = detectLatLon(meta.fields || []);
      if (!cols) {
        alert(`無法在 "${file.name}" 中偵測到經緯度欄位。\n請確認有 lat/lon、latitude/longitude、y/x 等欄位名稱。`);
        return;
      }
      const rows = data
        .map(r => ({ lat: parseFloat(r[cols.lat]), lon: parseFloat(r[cols.lon]) }))
        .filter(r => isFinite(r.lat) && isFinite(r.lon));

      if (rows.length === 0) {
        alert(`"${file.name}" 中沒有有效座標資料。`);
        return;
      }

      const id = nextId++;
      const color = PALETTE[id % PALETTE.length];
      const ds = {
        id,
        name: file.name.replace(/\.csv$/i, ''),
        rows,
        color,
        visible: true,
        sourceId: `h3-src-${id}`,
        layerId: `h3-layer-${id}`,
      };
      datasets.set(id, ds);
      addLayer(ds);
      renderSidebar();
    },
    error(err) {
      alert(`解析 "${file.name}" 時發生錯誤：${err.message}`);
    },
  });
}

function detectLatLon(fields) {
  const norm = f => f.toLowerCase().trim();
  const LAT = ['lat', 'latitude', 'y'];
  const LON = ['lon', 'lng', 'longitude', 'x'];
  const latCol = fields.find(f => LAT.includes(norm(f)));
  const lonCol = fields.find(f => LON.includes(norm(f)));
  return latCol && lonCol ? { lat: latCol, lon: lonCol } : null;
}

// ── H3 layer management ───────────────────────────────────────────────────
function computeGeoJSON(rows, res) {
  const counts = new Map();
  for (const { lat, lon } of rows) {
    const cell = latLngToCell(lat, lon, res);
    counts.set(cell, (counts.get(cell) ?? 0) + 1);
  }
  const max = Math.max(...counts.values(), 1);
  const features = [];
  for (const [cell, count] of counts) {
    const boundary = cellToBoundary(cell);
    features.push({
      type: 'Feature',
      properties: { cell, count, opacity: 0.3 + 0.55 * (count / max) },
      geometry: {
        type: 'Polygon',
        coordinates: [[...boundary.map(([lat, lon]) => [lon, lat]), [boundary[0][1], boundary[0][0]]]],
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
  const geojson = computeGeoJSON(ds.rows, resolution);
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
    const props = e.features[0].properties;
    tooltip.innerHTML = `<strong>${ds.name}</strong><br>Cell: ${props.cell}<br>點數: ${props.count}`;
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
      map.getSource(ds.sourceId).setData(computeGeoJSON(ds.rows, resolution));
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
        <div class="ds-count">${ds.rows.length.toLocaleString()} 筆</div>
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
