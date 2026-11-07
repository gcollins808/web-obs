import assert from 'node:assert/strict';
import { build } from 'esbuild';

async function load(entry) {
  const output = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
  return import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].contents).toString('base64'));
}
const { computeSiteLayouts, computeRoadMetrics, DEFAULT_ROAD_METRICS } = await load('src/data/globeLayout.ts');
const { fitCameraToPoints } = await load('src/components/SiteGlobeCanvas3D.tsx');
const THREE = await import('three');

function node(i, title) {
  return {
    id: `p${i}`, kind: i === 0 ? 'home' : 'page', health: i === 0 ? 'home' : 'healthy', title, url: `https://example.test/p${i}`,
    path: i === 0 ? '/' : `/p${i}`, section: `s${i % 5}`, obsidianPath: `p${i}.md`, statusCode: 200,
    inSitemap: true, urlDepth: 1, clickDepth: i === 0 ? 0 : 1 + (i % 3), wordCount: 100,
    metaDescription: '', canonical: '', metaRobots: '', inlinksBody: 1,
  };
}
const site = (count, title = 'A page title 17ch') => ({ domain: 'example.test', nodes: Array.from({ length: count }, (_, i) => node(i, title)), edges: [] });

let count = 0;
function check(name, fn) { fn(); count++; console.log('[PASS] ' + name); }

check('a mid sized site keeps the original Road spacing', () => {
  const metrics = computeRoadMetrics(site(64).nodes);
  assert.ok(Math.abs(metrics.rowStep - 0.95) < 0.01, `row step ${metrics.rowStep}`);
  assert.ok(Math.abs(metrics.subColumnWidth - 3.8) < 0.1, `sub column width ${metrics.subColumnWidth}`);
});

check('Road row spacing tightens as the site grows and stays within its limits', () => {
  const small = computeRoadMetrics(site(8).nodes).rowStep;
  const medium = computeRoadMetrics(site(64).nodes).rowStep;
  const large = computeRoadMetrics(site(2000).nodes).rowStep;
  assert.ok(small > medium && medium > large, `${small} > ${medium} > ${large}`);
  assert.ok(small <= 1.3 && large >= 0.7);
});

check('Road column width follows label length within its limits', () => {
  const short = computeRoadMetrics(site(40, 'Home').nodes).subColumnWidth;
  const long = computeRoadMetrics(site(40, 'A fairly long page title ok').nodes).subColumnWidth;
  assert.ok(long > short);
  assert.ok(short >= 2.6 && long <= 5.6);
});

check('an empty site falls back to the default Road spacing', () => {
  assert.deepEqual(computeRoadMetrics([]), DEFAULT_ROAD_METRICS);
  const layouts = computeSiteLayouts({ domain: 'example.test', nodes: [], edges: [] });
  assert.deepEqual(layouts.roadMetrics, DEFAULT_ROAD_METRICS);
  assert.equal(layouts.roadColumns.length, 0);
});

check('every page gets its own finite Road position', () => {
  const layouts = computeSiteLayouts(site(2000));
  assert.equal(layouts.road.size, 2000);
  const seen = new Set();
  for (const point of layouts.road.values()) {
    assert.ok(point.every(Number.isFinite));
    seen.add(`${point[0].toFixed(3)},${point[1].toFixed(3)}`);
  }
  assert.equal(seen.size, 2000, 'no two pages share a spot');
});

check('the camera fit has no fixed distance cap and reports the distance and radius', () => {
  const points = [new THREE.Vector3(-400, 0, 0), new THREE.Vector3(400, 0, 0)];
  const fit = fitCameraToPoints(points, new THREE.Vector3(0, 0.05, 1), 42, 1280, 720);
  assert.ok(fit.distance > 40, `distance ${fit.distance}`);
  assert.ok(fit.radius >= 400);
});

console.log(`${count} road layout checks passed`);
