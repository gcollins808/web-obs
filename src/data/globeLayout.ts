import type { SiteEdge, SiteGraphManifest, SiteNode } from '../types/site';

export const GLOBE_HUB_RADIUS = 3.05;
export const GLOBE_SURFACE_RADIUS = 5.35;
export const GLOBE_ORPHAN_RADIUS = 5.35;
export const GLOBE_EXTERNAL_RADIUS = 7.85;

export interface SectionSector {
  id: string;
  label: string;
  startAngle: number;
  endAngle: number;
  midAngle: number;
  pageCount: number;
}

export interface RoadColumn {
  id: string;
  title: string;
  count: number;
  /** Centre, left and right edge of the column and the top of its tallest stack, in world units. */
  x: number;
  left: number;
  right: number;
  top: number;
}

/** Spacing the Road layout derived from the site's own nodes; the camera fit and frame reuse it for padding. */
export interface RoadMetrics {
  rowStep: number;
  subColumnWidth: number;
  columnGap: number;
}

export const DEFAULT_ROAD_METRICS: RoadMetrics = { rowStep: 0.95, subColumnWidth: 3.8, columnGap: 2.4 };

export interface ComputedSiteLayouts {
  sectors: SectionSector[];
  roadColumns: RoadColumn[];
  roadMetrics: RoadMetrics;
  globe: Map<string, [number, number, number]>;
  road: Map<string, [number, number, number]>;
  clusters: Map<string, [number, number, number]>;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function sphericalToWorld(
  radius: number,
  azimuth: number,
  latitudeRad: number
): [number, number, number] {
  const cosLat = Math.cos(latitudeRad);
  const x = radius * cosLat * Math.sin(azimuth);
  const y = radius * Math.sin(latitudeRad);
  const z = radius * cosLat * Math.cos(azimuth);
  return [x, y, z];
}

/**
 * Computes deterministic, non-overlapping 3D coordinates for:
 * 1. `globe`: Concentric Cartographic Site Globe
 *    - Core [0,0,0]: Homepage (`/`)
 *    - Inner Hub Shell (R=3.05): Section root / pillar pages on their meridian
 *    - Main Domain Surface (R=5.35): Child pages packed cleanly inside their section's longitude slice
 *    - South Polar Drift Ring: Orphan pages (in sitemap, 0 incoming links) so isolated pages stand out
 *    - Outer Satellite Orbit (R=7.85): External domains positioned near the azimuth of linking pages
 * 2. `road`: click depth columns (home, depth 1, depth 2, depth 3+, unlinked, external), only the ones in use
 * 3. `clusters`: 3D Force-Directed Link Authority Clusters
 */
export function computeSiteLayouts(manifest: SiteGraphManifest): ComputedSiteLayouts {
  const globe = new Map<string, [number, number, number]>();
  const road = new Map<string, [number, number, number]>();

  const nodes = manifest.nodes;
  const edges = manifest.edges;

  const homeNode =
    nodes.find((n) => n.kind === 'home') ??
    nodes.find((n) => n.path === '/') ??
    nodes[0];

  const internalNonHome = nodes.filter(
    (n) => n.kind !== 'external-domain' && n.id !== homeNode?.id
  );
  const externalNodes = nodes.filter((n) => n.kind === 'external-domain');

  // Group internal non-home nodes by section
  const bySection = new Map<string, SiteNode[]>();
  for (const n of internalNonHome) {
    const sec = n.section || 'root';
    let list = bySection.get(sec);
    if (!list) {
      list = [];
      bySection.set(sec, list);
    }
    list.push(n);
  }

  const sortedSections = Array.from(bySection.entries()).sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])
  );

  const totalWeight = Math.max(
    1,
    sortedSections.reduce((acc, [, arr]) => acc + Math.max(1.5, Math.sqrt(arr.length) + arr.length * 0.45), 0)
  );

  const sectors: SectionSector[] = [];
  const sectorById = new Map<string, SectionSector>();
  let cursorAngle = 0;

  for (const [secId, arr] of sortedSections) {
    const weight = Math.max(1.5, Math.sqrt(arr.length) + arr.length * 0.45);
    const span = (weight / totalWeight) * Math.PI * 2;
    const startAngle = cursorAngle;
    const endAngle = cursorAngle + span;
    const midAngle = (startAngle + endAngle) * 0.5;
    cursorAngle = endAngle;

    const sector: SectionSector = {
      id: secId,
      label: secId === 'root' ? '/' : `/${secId}`,
      startAngle,
      endAngle,
      midAngle,
      pageCount: arr.length,
    };
    sectors.push(sector);
    sectorById.set(secId, sector);
  }

  // 1. GLOBE LAYOUT
  if (homeNode) {
    globe.set(homeNode.id, [0, 0, 0]);
  }

  const orphans: SiteNode[] = [];

  for (const [secId, arr] of sortedSections) {
    const sec = sectorById.get(secId)!;
    const usableSpan = Math.max(0.18, (sec.endAngle - sec.startAngle) * 0.8);

    const hubs = arr.filter((n) => n.kind === 'hub' && n.health !== 'orphan');
    const regularPages = arr.filter((n) => n.kind !== 'hub' && n.health !== 'orphan');
    const secOrphans = arr.filter((n) => n.health === 'orphan');
    orphans.push(...secOrphans);

    // Place section hubs on Inner Hub Shell (R = 3.05)
    hubs.sort((a, b) => b.inlinksTotal - a.inlinksTotal || a.path.localeCompare(b.path));
    hubs.forEach((hub, idx) => {
      const frac = hubs.length === 1 ? 0 : (idx / (hubs.length - 1) - 0.5);
      const az = sec.midAngle + frac * Math.min(usableSpan * 0.65, 0.7);
      const lat = hubs.length === 1 ? 0.22 : 0.28 - (idx % 2) * 0.34;
      globe.set(hub.id, sphericalToWorld(GLOBE_HUB_RADIUS, az, lat));
    });

    // Place section child pages on Main Domain Globe Surface (R = 5.35)
    regularPages.sort(
      (a, b) =>
        (a.clickDepth ?? 9) - (b.clickDepth ?? 9) ||
        b.inlinksBody - a.inlinksBody ||
        a.path.localeCompare(b.path)
    );

    const count = regularPages.length;
    regularPages.forEach((page, idx) => {
      // Spread across latitude (+48 deg down to -42 deg) by depth + index, and across sector azimuth using golden ratio offset
      const t = count === 1 ? 0.5 : idx / (count - 1);
      const latDeg = count === 1 ? 8 : 46 - t * 86;
      const latRad = (latDeg * Math.PI) / 180;
      const goldenFrac = count <= 2 ? (idx - (count - 1) * 0.5) * 0.45 : (((idx * 0.61803398875) % 1) - 0.5);
      const az = sec.midAngle + goldenFrac * usableSpan;
      globe.set(page.id, sphericalToWorld(GLOBE_SURFACE_RADIUS, az, latRad));
    });
  }

  // Place Orphan pages on a distinct South Polar Drift Ring (lat = -63 deg) so isolated pages are unmistakable
  orphans.sort((a, b) => a.path.localeCompare(b.path));
  orphans.forEach((orph, idx) => {
    const sec = sectorById.get(orph.section || 'root');
    const baseAz = sec ? sec.midAngle : (idx / Math.max(1, orphans.length)) * Math.PI * 2;
    const spread = orphans.length > 1 ? ((idx / Math.max(1, orphans.length)) * Math.PI * 2) : baseAz;
    const az = orphans.length <= 3 && sec ? baseAz + (idx - (orphans.length - 1) * 0.5) * 0.32 : spread;
    const latRad = (-63 * Math.PI) / 180;
    globe.set(orph.id, sphericalToWorld(GLOBE_ORPHAN_RADIUS, az, latRad));
  });

  // Place External Domains on the Outer Satellite Orbit (R = 7.85), aligned with the linking internal pages
  const incomingSourcesByExt = new Map<string, string[]>();
  for (const e of edges) {
    if (e.kind === 'external') {
      let arr = incomingSourcesByExt.get(e.target);
      if (!arr) {
        arr = [];
        incomingSourcesByExt.set(e.target, arr);
      }
      arr.push(e.source);
    }
  }

  externalNodes.forEach((ext, idx) => {
    const sources = incomingSourcesByExt.get(ext.id) ?? [];
    let sumSin = 0;
    let sumCos = 0;
    let sumY = 0;
    let validSources = 0;

    for (const sid of sources) {
      const p = globe.get(sid);
      if (p) {
        const horiz = Math.hypot(p[0], p[2]);
        if (horiz > 0.05) {
          sumSin += p[0] / horiz;
          sumCos += p[2] / horiz;
          sumY += p[1] / GLOBE_SURFACE_RADIUS;
          validSources++;
        }
      }
    }

    let az: number;
    let latRad: number;
    if (validSources > 0) {
      az = Math.atan2(sumSin / validSources, sumCos / validSources);
      // Offset slightly by index hash so multiple externals from same page never stack
      az += (((idx % 5) - 2) * 0.16);
      const meanY = Math.max(-0.55, Math.min(0.55, sumY / validSources));
      latRad = Math.asin(meanY) * 0.72 + (((idx % 3) - 1) * 0.14);
    } else {
      az = idx * GOLDEN_ANGLE;
      latRad = (((idx % 5) - 2) * 0.18);
    }

    globe.set(ext.id, sphericalToWorld(GLOBE_EXTERNAL_RADIUS, az, latRad));
  });

  // 2. SITEMAP ROAD LAYOUT: click depth columns left to right, each filled top to bottom.
  const { columns: roadColumns, metrics: roadMetrics } = layoutRoad(nodes, homeNode, road);

  // 3. 3D LINK CLUSTERS (Deterministic 3D Force Relaxation seeded from Globe)
  // The force simulation is O(N^2) per iteration, so it is computed on first use rather than on load.
  let clustersCache: Map<string, [number, number, number]> | null = null;
  return {
    sectors,
    roadColumns,
    roadMetrics,
    globe,
    road,
    get clusters() {
      return (clustersCache ??= relaxClusters(nodes, edges, homeNode, globe));
    },
  };
}

