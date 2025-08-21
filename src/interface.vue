<script setup lang="ts">
import { computed, onMounted, inject, ref, watch, toRefs, Ref } from 'vue';
import { useStores } from '@directus/extensions-sdk';
import { useRelationO2M } from './lib/use-relation-o2m';
import { DisplayItem, RelationQueryMultiple, useRelationMultiple } from './lib/use-relation-multiple';
import maplibregl from 'maplibre-gl';
import MapboxDraw from '@mapbox/mapbox-gl-draw';
import '@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css';
import type { Filter, ContentVersion } from '@directus/types';
import { clamp, get, isEmpty, isNil } from 'lodash';
import { useI18n } from 'vue-i18n';
// import { render } from 'micromustache';
// import { getMapStyle } from './style';
import { deepMap, parseFilter, getFieldsFromTemplate } from '@directus/utils';
import { addRelatedPrimaryKeyToFields } from './lib/add-related-primary-key-to-fields';
import { adjustFieldsForDisplays } from './lib/adjust-fields-for-displays';
import { cssVar } from '@directus/utils/browser';
import drawStyles from './lib/mapbox-gl-draw-styles';

type Layout = 'map' | 'table'; // retained for width classes
type SortDir = '+' | '-';

const props = withDefaults(
  defineProps<{
    value?: (number | string | Record<string, any>)[] | Record<string, any>;
    primaryKey: string | number;
    collection: string;
    field: string;
    width: string;
    disabled?: boolean;
    layout?: Layout;
    tableSpacing?: 'compact' | 'cozy' | 'comfortable';
    version: ContentVersion | null;
    fields?: Array<string>;
    template?: string | null;
    enableCreate?: boolean;
    enableSelect?: boolean;
    filter?: Filter | null;
    enableSearchFilter?: boolean;
    enableLink?: boolean;
    limit?: number;
    sort?: string;
    sortDirection?: SortDir;
    mapHeight?: string;
  }>(),
  {
    value: () => [],
    layout: 'map',
    tableSpacing: 'cozy',
    fields: () => ['id'],
    template: null,
    disabled: false,
    enableCreate: true,
    enableSelect: true,
    filter: null,
    enableSearchFilter: false,
    enableLink: true,
    mapHeight: '600px',
    limit: 1000,
  },
);

const emit = defineEmits(['input']);
const { t } = useI18n();

const { collection, field, primaryKey, version } = toRefs(props);
const { useFieldsStore } = useStores();
const fieldsStore = useFieldsStore();
// const api = useApi();

const page = ref(1);
const search = ref('');



