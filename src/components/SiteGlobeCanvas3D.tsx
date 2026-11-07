import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  CSS2DObject,
  CSS2DRenderer,
} from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import {
  computeSiteLayouts,
  GLOBE_EXTERNAL_RADIUS,
  GLOBE_HUB_RADIUS,
  GLOBE_SURFACE_RADIUS,
  type ComputedSiteLayouts,
} from '../data/globeLayout';
import { attentionNodeIds, restingLabelIds } from '../data/mapAttention';
import { type BrandMark, pickBrandMark } from '../data/brandMark';
import { type LogoTone, MIN_LOGO_COVERAGE, analyseLogo, badgeColors, decodeLogo, drawBrandBadge } from './brandBadge';
import type {
  CameraAxisSnap,
  GlobeViewMode,
  NodeFilter,
  NodeHealth,
  SiteEdge,
  SiteGraphManifest,
  SiteNode,
  ThemeMode,
} from '../types/site';
import type { ViewGizmoHandle } from './ViewGizmo3D';
import { MapDiscoveryControls } from './MapDiscoveryControls';

interface SiteGlobeCanvas3DProps {
  manifest: SiteGraphManifest | null;
  viewMode: GlobeViewMode;
  theme: ThemeMode;
  selectedId: string | null;
  hoveredId: string | null;
  filter: NodeFilter;
  searchQuery: string;
  showExternal: boolean;
  showChromeLinks: boolean;
  showAllLinks: boolean;
  showPulses: boolean;
  autoRotate: boolean;
  paused?: boolean;
  inspectorOpen: boolean;
  resetSignal: number;
  flyRequest: { nodeId: string; seq: number } | null;
  axisSnapRequest: { axis: CameraAxisSnap; seq: number } | null;
  gizmoRef?: React.RefObject<ViewGizmoHandle | null>;
  onSelectNode: (id: string | null) => void;
  onHoverNode: (id: string | null) => void;
  onOpenNoteNode?: (node: SiteNode) => void;
  onBeginDiscovery?: () => void;
  onWebGLContextLost?: () => void;
  /** Reads a saved vault image as bytes; lets the home node show the site's logo. */
  readAssetBytes?: (vaultRelativePath: string) => Promise<ArrayBuffer | null>;
}

const HEALTH_COLORS_LIGHT: Record<NodeHealth, number> = {
  home: 0x7c3aed,
  hub: 0x347d59,
  healthy: 0x666666,
  orphan: 0x93621c,
  unlisted: 0x9a742b,
  redirect: 0xa45d26,
  broken: 0xb92c3c,
  unavailable: 0x93621c,
  external: 0x7358a6,
};

const HEALTH_COLORS_DARK: Record<NodeHealth, number> = {
  home: 0xa882ff,
  hub: 0x8fd6af,
  healthy: 0xb3b3b3,
  orphan: 0xe9b86c,
  unlisted: 0xe2c38a,
  redirect: 0xe3a27c,
  broken: 0xed8796,
  unavailable: 0xe9b86c,
  external: 0xc2a9de,
};

interface ScreenBox {
  l: number;
  r: number;
  t: number;
  b: number;
}

interface RuntimeNodeEntry {
  node: SiteNode;
  group: THREE.Group;
  coreMesh: THREE.Mesh;
  haloMesh: THREE.Mesh;
  coreMat: THREE.MeshStandardMaterial;
  haloMat: THREE.MeshBasicMaterial;
  cssObj: CSS2DObject;
  labelEl: HTMLDivElement;
  currentPos: THREE.Vector3;
  targetPos: THREE.Vector3;
  pillW: number;
  pillH: number;
  /** True once the label was laid out in the DOM and its real size read. */
  pillMeasured: boolean;
  /** Home node only: the brand badge drawn in place of the sphere. */
  badge?: BrandBadgeRuntime;
}

/** Badge diameter as a multiple of the home sphere's radius (the sphere itself is 2). */
const BADGE_SCALE = 2.8;

interface BrandBadgeRuntime {
  mark: BrandMark;
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  material: THREE.SpriteMaterial;
  sprite: THREE.Sprite;
  logo: { img: HTMLCanvasElement; tone: LogoTone } | null;
  theme: ThemeMode | null;
  /** Ring colour for the current theme; the halo follows it. */
  ringHex: number;
  disposed: boolean;
}

interface RuntimeEdgeEntry {
  edge: SiteEdge;
  /** Index of this edge's run of vertices in the shared edge buffers. */
  slot: number;
  /** Alpha last written to the shared colour buffer, so unchanged edges cost nothing. */
  alpha: number;
  src: RuntimeNodeEntry | undefined;
  dst: RuntimeNodeEntry | undefined;
  pulseSlot: number;
  pulsePhase: number;
  ambientEligible: boolean;
  p0: THREE.Vector3;
  p1: THREE.Vector3;
  p2: THREE.Vector3;
  lastSrc: THREE.Vector3;
  lastDst: THREE.Vector3;
  lastSrcHex: number;
  lastDstHex: number;
  pulseHighlighted: boolean;
}

function boxesOverlap(a: ScreenBox, b: ScreenBox, pad = 5): boolean {
  return !(
    a.r + pad < b.l ||
    a.l - pad > b.r ||
    a.b + pad < b.t ||
    a.t - pad > b.b
  );
}

function pushCircleXZ(pts: THREE.Vector3[], radius: number, y: number, segs = 96): void {
  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    pts.push(
      new THREE.Vector3(Math.sin(a0) * radius, y, Math.cos(a0) * radius),
      new THREE.Vector3(Math.sin(a1) * radius, y, Math.cos(a1) * radius)
    );
  }
}

function pushMeridianHalfArc(
  pts: THREE.Vector3[],
  radius: number,
  azimuth: number,
  segs = 64
): void {
  const sinAz = Math.sin(azimuth);
  const cosAz = Math.cos(azimuth);
  for (let i = 0; i < segs; i++) {
    const lat0 = -Math.PI * 0.5 + (i / segs) * Math.PI;
    const lat1 = -Math.PI * 0.5 + ((i + 1) / segs) * Math.PI;
    const c0 = Math.cos(lat0);
    const c1 = Math.cos(lat1);
    pts.push(
      new THREE.Vector3(radius * c0 * sinAz, radius * Math.sin(lat0), radius * c0 * cosAz),
      new THREE.Vector3(radius * c1 * sinAz, radius * Math.sin(lat1), radius * c1 * cosAz)
    );
  }
}

function matchesFilter(node: SiteNode, filter: NodeFilter, showExternal: boolean, attention: ReadonlySet<string>): boolean {
  if (!showExternal && node.kind === 'external-domain') return false;
  switch (filter) {
    case 'hubs':
      return node.kind === 'home' || node.kind === 'hub';
    case 'pages':
      return node.kind !== 'external-domain';
    case 'orphans':
      return node.health === 'orphan' || node.health === 'unlisted' || node.kind === 'home';
    case 'issues':
      return attention.has(node.id);
    case 'external':
      return node.kind === 'external-domain' || node.externalDomainsOut > 0;
    default:
      return true;
  }
}

const GLOBE_VIEW_DIRECTION = new THREE.Vector3(-4.4, 5.0, 16.0).normalize();
const ROAD_VIEW_DIRECTION = new THREE.Vector3(0, 0.05, 1).normalize();

/**
 * Camera position that frames every point in the stage, looking along `direction`.
 * Leaves room for labels above nodes and for the discovery chip and legend in the corners.
 */
export function fitCameraToPoints(points: readonly THREE.Vector3[], direction: THREE.Vector3, fovDeg: number, stageW: number, stageH: number) {
  const d = direction.clone().normalize();
  const forward = d.clone().negate();
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));
  if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
  right.normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const projected = points.map((p) => [p.dot(right), p.dot(up), p.dot(d)] as const);
  for (const [x, y, z] of projected) {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
  }
  if (!Number.isFinite(minX)) { minX = maxX = minY = maxY = minZ = maxZ = 0; }
  const cx = (minX + maxX) / 2; const cy = (minY + maxY) / 2; const cz = (minZ + maxZ) / 2;
  const tanV = Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2) * Math.max(0.5, (stageH - 88) / Math.max(1, stageH));
  const tanH = Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2) * Math.max(0.3, stageW / Math.max(1, stageH)) * Math.max(0.5, (stageW - 40) / Math.max(1, stageW));
  // Exact per-point fit: a point nearer the camera needs more room than one at the back.
  // Padding covers the node radius and the label that sits above each node.
  let distance = 6;
  for (const [x, y, z] of projected) {
    const depth = z - cz;
    distance = Math.max(distance, depth + (Math.abs(x - cx) + 0.9) / tanH, depth + (Math.abs(y - cy) + 0.8) / tanV);
  }
  distance = Math.min(40, distance);
  const center = right.multiplyScalar(cx).add(up.multiplyScalar(cy)).add(d.clone().multiplyScalar(cz));
  return { lookTarget: center, camTarget: center.clone().addScaledVector(d, distance) };
}

