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

/**
 * A pooled DOM label. Only nodes that are showing a label hold one, so a site with thousands of pages
 * builds a few hundred pills at most instead of one per page.
 */
interface LabelSlot {
  el: HTMLDivElement;
  textEl: HTMLSpanElement;
  badgeEl: HTMLSpanElement | null;
  obj: CSS2DObject;
  entry: RuntimeNodeEntry | null;
  /** Bound this frame: stays transparent for one rendered frame so the CSS opacity transition can fade it in. */
  fresh: boolean;
}

/** Home node only: a standalone sphere (and brand badge). Every other node is an instance of a shared mesh. */
interface HomeRuntime {
  group: THREE.Group;
  coreMesh: THREE.Mesh;
  coreMat: THREE.MeshStandardMaterial;
}

interface RuntimeNodeEntry {
  node: SiteNode;
  /** Slot in the shared instance buffers (the same index is used by the core meshes and the halo). */
  index: number;
  baseRadius: number;
  /** Radius the halo ring is drawn around. */
  haloScale: number;
  /** Passed the filter on the last sync. */
  visible: boolean;
  /** Which core mesh draws this node: 0 translucent, 1 opaque (fully opaque orbs draw first), -1 none. */
  bucket: number;
  colorHex: number;
  /** Current and target style. Current values ease toward the targets; -1 means not yet initialised. */
  opacity: number;
  opacityTarget: number;
  glow: number;
  glowTarget: number;
  haloAlpha: number;
  haloAlphaTarget: number;
  haloHex: number;
  /** True for the frame after a node stopped moving, so its final position is written once. */
  posDirty: boolean;
  currentPos: THREE.Vector3;
  targetPos: THREE.Vector3;
  pillText: string;
  pillW: number;
  pillH: number;
  /** True once the label was laid out in the DOM and its real size read. */
  pillMeasured: boolean;
  /** Height of the label anchor above the node centre. */
  labelOffsetY: number;
  label: LabelSlot | null;
  home?: HomeRuntime;
  /** Home node only: the brand badge drawn in place of the sphere. */
  badge?: BrandBadgeRuntime;
}

interface LabelCandidate {
  entry: RuntimeNodeEntry;
  priority: number;
  isDirect: boolean;
  isHoverTarget: boolean;
  isNeighbor: boolean;
  dimmed: boolean;
}

/** All non-home nodes share two instanced spheres and every halo is one instanced billboard. */
interface NodeInstancing {
  coreGeom: THREE.SphereGeometry;
  /** [translucent, opaque]. Opacity and glow are per-instance attributes; the split only fixes draw order, so
   *  fully opaque orbs are drawn first and translucent ones blend over them, never the other way round. */
  buckets: THREE.InstancedMesh[];
  mats: THREE.MeshStandardMaterial[];
  opacity: THREE.InstancedBufferAttribute;
  glow: THREE.InstancedBufferAttribute;
  visuals: NodeVisualTuning;
  /** Radii spanned by the halo quad (fits the ring at the configured thickness). */
  haloPad: number;
  halo: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  haloCenter: THREE.InstancedBufferAttribute;
  haloColor: THREE.InstancedBufferAttribute;
  haloSize: THREE.InstancedBufferAttribute;
  byIndex: RuntimeNodeEntry[];
}

interface LabelContext {
  candidates: LabelCandidate[];
  focusId: string | null;
  hoverId: string | null;
  connectedIds: Set<string>;
}

/** Badge diameter as a multiple of the home sphere's radius (the sphere itself is 2). */
const BADGE_SCALE = 2.8;

/** A label pill is about 70 by 24 px, so more than this cannot be placed on a screen without overlap. */
const MAX_LABEL_CANDIDATES = 800;
/** Matches the 0.18s opacity transition on .wo-node-pill. */
const LABEL_FADE_MS = 220;
/** The halo quad spans this many node radii (the 1px ring sits inside it). */
const HALO_PAD = 1.7;
/** The original halo ring ran from 1.32 to 1.65 node radii; the hairline ring is centred on that band. */
const ORIGINAL_RING_INNER = 1.32;
const ORIGINAL_RING_OUTER = 1.65;

/**
 * How nodes look. Everything here can be changed without touching the renderer: set
 * `window.__WO_VISUAL__ = { defaultOpacity: 0.8 }` before the map is built and the given fields override the
 * defaults. That is how sphere detail, opacity and halo weight are tuned against frame rate.
 */
export interface NodeVisualTuning {
  /** Sphere tessellation. Fixed by default so a node looks the same at every site size. */
  sphereWidthSegments: number;
  sphereHeightSegments: number;
  /** When true, big sites use coarser spheres (14x10 above 400 nodes, 10x8 above 1200) to save GPU time. */
  adaptiveSphereDetail: boolean;
  /** Opacity of an orb at rest. */
  defaultOpacity: number;
  /** Opacity of the selected or hovered orb, the orbs linked to it, and search matches. */
  highlightOpacity: number;
  /** Opacity of every other orb while something is selected, hovered or searched. */
  dimOpacity: number;
  /** Time for an opacity change to settle, in milliseconds. */
  transitionMs: number;
  /** Emissive glow strength (the share of the orb's own colour added on top of its lighting). */
  glowDefault: number;
  glowSelected: number;
  glowDim: number;
  /** Halo ring opacity for the same three states. */
  haloAlphaDefault: number;
  haloAlphaSelected: number;
  haloAlphaDim: number;
  /** Halo ring width in screen pixels. It is a hairline at every zoom level, however large the orb. */
  haloWidthPx: number;
}