// ---- Options (from index.ts) ----
const fieldMeta = computed(() => fieldsStore.getField(collection.value, field.value)?.meta || {});
const opt = computed(() => fieldMeta.value?.options ?? {});
const geometryField = computed<string>(() => opt.value.geometry_field || 'geometry');
const styleUrl = computed<string>(() => opt.value.map_style || 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json');
const cluster = computed<boolean>(() => Boolean(opt.value.cluster ?? true));
const allowCreate = computed<boolean>(() => Boolean(opt.value.allow_create ?? false));
const fitOnLoad = computed<boolean>(() => Boolean(opt.value.fit_on_load ?? true));
const limit = computed<number>(() => {
  // Prefer interface option, then prop, then fallback; coerce safely
  const n = Number((opt.value.limit ?? props.limit ?? 1000));
  return Number.isFinite(n) && n > 0 ? n : 1000;
});

const templateWithDefaults = computed(() => {
	return (
		props.template ||
		relationInfo.value?.relatedCollection.meta?.display_template ||
		`{{${relationInfo.value?.relatedPrimaryKeyField.field}}}`
	);
});

/** ---- Relation via stores ---- */
const { relationInfo } = useRelationO2M(collection, field);
// const { createAllowed, deleteAllowed, updateAllowed } = useRelationPermissionsO2M(relationInfo);
const updateAllowed = computed(() => true); // TODO: implement permissions
const deleteAllowed = computed(() => true); // TODO: implement permissions

const relatedCollection = computed(() => relationInfo.value?.relatedCollection?.collection ?? undefined);
const reverseFieldName = computed(() => relationInfo.value?.reverseJunctionField?.field ?? undefined);
const relatedPkFieldName = computed(() => relationInfo.value?.relatedPrimaryKeyField?.field ?? 'id');
const sortFieldName = computed(() => relationInfo.value?.sortField);

const fields = computed(() => {
	if (!relationInfo.value) return [];

	let displayFields: string[] = [];

	// if (props.layout === LAYOUTS.TABLE) {
	// 	displayFields = adjustFieldsForDisplays(props.fields, relationInfo.value.relatedCollection.collection);
	// } else {
  // }
  displayFields = adjustFieldsForDisplays(
    getFieldsFromTemplate(templateWithDefaults.value),
    relationInfo.value.relatedCollection.collection,
  );
  if (!displayFields.includes(geometryField.value)) {
    displayFields.push(geometryField.value);
  }

	return addRelatedPrimaryKeyToFields(relationInfo.value.relatedCollection.collection, displayFields);
});

const baseFilter = computed<Filter>(() => {
  const f: Filter = { _and: [] as any[] };
  if (props.filter) f._and!.push(props.filter as any);
  if (reverseFieldName.value) {
    f._and!.push({ [reverseFieldName.value]: { _eq: primaryKey.value } });
  }
  if (search.value) {
    f._and!.push({ _or: [{ [geometryField.value]: { _nnull: true } }, { $or: [{ $contains: search.value }] }] } as any);
  }
  return f;
});

const value = computed({
	get: () => props.value,
	set: (val) => {
		emit('input', val);
	},
});


// const values = inject('values', ref<Record<string, any>>({}));
const customFilter = computed(() => {
	const filter: Filter = {
		_and: [],
	};

	// const customFilter = parseFilter(
	// 	deepMap(props.filter, (val: any) => {
	// 		if (val && typeof val === 'string') {
	// 			return render(val, values.value);
	// 		}

	// 		return val;
	// 	}),
	// );

	// if (!isEmpty(customFilter)) filter._and.push(customFilter);

	if (!relationInfo.value) return filter;

	const selectFilter: Filter = {
		_or: [
			{
				[relationInfo.value.reverseJunctionField.field]: {
					_neq: props.primaryKey,
				},
			},
			{
				[relationInfo.value.reverseJunctionField.field]: {
					_null: true,
				},
			},
		],
	};

	if (selectedPrimaryKeys.value.length > 0) {
		filter._and.push({
			[relationInfo.value.relatedPrimaryKeyField.field]: {
				_nin: selectedPrimaryKeys.value,
			},
		});
	}

	if (props.primaryKey !== '+') filter._and.push(selectFilter);

	return filter;
});

/** ---- Items composable ---- */
const query = computed<RelationQueryMultiple>(() => {
  const q: RelationQueryMultiple = {
    // fields: [relatedPkFieldName.value, geometryField.value],
    fields: fields.value,
    limit: limit.value,
    page: page.value,
    search: search.value,
    sort: sortFieldName.value ? [sortFieldName.value] : [],
    filter: baseFilter.value,
  };
  return q;
});

const {
	create,
	update,
	remove,
	select,
	displayItems,
	loading,
	selected,
	totalItemCount,
	isItemSelected,
	isLocalItem,
	getItemEdits,
} = useRelationMultiple(value, query, relationInfo, primaryKey, version);
const items = displayItems;
// console.log("items", items.value);

const selectedPrimaryKeys = computed(() => {
	if (!relationInfo.value) return [];
	const relatedPkField = relationInfo.value.relatedPrimaryKeyField.field;
	return selected.value.map((item: any) => item[relatedPkField]);
});

// ---- Map setup ----
const map = ref<maplibregl.Map | null>(null);
const mapContainer = ref<HTMLDivElement | null>(null);
const mapPopup = ref<maplibregl.Popup | null>(null);
const hoveredId = ref<string | number | null>(null);
const hoveredItem = ref<Record<string, any> | null>(null);
const lastHover = ref<string | number | null>(null);
// const lassoActive = ref(false);
const draw = ref<MapboxDraw | null>(null);

// --- Map readiness flags and helpers ---
const styleReady = ref(false);

function isMapReady() {
  return !!map.value && map.value.isStyleLoaded() && !!map.value.getSource('o2m');
}


// ---- Map lifecycle ----
onMounted(async () => {
  map.value = new maplibregl.Map({
    container: mapContainer.value as HTMLDivElement,
    style: styleUrl.value,
  });

  map.value.on('load', (() => {
    ensureSourcesAndLayers(map.value as maplibregl.Map);
    // if (fitOnLoad.value) fitToData();
    map.value!.once('idle', () => {
      styleReady.value = true;
      syncSelectedState();
    });
  }) as () => void);
  const m = map.value;

  const onClick = (e: maplibregl.MapLayerMouseEvent) => {
    selectItem(e.features?.[0]?.id);
    syncSelectedState();
  };

  const onMouseMove = (e: maplibregl.MapLayerMouseEvent) => {
    const feature = e.features && e.features[0];
    if (!feature) return;
    const id = feature?.properties?.id ?? null;
    hoveredId.value = id;
    setHoverState(id);
    hoveredItem.value = feature.properties || null;
    // console.log(feature.properties);
    // console.log(hoveredItem.value);
    // const item = feature.properties;
    // const html = `<div class="o2m-tooltip">${escapeHtml(renderTemplateString(item || {}))}</div>`;

    if (!mapPopup.value) {
      mapPopup.value = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10 }).setLngLat(e.lngLat);
      const tooltipEl = document.getElementById('tooltip-template');
      if (tooltipEl) {
        mapPopup.value.setHTML(tooltipEl.innerHTML);
      }
      mapPopup.value.addTo(map.value as maplibregl.Map);
    } else {
      mapPopup.value.setLngLat(e.lngLat);
      const tooltipEl = document.getElementById('tooltip-template');
      if (tooltipEl) {
        mapPopup.value.setHTML(tooltipEl.innerHTML);
      } 
    }
  };
  const onMouseLeave = () => {
    if (mapPopup.value) {
      mapPopup.value.remove();
      mapPopup.value = null;
    }
    hoveredId.value = null;
    hoveredItem.value = null;
    setHoverState(null);
  };

  m.on('click', 'o2m-points', onClick);
  m.on('click', 'o2m-lines', onClick);
  m.on('click', 'o2m-polygons-fill', onClick);
  m.on('mousemove', 'o2m-points', onMouseMove);
  m.on('mousemove', 'o2m-lines', onMouseMove);
  m.on('mousemove', 'o2m-polygons-fill', onMouseMove);
  m.on('mouseleave', 'o2m-points', onMouseLeave);
  m.on('mouseleave', 'o2m-lines', onMouseLeave);
  m.on('mouseleave', 'o2m-polygons-fill', onMouseLeave);

  // Optional: add a keyboard escape to cancel lasso
  m.getCanvas().addEventListener('keydown', (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') cancelLasso();
  });
});