/**
 * Deterministic 3D force relaxation seeded from the globe layout. Flat typed arrays and index loops: the pairwise
 * repulsion runs N^2/2 times per iteration, and string-keyed Map lookups in that loop dominated the cost.
 * The arithmetic and its order match the earlier Map-based version, so the coordinates are identical.
 */
export function relaxClusters(
  nodes: readonly SiteNode[],
  edges: readonly SiteEdge[],
  homeNode: SiteNode | undefined,
  globe: ReadonlyMap<string, [number, number, number]>
): Map<string, [number, number, number]> {
  const n = nodes.length;
  const px = new Float64Array(n), py = new Float64Array(n), pz = new Float64Array(n);
  const vx = new Float64Array(n), vy = new Float64Array(n), vz = new Float64Array(n);
  const indexById = new Map<string, number>();
  let homeIndex = -1;
  for (let i = 0; i < n; i++) {
    const g = globe.get(nodes[i].id) ?? [0, 0, 0];
    px[i] = g[0] * 0.85; py[i] = g[1] * 0.85; pz[i] = g[2] * 0.85;
    indexById.set(nodes[i].id, i);
    if (homeNode && nodes[i].id === homeNode.id) homeIndex = i;
  }

  // Divide each link's spring by the busier endpoint's link count (as d3-force does), so a
  // hub with hundreds of links cannot overshoot and drive the relaxation unstable.
  const activeEdges = edges.filter((e) => e.kind !== 'internal-chrome');
  const degree = new Int32Array(n);
  for (const e of activeEdges) {
    const s = indexById.get(e.source), t = indexById.get(e.target);
    if (s !== undefined) degree[s]++;
    if (t !== undefined) degree[t]++;
  }
  // Edges whose ends are both known, as parallel arrays: source, target, ideal length, stiffness.
  const es: number[] = [], et: number[] = [], eideal: number[] = [], estiff: number[] = [];
  for (const e of activeEdges) {
    const s = indexById.get(e.source), t = indexById.get(e.target);
    if (s === undefined || t === undefined) continue;
    es.push(s); et.push(t);
    eideal.push(e.kind === 'external' ? 5.6 : e.kind === 'sitemap-hierarchy' ? 3.2 : 3.8);
    estiff.push(0.045 * Math.min(1, 8 / Math.max(degree[s], degree[t])));
  }
  const edgeCount = es.length;

  const iterations = Math.min(90, Math.max(40, Math.round(1400 / Math.max(12, n))));
  for (let iter = 0; iter < iterations; iter++) {
    const alpha = 1 - iter / iterations;
    const k = 0.52 * alpha;
    // Repulsion
    for (let i = 0; i < n; i++) {
      const ax = px[i], ay = py[i], az = pz[i];
      let vax = vx[i], vay = vy[i], vaz = vz[i];
      for (let j = i + 1; j < n; j++) {
        const dx = ax - px[j];
        const dy = ay - py[j];
        const dz = az - pz[j];
        const dSq = Math.max(0.25, dx * dx + dy * dy + dz * dz);
        const f = k / dSq;
        const dist = Math.sqrt(dSq);
        const fx = (dx / dist) * f;
        const fy = (dy / dist) * f;
        const fz = (dz / dist) * f;
        vax += fx; vay += fy; vaz += fz;
        vx[j] -= fx; vy[j] -= fy; vz[j] -= fz;
      }
      vx[i] = vax; vy[i] = vay; vz[i] = vaz;
    }

    // Spring attraction
    for (let e = 0; e < edgeCount; e++) {
      const s = es[e], t = et[e];
      const dx = px[t] - px[s];
      const dy = py[t] - py[s];
      const dz = pz[t] - pz[s];
      const dist = Math.max(0.1, Math.hypot(dx, dy, dz));
      const pull = (dist - eideal[e]) * estiff[e] * alpha;
      const fx = (dx / dist) * pull;
      const fy = (dy / dist) * pull;
      const fz = (dz / dist) * pull;
      vx[s] += fx; vy[s] += fy; vz[s] += fz;
      vx[t] -= fx; vy[t] -= fy; vz[t] -= fz;
    }

    // Centering + integrate
    for (let i = 0; i < n; i++) {
      if (i === homeIndex) {
        px[i] = 0; py[i] = 0; pz[i] = 0;
        continue;
      }
      px[i] = (px[i] + vx[i]) * 0.995;
      py[i] = (py[i] + vy[i]) * 0.995;
      pz[i] = (pz[i] + vz[i]) * 0.995;
      vx[i] *= 0.6; vy[i] *= 0.6; vz[i] *= 0.6;
    }
  }

  const clusters = new Map<string, [number, number, number]>();
  for (let i = 0; i < n; i++) clusters.set(nodes[i].id, [px[i], py[i], pz[i]]);
  return clusters;
}