export const DEFAULT_NODE_VISUALS: NodeVisualTuning = {
  sphereWidthSegments: 22,
  sphereHeightSegments: 22,
  adaptiveSphereDetail: false,
  defaultOpacity: 0.69,
  highlightOpacity: 1,
  dimOpacity: 0.2,
  transitionMs: 240,
  glowDefault: 0.32,
  glowSelected: 0.85,
  glowDim: 0.08,
  haloAlphaDefault: 0.28,
  haloAlphaSelected: 0.85,
  haloAlphaDim: 0.05,
  haloWidthPx: 1,
};

function resolveNodeVisuals(): NodeVisualTuning {
  const override = (globalThis as { __WO_VISUAL__?: Partial<NodeVisualTuning> }).__WO_VISUAL__;
  return { ...DEFAULT_NODE_VISUALS, ...(override ?? {}) };
}

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
export function fitCameraToPoints(points: readonly THREE.Vector3[], direction: THREE.Vector3, fovDeg: number, stageW: number, stageH: number, pad: { x: number; y: number } = { x: 0.9, y: 0.8 }) {
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
    distance = Math.max(distance, depth + (Math.abs(x - cx) + pad.x) / tanH, depth + (Math.abs(y - cy) + pad.y) / tanV);
  }
  // No fixed cap: a wide Road strip or a large Clusters layout needs the camera farther out.
  const center = right.multiplyScalar(cx).add(up.multiplyScalar(cy)).add(d.clone().multiplyScalar(cz));
  let radius = 0;
  for (const p of points) radius = Math.max(radius, p.distanceTo(center));
  return { lookTarget: center, camTarget: center.clone().addScaledVector(d, distance), distance, radius };
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
  // Work out the Clusters layout in small idle slices, so opening that view is instant even on a large site.
  useEffect(() => layouts?.prefetchClusters?.(), [layouts]);
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
      const step = curLayouts.roadMetrics.rowStep;
      const top = Math.max(step, ...columns.map((column) => column.top));
      const pts: THREE.Vector3[] = [];
      columns.forEach((column, index) => {
        if (index > 0) {
          const x = (columns[index - 1].right + column.left) / 2;
          pts.push(new THREE.Vector3(x, -top - step * 0.5, 0), new THREE.Vector3(x, top + step * 0.5, 0));
        }
        const el = document.createElement('div');
        el.className = 'wo-sector-tag wo-road-tag';
        el.dataset.columnId = column.id;
        el.textContent = column.id === 'home' ? domain || column.title : `${column.title} · ${column.count}`;
        const obj = new CSS2DObject(el);
        obj.position.set(column.x, top + step * 1.1, 0);
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
        const step = curLayouts.roadMetrics.rowStep;
        const top = Math.max(step, ...curLayouts.roadColumns.map((column) => column.top));
        points.push(new THREE.Vector3(0, top + step * 1.1, 0));
      } else if (mode === 'globe') {
        // Frame the globe wireframe, not just the nodes on it.
        const r = GLOBE_SURFACE_RADIUS;
        points.push(new THREE.Vector3(r, 0, 0), new THREE.Vector3(-r, 0, 0), new THREE.Vector3(0, r, 0),
          new THREE.Vector3(0, -r, 0), new THREE.Vector3(0, 0, r), new THREE.Vector3(0, 0, -r));
      }
      if (!points.length) return;
      // Road padding follows the layout's own row step, so it stays proportional to node and label spacing.
      const roadStep = curLayouts.roadMetrics.rowStep;
      const fit = fitCameraToPoints(points, mode === 'road' ? ROAD_VIEW_DIRECTION : GLOBE_VIEW_DIRECTION, camera.fov, stageW, stageH,
        mode === 'road' ? { x: roadStep * 0.95, y: roadStep * 0.85 } : undefined);
      // Size the zoom-out limit and far plane to this layout, so the whole site can always be seen
      // and nothing is clipped. Small layouts keep the original limits (42 and 180).
      controls.maxDistance = Math.max(42, fit.distance * 1.6);
      camera.far = Math.max(180, (controls.maxDistance + fit.radius) * 1.1);
      camera.updateProjectionMatrix();
      cameraFlyRef.current = { active: true, lookTarget: fit.lookTarget, camTarget: fit.camTarget };
    };

    const homeSphereGeom = track(new THREE.SphereGeometry(1, 22, 22));
    const hiddenInstanceMat = new THREE.Matrix4().compose(
      new THREE.Vector3(1e9, 1e9, 1e9), new THREE.Quaternion(), new THREE.Vector3(0, 0, 0)
    );
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
    let nodeInst: NodeInstancing | null = null;

    // Pooled labels live under their own group so each follows its node through the spin group.
    const labelsRoot = new THREE.Group();
    sceneSpinGroup.add(labelsRoot);
    const labelPool: LabelSlot[] = [];
    const freeLabels: LabelSlot[] = [];
    let forceLabels = false;
    const emptyLabelContext = (): LabelContext => ({ candidates: [], focusId: null, hoverId: null, connectedIds: new Set() });
    let labelCtx: LabelContext = emptyLabelContext();

    const createLabelSlot = (): LabelSlot => {
      const el = document.createElement('div');
      el.className = 'wo-node-pill is-hidden';
      el.setAttribute('role', 'button');
      el.tabIndex = 0;
      const dotEl = document.createElement('span');
      dotEl.className = 'wo-pill-dot';
      const textEl = document.createElement('span');
      textEl.className = 'wo-pill-label';
      el.append(dotEl, textEl);
      const slot: LabelSlot = { el, textEl, badgeEl: null, obj: new CSS2DObject(el), entry: null, fresh: false };
      // The handlers read the slot's current node, so a slot can be handed from one node to another.
      el.addEventListener('pointerenter', () => { if (slot.entry) callbacksRef.current.onHoverNode(slot.entry.node.id); });
      el.addEventListener('pointerleave', () => { callbacksRef.current.onHoverNode(null); });
      el.addEventListener('click', (ev) => { ev.stopPropagation(); if (slot.entry) selectFromMap(slot.entry.node.id); });
      el.addEventListener('focus', () => { if (slot.entry) callbacksRef.current.onHoverNode(slot.entry.node.id); });
      el.addEventListener('blur', () => callbacksRef.current.onHoverNode(null));
      el.addEventListener('keydown', (event) => {
        if (!slot.entry) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          selectFromMap(slot.entry.node.id);
        }
      });
      el.addEventListener('dblclick', (ev) => {
        ev.stopPropagation();
        if (!slot.entry) return;
        selectFromMap(slot.entry.node.id);
        callbacksRef.current.onOpenNoteNode?.(slot.entry.node);
      });
      slot.obj.visible = false;
      labelsRoot.add(slot.obj);
      labelPool.push(slot);
      return slot;
    };

    const bindLabel = (entry: RuntimeNodeEntry) => {
      const slot = freeLabels.pop() ?? createLabelSlot();
      const { node } = entry;
      slot.entry = entry;
      entry.label = slot;
      slot.el.className = `wo-node-pill wo-health-${node.health} wo-kind-${node.kind} is-hidden`;
      slot.fresh = true;
      slot.el.dataset.nodeId = node.id;
      slot.textEl.textContent = entry.pillText;
      slot.badgeEl?.remove();
      slot.badgeEl = null;
      if (node.health === 'orphan' || node.health === 'broken' || node.health === 'unlisted') {
        const badgeEl = document.createElement('span');
        badgeEl.className = 'wo-pill-badge';
        badgeEl.textContent =
          node.health === 'broken' ? String(node.statusCode || 404) : node.health === 'orphan' ? 'orphan' : 'unlisted';
        slot.el.appendChild(badgeEl);
        slot.badgeEl = badgeEl;
      }
      slot.el.setAttribute('aria-label', `${slot.el.textContent}. Inspect ${node.title}`);
      slot.obj.visible = true;
    };

    const unbindLabel = (entry: RuntimeNodeEntry, immediate = false) => {
      const slot = entry.label;
      if (!slot) return;
      slot.entry = null;
      entry.label = null;
      // Fade out like a hidden pill used to, then return the slot to the pool once the transition has finished.
      // The state classes go at once: a releasing pill must not keep matching .is-active or .is-hover-target.
      slot.fresh = false;
      slot.el.classList.remove('is-active', 'is-hover-target', 'is-hover-context');
      slot.el.classList.add('is-hidden');
      slot.el.removeAttribute('aria-pressed');
      delete slot.el.dataset.nodeId;
      if (immediate) {
        slot.obj.visible = false;
        freeLabels.push(slot);
        return;
      }
      window.setTimeout(() => {
        if (slot.entry || disposed) return;
        slot.obj.visible = false;
        slot.el.style.translate = '';
        freeLabels.push(slot);
      }, LABEL_FADE_MS);
    };
    // Shows a placed label; a freshly bound one waits a frame so it fades in instead of popping.
    const revealLabel = (slot: LabelSlot) => {
      if (slot.fresh) {
        slot.fresh = false;
        forceLabels = true;
        return;
      }
      slot.el.classList.remove('is-hidden');
    };

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
    pulseInstanced.renderOrder = 4;
    edgesRoot.add(pulseInstanced);

    // Orbs whose opacity, glow or halo is still easing toward its target.
    const animatingNodes = new Set<RuntimeNodeEntry>();

    const disposeNodeInstancing = () => {
      if (!nodeInst) return;
      for (const mesh of nodeInst.buckets) {
        nodesRoot.remove(mesh);
        mesh.dispose();
      }
      nodesRoot.remove(nodeInst.halo);
      nodeInst.halo.geometry.dispose();
      nodeInst.halo.material.dispose();
      nodeInst.coreGeom.dispose();
      for (const mat of nodeInst.mats) mat.dispose();
      nodeInst = null;
    };

    const clearRuntimeGraph = () => {
      runtimeNodes.forEach((entry) => {
        unbindLabel(entry, true);
        if (entry.badge) {
          entry.badge.disposed = true;
          entry.badge.texture.dispose();
          entry.badge.material.dispose();
        }
        if (entry.home) {
          nodesRoot.remove(entry.home.group);
          entry.home.coreMat.dispose();
        }
      });
      runtimeNodes.clear();
      animatingNodes.clear();
      disposeNodeInstancing();
      labelCtx = emptyLabelContext();

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

      // Every node except home is an instance of one shared sphere, so a site with thousands of pages costs a
      // handful of draw calls and three materials instead of two meshes and two materials per page. Sphere
      // detail drops as the count rises: a few hundred triangles per node is invisible once there are thousands.
      const nodeCount = nextManifest.nodes.length;
      const capacity = Math.max(1, nodeCount);
      const visuals = resolveNodeVisuals();
      const adaptive = visuals.adaptiveSphereDetail;
      const [widthSegs, heightSegs] =
        adaptive && nodeCount > 1200 ? [10, 8]
        : adaptive && nodeCount > 400 ? [14, 10]
        : [visuals.sphereWidthSegments, visuals.sphereHeightSegments];
      const coreGeom = new THREE.SphereGeometry(1, widthSegs, heightSegs);
      // Opacity and glow are per orb, so any orb can fade independently of the others.
      const opacityAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity).fill(visuals.defaultOpacity), 1);
      const glowAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity).fill(visuals.glowDefault), 1);
      opacityAttr.setUsage(THREE.DynamicDrawUsage);
      glowAttr.setUsage(THREE.DynamicDrawUsage);
      coreGeom.setAttribute('aOpacity', opacityAttr);
      coreGeom.setAttribute('aGlow', glowAttr);
      // The instance colour is the node colour from the palette, multiplied onto a white material. Emissive follows
      // it (the orb's own colour times its glow), exactly as a per-node emissive material did.
      const makeCoreMaterial = (transparent: boolean) => {
        const mat = new THREE.MeshStandardMaterial({
          color: 0xffffff,
          emissive: 0xffffff,
          roughness: 0.28,
          metalness: 0.18,
          transparent,
          depthWrite: !transparent,
        });
        mat.onBeforeCompile = (shader) => {
          shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nattribute float aOpacity;\nattribute float aGlow;\nvarying float vOpacity;\nvarying float vGlow;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvOpacity = aOpacity;\n\tvGlow = aGlow;');
          shader.fragmentShader = shader.fragmentShader
            .replace('#include <common>', '#include <common>\nvarying float vOpacity;\nvarying float vGlow;')
            .replace('#include <color_fragment>', '#include <color_fragment>\n\tdiffuseColor.a *= vOpacity;')
            .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance = diffuseColor.rgb * vGlow;');
        };
        mat.customProgramCacheKey = () => 'web-obs-instanced-style';
        return mat;
      };
      const mats = [makeCoreMaterial(true), makeCoreMaterial(false)];
      const white = new THREE.Color(1, 1, 1);
      const buckets = mats.map((mat, bucketIndex) => {
        const mesh = new THREE.InstancedMesh(coreGeom, mat, capacity);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.count = nodeCount;
        mesh.frustumCulled = false;
        // Edges, then halos, then translucent orbs, then pulse dots: a stable order among the transparent objects.
        if (bucketIndex === 0) mesh.renderOrder = 3;
        for (let i = 0; i < capacity; i++) {
          mesh.setMatrixAt(i, hiddenInstanceMat);
          mesh.setColorAt(i, white);
        }
        mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
        nodesRoot.add(mesh);
        return mesh;
      });

      // Every halo ring is one instanced camera-facing quad: no per-node object, and no rotation to keep in step.
      const haloGeom = new THREE.InstancedBufferGeometry();
      haloGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
      haloGeom.setIndex([0, 1, 2, 0, 2, 3]);
      const haloCenter = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
      const haloColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
      const haloSize = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
      for (const attr of [haloCenter, haloColor, haloSize]) attr.setUsage(THREE.DynamicDrawUsage);
      haloGeom.setAttribute('iCenter', haloCenter);
      haloGeom.setAttribute('iColor', haloColor);
      haloGeom.setAttribute('iSize', haloSize);
      haloGeom.instanceCount = nodeCount;
      // The ring keeps the original ring's centre radius; its width is set in screen pixels in the shader.
      const haloPad = HALO_PAD;
      const ringMid = ((ORIGINAL_RING_INNER + ORIGINAL_RING_OUTER) / 2) / haloPad;
      const haloMat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        vertexShader: `
          attribute vec3 iCenter;
          attribute vec4 iColor;
          attribute float iSize;
          varying vec2 vUv;
          varying vec4 vColor;
          void main() {
            vec4 mv = modelViewMatrix * vec4(iCenter, 1.0);
            mv.xy += position.xy * iSize;
            vUv = position.xy;
            vColor = iColor;
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: `
          varying vec2 vUv;
          varying vec4 vColor;
          void main() {
            // The quad spans ${haloPad.toFixed(3)} radii. The ring is centred where the original ring was and is exactly
            // haloWidthPx pixels wide (px is one pixel in these units), so it stays a hairline at every zoom.
            float r = length(vUv);
            float px = max(fwidth(r), 0.0005);
            float halfWidth = ${(visuals.haloWidthPx * 0.5).toFixed(3)} * px;
            float d = abs(r - ${ringMid.toFixed(5)}) - halfWidth;
            float a = 1.0 - smoothstep(-0.5 * px, 0.5 * px, d);
            if (a < 0.004) discard;
            gl_FragColor = vec4(vColor.rgb, vColor.a * a);
            #include <colorspace_fragment>
          }`,
      });
      const halo = new THREE.Mesh(haloGeom, haloMat);
      halo.frustumCulled = false;
      halo.renderOrder = 2;
      nodesRoot.add(halo);

      const byIndex: RuntimeNodeEntry[] = [];

      nextManifest.nodes.forEach((node, index) => {
        const initPos = curLayouts.globe.get(node.id) ?? [0, 0, 0];
        const baseRadius =
          node.kind === 'home'
            ? 0.34
            : node.kind === 'hub'
              ? 0.21
              : node.kind === 'external-domain'
                ? 0.115
                : 0.135;
        const hex = palette[node.health] ?? palette.healthy;
        const pillText = shortPillLabel(node, nextManifest.domain);
        const entry: RuntimeNodeEntry = {
          node,
          index,
          baseRadius,
          haloScale: baseRadius,
          visible: true,
          bucket: -1,
          colorHex: -1,
          opacity: -1,
          opacityTarget: -1,
          glow: -1,
          glowTarget: -1,
          haloAlpha: -1,
          haloAlphaTarget: -1,
          haloHex: -1,
          posDirty: true,
          currentPos: new THREE.Vector3(...initPos),
          targetPos: new THREE.Vector3(...initPos),
          pillText,
          pillW: Math.max(68, pillText.length * 7.2 + 28),
          pillH: 24,
          pillMeasured: false,
          labelOffsetY: baseRadius + 0.16,
          label: null,
        };

        if (node.kind === 'home') {
          const group = new THREE.Group();
          group.position.set(initPos[0], initPos[1], initPos[2]);
          const coreMat = new THREE.MeshStandardMaterial({
            color: hex,
            emissive: hex,
            emissiveIntensity: 0.55,
            roughness: 0.28,
            metalness: 0.18,
          });
          const coreMesh = new THREE.Mesh(homeSphereGeom, coreMat);
          coreMesh.scale.setScalar(baseRadius);
          group.add(coreMesh);

          // The home node shows the site's own mark. The sphere stays as an invisible depth occluder
          // and click target, so links still end at the centre and picking is unchanged.
          let badge: BrandBadgeRuntime | undefined;
          const mark = pickBrandMark(nextManifest);
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
            entry.haloScale = baseRadius * (BADGE_SCALE / 2) * 0.82;
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
          nodesRoot.add(group);
          entry.home = { group, coreMesh, coreMat };
          entry.badge = badge;
          entry.labelOffsetY = (badge ? baseRadius * (BADGE_SCALE / 2) : baseRadius) + 0.16;
        }

        byIndex.push(entry);
        runtimeNodes.set(node.id, entry);
      });

      nodeInst = { coreGeom, buckets, mats, opacity: opacityAttr, glow: glowAttr, visuals, haloPad, halo, haloCenter, haloColor, haloSize, byIndex };

      if (nextManifest.edges.length > pulseCapacity) {
        edgesRoot.remove(pulseInstanced);
        pulseInstanced.dispose();
        pulseCapacity = nextManifest.edges.length + 32;
        pulseInstanced = new THREE.InstancedMesh(pulseGeom, pulseMat, pulseCapacity);
        pulseInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        pulseInstanced.frustumCulled = false;
    pulseInstanced.renderOrder = 4;
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
        lines.renderOrder = 1;
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

    // A ray against every visible node as an exact sphere: cheaper than raycasting instanced triangle meshes, and a
    // low-poly instance mesh would otherwise shrink each node's clickable area at its edge.
    const pickRay = new THREE.Ray();
    const pickInverse = new THREE.Matrix4();
    const pickSphere = new THREE.Sphere();
    const pickHit = new THREE.Vector3();
    const pickNodeAt = (clientX: number, clientY: number): string | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      // Nodes are positioned in the spin group's space, so the ray goes there rather than every node going to world space.
      sceneSpinGroup.updateWorldMatrix(true, false);
      pickRay.copy(raycaster.ray).applyMatrix4(pickInverse.copy(sceneSpinGroup.matrixWorld).invert());
      let best: string | null = null;
      let bestDistSq = Infinity;
      for (const entry of runtimeNodes.values()) {
        if (!entry.visible) continue;
        pickSphere.center.copy(entry.currentPos);
        pickSphere.radius = entry.home ? entry.home.coreMesh.scale.x : entry.baseRadius;
        if (pickRay.intersectSphere(pickSphere, pickHit) === null) continue;
        const distSq = pickHit.distanceToSquared(pickRay.origin);
        if (distSq < bestDistSq) {
          bestDistSq = distSq;
          best = entry.node.id;
        }
      }
      return best;
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

    const tmpScale = new THREE.Vector3();
    const identityQuat = new THREE.Quaternion();

    // Puts a node's instance matrix in the mesh that should draw it: opaque once fully opaque (those draw first),
    // translucent otherwise. Returns true when a matrix was written.
    const placeInstance = (entry: RuntimeNodeEntry, inst: NodeInstancing, forceWrite: boolean): boolean => {
      if (entry.home) return false;
      const bucket = !entry.visible ? -1 : entry.opacity >= 0.999 ? 1 : 0;
      if (bucket === entry.bucket && (!forceWrite || bucket < 0)) return false;
      if (bucket >= 0) tmpMat4.compose(entry.currentPos, identityQuat, tmpScale.setScalar(entry.baseRadius));
      if (bucket !== entry.bucket) {
        inst.buckets[0].setMatrixAt(entry.index, bucket === 0 ? tmpMat4 : hiddenInstanceMat);
        inst.buckets[1].setMatrixAt(entry.index, bucket === 1 ? tmpMat4 : hiddenInstanceMat);
      } else {
        inst.buckets[bucket].setMatrixAt(entry.index, tmpMat4);
      }
      entry.bucket = bucket;
      return true;
    };

    const approach = (current: number, target: number, rate: number) => {
      const delta = target - current;
      return Math.abs(delta) < 0.004 ? target : current + delta * rate;
    };

    // Eases every animating orb toward its target opacity, glow and halo, so selecting or hovering fades the map
    // instead of snapping it. Cheap: only orbs that are still moving are touched.
    const stepStyles = (dt: number) => {
      const inst = nodeInst;
      if (!inst || animatingNodes.size === 0) return;
      const rate = 1 - Math.exp(-dt / Math.max(0.001, inst.visuals.transitionMs / 3000));
      let matrixDirty = false;
      for (const entry of animatingNodes) {
        entry.opacity = approach(entry.opacity, entry.opacityTarget, rate);
        entry.glow = approach(entry.glow, entry.glowTarget, rate);
        entry.haloAlpha = approach(entry.haloAlpha, entry.haloAlphaTarget, rate);
        inst.opacity.setX(entry.index, entry.opacity);
        inst.glow.setX(entry.index, entry.glow);
        inst.haloColor.setW(entry.index, entry.haloAlpha);
        if (placeInstance(entry, inst, false)) matrixDirty = true;
        if (entry.opacity === entry.opacityTarget && entry.glow === entry.glowTarget && entry.haloAlpha === entry.haloAlphaTarget) {
          animatingNodes.delete(entry);
        }
      }
      inst.opacity.needsUpdate = true;
      inst.glow.needsUpdate = true;
      inst.haloColor.needsUpdate = true;
      if (matrixDirty) for (const mesh of inst.buckets) mesh.instanceMatrix.needsUpdate = true;
    };

    // How nodes look and which of them get a label: the mesh that draws each node, its colour and halo, and the
    // capped, priority-ordered label candidates. Runs only when something that affects a node changed.
    const syncNodes = (st: typeof stateRef.current, palette: Record<NodeHealth, number>) => {
      const layouts = st.layouts!;
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
          ? layouts.road
          : st.viewMode === 'clusters'
            ? layouts.clusters
            : layouts.globe;

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

      const inst = nodeInst;
      let matrixDirty = false;
      let colorDirty = false;
      let haloDirty = false;
      let anyNodeMoving = false;
      const candidates: LabelCandidate[] = [];

      runtimeNodes.forEach((entry, id) => {
        const tgt = targetMap.get(id) ?? [0, 0, 0];
        entry.targetPos.set(tgt[0], tgt[1], tgt[2]);
        entry.currentPos.lerp(entry.targetPos, 0.14);
        const moving = entry.currentPos.distanceToSquared(entry.targetPos) > 1e-6;
        if (moving) anyNodeMoving = true;
        else entry.currentPos.copy(entry.targetPos);
        if (entry.badge) syncBadge(entry.badge, st.theme);

        const allowedByFilter = matchesFilter(entry.node, st.filter, st.showExternal, st.attention);
        entry.visible = allowedByFilter;
        const matchesQuery =
          !query ||
          entry.node.title.toLowerCase().includes(query) ||
          entry.node.path.toLowerCase().includes(query) ||
          entry.node.url.toLowerCase().includes(query);
        const hex = palette[entry.node.health] ?? palette.healthy;
        const isDirect = id === focusId;
        const isNeighbor = focusId ? connectedIds.has(id) : true;
        const dimmed = entry.node.kind !== 'home' && ((Boolean(focusId) && !isNeighbor) || (Boolean(query) && !matchesQuery));

        const home = entry.home;
        if (home) {
          home.group.position.copy(entry.currentPos);
          home.group.visible = allowedByFilter;
          if (allowedByFilter) {
            home.coreMat.color.setHex(hex);
            home.coreMat.emissive.setHex(hex);
            home.coreMat.opacity = 1;
            home.coreMat.transparent = false;
            home.coreMat.emissiveIntensity = isDirect ? 0.85 : 0.32;
          }
        }

        if (inst) {
          const needsWrite = moving || entry.posDirty;
          entry.posDirty = moving;
          const v = inst.visuals;
          // Something is selected, hovered or searched: linked orbs and matches light up, the rest recede.
          const focusing = Boolean(focusId) || Boolean(query);
          const targetOpacity = dimmed ? v.dimOpacity : focusing ? v.highlightOpacity : v.defaultOpacity;
          const targetGlow = isDirect ? v.glowSelected : dimmed ? v.glowDim : v.glowDefault;
          const targetHalo = !allowedByFilter ? 0 : isDirect ? v.haloAlphaSelected : dimmed ? v.haloAlphaDim : v.haloAlphaDefault;
          const haloHex = entry.badge ? entry.badge.ringHex : hex;
          let snapped = false;
          if (entry.opacity < 0 || !allowedByFilter) {
            snapped = true;
            // First sync, or hidden by a filter: set directly, nothing to animate.
            entry.opacity = entry.opacityTarget = targetOpacity;
            entry.glow = entry.glowTarget = targetGlow;
            entry.haloAlpha = entry.haloAlphaTarget = targetHalo;
            inst.opacity.setX(entry.index, targetOpacity);
            inst.glow.setX(entry.index, targetGlow);
            animatingNodes.delete(entry);
          } else if (targetOpacity !== entry.opacityTarget || targetGlow !== entry.glowTarget || targetHalo !== entry.haloAlphaTarget) {
            entry.opacityTarget = targetOpacity;
            entry.glowTarget = targetGlow;
            entry.haloAlphaTarget = targetHalo;
            animatingNodes.add(entry);
          }
          if (!home) {
            if (hex !== entry.colorHex) {
              entry.colorHex = hex;
              tmpColorA.setHex(hex);
              for (const mesh of inst.buckets) mesh.setColorAt(entry.index, tmpColorA);
              colorDirty = true;
            }
            if (placeInstance(entry, inst, needsWrite)) matrixDirty = true;
          }
          if (needsWrite || snapped || haloHex !== entry.haloHex) {
            tmpColorB.setHex(haloHex);
            inst.haloCenter.setXYZ(entry.index, entry.currentPos.x, entry.currentPos.y, entry.currentPos.z);
            inst.haloSize.setX(entry.index, entry.haloScale * inst.haloPad);
            inst.haloColor.setXYZW(entry.index, tmpColorB.r, tmpColorB.g, tmpColorB.b, entry.haloAlpha);
            entry.haloHex = haloHex;
            haloDirty = true;
          }
        }

        // Label candidates: only a few labels at rest; hover, selection, neighbours and search add the rest.
        if (!allowedByFilter || (hoverId && !isNeighbor)) {
          unbindLabel(entry);
          return;
        }
        const linked = Boolean(focusId) && connectedIds.has(id);
        if (!(isDirect || id === hoverId || id === st.selectedId || linked || (query && matchesQuery) || resting.has(id))) {
          unbindLabel(entry);
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

        candidates.push({ entry, priority, isDirect, isHoverTarget: id === hoverId, isNeighbor, dimmed });
      });

      nodesSettled = !anyNodeMoving;
      if (inst) {
        if (matrixDirty) for (const mesh of inst.buckets) mesh.instanceMatrix.needsUpdate = true;
        inst.opacity.needsUpdate = true;
        inst.glow.needsUpdate = true;
        if (colorDirty) for (const mesh of inst.buckets) if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        if (haloDirty) {
          inst.haloCenter.needsUpdate = true;
          inst.haloSize.needsUpdate = true;
          inst.haloColor.needsUpdate = true;
        }
      }

      // More labels than a screen can hold without overlap would only cost DOM; keep the highest priority ones.
      candidates.sort((a, b) => b.priority - a.priority);
      for (let i = MAX_LABEL_CANDIDATES; i < candidates.length; i++) unbindLabel(candidates[i].entry);
      if (candidates.length > MAX_LABEL_CANDIDATES) candidates.length = MAX_LABEL_CANDIDATES;

      for (const candidate of candidates) {
        const { entry } = candidate;
        if (!entry.label) bindLabel(entry);
        const slot = entry.label!;
        slot.obj.position.set(entry.currentPos.x, entry.currentPos.y + entry.labelOffsetY, entry.currentPos.z);
        const el = slot.el;
        el.setAttribute('aria-pressed', String(entry.node.id === st.selectedId));
        el.classList.toggle('is-active', candidate.isDirect);
        el.classList.toggle('is-hover-target', candidate.isHoverTarget);
        el.classList.toggle('is-hover-context', candidate.isNeighbor);
        el.classList.toggle('is-dimmed', candidate.dimmed);
        el.style.translate = '';
      }

      labelCtx = { candidates, focusId, hoverId, connectedIds };
    };

    // Screen-space collision-free label placement. Cheap enough to run on every camera or spin frame: it only
    // touches the capped candidate list that syncNodes chose.
    const placeLabels = (st: typeof stateRef.current, measureLabels: boolean) => {
      const { candidates: visibleEntries, focusId, hoverId, connectedIds } = labelCtx;
      sceneSpinGroup.updateWorldMatrix(true, false);
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
          const measuredW = entry.label!.el.offsetWidth;
          const measuredH = entry.label!.el.offsetHeight;
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
        if (sizeChanged || (unmeasured && measureAttempts < 30)) forceLabels = true;
      }

      for (const { entry, priority } of visibleEntries) {
        // Section tags rank just below section hubs.
        if (priority < 58) placeSectorTags();
        tmpWorldPos.set(entry.currentPos.x, entry.currentPos.y + entry.labelOffsetY, entry.currentPos.z).applyMatrix4(sceneSpinGroup.matrixWorld);
        tmpVec.copy(tmpWorldPos).project(camera);
        if (tmpVec.z > 1 || tmpVec.z < -1) {
          entry.label!.el.classList.add('is-hidden');
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
          revealLabel(entry.label!);
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
          entry.label!.el.classList.add('is-hidden');
        } else {
          const [dx, dy] = freeSlot;
          entry.label!.el.style.translate = `${dx}px ${dy}px`;
          placedBoxes.push({ l: box.l + dx, r: box.r + dx, t: box.t + dy, b: box.b + dy });
          revealLabel(entry.label!);
        }
      }

      placeSectorTags();
    };

    // Curves, colours and pulse flow for every edge. Runs only when something that affects an edge changed.
    const syncEdges = (st: typeof stateRef.current, focusId: string | null, palette: Record<NodeHealth, number>, elapsed: number) => {
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
          Boolean(srcEntry?.visible) &&
          Boolean(dstEntry?.visible) &&
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
      // On-demand rendering in two tiers. Scene state (node placement, colour, halo, edges, label choice) is
      // rebuilt only when something that affects it changed. A frame that only moves the camera or spins the
      // globe just re-places the labels, which is all that depends on the view.
      const camMoved = !camera.position.equals(lastCamPos) || !camera.quaternion.equals(lastCamQuat);
      const key = [
        st.viewMode, st.theme, st.selectedId ?? '', st.hoveredId ?? '', labelHoverId ?? '', st.filter, st.searchQuery,
        st.showExternal, st.showChromeLinks, st.showAllLinks, st.showPulses, st.autoRotate,
      ].join('|');
      const keyChanged = key !== lastKey || st.manifest !== lastManifestRef || st.layouts !== lastLayoutsRef ||
        renderVersionRef.current !== lastVersion;
      const gizmoPending = Boolean(gizmoHolderRef.current?.current && gizmoHolderRef.current.current !== syncedGizmo);
      const stateDirty = forceHeavy || keyChanged || !nodesSettled;
      const stylesAnimating = animatingNodes.size > 0;
      const viewDirty = camMoved || spinningNow || settlingSpin || flying || gizmoPending;
      if (!stateDirty && !viewDirty && !forceLabels) {
        // Nothing but orb opacity is easing (or only pulses move): the scene redraws, labels stay where they are.
        if (stylesAnimating) stepStyles(dt);
        if (stylesAnimating || (st.showPulses && pulseEdges.length > 0)) {
          if (st.showPulses) {
            for (const re of pulseEdges) writePulse(re, elapsed, re.pulseHighlighted);
            pulseInstanced.instanceMatrix.needsUpdate = true;
          }
          renderer.render(scene, camera);
        }
        return;
      }
      const measureLabels = keyChanged || forceHeavy;
      forceLabels = false;
      if (stateDirty) {
        forceHeavy = false;
        lastKey = key;
        lastManifestRef = st.manifest;
        lastLayoutsRef = st.layouts;
        lastVersion = renderVersionRef.current;
        pulseEdges = [];
      }
      lastCamPos.copy(camera.position);
      lastCamQuat.copy(camera.quaternion);
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

      if (stateDirty) {
        syncNodes(st, palette);
        syncEdges(st, labelCtx.focusId, palette, elapsed);
      } else if (st.showPulses && pulseEdges.length > 0) {
        for (const re of pulseEdges) writePulse(re, elapsed, re.pulseHighlighted);
        pulseInstanced.instanceMatrix.needsUpdate = true;
      }
      stepStyles(dt);
      placeLabels(st, measureLabels);

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
      for (const slot of labelPool) slot.el.remove();
      labelPool.length = 0;
      freeLabels.length = 0;
      sceneSpinGroup.remove(labelsRoot);
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