watch([items, loading, cluster], () => {
  if (!map.value) return;
  if (loading.value) return;
  // If cluster option toggled at runtime, recreate source
  if (map.value.getSource('o2m')) {
    (map.value.getSource('o2m') as any).setData(toGeoJSON(items.value, relatedPkFieldName.value, geometryField.value));
    if (fitOnLoad.value) fitToData();
    if (map.value.isStyleLoaded()) styleReady.value = true;
  }
});


function ensureSourcesAndLayers(m: maplibregl.Map) {
  if (!m.getSource('o2m')) {
    m.resize(); // the canvas size doesn't get initialized properly for some reason (full width)
    const gj = toGeoJSON(items.value, relatedPkFieldName.value, geometryField.value);
    const allPoints = (gj.features || []).every((f: any) => f?.geometry?.type === 'Point');
    // console.log("Geojson", gj)
    m.addSource('o2m', {
      type: 'geojson',
      data: gj,
      cluster: allPoints && cluster.value,
      clusterRadius: 50,
      promoteId: 'id',
    } as any);
    
    // Polygons (and MultiPolygons render as Polygon via geometry-type)
    m.addLayer({
      id: 'o2m-polygons-fill',
      type: 'fill',
      source: 'o2m',
      filter: ['==', "$type", 'Polygon'],
      paint: {
        'fill-color': [
          'case',
          ['boolean', ['feature-state', 'selected'], false], cssVar('--theme--secondary'),
          ['boolean', ['feature-state', 'hover'], false], cssVar('--theme--primary'),
          '#1f2937'
        ],
        'fill-opacity': [
          'case',
          ['boolean', ['feature-state', 'selected'], false], 0.35,
          ['boolean', ['feature-state', 'hover'], false], 0.25,
          0.15
        ],
        'fill-outline-color': '#000000',
        
      },
    });

    // Lines (and MultiLineStrings render as LineString via geometry-type)
    m.addLayer({
      id: 'o2m-lines',
      type: 'line',
      source: 'o2m',
      filter: ['==', '$type', 'LineString'],
      paint: {
        'line-color': [
          'case',
          ['boolean', ['feature-state', 'selected'], false], cssVar('--theme--secondary'),
          ['boolean', ['feature-state', 'hover'], false], cssVar('--theme--primary'),
          '#1f2937'
        ],
        'line-width': [
          'case',
          ['boolean', ['feature-state', 'selected'], false], 6,
          ['boolean', ['feature-state', 'hover'], false], 7,
          4
        ],
      },
    });

    // Points (and MultiPoints render as Point via geometry-type)
    m.addLayer({
      id: 'o2m-points',
      type: 'circle',
      source: 'o2m',
      filter: ['==', '$type', 'Point'],
      paint: {
        'circle-radius': [
          'case',
          ['boolean', ['feature-state', 'selected'], false], 9,
          ['boolean', ['feature-state', 'hover'], false], 8,
          6
        ],
        'circle-color': [
          'case',
          ['boolean', ['feature-state', 'selected'], false], cssVar('--theme--secondary'),
          ['boolean', ['feature-state', 'hover'], false], cssVar('--theme--primary'),
          '#1f2937'
        ],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': [
          'case',
          ['boolean', ['feature-state', 'selected'], false], 2,
          ['boolean', ['feature-state', 'hover'], false], 1.5,
          1
        ],
      },
    });

    // Point labels
    m.addLayer({
      id: 'o2m-point-labels',
      type: 'symbol',
      source: 'o2m',
      filter: ['==', '$type', 'Point'],
      layout: {
        'text-field': ['coalesce', ['get', '$display'], ['to-string', ['id']]],
        'text-size': 12,
        'text-offset': [0, 1.2],
      },
    });

    // Line labels (placed along the line)
    m.addLayer({
      id: 'o2m-line-labels',
      type: 'symbol',
      source: 'o2m',
      filter: ['==', '$type', 'LineString'],
      layout: {
        'symbol-placement': 'line',
        'text-field': ['coalesce', ['get', '$display'], ['to-string', ['id']]],
        'text-size': 12,
      },
    });
    m.addLayer({
      id: 'o2m-clusters',
      type: 'circle',
      source: 'o2m',
      filter: ['has', 'point_count'],
      paint: { 'circle-radius': ['step', ['get', 'point_count'], 12, 50, 18, 200, 24] },
    });

    if (fitOnLoad.value) fitToData();
    if (m.isStyleLoaded()) styleReady.value = true;

    draw.value = new MapboxDraw({
      displayControlsDefault: false,
      controls: { polygon: true, trash: true },
      styles: drawStyles,
    })
    m.addControl(draw.value);
    // lassoActive.value = true;
    // Immediately enter polygon draw mode
    // (draw.value as any).changeMode('draw_polygon');

    m.on('draw.create', onLassoCreate as any);
    m.on('draw.update', onLassoCreate as any);
    m.on('draw.delete', onLassoCreate as any);
    m.on('draw.selectionchange', onLassoCreate as any);



  } else {
    const src = m.getSource('o2m') as any;
    src.setData(toGeoJSON(items.value, relatedPkFieldName.value, geometryField.value));
    if (fitOnLoad.value) fitToData();
    if (m.isStyleLoaded()) styleReady.value = true;
  }
}