/** Characters a pill label is shown with (mirrors the 28 character cut-off used for node labels). */
const ROAD_LABEL_MAX_CHARS = 28;

function roadLabelChars(node: SiteNode): number {
  if (node.kind === 'home') return 14;
  const title = node.title.split('|')[0].split(' - ')[0].trim();
  const text = title.length > 0 && title.length <= ROAD_LABEL_MAX_CHARS ? title : (node.path || '/');
  return Math.min(ROAD_LABEL_MAX_CHARS, text.length);
}

/**
 * Derives Road spacing from the nodes actually present, so it scales with the site:
 * - sub-column width follows the longer labels (90th percentile), so labels fit without a wasted gutter;
 * - row step tightens as the page count grows and relaxes for small sites.
 * Both reproduce the former fixed values (0.95 / 3.8) for a ~64 page site with ~17 character labels.
 */
export function computeRoadMetrics(nodes: readonly SiteNode[]): RoadMetrics {
  if (!nodes.length) return DEFAULT_ROAD_METRICS;
  const lengths = nodes.map(roadLabelChars).sort((a, b) => a - b);
  const labelChars = lengths[Math.min(lengths.length - 1, Math.floor(lengths.length * 0.9))];
  const subColumnWidth = Math.min(5.6, Math.max(2.6, labelChars * 0.17 + 0.9));
  const rowStep = Math.min(1.3, Math.max(0.7, 1.25 - 0.1 * Math.log2(Math.max(nodes.length, 8) / 8)));
  return { rowStep, subColumnWidth, columnGap: subColumnWidth * (2.4 / 3.8) };
}