function shortPillLabel(node: SiteNode, domain?: string): string {
  if (node.kind === 'home') {
    const cleanDomain = (
      domain ||
      node.url.replace(/^https?:\/\//i, '').replace(/\/.*$/, '') ||
      'site'
    ).trim();
    return cleanDomain;
  }
  if (node.kind === 'external-domain') return node.title;
  const cleanTitle = node.title.split('|')[0].split(' - ')[0].trim();
  if (cleanTitle.length > 0 && cleanTitle.length <= 28) return cleanTitle;
  const p = node.path || '/';
  if (p.length <= 28) return p;
  const parts = p.split('/').filter(Boolean);
  const last = parts[parts.length - 1] ?? p;
  return `/${last.slice(0, 24)}`;
}

export const SiteGlobeCanvas3D: React.FC<SiteGlobeCanvas3DProps> = ({
  manifest,
  viewMode,
  theme,
  selectedId,
  hoveredId,
  filter,
  searchQuery,
  showExternal,
  showChromeLinks,
  showAllLinks,
  showPulses,
  autoRotate,
  paused = false,
  inspectorOpen,
  resetSignal,
  flyRequest,
  axisSnapRequest,
  gizmoRef,
  onSelectNode,
  onHoverNode,
  onOpenNoteNode,
  onBeginDiscovery,
  onWebGLContextLost,
  readAssetBytes,
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [renderUnavailable, setRenderUnavailable] = useState(false);
  const [discoveryFocusId, setDiscoveryFocusId] = useState<string | null>(null);
  const effectiveSelectedId = selectedId ?? discoveryFocusId;
  const pausedRef = useRef<boolean>(paused);
  pausedRef.current = paused;

  const layouts = useMemo(
    () => (manifest ? computeSiteLayouts(manifest) : null),
    [manifest]
  );
  const attention = useMemo(() => attentionNodeIds(manifest), [manifest]);
  const discoveryNodes = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return (manifest?.nodes ?? []).filter(node => matchesFilter(node, filter, showExternal, attention) &&
      (!query || [node.title, node.path, node.url].join(' ').toLowerCase().includes(query)));
  }, [manifest, filter, searchQuery, showExternal, attention]);

  // Bumped on every React render so any prop change marks the scene dirty for the on-demand frame loop.
  const renderVersionRef = useRef(0);
  const stateRef = useRef({
    manifest,
    layouts,
    attention,
    viewMode,
    theme,
    selectedId: effectiveSelectedId,
    hoveredId,
    filter,
    searchQuery,
    showExternal,
    showChromeLinks,
    showAllLinks,
    showPulses,
    autoRotate,
    inspectorOpen,
  });
  renderVersionRef.current += 1;
  stateRef.current = {
    manifest,
    layouts,
    attention,
    viewMode,
    theme,
    selectedId: effectiveSelectedId,
    hoveredId,
    filter,
    searchQuery,
    showExternal,
    showChromeLinks,
    showAllLinks,
    showPulses,
    autoRotate,
    inspectorOpen,
  };

  const callbacksRef = useRef({
    onSelectNode,
    onHoverNode,
    onOpenNoteNode,
    onWebGLContextLost,
    onBeginDiscovery,
  });
  callbacksRef.current = {
    onSelectNode,
    onHoverNode,
    onOpenNoteNode,
    onWebGLContextLost,
    onBeginDiscovery,
  };

  const assetReaderRef = useRef(readAssetBytes);
  assetReaderRef.current = readAssetBytes;

  const gizmoHolderRef = useRef(gizmoRef);
  gizmoHolderRef.current = gizmoRef;

  const syncGraphRef = useRef<((m: SiteGraphManifest | null) => void) | null>(null);
  const cameraFlyRef = useRef<{
    active: boolean;
    camTarget: THREE.Vector3;
    lookTarget: THREE.Vector3;
    instant?: boolean;
  }>({
    active: false,
    camTarget: new THREE.Vector3(0, 4.2, 16.5),
    lookTarget: new THREE.Vector3(0, 0, 0),
  });
  const wakeLoopRef = useRef<(() => void) | null>(null);
  const discoverCameraRef = useRef<((nodeId: string) => void) | null>(null);
  const fitCameraRef = useRef<((mode: GlobeViewMode, layouts: ComputedSiteLayouts) => void) | null>(null);
  const discoverNode = useCallback((nodeId: string) => {
    if (callbacksRef.current.onBeginDiscovery) callbacksRef.current.onBeginDiscovery();
    else callbacksRef.current.onSelectNode(null);
    setDiscoveryFocusId(nodeId);
    callbacksRef.current.onHoverNode(null);
    discoverCameraRef.current?.(nodeId);
  }, []);
  const inspectDiscoveryNode = useCallback((nodeId: string) => {
    callbacksRef.current.onSelectNode(nodeId);
  }, []);
  useEffect(() => { setDiscoveryFocusId(null); }, [manifest, filter, searchQuery, showExternal]);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;
    const selectFromMap = (nodeId: string | null) => {
      setDiscoveryFocusId(null);
      callbacksRef.current.onSelectNode(nodeId);
    };

    const width = Math.max(320, container.clientWidth);
    const height = Math.max(260, container.clientHeight);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 180);
    camera.position.set(-4.6, 5.2, 16.2);

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance',
      });
    } catch {
      setRenderUnavailable(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    container.appendChild(renderer.domElement);

    const labelRenderer = new CSS2DRenderer();
    labelRenderer.setSize(width, height);
    labelRenderer.domElement.className = 'wo-css2d-layer';
    container.appendChild(labelRenderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.minDistance = 2.8;
    controls.maxDistance = 42;
    controls.target.set(0, 0, 0);

    controls.addEventListener('start', () => {
      cameraFlyRef.current.active = false;
    });

    // Subtle studio lighting for 3D node spheres
    const ambient = new THREE.AmbientLight(0xffffff, 1.35);
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.45);
    keyLight.position.set(8, 14, 12);
    const rimLight = new THREE.DirectionalLight(0xa882ff, 0.65);
    rimLight.position.set(-10, -6, -8);
    scene.add(ambient, keyLight, rimLight);

    const disposables: Array<{ dispose: () => void }> = [];
    const track = <T extends { dispose: () => void }>(obj: T): T => {
      disposables.push(obj);
      return obj;
    };

    // =========================================================================
    // 1. CARTOGRAPHIC SITE GLOBE WIREFRAME & DYNAMIC SECTION MERIDIANS
    // =========================================================================
    const globeFrameGroup = new THREE.Group();
    scene.add(globeFrameGroup);

    const primaryWireMat = track(
      new THREE.LineBasicMaterial({
        color: 0xa882ff,
        transparent: true,
        opacity: 0.24,
        depthWrite: false,
      })
    );
    const secondaryWireMat = track(
      new THREE.LineBasicMaterial({
        color: 0x858585,
        transparent: true,
        opacity: 0.14,
        depthWrite: false,
      })
    );
    const orphanRingMat = track(
      new THREE.LineBasicMaterial({
        color: 0x93621c,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
      })
    );
    const externalOrbitMat = track(
      new THREE.LineBasicMaterial({
        color: 0x7c3aed,
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
      })
    );

    // Static precision graticule
    {
      const primPts: THREE.Vector3[] = [];
      const secPts: THREE.Vector3[] = [];
      const orphPts: THREE.Vector3[] = [];
      const extPts: THREE.Vector3[] = [];

      // Core ring & Inner Hub shell equator
      pushCircleXZ(primPts, 1.05, 0, 64);
      pushCircleXZ(secPts, GLOBE_HUB_RADIUS, 0, 80);

      // Main Domain Globe equator + tropic/polar parallels (R = 5.35)
      pushCircleXZ(primPts, GLOBE_SURFACE_RADIUS, 0, 112);
      for (const deg of [26, -26, 50]) {
        const rad = (deg * Math.PI) / 180;
        pushCircleXZ(
          secPts,
          Math.cos(rad) * GLOBE_SURFACE_RADIUS,
          Math.sin(rad) * GLOBE_SURFACE_RADIUS,
          96
        );
      }

      // South Polar Orphan Drift Belt (-63 deg)
      {
        const rad = (-63 * Math.PI) / 180;
        pushCircleXZ(
          orphPts,
          Math.cos(rad) * GLOBE_SURFACE_RADIUS,
          Math.sin(rad) * GLOBE_SURFACE_RADIUS,
          80
        );
      }

      // Polar central axis spindle
      primPts.push(
        new THREE.Vector3(0, -GLOBE_SURFACE_RADIUS * 1.04, 0),
        new THREE.Vector3(0, GLOBE_SURFACE_RADIUS * 1.04, 0)
      );

      // Base 4 cardinal meridians (faint reference when 0 sections exist)
      for (let m = 0; m < 8; m++) {
        pushMeridianHalfArc(secPts, GLOBE_SURFACE_RADIUS, (m / 8) * Math.PI * 2, 56);
      }

      // Outer External Satellite Ring (R = 7.85)
      pushCircleXZ(extPts, GLOBE_EXTERNAL_RADIUS, 0, 120);
      pushCircleXZ(
        extPts,
        Math.cos(0.28) * GLOBE_EXTERNAL_RADIUS,
        Math.sin(0.28) * GLOBE_EXTERNAL_RADIUS,
        96
      );
      pushCircleXZ(
        extPts,
        Math.cos(-0.28) * GLOBE_EXTERNAL_RADIUS,
        Math.sin(-0.28) * GLOBE_EXTERNAL_RADIUS,
        96
      );

      globeFrameGroup.add(
        new THREE.LineSegments(track(new THREE.BufferGeometry().setFromPoints(primPts)), primaryWireMat),
        new THREE.LineSegments(track(new THREE.BufferGeometry().setFromPoints(secPts)), secondaryWireMat),
        new THREE.LineSegments(track(new THREE.BufferGeometry().setFromPoints(orphPts)), orphanRingMat),
        new THREE.LineSegments(track(new THREE.BufferGeometry().setFromPoints(extPts)), externalOrbitMat)
      );
    }

    // Dynamic section meridians & CSS2D equator plaques
    const dynamicSectorsGroup = new THREE.Group();
    globeFrameGroup.add(dynamicSectorsGroup);
    let dynamicSectorGeoms: THREE.BufferGeometry[] = [];
    let dynamicSectorPlaques: CSS2DObject[] = [];
    const tagSizes = new WeakMap<HTMLElement, { w: number; h: number }>();

    const clearDynamicSectors = () => {
      for (const p of dynamicSectorPlaques) {
        dynamicSectorsGroup.remove(p);
        p.element.remove();
      }
      dynamicSectorPlaques = [];
      for (const g of dynamicSectorGeoms) g.dispose();
      dynamicSectorGeoms = [];
      dynamicSectorsGroup.clear();
    };

    // =========================================================================
    // 2. SITEMAP ROAD STAGE COLUMNS
    // =========================================================================
    const roadFrameGroup = new THREE.Group();
    roadFrameGroup.visible = false;
    scene.add(roadFrameGroup);
    let roadTags: CSS2DObject[] = [];
    let roadGeoms: THREE.BufferGeometry[] = [];
    const clearRoadFrame = () => {
      for (const tag of roadTags) { roadFrameGroup.remove(tag); tag.element.remove(); }
      roadTags = [];
      for (const geom of roadGeoms) geom.dispose();
      roadGeoms = [];
      roadFrameGroup.clear();
    };
    // Column titles sit above each depth column; faint rules separate neighbouring columns.
    const buildRoadFrame = (curLayouts: ComputedSiteLayouts, domain: string) => {
      clearRoadFrame();
      const columns = curLayouts.roadColumns;
      const top = Math.max(1, ...columns.map((column) => column.top));
      const pts: THREE.Vector3[] = [];
      columns.forEach((column, index) => {
        if (index > 0) {
          const x = (columns[index - 1].right + column.left) / 2;
          pts.push(new THREE.Vector3(x, -top - 0.5, 0), new THREE.Vector3(x, top + 0.5, 0));
        }
        const el = document.createElement('div');
        el.className = 'wo-sector-tag wo-road-tag';
        el.dataset.columnId = column.id;
        el.textContent = column.id === 'home' ? domain || column.title : `${column.title} · ${column.count}`;
        const obj = new CSS2DObject(el);
        obj.position.set(column.x, top + 1.05, 0);
        roadFrameGroup.add(obj);
        roadTags.push(obj);
      });
      if (pts.length) {
        const geom = new THREE.BufferGeometry().setFromPoints(pts);
        roadGeoms.push(geom);
        roadFrameGroup.add(new THREE.LineSegments(geom, secondaryWireMat));
      }
    };

    // =========================================================================
    // 3. DYNAMIC NODES, EDGES, & SUBTLE MICRO-LIGHT FLOW
    // =========================================================================
    const sceneSpinGroup = new THREE.Group();
    sceneSpinGroup.add(globeFrameGroup);
    scene.add(sceneSpinGroup);

    const nodesRoot = new THREE.Group();
    const edgesRoot = new THREE.Group();
    sceneSpinGroup.add(edgesRoot, nodesRoot);
    discoverCameraRef.current = (nodeId) => {
      const state = stateRef.current;
      const map = state.viewMode === 'road' ? state.layouts?.road : state.viewMode === 'clusters' ? state.layouts?.clusters : state.layouts?.globe;
      const coordinates = map?.get(nodeId);
      if (!coordinates) return;
      sceneSpinGroup.updateWorldMatrix(true, false);
      const point = new THREE.Vector3(...coordinates);
      if (state.viewMode === 'globe') sceneSpinGroup.localToWorld(point);
      const direction = point.length() > .2 ? point.clone().normalize() : new THREE.Vector3(0, .3, 1).normalize();
      const kind = state.manifest?.nodes.find(node => node.id === nodeId)?.kind;
      const distance = kind === 'home' ? 8 : kind === 'hub' ? 7 : 6.2;
      cameraFlyRef.current = {
        active: true,
        lookTarget: point.clone(),
        camTarget: point.clone().addScaledVector(direction, distance).add(new THREE.Vector3(0, 1.1, 0)),
        instant: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
      };
    };

    fitCameraRef.current = (mode, curLayouts) => {
      const state = stateRef.current;
      const map = mode === 'road' ? curLayouts.road : mode === 'clusters' ? curLayouts.clusters : curLayouts.globe;
      const points: THREE.Vector3[] = [];
      for (const node of state.manifest?.nodes ?? []) {
        if (node.kind === 'external-domain' && !state.showExternal) continue;
        const coordinates = map.get(node.id);
        if (coordinates) points.push(new THREE.Vector3(...coordinates));
      }
      if (mode === 'road') {
        const top = Math.max(1, ...curLayouts.roadColumns.map((column) => column.top));
        points.push(new THREE.Vector3(0, top + 1.05, 0));
      } else if (mode === 'globe') {
        // Frame the globe wireframe, not just the nodes on it.
        const r = GLOBE_SURFACE_RADIUS;
        points.push(new THREE.Vector3(r, 0, 0), new THREE.Vector3(-r, 0, 0), new THREE.Vector3(0, r, 0),
          new THREE.Vector3(0, -r, 0), new THREE.Vector3(0, 0, r), new THREE.Vector3(0, 0, -r));
      }
      if (!points.length) return;
      const fit = fitCameraToPoints(points, mode === 'road' ? ROAD_VIEW_DIRECTION : GLOBE_VIEW_DIRECTION, camera.fov, stageW, stageH);
      cameraFlyRef.current = { active: true, ...fit };
    };

    const unitSphereGeom = track(new THREE.SphereGeometry(1, 22, 22));
    const unitHaloGeom = track(new THREE.RingGeometry(1.32, 1.65, 28));
    const pulseGeom = track(new THREE.SphereGeometry(0.017, 8, 8));
    const pulseMat = track(
      new THREE.MeshBasicMaterial({
        color: 0xa882ff,
        transparent: true,
        opacity: 0.62,
        depthWrite: false,
      })
    );

    const runtimeNodes = new Map<string, RuntimeNodeEntry>();
    const runtimeEdges = new Map<string, RuntimeEdgeEntry>();
    const pickableMeshes: THREE.Mesh[] = [];

    // Every edge lives in one LineSegments object: one draw call and one material however many links the
    // site has. Colour carries per-edge alpha (RGBA), so a hidden or dimmed edge is a buffer write, not an object.
    // The curve is cut into fewer segments as the edge count grows, which keeps the buffers small on big sites.
    let edgeBuffers: {
      lines: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
      segments: number;
      position: THREE.BufferAttribute;
      color: THREE.BufferAttribute;
    } | null = null;
    const edgeSegmentsFor = (edgeCount: number) =>
      edgeCount <= 300 ? 20 : edgeCount <= 1500 ? 12 : edgeCount <= 6000 ? 6 : 3;

    let pulseCapacity = 128;
    let pulseInstanced = new THREE.InstancedMesh(pulseGeom, pulseMat, pulseCapacity);
    pulseInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    pulseInstanced.frustumCulled = false;
    edgesRoot.add(pulseInstanced);

    const clearRuntimeGraph = () => {
      runtimeNodes.forEach((entry) => {
        entry.group.remove(entry.cssObj);
        entry.labelEl.remove();
        entry.coreMat.dispose();
        entry.haloMat.dispose();
        if (entry.badge) {
          entry.badge.disposed = true;
          entry.badge.texture.dispose();
          entry.badge.material.dispose();
        }
        nodesRoot.remove(entry.group);
      });
      runtimeNodes.clear();
      pickableMeshes.length = 0;

      runtimeEdges.clear();
      if (edgeBuffers) {
        edgesRoot.remove(edgeBuffers.lines);
        edgeBuffers.lines.geometry.dispose();
        edgeBuffers.lines.material.dispose();
        edgeBuffers = null;
      }
      pulseInstanced.count = 0;
    };

    // Frame-loop invalidation state. The heavy scene and label work runs only when something changed.
    let forceHeavy = true;
    let lastKey = '';
    let lastManifestRef: unknown = null;
    let lastLayoutsRef: unknown = null;
    let lastVersion = -1;
    let nodesSettled = false;
    let measureAttempts = 0;
    let syncedGizmo: unknown = null;
    let labelHoverId: string | null = null;
    let restingCache: { manifest: unknown; key: string; count: number; attention: unknown; ids: Set<string> } = { manifest: null, key: '', count: -1, attention: null, ids: new Set() };
    let pulseEdges: RuntimeEdgeEntry[] = [];
    const lastCamPos = new THREE.Vector3(Number.NaN, 0, 0);
    const lastCamQuat = new THREE.Quaternion(Number.NaN, 0, 0, 1);

    const rebuildGraph = (nextManifest: SiteGraphManifest | null) => {
      forceHeavy = true;
      clearRuntimeGraph();
      clearDynamicSectors();
      clearRoadFrame();
      if (!nextManifest) return;

      const curLayouts = stateRef.current.layouts ?? computeSiteLayouts(nextManifest);
      buildRoadFrame(curLayouts, nextManifest.domain);

      // Build section boundary meridians & sector plaques
      const mPts: THREE.Vector3[] = [];
      for (const sec of curLayouts.sectors) {
        pushMeridianHalfArc(mPts, GLOBE_SURFACE_RADIUS, sec.startAngle, 56);
        if (curLayouts.sectors.length >= 1) {
          const el = document.createElement('div');
          el.className = 'wo-sector-tag';
          el.textContent = `${sec.label} · ${sec.pageCount}`;
          const obj = new CSS2DObject(el);
          const rTag = GLOBE_SURFACE_RADIUS + 0.42;
          obj.position.set(
            Math.sin(sec.midAngle) * rTag,
            0.22,
            Math.cos(sec.midAngle) * rTag
          );
          dynamicSectorsGroup.add(obj);
          dynamicSectorPlaques.push(obj);
        }
      }
      if (mPts.length > 0) {
        const g = new THREE.BufferGeometry().setFromPoints(mPts);
        dynamicSectorGeoms.push(g);
        dynamicSectorsGroup.add(new THREE.LineSegments(g, primaryWireMat));
      }

      const palette =
        stateRef.current.theme === 'dark' ? HEALTH_COLORS_DARK : HEALTH_COLORS_LIGHT;

      for (const node of nextManifest.nodes) {
        const initPos = curLayouts.globe.get(node.id) ?? [0, 0, 0];
        const group = new THREE.Group();
        group.position.set(initPos[0], initPos[1], initPos[2]);

        const baseRadius =
          node.kind === 'home'
            ? 0.34
            : node.kind === 'hub'
              ? 0.21
              : node.kind === 'external-domain'
                ? 0.115
                : 0.135;

        const hex = palette[node.health] ?? palette.healthy;
        const coreMat = new THREE.MeshStandardMaterial({
          color: hex,
          emissive: hex,
          emissiveIntensity: node.kind === 'home' ? 0.55 : 0.28,
          roughness: 0.28,
          metalness: 0.18,
        });
        const coreMesh = new THREE.Mesh(unitSphereGeom, coreMat);
        coreMesh.scale.setScalar(baseRadius);
        coreMesh.userData = { nodeId: node.id };
        group.add(coreMesh);
        pickableMeshes.push(coreMesh);

        const haloMat = new THREE.MeshBasicMaterial({
          color: hex,
          transparent: true,
          opacity: node.kind === 'home' || node.health === 'orphan' || node.health === 'broken' ? 0.55 : 0.22,
          side: THREE.DoubleSide,
          depthWrite: false,
        });
        const haloMesh = new THREE.Mesh(unitHaloGeom, haloMat);
        haloMesh.scale.setScalar(baseRadius);
        group.add(haloMesh);

        // The home node shows the site's own mark. The sphere stays as an invisible depth occluder
        // and click target, so links still end at the centre and picking is unchanged.
        let badge: BrandBadgeRuntime | undefined;
        const mark = node.kind === 'home' ? pickBrandMark(nextManifest) : null;
        if (mark) {
          const canvas = document.createElement('canvas');
          const texture = new THREE.CanvasTexture(canvas);
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.anisotropy = 4;
          // Drawn last and without a depth test, so pages in front never hide the site's mark.
          const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false });
          const sprite = new THREE.Sprite(material);
          sprite.scale.setScalar(baseRadius * BADGE_SCALE);
          sprite.renderOrder = 10;
          group.add(sprite);
          haloMesh.scale.setScalar(baseRadius * (BADGE_SCALE / 2) * 0.82);
          coreMat.colorWrite = false;
          // The invisible sphere is the click target, so it grows to the badge's full size, rim included.
          coreMesh.scale.setScalar(baseRadius * (BADGE_SCALE / 2));
          badge = { mark, canvas, texture, material, sprite, logo: null, theme: null, ringHex: hex, disposed: false };
          const reader = assetReaderRef.current;
          if (reader && mark.logoCandidates.length > 0) {
            const target = badge;
            void (async () => {
              // First candidate that decodes and actually paints something; otherwise keep the initials.
              for (const candidate of mark.logoCandidates) {
                try {
                  const bytes = await reader(candidate.path);
                  if (target.disposed) return;
                  if (!bytes) continue;
                  const img = await decodeLogo(bytes, candidate.path);
                  if (target.disposed) return;
                  if (!img) continue;
                  const tone = analyseLogo(img);
                  if (tone.coverage < MIN_LOGO_COVERAGE) continue;
                  target.logo = { img, tone };
                  target.theme = null; // redraw on the next frame
                  renderVersionRef.current += 1;
                  return;
                } catch {
                  // Try the next candidate.
                }
              }
            })();
          }
        }

        const pillText = shortPillLabel(node, nextManifest.domain);
        const labelEl = document.createElement('div');
        labelEl.className = `wo-node-pill wo-health-${node.health} wo-kind-${node.kind}`;
        labelEl.dataset.nodeId = node.id;
        labelEl.setAttribute('role', 'button');
        labelEl.tabIndex = 0;
        const dotEl = document.createElement('span');
        dotEl.className = 'wo-pill-dot';
        const txtEl = document.createElement('span');
        txtEl.className = 'wo-pill-label';
        txtEl.textContent = pillText;
        labelEl.append(dotEl, txtEl);

        if (node.health === 'orphan' || node.health === 'broken' || node.health === 'unlisted') {
          const badgeEl = document.createElement('span');
          badgeEl.className = 'wo-pill-badge';
          badgeEl.textContent =
            node.health === 'broken'
              ? String(node.statusCode || 404)
              : node.health === 'orphan'
                ? 'orphan'
                : 'unlisted';
          labelEl.appendChild(badgeEl);
        }
        labelEl.setAttribute('aria-label', `${labelEl.textContent}. Inspect ${node.title}`);

        labelEl.addEventListener('pointerenter', () => {
          callbacksRef.current.onHoverNode(node.id);
        });
        labelEl.addEventListener('pointerleave', () => {
          callbacksRef.current.onHoverNode(null);
        });
        labelEl.addEventListener('click', (ev) => {
          ev.stopPropagation();
          selectFromMap(node.id);
        });
        labelEl.addEventListener('focus', () => callbacksRef.current.onHoverNode(node.id));
        labelEl.addEventListener('blur', () => callbacksRef.current.onHoverNode(null));
        labelEl.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            selectFromMap(node.id);
          }
        });
        labelEl.addEventListener('dblclick', (ev) => {
          ev.stopPropagation();
          selectFromMap(node.id);
          callbacksRef.current.onOpenNoteNode?.(node);
        });

        const cssObj = new CSS2DObject(labelEl);
        cssObj.position.set(0, (badge ? baseRadius * (BADGE_SCALE / 2) : baseRadius) + 0.16, 0);
        group.add(cssObj);
        nodesRoot.add(group);

        runtimeNodes.set(node.id, {
          node,
          group,
          coreMesh,
          haloMesh,
          coreMat,
          haloMat,
          cssObj,
          labelEl,
          currentPos: new THREE.Vector3(...initPos),
          targetPos: new THREE.Vector3(...initPos),
          pillMeasured: false,
          pillW: Math.max(68, pillText.length * 7.2 + 28),
          pillH: 24,
          badge,
        });
      }

      if (nextManifest.edges.length > pulseCapacity) {
        edgesRoot.remove(pulseInstanced);
        pulseInstanced.dispose();
        pulseCapacity = nextManifest.edges.length + 32;
        pulseInstanced = new THREE.InstancedMesh(pulseGeom, pulseMat, pulseCapacity);
        pulseInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        pulseInstanced.frustumCulled = false;
        edgesRoot.add(pulseInstanced);
      }

      // Select at most 24 calm structural routes for idle ambient light flow
      // so dense sites never produce a noisy swarm of dots.
      const nodeKindMap = new Map(nextManifest.nodes.map((n) => [n.id, n.kind]));
      const primaryCandidates: number[] = [];
      const secondaryCandidates: number[] = [];
      nextManifest.edges.forEach((edge, idx) => {
        if (edge.kind === 'internal-chrome') return;
        const sk = nodeKindMap.get(edge.source);
        const tk = nodeKindMap.get(edge.target);
        if (
          edge.kind === 'sitemap-hierarchy' ||
          (sk === 'home' && tk === 'hub')
        ) {
          primaryCandidates.push(idx);
        } else if (edge.kind === 'internal-body' && (sk === 'home' || sk === 'hub')) {
          secondaryCandidates.push(idx);
        }
      });

      const MAX_AMBIENT_PULSES = 24;
      const ambientSet = new Set<number>();
      if (primaryCandidates.length <= MAX_AMBIENT_PULSES) {
        for (const i of primaryCandidates) ambientSet.add(i);
        const rem = MAX_AMBIENT_PULSES - ambientSet.size;
        if (rem > 0 && secondaryCandidates.length > 0) {
          const step = Math.max(1, Math.floor(secondaryCandidates.length / rem));
          for (
            let k = 0;
            k < secondaryCandidates.length && ambientSet.size < MAX_AMBIENT_PULSES;
            k += step
          ) {
            ambientSet.add(secondaryCandidates[k]);
          }
        }
      } else {
        const step = primaryCandidates.length / MAX_AMBIENT_PULSES;
        for (let k = 0; k < MAX_AMBIENT_PULSES; k++) {
          ambientSet.add(primaryCandidates[Math.floor(k * step)]);
        }
      }

      {
        const segments = edgeSegmentsFor(nextManifest.edges.length);
        const vertexCount = Math.max(1, nextManifest.edges.length * segments * 2);
        const geom = new THREE.BufferGeometry();
        const position = new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3);
        const color = new THREE.BufferAttribute(new Float32Array(vertexCount * 4), 4);
        position.setUsage(THREE.DynamicDrawUsage);
        color.setUsage(THREE.DynamicDrawUsage);
        geom.setAttribute('position', position);
        geom.setAttribute('color', color);
        const mat = new THREE.LineBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, depthWrite: false });
        const lines = new THREE.LineSegments(geom, mat);
        // Positions change every frame while nodes move, so a stale bounding sphere would cull the whole set.
        lines.frustumCulled = false;
        edgesRoot.add(lines);
        edgeBuffers = { lines, segments, position, color };
      }

      nextManifest.edges.forEach((edge, idx) => {
        runtimeEdges.set(edge.id, {
          edge,
          slot: idx,
          alpha: -1,
          src: runtimeNodes.get(edge.source),
          dst: runtimeNodes.get(edge.target),
          pulseSlot: idx,
          pulsePhase: ((idx * 0.61803398875) % 1),
          ambientEligible: ambientSet.has(idx),
          p0: new THREE.Vector3(),
          p1: new THREE.Vector3(),
          p2: new THREE.Vector3(),
          lastSrc: new THREE.Vector3(NaN, NaN, NaN),
          lastDst: new THREE.Vector3(NaN, NaN, NaN),
          lastSrcHex: -1,
          lastDstHex: -1,
          pulseHighlighted: false,
        });
      });

      pulseInstanced.count = nextManifest.edges.length;
    };

    syncGraphRef.current = rebuildGraph;
    rebuildGraph(manifest);

    // =========================================================================
    // 4. POINTER RAYCASTING
    // =========================================================================
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let downPos = { x: 0, y: 0 };

    const pickNodeAt = (clientX: number, clientY: number): string | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const visible = pickableMeshes.filter((m) => m.parent?.visible);
      const hits = raycaster.intersectObjects(visible, false);
      return hits.length > 0 ? (hits[0].object.userData?.nodeId as string) ?? null : null;
    };

    const onLabelOver = (ev: MouseEvent) => {
      const pill = (ev.target as Element | null)?.closest?.('.wo-node-pill') as HTMLElement | null;
      const id = pill?.dataset.nodeId ?? null;
      if (id !== labelHoverId) { labelHoverId = id; forceHeavy = true; }
    };
    const onLabelOut = (ev: MouseEvent) => {
      const next = (ev.relatedTarget as Element | null)?.closest?.('.wo-node-pill');
      if (!next && labelHoverId !== null) { labelHoverId = null; forceHeavy = true; }
    };
    labelRenderer.domElement.addEventListener('mouseover', onLabelOver);
    labelRenderer.domElement.addEventListener('mouseout', onLabelOut);

    const onPointerMove = (ev: PointerEvent) => {
      if (labelHoverId !== null) { labelHoverId = null; forceHeavy = true; }
      const hit = pickNodeAt(ev.clientX, ev.clientY);
      renderer.domElement.style.cursor = hit ? 'pointer' : 'grab';
      if (hit !== stateRef.current.hoveredId) {
        callbacksRef.current.onHoverNode(hit);
      }
    };
    const onPointerLeave = (event: PointerEvent) => {
      if (event.relatedTarget instanceof Node && labelRenderer.domElement.contains(event.relatedTarget)) return;
      callbacksRef.current.onHoverNode(null);
    };

    const onPointerDown = (ev: PointerEvent) => {
      downPos = { x: ev.clientX, y: ev.clientY };
    };

    const onPointerUp = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - downPos.x, ev.clientY - downPos.y) > 5) return;
      const hit = pickNodeAt(ev.clientX, ev.clientY);
      selectFromMap(hit);
    };

    const onDblClick = (ev: MouseEvent) => {
      const hit = pickNodeAt(ev.clientX, ev.clientY);
      if (hit) {
        const entry = runtimeNodes.get(hit);
        if (entry) callbacksRef.current.onOpenNoteNode?.(entry.node);
      }
    };

    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerleave', onPointerLeave);
    renderer.domElement.addEventListener('pointerdown', onPointerDown);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('dblclick', onDblClick);

    const handleContextLost = (e: Event) => {
      e.preventDefault();
      callbacksRef.current.onWebGLContextLost?.();
    };
    renderer.domElement.addEventListener('webglcontextlost', handleContextLost);

    // =========================================================================
    // 5. RESIZE OBSERVER
    // =========================================================================
    let stageW = width;
    let stageH = height;
    const resizeObs = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (!cr || cr.width < 20 || cr.height < 20) return;
      stageW = cr.width;
      stageH = cr.height;
      camera.aspect = stageW / stageH;
      camera.updateProjectionMatrix();
      renderer.setSize(stageW, stageH);
      labelRenderer.setSize(stageW, stageH);
      forceHeavy = true;
    });
    resizeObs.observe(container);

    // =========================================================================
    // 6. RENDER LOOP (60fps, screen-space label solver, pulse animation)
    // =========================================================================
    let rafId = 0;
    let disposed = false;
    const clock = new THREE.Clock();
    const tmpColorA = new THREE.Color();
    const tmpColorB = new THREE.Color();
    const tmpVec = new THREE.Vector3();
    // Redraws the badge when the theme changes (or a logo arrives), since its ring colour follows the theme.
    const syncBadge = (badge: BrandBadgeRuntime, theme: ThemeMode) => {
      if (badge.theme !== theme) {
        const fallback = '#' + (theme === 'dark' ? HEALTH_COLORS_DARK : HEALTH_COLORS_LIGHT).home.toString(16).padStart(6, '0');
        const colors = badgeColors(badge.mark, theme, fallback);
        let drawn = drawBrandBadge(badge.canvas, badge.mark, colors, badge.logo);
        if (!drawn && badge.logo) {
          badge.logo = null; // An unreadable image would be refused by WebGL; fall back to initials.
          drawn = drawBrandBadge(badge.canvas, badge.mark, colors, null);
        }
        badge.sprite.visible = drawn;
        badge.ringHex = parseInt(colors.ring.slice(1), 16);
        badge.texture.needsUpdate = true;
        badge.theme = theme;
      }
    };
    const tmpMid = new THREE.Vector3();
    const tmpWorldPos = new THREE.Vector3();
    const tmpMat4 = new THREE.Matrix4();
    const hiddenMat4 = new THREE.Matrix4().makeScale(0, 0, 0);

    // Moves one pulse instance along its cached curve. Shared by the dirty frame and the pulse-only frame.
    const writePulse = (re: RuntimeEdgeEntry, elapsed: number, isHighlighted: boolean) => {
      // Slow, meditative transit with a rest gap and smooth endpoint taper
      const period = isHighlighted ? 1.35 : 1.85;
      const speed = isHighlighted ? 0.115 : 0.072;
      const cycle = (elapsed * speed + re.pulsePhase * period) % period;
      if (cycle <= 1.0) {
        const tPulse = cycle;
        const inv = 1 - tPulse;
        const px = inv * inv * re.p0.x + 2 * inv * tPulse * re.p1.x + tPulse * tPulse * re.p2.x;
        const py = inv * inv * re.p0.y + 2 * inv * tPulse * re.p1.y + tPulse * tPulse * re.p2.y;
        const pz = inv * inv * re.p0.z + 2 * inv * tPulse * re.p1.z + tPulse * tPulse * re.p2.z;
        const envelope = Math.sin(tPulse * Math.PI);
        const sc = (isHighlighted ? 1.15 : 0.88) * envelope;
        if (sc > 0.05) {
          tmpMat4.makeTranslation(px, py, pz);
          tmpMat4.scale(tmpVec.set(sc, sc, sc));
          pulseInstanced.setMatrixAt(re.pulseSlot, tmpMat4);
        } else {
          pulseInstanced.setMatrixAt(re.pulseSlot, hiddenMat4);
        }
      } else {
        pulseInstanced.setMatrixAt(re.pulseSlot, hiddenMat4);
      }
    };

    const animate = () => {
      if (disposed) return;
      rafId = window.requestAnimationFrame(animate);
      if (pausedRef.current) return;

      const dt = Math.min(0.05, clock.getDelta());
      const elapsed = clock.elapsedTime;
      const st = stateRef.current;
      const isDark = st.theme === 'dark';
      const palette = isDark ? HEALTH_COLORS_DARK : HEALTH_COLORS_LIGHT;

      const spinningNow = (!st.manifest || st.autoRotate) && st.viewMode === 'globe' && !st.selectedId && !st.hoveredId;
      if (spinningNow) {
        sceneSpinGroup.rotation.y += dt * (st.manifest ? 0.08 : 0.14);
      } else if (st.viewMode !== 'globe') {
        sceneSpinGroup.rotation.y = THREE.MathUtils.lerp(sceneSpinGroup.rotation.y, 0, 0.14);
        if (Math.abs(sceneSpinGroup.rotation.y) < 1e-4) sceneSpinGroup.rotation.y = 0;
      }
      const settlingSpin = st.viewMode !== 'globe' && sceneSpinGroup.rotation.y !== 0;

      // Smooth camera fly-to
      const flying = cameraFlyRef.current.active;
      if (cameraFlyRef.current.active) {
        if (cameraFlyRef.current.instant) {
          camera.position.copy(cameraFlyRef.current.camTarget);
          controls.target.copy(cameraFlyRef.current.lookTarget);
        } else {
          camera.position.lerp(cameraFlyRef.current.camTarget, 0.11);
          controls.target.lerp(cameraFlyRef.current.lookTarget, 0.13);
        }
        if (
          camera.position.distanceTo(cameraFlyRef.current.camTarget) < 0.04 &&
          controls.target.distanceTo(cameraFlyRef.current.lookTarget) < 0.04
        ) {
          cameraFlyRef.current.active = false;
        }
      }

      controls.update();

      // On-demand rendering: skip the heavy node, label and edge work unless something changed.
      const camMoved = !camera.position.equals(lastCamPos) || !camera.quaternion.equals(lastCamQuat);
      const key = [
        st.viewMode, st.theme, st.selectedId ?? '', st.hoveredId ?? '', labelHoverId ?? '', st.filter, st.searchQuery,
        st.showExternal, st.showChromeLinks, st.showAllLinks, st.showPulses, st.autoRotate,
      ].join('|');
      const keyChanged = key !== lastKey || st.manifest !== lastManifestRef || st.layouts !== lastLayoutsRef ||
        renderVersionRef.current !== lastVersion;
      const heavy = forceHeavy || keyChanged || camMoved || spinningNow || settlingSpin || flying || !nodesSettled || Boolean(gizmoHolderRef.current?.current && gizmoHolderRef.current.current !== syncedGizmo);
      if (!heavy) {
        if (st.showPulses && pulseEdges.length > 0) {
          for (const re of pulseEdges) writePulse(re, elapsed, re.pulseHighlighted);
          pulseInstanced.instanceMatrix.needsUpdate = true;
          renderer.render(scene, camera);
        }
        return;
      }
      const measureLabels = keyChanged || forceHeavy;
      forceHeavy = false;
      lastKey = key;
      lastManifestRef = st.manifest;
      lastLayoutsRef = st.layouts;
      lastVersion = renderVersionRef.current;
      lastCamPos.copy(camera.position);
      lastCamQuat.copy(camera.quaternion);
      pulseEdges = [];
      const gizmo = gizmoHolderRef.current?.current;
      if (gizmo && (camMoved || gizmo !== syncedGizmo)) {
        gizmo.updateCameraQuaternion(camera.quaternion);
        syncedGizmo = gizmo;
      }

      // Update wireframe theme tint
      primaryWireMat.color.setHex(isDark ? 0xa882ff : 0x7c3aed);
      primaryWireMat.opacity = st.manifest ? (isDark ? 0.11 : 0.12) : 0.3;
      secondaryWireMat.color.setHex(isDark ? 0x666666 : 0xb3b3b3);
      secondaryWireMat.opacity = isDark ? 0.065 : 0.09;
      externalOrbitMat.color.setHex(isDark ? 0xc2a9de : 0x7358a6);
      externalOrbitMat.opacity = st.showExternal ? (isDark ? 0.2 : 0.18) : 0.04;
      pulseMat.color.setHex(isDark ? 0xcbb3ff : 0x7c3aed);

      globeFrameGroup.visible = st.viewMode === 'globe';
      roadFrameGroup.visible = st.viewMode === 'road' && Boolean(st.manifest);

      if (!st.manifest || !st.layouts) {
        renderer.render(scene, camera);
        labelRenderer.render(scene, camera);
        return;
      }

      const hoverId = labelHoverId ?? st.hoveredId;
      const focusId = hoverId ?? st.selectedId;
      labelRenderer.domElement.classList.toggle('is-hovering-node', hoverId !== null);
      const connectedIds = new Set<string>();
      if (focusId) {
        connectedIds.add(focusId);
        runtimeEdges.forEach((re) => {
          if (re.edge.kind === 'internal-chrome' && !st.showChromeLinks) return;
          if (re.edge.kind === 'external' && !st.showExternal) return;
          if (re.edge.source === focusId) connectedIds.add(re.edge.target);
          if (re.edge.target === focusId) connectedIds.add(re.edge.source);
        });
      }

      const query = st.searchQuery.trim().toLowerCase();
      const targetMap =
        st.viewMode === 'road'
          ? st.layouts.road
          : st.viewMode === 'clusters'
            ? st.layouts.clusters
            : st.layouts.globe;

      // Resting label set, recomputed only when the manifest, filter or external toggle changes.
      const restingKey = `${st.filter}|${st.showExternal}`;
      // The node count and attention set are part of the cache key: a frame drawn before the nodes exist must not freeze an empty set.
      if (restingCache.manifest !== st.manifest || restingCache.key !== restingKey || restingCache.count !== runtimeNodes.size || restingCache.attention !== st.attention) {
        const visibleNodes: SiteNode[] = [];
        for (const entry of runtimeNodes.values()) {
          if (matchesFilter(entry.node, st.filter, st.showExternal, st.attention)) visibleNodes.push(entry.node);
        }
        restingCache = { manifest: st.manifest, key: restingKey, count: runtimeNodes.size, attention: st.attention, ids: restingLabelIds(visibleNodes, st.attention) };
      }
      const resting = restingCache.ids;

      // Update nodes
      const visibleEntries: Array<{ entry: RuntimeNodeEntry; priority: number }> = [];

      let anyNodeMoving = false;
      runtimeNodes.forEach((entry, id) => {
        const tgt = targetMap.get(id) ?? [0, 0, 0];
        entry.targetPos.set(tgt[0], tgt[1], tgt[2]);
        entry.currentPos.lerp(entry.targetPos, 0.14);
        if (entry.currentPos.distanceToSquared(entry.targetPos) > 1e-6) anyNodeMoving = true;
        else entry.currentPos.copy(entry.targetPos);
        entry.group.position.copy(entry.currentPos);
        entry.haloMesh.quaternion.copy(camera.quaternion);
        if (entry.badge) syncBadge(entry.badge, st.theme);

        const allowedByFilter = matchesFilter(entry.node, st.filter, st.showExternal, st.attention);
        const matchesQuery =
          !query ||
          entry.node.title.toLowerCase().includes(query) ||
          entry.node.path.toLowerCase().includes(query) ||
          entry.node.url.toLowerCase().includes(query);

        entry.group.visible = allowedByFilter;
        if (!allowedByFilter) {
          entry.labelEl.classList.add('is-hidden');
          return;
        }

        const hex = palette[entry.node.health] ?? palette.healthy;
        entry.coreMat.color.setHex(hex);
        entry.coreMat.emissive.setHex(hex);
        entry.haloMat.color.setHex(entry.badge ? entry.badge.ringHex : hex);

        const isDirect = id === focusId;
        entry.labelEl.setAttribute('aria-pressed', String(id === st.selectedId));
        const isNeighbor = focusId ? connectedIds.has(id) : true;
        const dimmed = entry.node.kind !== 'home' && ((Boolean(focusId) && !isNeighbor) || (Boolean(query) && !matchesQuery));

        entry.coreMat.opacity = dimmed ? 0.22 : 1;
        entry.coreMat.transparent = dimmed;
        entry.coreMat.emissiveIntensity = isDirect ? 0.85 : dimmed ? 0.08 : 0.32;
        entry.haloMat.opacity = isDirect ? 0.85 : dimmed ? 0.05 : 0.28;

        entry.labelEl.classList.toggle('is-active', isDirect);
        entry.labelEl.classList.toggle('is-hover-target', id === hoverId);
        entry.labelEl.classList.toggle('is-hover-context', isNeighbor);
        entry.labelEl.classList.toggle('is-dimmed', dimmed);
        entry.labelEl.style.translate = '';
        if (hoverId && !isNeighbor) {
          entry.labelEl.classList.add('is-hidden');
          return;
        }
        // Only a few labels at rest; hover, selection, neighbours and search add the rest.
        const linked = Boolean(focusId) && connectedIds.has(id);
        if (!(isDirect || id === hoverId || id === st.selectedId || linked || (query && matchesQuery) || resting.has(id))) {
          entry.labelEl.classList.add('is-hidden');
          return;
        }

        let priority = 10;
        if (isDirect) priority = 100;
        else if (query && matchesQuery) priority = 90;
        else if (entry.node.kind === 'home') priority = 86;
        else if (linked) priority = 80;
        else if (entry.node.kind === 'hub') priority = 60;
        else if (st.attention.has(id)) priority = 56;
        else if (entry.node.kind === 'external-domain') priority = 25;
        else priority = 35 + Math.min(12, (entry.node.authorityScore ?? entry.node.inlinksBody * 4) / 8);

        visibleEntries.push({ entry, priority });
      });

      nodesSettled = !anyNodeMoving;

      // Screen-space collision-free pill placement
      visibleEntries.sort((a, b) => b.priority - a.priority);
      const placedBoxes: ScreenBox[] = [];
      placedBoxes.push({ l: 0, r: stageW, t: 0, b: 12 });
      // Keep labels clear of the discovery chip (top left) and the legend (bottom left).
      placedBoxes.push({ l: 0, r: 250, t: 0, b: 50 }, { l: 0, r: 420, t: stageH - 34, b: stageH });

      // Section and depth tags take part in the same collision pass so they never sit on a page label.
      const frameTags = st.viewMode === 'globe' ? dynamicSectorPlaques : st.viewMode === 'road' ? roadTags : [];
      const tagBoxes: Array<{ el: HTMLElement; box: ScreenBox | null; fixed: boolean }> = [];
      for (const tag of frameTags) {
        const el = tag.element as HTMLElement;
        let size = tagSizes.get(el);
        if (!size || measureLabels) {
          const w = el.offsetWidth; const h = el.offsetHeight;
          if (w && h) { size = { w, h }; tagSizes.set(el, size); }
        }
        tag.getWorldPosition(tmpWorldPos);
        tmpVec.copy(tmpWorldPos).project(camera);
        if (!size || tmpVec.z > 1 || tmpVec.z < -1) { tagBoxes.push({ el, box: null, fixed: false }); continue; }
        const sx = (tmpVec.x * 0.5 + 0.5) * stageW;
        const sy = (-tmpVec.y * 0.5 + 0.5) * stageH;
        tagBoxes.push({ el, box: { l: sx - size.w / 2, r: sx + size.w / 2, t: sy - size.h / 2, b: sy + size.h / 2 }, fixed: st.viewMode === 'road' });
      }
      // Depth column titles are fixed scaffolding: place them first.
      for (const tag of tagBoxes) {
        if (tag.fixed && tag.box) { placedBoxes.push(tag.box); tag.el.classList.remove('is-hidden'); }
      }
      let tagsPlaced = false;
      const placeSectorTags = () => {
        if (tagsPlaced) return;
        tagsPlaced = true;
        for (const tag of tagBoxes) {
          if (tag.fixed) continue;
          const free = tag.box && !placedBoxes.some((placed) => boxesOverlap(tag.box!, placed, 3));
          tag.el.classList.toggle('is-hidden', !free);
          if (free) placedBoxes.push(tag.box!);
        }
      };

      {
        // Read every size in one pass so layout is flushed once, not interleaved with class and style writes.
        // Labels that were never laid out (just created or not yet attached) are measured on every dirty frame
        // until they report a real size; a changed size schedules one more pass so placement converges.
        let sizeChanged = false;
        for (const { entry } of visibleEntries) {
          if (!measureLabels && entry.pillMeasured) continue;
          const measuredW = entry.labelEl.offsetWidth;
          const measuredH = entry.labelEl.offsetHeight;
          if (measuredW && measuredH) {
            if (Math.abs(measuredW - entry.pillW) > 0.5 || Math.abs(measuredH - entry.pillH) > 0.5) sizeChanged = true;
            entry.pillW = measuredW;
            entry.pillH = measuredH;
            entry.pillMeasured = true;
          }
        }
        const unmeasured = visibleEntries.some(({ entry }) => !entry.pillMeasured);
        measureAttempts = unmeasured ? measureAttempts + 1 : 0;
        // Bounded so a label that can never be measured cannot keep the loop awake forever.
        if (sizeChanged || (unmeasured && measureAttempts < 30)) forceHeavy = true;
      }

      for (const { entry, priority } of visibleEntries) {
        // Section tags rank just below section hubs.
        if (priority < 58) placeSectorTags();
        entry.cssObj.getWorldPosition(tmpWorldPos);
        tmpVec.copy(tmpWorldPos).project(camera);
        if (tmpVec.z > 1 || tmpVec.z < -1) {
          entry.labelEl.classList.add('is-hidden');
          continue;
        }
        const sx = (tmpVec.x * 0.5 + 0.5) * stageW;
        const sy = (-tmpVec.y * 0.5 + 0.5) * stageH;
        const w = entry.pillW;
        const h = entry.pillH;

        const box: ScreenBox = {
          l: sx - w * 0.5,
          r: sx + w * 0.5,
          t: sy - h * 0.5,
          b: sy + h * 0.5,
        };

        if (entry.node.id === focusId || (!focusId && entry.node.kind === 'home')) {
          placedBoxes.push(box);
          entry.labelEl.classList.remove('is-hidden');
          continue;
        }

        // Move linked labels into nearby free slots, keeping the hovered label fixed.
        const offsets: Array<[number, number]> = [[0, 0]];
        if (hoverId && connectedIds.has(entry.node.id)) {
          for (const dy of [-28, 28, -56, 56, -84, 84, -112, 112, -140, 140]) offsets.push([0, dy]);
          for (const dx of [-(w + 12), w + 12]) {
            for (const dy of [0, -28, 28, -56, 56, -84, 84]) offsets.push([dx, dy]);
          }
        }
        const freeSlot = offsets.find(([dx, dy]) => {
          const candidate = { l: box.l + dx, r: box.r + dx, t: box.t + dy, b: box.b + dy };
          return candidate.l >= 8 && candidate.r <= stageW - 8 && candidate.t >= 12 &&
            candidate.b <= stageH - 8 && !placedBoxes.some((placed) => boxesOverlap(candidate, placed, 4));
        });
        if (!freeSlot) {
          entry.labelEl.classList.add('is-hidden');
        } else {
          const [dx, dy] = freeSlot;
          entry.labelEl.style.translate = `${dx}px ${dy}px`;
          placedBoxes.push({ l: box.l + dx, r: box.r + dx, t: box.t + dy, b: box.b + dy });
          entry.labelEl.classList.remove('is-hidden');
        }
      }

      placeSectorTags();

      // Update curved 3D edges & calm, sparse directional micro-pulses
      const densityScale = Math.max(
        0.38,
        Math.min(1, Math.sqrt(85 / Math.max(85, runtimeEdges.size)))
      );

      const eb = edgeBuffers;
      const segs = eb ? eb.segments : 1;
      const posArr = eb ? (eb.position.array as Float32Array) : null;
      const colArr = eb ? (eb.color.array as Float32Array) : null;
      let edgePosDirty = false;
      let edgeColDirty = false;

      runtimeEdges.forEach((re) => {
        const srcEntry = re.src;
        const dstEntry = re.dst;
        const isDirectConnection = Boolean(focusId) && (re.edge.source === focusId || re.edge.target === focusId);
        const isStructural = re.edge.kind === 'sitemap-hierarchy' ||
          re.edge.kind === 'external' || re.edge.kind === 'internal-chrome' ||
          srcEntry?.node.kind === 'home' ||
          (srcEntry?.node.kind === 'hub' && srcEntry.node.section === dstEntry?.node.section);
        const edgeAllowed =
          Boolean(srcEntry?.group.visible) &&
          Boolean(dstEntry?.group.visible) &&
          (re.edge.kind !== 'internal-chrome' || st.showChromeLinks) &&
          (re.edge.kind !== 'external' || st.showExternal) &&
          (st.showAllLinks || isDirectConnection || isStructural);

        const first = re.slot * segs * 2 * 4;
        const vertexTotal = segs * 2;
        if (!edgeAllowed || !srcEntry || !dstEntry || !posArr || !colArr) {
          if (colArr && re.alpha !== 0) {
            for (let v = 0; v < vertexTotal; v++) colArr[first + v * 4 + 3] = 0;
            re.alpha = 0;
            edgeColDirty = true;
          }
          pulseInstanced.setMatrixAt(re.pulseSlot, hiddenMat4);
          return;
        }

        const pS = srcEntry.currentPos;
        const pT = dstEntry.currentPos;
        const srcHex = palette[srcEntry.node.health] ?? palette.healthy;
        const dstHex = palette[dstEntry.node.health] ?? palette.healthy;

        if (
          pS.distanceToSquared(re.lastSrc) > 0.0001 ||
          pT.distanceToSquared(re.lastDst) > 0.0001 ||
          srcHex !== re.lastSrcHex ||
          dstHex !== re.lastDstHex
        ) {
          re.lastSrc.copy(pS);
          re.lastDst.copy(pT);
          re.lastSrcHex = srcHex;
          re.lastDstHex = dstHex;

          re.p0.copy(pS);
          re.p2.copy(pT);
          tmpMid.addVectors(pS, pT).multiplyScalar(0.5);
          const chordLen = pS.distanceTo(pT);

          if (st.viewMode === 'globe') {
            const midLen = tmpMid.length();
            if (re.edge.kind === 'external') {
              if (midLen > 0.01) {
                tmpMid.normalize().multiplyScalar(GLOBE_SURFACE_RADIUS + chordLen * 0.25);
              }
            } else if (midLen > 0.2) {
              const targetArcR = Math.min(
                GLOBE_SURFACE_RADIUS + 0.65,
                Math.max(pS.length(), pT.length()) * 0.92 + chordLen * 0.14
              );
              tmpMid.normalize().multiplyScalar(targetArcR);
            } else {
              tmpMid.y += chordLen * 0.22;
            }
          } else {
            tmpMid.y += Math.min(1.6, chordLen * 0.16);
          }
          re.p1.copy(tmpMid);

          tmpColorA.setHex(srcHex);
          tmpColorB.setHex(dstHex);

          // Walk the curve and write each piece as a separate line segment (start and end vertex).
          let prevX = re.p0.x, prevY = re.p0.y, prevZ = re.p0.z;
          let prevR = tmpColorA.r, prevG = tmpColorA.g, prevB = tmpColorA.b;
          for (let s = 1; s <= segs; s++) {
            const t = s / segs;
            const inv = 1 - t;
            const x = inv * inv * re.p0.x + 2 * inv * t * re.p1.x + t * t * re.p2.x;
            const y = inv * inv * re.p0.y + 2 * inv * t * re.p1.y + t * t * re.p2.y;
            const z = inv * inv * re.p0.z + 2 * inv * t * re.p1.z + t * t * re.p2.z;
            const r = tmpColorA.r + (tmpColorB.r - tmpColorA.r) * t;
            const g = tmpColorA.g + (tmpColorB.g - tmpColorA.g) * t;
            const b = tmpColorA.b + (tmpColorB.b - tmpColorA.b) * t;
            const p = (re.slot * segs + (s - 1)) * 2;
            const pi = p * 3;
            posArr[pi] = prevX; posArr[pi + 1] = prevY; posArr[pi + 2] = prevZ;
            posArr[pi + 3] = x; posArr[pi + 4] = y; posArr[pi + 5] = z;
            const ci = p * 4;
            colArr[ci] = prevR; colArr[ci + 1] = prevG; colArr[ci + 2] = prevB;
            colArr[ci + 4] = r; colArr[ci + 5] = g; colArr[ci + 6] = b;
            prevX = x; prevY = y; prevZ = z; prevR = r; prevG = g; prevB = b;
          }
          edgePosDirty = true;
          edgeColDirty = true;
        }

        const isHighlighted =
          Boolean(focusId) && (re.edge.source === focusId || re.edge.target === focusId);
        const isDimmed = Boolean(focusId) && !isHighlighted;
        const alpha = isHighlighted
          ? 0.72
          : isDimmed
            ? 0.035
            : (re.edge.kind === 'sitemap-hierarchy'
                ? 0.26
                : re.edge.kind === 'external'
                  ? 0.12
                  : 0.16) * densityScale;
        if (Math.abs(alpha - re.alpha) > 1e-4) {
          for (let v = 0; v < vertexTotal; v++) colArr[first + v * 4 + 3] = alpha;
          re.alpha = alpha;
          edgeColDirty = true;
        }

        const shouldAnimatePulse =
          st.showPulses && (focusId ? isHighlighted : re.ambientEligible);

        if (shouldAnimatePulse) {
          re.pulseHighlighted = isHighlighted;
          pulseEdges.push(re);
          writePulse(re, elapsed, isHighlighted);
        } else {
          pulseInstanced.setMatrixAt(re.pulseSlot, hiddenMat4);
        }
      });

      if (eb) {
        if (edgePosDirty) eb.position.needsUpdate = true;
        if (edgeColDirty) eb.color.needsUpdate = true;
      }
      pulseInstanced.instanceMatrix.needsUpdate = true;

      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);
    };

    wakeLoopRef.current = () => {
      forceHeavy = true;
      clock.getDelta();
    };
    animate();

    return () => {
      disposed = true;
      window.cancelAnimationFrame(rafId);
      resizeObs.disconnect();
      labelRenderer.domElement.removeEventListener('mouseover', onLabelOver);
      labelRenderer.domElement.removeEventListener('mouseout', onLabelOut);
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('dblclick', onDblClick);
      renderer.domElement.removeEventListener('webglcontextlost', handleContextLost);
      clearRuntimeGraph();
      clearDynamicSectors();
      pulseInstanced.dispose();
      for (const d of disposables) d.dispose();
      controls.dispose();
      discoverCameraRef.current = null;
      renderer.dispose();
      renderer.domElement.remove();
      labelRenderer.domElement.remove();
    };
  }, []);

  // Rebuild Three.js graph whenever manifest changes, then frame it.
  useEffect(() => {
    syncGraphRef.current?.(manifest);
  }, [manifest]);

  // Frame the whole layout on a new capture, a layout change or Reset camera.
  useEffect(() => {
    if (layouts && fitCameraRef.current) {
      fitCameraRef.current(viewMode, layouts);
      return;
    }
    cameraFlyRef.current = {
      active: true,
      camTarget: new THREE.Vector3(-4.4, 5.0, 16.0),
      lookTarget: new THREE.Vector3(0, 0, 0),
    };
  }, [viewMode, resetSignal, layouts]);

  // Fly to a requested node
  useEffect(() => {
    if (!flyRequest || !layouts) return;
    const map =
      viewMode === 'road'
        ? layouts.road
        : viewMode === 'clusters'
          ? layouts.clusters
          : layouts.globe;
    const target = map.get(flyRequest.nodeId);
    if (!target) return;
    const p = new THREE.Vector3(...target);
    const dir = p.length() > 0.2 ? p.clone().normalize() : new THREE.Vector3(0, 0.3, 1).normalize();
    cameraFlyRef.current = {
      active: true,
      lookTarget: p.clone(),
      // Far enough back to keep the neighbourhood in view, and lifted so the node does not hide behind home.
      camTarget: p.clone().addScaledVector(dir, 8.5).add(new THREE.Vector3(0, 1.8, 0)),
    };
  }, [flyRequest, layouts, viewMode]);

  // Snap camera to cardinal gizmo axis
  useEffect(() => {
    if (!axisSnapRequest) return;
    const dist = 16.5;
    const map: Record<CameraAxisSnap, [number, number, number]> = {
      '+X': [dist, 0.5, 0],
      '-X': [-dist, 0.5, 0],
      '+Y': [0, dist, 0.01],
      '-Y': [0, -dist, 0.01],
      '+Z': [0, 0.5, dist],
      '-Z': [0, 0.5, -dist],
    };
    cameraFlyRef.current = {
      active: true,
      camTarget: new THREE.Vector3(...map[axisSnapRequest.axis]),
      lookTarget: new THREE.Vector3(0, 0, 0),
    };
  }, [axisSnapRequest]);

  return <div ref={mountRef} className="wo-canvas-stage">
    {manifest && !renderUnavailable && <MapDiscoveryControls
      key={manifest.siteId + ':' + manifest.capturedAt}
      manifest={manifest}
      nodes={discoveryNodes}
      selectedId={effectiveSelectedId}
      showChromeLinks={showChromeLinks}
      onNavigate={discoverNode}
      onInspect={inspectDiscoveryNode}
    />}
    {renderUnavailable && <div className="wo-webgl-fallback" role="status">
      <strong>3D view unavailable</strong>
      <p>Capture pages, browse the Page explorer and open reports while graphics are unavailable.</p>
    </div>}
  </div>;
};