function toGeoJSON(items: any[], relatedPkFieldName: string, geometryField: string = 'geometry') {
  // console.log("items", items)
  const feats = (items || []).map(({ [geometryField]: geom, ...it }) => {
      if (!geom) return null;
      return {
        type: 'Feature',
        id: it?.[relatedPkFieldName] ?? null,
        properties: it,
        geometry: geom,
      };
    })
    .filter(Boolean);
  return { type: 'FeatureCollection', features: feats } as any;
}

function fitToData() {
  if (!map.value) return;
  const gj = toGeoJSON(items.value, relatedPkFieldName.value, geometryField.value);
  if (!gj.features.length) return;
  const bbox = turfBBox(gj as any);
  map.value.fitBounds(bbox as any, { padding: 100, duration: 0, maxZoom: 14 });
}

// Minimal bbox util (avoid turf import)
function turfBBox(fc: any): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const f of fc.features) {
    const g = f.geometry;
    const coords: number[][] = g.type === 'Point'
      ? [g.coordinates]
      : g.type === 'LineString'
      ? g.coordinates
      : g.type === 'Polygon'
      ? g.coordinates.flat()
      : g.type === 'MultiPoint'
      ? g.coordinates
      : g.type === 'MultiLineString'
      ? g.coordinates.flat()
      : g.type === 'MultiPolygon'
      ? g.coordinates.flat(2)
      : g.type === 'GeometryCollection'
      ? g.geometries.flatMap((geom: any) => geom.coordinates)
      : [];
    for (const [x, y] of coords) {
      if (x && y) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!isFinite(minX)) return [40.663894, -73.965075, 40.663894, -73.965075]; //[-180, -85, 180, 85];
  return [minX, minY, maxX, maxY];
}

