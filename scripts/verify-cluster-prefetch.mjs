import assert from 'node:assert/strict';
import { build } from 'esbuild';

async function load(entry) {
  const output = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
  return import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].contents).toString('base64'));
}
const { computeSiteLayouts, relaxClusters, ClusterRelaxation } = await load('src/data/globeLayout.ts');

function node(id, kind, index) {
  return {
    id, kind, health: kind === 'home' ? 'home' : 'healthy', title: id, url: `https://example.test/${id}`,
    path: kind === 'home' ? '/' : `/${id}`, section: `s${index % 6}`, obsidianPath: `${id}.md`, statusCode: 200,
    inSitemap: true, urlDepth: 1, clickDepth: kind === 'home' ? 0 : 1, wordCount: 100,
    metaDescription: '', canonical: '', metaRobots: '', inlinksBody: 1,
  };
}

function linkedSite(pages, linksPerPage) {
  const nodes = [node('home', 'home', 0)];
  for (let i = 0; i < pages; i++) nodes.push(node(`p${i}`, 'page', i + 1));
  const edges = [];
  for (let i = 0; i < pages; i++) {
    edges.push({ id: `h${i}`, source: 'home', target: `p${i}`, kind: 'internal-body' });
    edges.push({ id: `c${i}`, source: `p${i}`, target: 'home', kind: 'internal-chrome' });
    for (let j = 0; j < linksPerPage; j++) {
      edges.push({ id: `l${i}-${j}`, source: `p${i}`, target: `p${(i + j * 17 + 1) % pages}`, kind: 'internal-body' });
    }
  }
  return { domain: 'example.test', nodes, edges };
}

/** The simulation as it was written before the typed-array rewrite: string-keyed Maps, one division per axis. */
function referenceClusters(nodes, edges, homeNode, globe) {
  const pos = new Map();
  for (const n of nodes) {
    const g = globe.get(n.id) ?? [0, 0, 0];
    pos.set(n.id, [g[0] * 0.85, g[1] * 0.85, g[2] * 0.85]);
  }
  const activeEdges = edges.filter((e) => e.kind !== 'internal-chrome');
  const idList = nodes.map((n) => n.id);
  const vel = new Map();
  for (const id of idList) vel.set(id, [0, 0, 0]);
  const degree = new Map();
  for (const e of activeEdges) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }
  const iterations = Math.min(90, Math.max(40, Math.round(1400 / Math.max(12, nodes.length))));
  for (let iter = 0; iter < iterations; iter++) {
    const alpha = 1 - iter / iterations;
    for (let i = 0; i < idList.length; i++) {
      const pA = pos.get(idList[i]);
      const vA = vel.get(idList[i]);
      for (let j = i + 1; j < idList.length; j++) {
        const pB = pos.get(idList[j]);
        const vB = vel.get(idList[j]);
        const dx = pA[0] - pB[0];
        const dy = pA[1] - pB[1];
        const dz = pA[2] - pB[2];
        const dSq = Math.max(0.25, dx * dx + dy * dy + dz * dz);
        const f = (0.52 * alpha) / dSq;
        const dist = Math.sqrt(dSq);
        const fx = (dx / dist) * f;
        const fy = (dy / dist) * f;
        const fz = (dz / dist) * f;
        vA[0] += fx; vA[1] += fy; vA[2] += fz;
        vB[0] -= fx; vB[1] -= fy; vB[2] -= fz;
      }
    }
    for (const e of activeEdges) {
      const pS = pos.get(e.source);
      const pT = pos.get(e.target);
      if (!pS || !pT) continue;
      const vS = vel.get(e.source);
      const vT = vel.get(e.target);
      const ideal = e.kind === 'external' ? 5.6 : e.kind === 'sitemap-hierarchy' ? 3.2 : 3.8;
      const dx = pT[0] - pS[0];
      const dy = pT[1] - pS[1];
      const dz = pT[2] - pS[2];
      const dist = Math.max(0.1, Math.hypot(dx, dy, dz));
      const stiffness = 0.045 * Math.min(1, 8 / Math.max(degree.get(e.source) ?? 1, degree.get(e.target) ?? 1));
      const pull = (dist - ideal) * stiffness * alpha;
      const fx = (dx / dist) * pull;
      const fy = (dy / dist) * pull;
      const fz = (dz / dist) * pull;
      vS[0] += fx; vS[1] += fy; vS[2] += fz;
      vT[0] -= fx; vT[1] -= fy; vT[2] -= fz;
    }
    for (const n of nodes) {
      if (homeNode && n.id === homeNode.id) { pos.set(n.id, [0, 0, 0]); continue; }
      const p = pos.get(n.id);
      const v = vel.get(n.id);
      p[0] = (p[0] + v[0]) * 0.995;
      p[1] = (p[1] + v[1]) * 0.995;
      p[2] = (p[2] + v[2]) * 0.995;
      v[0] *= 0.6; v[1] *= 0.6; v[2] *= 0.6;
    }
  }
  const clusters = new Map();
  for (const n of nodes) clusters.set(n.id, pos.get(n.id) ?? [0, 0, 0]);
  return clusters;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let count = 0;