/** Wide enough for a typical 16:9 pane once the toolbar and filter bar are taken away. */
const ROAD_TARGET_ASPECT = 2.2;

const ROAD_COLUMN_DEFS = [
  { id: 'home', title: 'Home' },
  { id: 'd1', title: 'Depth 1' },
  { id: 'd2', title: 'Depth 2' },
  { id: 'd3', title: 'Depth 3+' },
  { id: 'unlinked', title: 'Unlinked' },
  { id: 'external', title: 'External' },
] as const;

function roadColumnIndex(node: SiteNode, homeId: string | undefined): number {
  if (node.kind === 'home' || node.id === homeId) return 0;
  if (node.kind === 'external-domain') return 5;
  if (node.health === 'orphan' || node.clickDepth === null) return 4;
  if (node.clickDepth <= 1 || node.kind === 'hub') return 1;
  return node.clickDepth === 2 ? 2 : 3;
}

/**
 * Places every node into its depth column and returns the columns that hold at least one node.
 * The row count is chosen so the internal columns come out about as wide as a landscape pane;
 * a tall column wraps into side-by-side sub-columns instead of one long strip.
 */
function layoutRoad(nodes: readonly SiteNode[], homeNode: SiteNode | undefined, out: Map<string, [number, number, number]>): { columns: RoadColumn[]; metrics: RoadMetrics } {
  const metrics = computeRoadMetrics(nodes);
  const { rowStep: ROAD_ROW_STEP, subColumnWidth: ROAD_SUBCOLUMN_WIDTH, columnGap: ROAD_COLUMN_GAP } = metrics;
  const buckets: SiteNode[][] = ROAD_COLUMN_DEFS.map(() => []);
  for (const node of nodes) buckets[roadColumnIndex(node, homeNode?.id)].push(node);
  for (const bucket of buckets) {
    bucket.sort((a, b) => a.section.localeCompare(b.section) ||
      Number(b.kind === 'hub') - Number(a.kind === 'hub') || a.path.localeCompare(b.path));
  }
  const used = buckets.map((bucket, index) => ({ index, bucket })).filter(({ bucket }) => bucket.length > 0);
  if (!used.length) return { columns: [], metrics };

  const internal = used.filter(({ index }) => index !== 5);
  const sizeFor = (rows: number) => {
    const subColumns = internal.reduce((sum, { bucket }) => sum + Math.ceil(bucket.length / rows), 0);
    const width = subColumns * ROAD_SUBCOLUMN_WIDTH + Math.max(0, internal.length - 1) * ROAD_COLUMN_GAP;
    return width / Math.max(ROAD_ROW_STEP * 3, (rows - 1) * ROAD_ROW_STEP);
  };
  const largest = Math.max(1, ...internal.map(({ bucket }) => bucket.length));
  let rows = Math.min(largest, 4);
  let best = Infinity;
  for (let candidate = Math.min(largest, 4); candidate <= Math.max(4, Math.min(largest, 18)); candidate++) {
    const miss = Math.abs(Math.log(sizeFor(candidate) / ROAD_TARGET_ASPECT));
    if (miss < best - 1e-9) { best = miss; rows = candidate; }
  }
  rows = Math.max(1, rows);

  const columns: RoadColumn[] = [];
  let cursor = 0;
  for (const { index, bucket } of used) {
    const subColumns = Math.ceil(bucket.length / rows);
    const width = subColumns * ROAD_SUBCOLUMN_WIDTH;
    const left = cursor;
    let tallest = 0;
    bucket.forEach((node, i) => {
      const sub = Math.floor(i / rows);
      const row = i % rows;
      const inThisSub = Math.min(rows, bucket.length - sub * rows);
      tallest = Math.max(tallest, inThisSub);
      const x = left + (sub + 0.5) * ROAD_SUBCOLUMN_WIDTH;
      const y = ((inThisSub - 1) * 0.5 - row) * ROAD_ROW_STEP;
      // A slight alternating depth keeps the 3D feel when the camera orbits.
      const z = ((row % 2) - 0.5) * ROAD_ROW_STEP * 0.32;
      out.set(node.id, [x, y, z]);
    });
    columns.push({
      id: ROAD_COLUMN_DEFS[index].id,
      title: ROAD_COLUMN_DEFS[index].title,
      count: bucket.length,
      x: left + width / 2,
      left,
      right: left + width,
      top: ((tallest - 1) * 0.5) * ROAD_ROW_STEP,
    });
    cursor += width + ROAD_COLUMN_GAP;
  }

  // Centre the internal columns on the origin so the default camera looks at the site, not the externals.
  const internalColumns = columns.filter((column) => column.id !== 'external');
  const span = internalColumns.length ? [internalColumns[0].left, internalColumns[internalColumns.length - 1].right] : [0, cursor];
  const shift = -(span[0] + span[1]) / 2;
  for (const column of columns) { column.x += shift; column.left += shift; column.right += shift; }
  for (const [id, point] of out) out.set(id, [point[0] + shift, point[1], point[2]]);
  return { columns, metrics };
}