function pointInRing(pt: [number, number], ring: [number, number][]) {
  // ray casting
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > pt[1]) !== (yj > pt[1])) &&
      (pt[0] < (xj - xi) * (pt[1] - yi) / ((yj - yi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygon(pt: [number, number], poly: any): boolean {
  // Supports Polygon and MultiPolygon GeoJSON
  if (!poly) return false;
  if (poly.type === 'Polygon') {
    const [outer, ...holes] = poly.coordinates as [number, number][][];
    if (!outer) return false;
    if (!pointInRing(pt, outer)) return false;
    for (const hole of holes) if (pointInRing(pt, hole)) return false;
    return true;
  } else if (poly.type === 'MultiPolygon') {
    for (const p of poly.coordinates) {
      const [outer, ...holes] = p as [number, number][][];
      if (outer && pointInRing(pt, outer)) {
        let inHole = false;
        for (const h of holes) if (pointInRing(pt, h)) { inHole = true; break; }
        if (!inHole) return true;
      }
    }
    return false;
  }
  return false;
}
function geomCentroid(g: any): [number, number] | null {
  if (!g) return null;
  const avg = (arr: number[][]) => {
    let sx = 0, sy = 0, n = 0;
    for (const [x, y] of arr) { sx += x; sy += y; n++; }
    return n ? [sx / n, sy / n] as [number, number] : null;
  };
  if (g.type === 'Point') return g.coordinates as [number, number];
  if (g.type === 'MultiPoint') return avg(g.coordinates);
  if (g.type === 'LineString') return avg(g.coordinates);
  if (g.type === 'MultiLineString') return avg(g.coordinates.flat());
  if (g.type === 'Polygon') return avg(g.coordinates[0] || []);
  if (g.type === 'MultiPolygon') return avg((g.coordinates[0] && g.coordinates[0][0]) || []);
  if (g.type === 'GeometryCollection') return avg(g.geometries.flatMap((geom: any) => geom.coordinates));
  return null;
}


// Selection and hover state management

function setHoverState(id: string | number | null) {
  if (!map.value) return;
  if (!isMapReady()) {
    map.value.once('idle', () => setHoverState(id));
    return;
  }
  if (lastHover.value != null) {
    try {
      map.value.setFeatureState({ source: 'o2m', id: lastHover.value }, { hover: false });
    } catch { /* no-op */ }
  }
  if (id != null) {
    try {
      map.value.setFeatureState({ source: 'o2m', id }, { hover: true });
    } catch { /* no-op */ }
  }
  lastHover.value = id;
}

function syncSelectedState() {
  if (!map.value) return;
  if (!isMapReady()) {
    map.value.once('idle', () => syncSelectedState());
    return;
  }
  (items.value || []).forEach((it: any) => {
    const id = it?.[relatedPkFieldName.value];
    if (id == null) return;
    const isSel = selectedKeys.value.includes(id);
    try {
      map.value!.setFeatureState({ source: 'o2m', id }, { selected: isSel });
    } catch {
      console.warn(`Failed to set feature state for id ${id} on source 'o2m'. This may be due to a missing or invalid id.`);
    }
  });
}

const selectedKeys = computed(() => {
  if (!relationInfo.value) return [];
  // console.log("selectedKeys", selection.value
	// 	.map(
	// 		// use `$index` for newly created items that don’t have a PK yet
	// 		(item) => item[relationInfo.value!.relatedPrimaryKeyField.field] ?? item.$index ?? null,
	// 	)
	// 	.filter((key) => !isNil(key)), relationInfo.value!.relatedPrimaryKeyField.field);
  
	return selection.value
		.map(
			// use `$index` for newly created items that don’t have a PK yet
			(item) => item[relationInfo.value!.relatedPrimaryKeyField.field] ?? item.$index ?? null,
		)
		.filter((key) => !isNil(key));
});

function isSelectedOnMap(item: DisplayItem) {
  if (!relationInfo.value) return false;
  const relatedPk = item[relationInfo.value.relatedPrimaryKeyField.field];
  return selectedKeys.value.includes(relatedPk);
}

function selectItem(relatedPk: string | number | undefined) {
  if (relatedPk != null) {
      const item = displayItems.value.find((i) => i[relatedPkFieldName.value] === relatedPk);
        // console.log("item", item);
      if (item) {
        const existing = selection.value.find((i) => i[relatedPkFieldName.value] === relatedPk);
        if (existing) {
          selection.value = [...selection.value.filter((i) => i !== existing)];
        } else {
          selection.value = [...selection.value, item];
        }
        console.log("selection", selection.value);
        // console.log("displayItems", displayItems.value);
      }
    }
}

function cancelLasso() {
  if (!map.value) return;
  if (draw.value) {
    try { (draw.value as any).deleteAll(); } catch {}
    // map.value.removeControl(draw.value as any);
  }
  // lassoActive.value = false;
}

function onLassoCreate(e: any) {
  try {
  const nextSel: DisplayItem[] = [];
  for (const f of e?.features || []) {
    const poly = f?.geometry;
    if (!poly) continue;
    for (const it of displayItems.value || []) {
      const g = it?.[geometryField.value];
      if (!g) continue;
      if (g.type === 'Point') {
        const pt = g.coordinates as [number, number];
        if (pointInPolygon(pt, poly)) nextSel.push(it);
      } else {
        const c = geomCentroid(g);
        if (c && pointInPolygon(c, poly)) nextSel.push(it);
      }
    }
  }
  selection.value = nextSel;
  syncSelectedState();
} catch {}
}


// ---- Link to item ----
function getItemRoute(collection: string, primaryKey: string | number) {
  const collectionRoute = `/content/${collection}`;
  const itemRoute = primaryKey === '+' ? primaryKey : encodeURIComponent(primaryKey);
  return `${collectionRoute}/${itemRoute}`;
}

function getLinkForItem(item: DisplayItem) {
	if (relationInfo.value) {
		const primaryKey = get(item, relationInfo.value.relatedPrimaryKeyField.field);

		return getItemRoute(relationInfo.value.relatedCollection.collection, primaryKey);
	}

	return null;
}



// ---- Selection / Editing / Linking ----
const currentlyEditing = ref<string | null>(null);
const selectModalActive = ref(false);
const batchEditActive = ref(false);
const pendingEdits = ref<Record<string, any>>({});
const selection = ref<DisplayItem[]>([]);

const editsAtStart = ref<Record<string, any>>({});
let newItem = false;

function editItem(item: DisplayItem) {
	if (!relationInfo.value) return;

	const relatedPkField = relationInfo.value.relatedPrimaryKeyField.field;

	newItem = false;
	editsAtStart.value = getItemEdits(item);

	if (item?.$type === 'created' && !isItemSelected(item)) {
		currentlyEditing.value = '+';
	} else {
		currentlyEditing.value = item[relatedPkField];
	}
}

function deleteItem(item: DisplayItem) {
  if (
    page.value === Math.ceil(totalItemCount.value / limit.value) &&
    page.value !== Math.ceil((totalItemCount.value - 1) / limit.value)
  ) {
    page.value = Math.max(1, page.value - 1);
  }

  remove(item);
}

function stageEdits(item: Record<string, any>) {
  newItem ? create(item) : update(item);
}

function stageBatchEdits(edits: Record<string, any>) {
	if (!relationInfo.value) return;

	const relatedPkField = relationInfo.value.relatedPrimaryKeyField.field;

	for (const item of selection.value) {
		const relatedId = get(item, [relatedPkField], null);

		const changes: Record<string, any> = {
			$index: item.$index,
			$type: item.$type,
			$edits: item.$edits,
			...getItemEdits(item),
			...edits,
		};

		if (relatedId !== null) {
			changes[relatedPkField] = relatedId;
		}

		update(changes);
	}

	selection.value = [];
}


watch([items, selectedKeys], () => {
  syncSelectedState();
});

const itemCountText = computed(() => 
  selectedKeys.value.length
    ? `${selectedKeys.value.length}/${items.value.length} ${t('items')}`
    : `${items.value.length} ${t('items')}`
);
</script>

<template>
  <div class="o2m-map">
    <v-notice v-if="!relatedCollection" type="warning">
      {{ t('relationship_not_setup') }}
    </v-notice>

    <div v-else class="map-wrapper" :class="width">
      <div ref="mapContainer" class="map-container" :style="{ height: mapHeight }" />

      <div class="actions top" :class="width">

        <v-button
          v-if="!disabled && selectedKeys.length"
          v-tooltip.bottom="t('deselect')"
          rounded icon :secondary="true"
          @click="selection = []"
        >
          <v-icon name="close" />
        </v-button>

        <v-notice v-if="loading" type="info">
          {{ t('loading_items') }}
        </v-notice>
        <v-notice v-else-if="!items.length" type="info">
          {{ t('no_items') }}
        </v-notice>
        <div v-else class="spacer" />

        <div class="item-count" v-if="items.length">{{ itemCountText }}</div>
        <div style="display: none;">
          <render-template 
            id="tooltip-template"
            :collection="relationInfo?.relatedCollection.collection"
            :item="hoveredItem"
            :template="templateWithDefaults"
          />
        </div>

        <v-button
          v-if="!disabled && enableSelect"
          v-tooltip.bottom="t('add_existing')"
          rounded icon :secondary="true"
          @click="selectModalActive = true"
        >
          <v-icon name="playlist_add" />
        </v-button>

        <v-button
          v-if="!disabled && allowCreate"
          v-tooltip.bottom="t('create_item')"
          rounded icon
          @click="() => (currentlyEditing = '+', pendingEdits = {})"
        >
          <v-icon name="add" />
        </v-button>

        <v-button
					v-if="!disabled && updateAllowed && selectedKeys.length"
					v-tooltip.bottom="t('edit')"
					rounded
					icon
					secondary
					@click="batchEditActive = true"
				>
					<v-icon name="edit" outline />
				</v-button>

      </div>

      <v-list>
          <v-list-item
            block
            v-for="element in displayItems"
            clickable
							:disabled="disabled"
							:dense="totalItemCount > 4"
              :class="{
                deleted: element.$type === 'deleted',
                selected: isSelectedOnMap(element),
                hovered: hoveredId === element[relationInfo!.relatedPrimaryKeyField.field],
                // local: isLocalItem(element)
              }"
              @click="selectItem(element[relationInfo!.relatedPrimaryKeyField.field])"
						>
							<render-template
								:collection="relationInfo?.relatedCollection.collection"
								:item="element"
								:template="templateWithDefaults"
							/>

              <v-icon
                v-if="element[geometryField] == null"
                name="visibility_off"
                v-tooltip="t('no_location')"
                style="color: var(--theme--foreground-subdued);"
              />

							<div class="spacer" />

							<div class="item-actions">
								<router-link
									v-if="enableLink && element.$type !== 'created'"
									v-tooltip="t('navigate_to_item')"
									:to="getLinkForItem(element)!"
									class="item-link"
									@click.stop
								>
									<v-icon name="launch" />
								</router-link>

                <v-icon 
                  v-if="!disabled && updateAllowed"
                  class="edit-icon"
                  :class="{ 'disabled': element.$type === 'created' }"
                  v-tooltip.bottom="t('edit')"
                  @click.stop="editItem(element)" 
                  name="edit" outline 
                />

								<v-remove
									v-if="!disabled && (deleteAllowed || isLocalItem(element))"
									:item-type="element.$type"
									:item-info="relationInfo"
									:item-is-local="isLocalItem(element)"
									:item-edits="getItemEdits(element)"
									@action="deleteItem(element)"
                  @click.stop
								/>
							</div>
						</v-list-item>
				</v-list>

      <!-- Drawers (globally registered in Directus app) -->
      <drawer-item
        :disabled="disabled"
        :active="currentlyEditing !== null"
        :collection="relationInfo?.relatedCollection.collection"
        :primary-key="currentlyEditing || '+'"
        :edits="pendingEdits"
        :circular-field="relationInfo?.reverseJunctionField.field"
        @input="stageEdits"
        @update:active="currentlyEditing = null"
      />

      <drawer-collection
        v-if="!disabled"
        v-model:active="selectModalActive"
        :collection="relationInfo?.relatedCollection.collection"
        :filter="customFilter"
        multiple
        @input="select"
      />
      <drawer-batch
        v-model:active="batchEditActive"
        :primary-keys="selectedKeys"
        :collection="relationInfo?.relatedCollection.collection"
        stage-on-save
        @input="stageBatchEdits"
      />
    </div>
    
  </div>
</template>

<style lang="scss" scoped>
.o2m-map {
  .map-wrapper {
    border: var(--theme--border-width) solid var(--theme--form--field--input--border-color);
    border-radius: var(--theme--border-radius);
    /* padding: var(--v-card-padding, 16px); */
    position: relative;
  }
  .actions {
    display: flex;
    align-items: center;
    margin: 16px 16px 8px 16px;
    gap: 8px;
    .v-notice {
      flex: 1;
    }
    .spacer { flex: 1; }
    .item-count {
      color: var(--theme--form--field--input--foreground-subdued);
      white-space: nowrap;
    }
  }
  .v-list .v-list-item .item-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .map-container {
    inline-size: 100%;
    block-size: 360px;
    border-radius: 8px;
    overflow: hidden;
    position: relative;
  }
  .legend {
    position: absolute;
    left: 24px;
    bottom: 24px;
    background: rgba(255,255,255,.9);
    border: 1px solid var(--theme--border-color-subdued);
    border-radius: 6px;
    padding: 4px 8px;
    font-size: 12px;
  }
  .v-list {
    max-height: 400px;
    .hovered {
      background-color: var(--theme--primary-background) !important;
      border-color: var(--theme--primary-subdued) !important;
    }
    .selected {
      /* background-color: var(--theme--primary) !important; */
      border-color: var(--theme--primary) !important;
    }
  }
  :deep(.mapboxgl-popup),
  :deep(.maplibregl-popup) {
    &.maplibregl-popup-anchor-bottom .maplibregl-popup-tip {
      border-top-color: var(--theme--primary-background);
    }
    &.maplibregl-popup-anchor-top .maplibregl-popup-tip {
      border-bottom-color: var(--theme--primary-background);
    }
    &.maplibregl-popup-anchor-left .maplibregl-popup-tip {
      border-right-color: var(--theme--primary-background);
    }
    &.maplibregl-popup-anchor-right .maplibregl-popup-tip {   
      border-left-color: var(--theme--primary-background);
    }
    .mapboxgl-popup-content, .maplibregl-popup-content {
      padding: 5px 10px 5px;
      font-size: 1.3em;
      background-color: var(--theme--primary-background);
      color: var(--theme--primary-foreground);
    }

    .o2m-tooltip {
      max-width: 240px;
      white-space: nowrap;
      text-overflow: ellipsis;
      overflow: hidden;
    }
  }
}
</style>