async function check(name, fn) { await fn(); count++; console.log('[PASS] ' + name); }

await check('the relaxation matches the original Map-based simulation to rounding', () => {
  const site = linkedSite(300, 6);
  const layouts = computeSiteLayouts(site);
  const reference = referenceClusters(site.nodes, site.edges, site.nodes[0], layouts.globe);
  const actual = relaxClusters(site.nodes, site.edges, site.nodes[0], layouts.globe);
  assert.equal(actual.size, reference.size);
  let radius = 0;
  for (const point of reference.values()) radius = Math.max(radius, ...point.map(Math.abs));
  for (const [id, point] of reference) {
    const got = actual.get(id);
    for (let axis = 0; axis < 3; axis++) {
      assert.ok(Math.abs(got[axis] - point[axis]) <= 1e-9 * Math.max(1, radius), `${id}[${axis}] ${got[axis]} vs ${point[axis]}`);
    }
  }
});

await check('a sliced run is bit-identical to a one-shot run', () => {
  const site = linkedSite(400, 5);
  const layouts = computeSiteLayouts(site);
  const whole = relaxClusters(site.nodes, site.edges, site.nodes[0], layouts.globe);
  const job = new ClusterRelaxation(site.nodes, site.edges, site.nodes[0], layouts.globe);
  let slices = 0;
  while (!job.step(0.05)) slices++;
  assert.ok(slices > 3, `a tiny budget splits the work into slices (${slices})`);
  const sliced = job.result();
  for (const [id, point] of whole) assert.deepEqual(sliced.get(id), point);
});

await check('clusters are computed on first read and cached', () => {
  const layouts = computeSiteLayouts(linkedSite(150, 4));
  const first = layouts.clusters;
  assert.equal(first.size, 151);
  assert.equal(layouts.clusters, first, 'a second read returns the same map');
});

await check('reading clusters during a prefetch finishes the job with the same result', async () => {
  const site = linkedSite(500, 4);
  const layouts = computeSiteLayouts(site);
  const expected = relaxClusters(site.nodes, site.edges, site.nodes[0], layouts.globe);
  const cancel = layouts.prefetchClusters(1, 0);
  assert.equal(typeof cancel, 'function');
  await sleep(420); // the first slice runs after 300 ms; the read below must be right whether or not the job has finished
  const clusters = layouts.clusters;
  for (const [id, point] of expected) assert.deepEqual(clusters.get(id), point);
  cancel();
});

await check('cancelling a prefetch is safe and clusters are still computed on demand', async () => {
  const site = linkedSite(400, 4);
  const layouts = computeSiteLayouts(site);
  layouts.prefetchClusters(1, 0)();
  await sleep(350);
  assert.equal(layouts.clusters.size, 401);
});

await check('small sites skip the prefetch', () => {
  const layouts = computeSiteLayouts(linkedSite(40, 3));
  assert.equal(layouts.prefetchClusters()(), undefined);
  assert.equal(layouts.clusters.size, 41);
});

console.log(`${count} cluster prefetch checks passed`);
