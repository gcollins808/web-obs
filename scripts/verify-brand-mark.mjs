// The map's brand badge: which logo and colour it picks from a capture, that the ring stays visible
// on both map surfaces, and that the dev server only hands out images from inside a capture.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';

async function load(entry) {
  const output = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent', external: ['vite'] });
  return import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].contents).toString('base64'));
}
const brand = await load('src/data/brandMark.ts');
const server = await load('src/server/captureApi.ts');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('[PASS] ' + name); }

const base = (extra = {}) => ({ siteId: 'shop.example', domain: 'shop.example', brandName: 'Shop Example', resources: [], brandKit: {}, ...extra });
const icon = (url, localPath) => ({ id: url, url, type: 'image', references: [], localPath });

test('a saved brand logo wins over favicons', () => {
  const mark = brand.pickBrandMark(base({
    brandKit: { localLogoAsset: 'sites/shop.example/assets/brand-logo.svg', faviconUrls: ['https://shop.example/favicon.svg'] },
    resources: [icon('https://shop.example/favicon.svg', 'sites/shop.example/assets/favicon-1.svg')],
  }));
  assert.deepEqual(mark.logo, { path: 'sites/shop.example/assets/brand-logo.svg', source: 'brand-logo' });
});

test('without a logo, the sharpest icon is used: SVG, then the largest declared size, ICO last', () => {
  const resources = [
    icon('https://shop.example/favicon.ico', 'sites/shop.example/assets/favicon-a.ico'),
    icon('https://shop.example/favicon-48x48.png', 'sites/shop.example/assets/favicon-48x48-b.png'),
    icon('https://shop.example/apple-touch-icon.png', 'sites/shop.example/assets/apple-touch-icon-c.png'),
  ];
  const kit = { faviconUrls: resources.map((r) => r.url) };
  assert.deepEqual(brand.pickBrandMark(base({ brandKit: kit, resources })).logo,
    { path: 'sites/shop.example/assets/apple-touch-icon-c.png', source: 'touch-icon' });
  const withSvg = [...resources, icon('https://shop.example/favicon.svg', 'sites/shop.example/assets/favicon-d.svg')];
  assert.equal(brand.pickBrandMark(base({ brandKit: kit, resources: withSvg })).logo.path, 'sites/shop.example/assets/favicon-d.svg');
  assert.equal(brand.pickBrandMark(base({ brandKit: { localFaviconAsset: 'sites/shop.example/assets/favicon-a.ico' } })).logo.source, 'favicon');
});

test('fallbacks follow the logo in order, without repeats, so an unusable file can be skipped', () => {
  const resources = [
    icon('https://shop.example/favicon.ico', 'sites/shop.example/assets/favicon-a.ico'),
    icon('https://shop.example/favicon.svg', 'sites/shop.example/assets/favicon-d.svg'),
    icon('https://shop.example/apple-touch-icon.png', 'sites/shop.example/assets/apple-touch-icon-c.png'),
  ];
  const mark = brand.pickBrandMark(base({
    brandKit: { localLogoAsset: 'sites/shop.example/assets/brand-logo.svg', localFaviconAsset: 'sites/shop.example/assets/favicon-a.ico', faviconUrls: resources.map((r) => r.url) },
    resources,
  }));
  assert.deepEqual(mark.logoCandidates.map((c) => c.path.split('/').pop()), ['brand-logo.svg', 'favicon-d.svg', 'apple-touch-icon-c.png', 'favicon-a.ico']);
  assert.deepEqual(mark.logo, mark.logoCandidates[0]);
  assert.deepEqual(brand.pickBrandMark(base()).logoCandidates, []);
});

test('logo paths outside the site folder, with traversal, or not images are refused', () => {
  for (const bad of ['sites/other.example/assets/logo.png', 'sites/shop.example/../other.example/logo.png', 'sites/shop.example/assets/logo.md',
    'sites/shop.example//logo.png', 'sites\\shop.example\\logo.png', '/etc/passwd.png', 42, null]) {
    assert.equal(brand.pickBrandMark(base({ brandKit: { localLogoAsset: bad } })).logo, null, String(bad));
  }
  const notIcon = icon('https://shop.example/hero.png', 'sites/shop.example/assets/hero.png');
  assert.equal(brand.pickBrandMark(base({ resources: [notIcon] })).logo, null, 'ordinary page images are not logos');
});

test('brand colour: a chromatic theme-color first, then the first chromatic stylesheet colour', () => {
  const palette = [
    { hex: '#e07850', declared: '#e0785026', candidateRole: 'chromatic' },
    { hex: '#4ade80', declared: '#4ade80', candidateRole: 'chromatic' },
  ];
  assert.deepEqual(brand.pickBrandMark(base({ brandKit: { themeColor: '#1d5bd1', palette } })).color,
    { hex: '#1d5bd1', declared: '#1d5bd1', source: 'theme-color' });
  const fromSheet = brand.pickBrandMark(base({ brandKit: { themeColor: '#0A0A0A', palette } })).color;
  assert.equal(fromSheet.hex, '#e07850', 'a near-black theme-color says nothing; a translucent tint still names the colour');
  assert.equal(fromSheet.source, 'stylesheet');
  const greys = [{ declared: '#777777', candidateRole: 'neutral' }, { declared: '#263339', candidateRole: 'chromatic' }, { declared: 'rgba(224,120,80,0)', candidateRole: 'chromatic' }];
  assert.equal(brand.pickBrandMark(base({ brandKit: { palette: greys } })).color, null, 'greys, near-greys and transparent values are not brand colours');
  assert.equal(brand.pickBrandMark(base({ brandKit: { palette: [{ declared: 'rgb(23, 134, 235)' }] } })).color.hex, '#1786eb');
});

test('the ring always reaches 3:1 against both map surfaces and keeps its hue', () => {
  const samples = ['#e07850', '#ffe04a', '#4ade80', '#1786eb', '#006c4a', '#0f1b2d', '#591fc9', '#ff5a26', '#a76a3e', '#f43f5e', '#00d084', '#7db3ff', '#fff3b0', '#1a0033'];
  const family = (c) => { const p = /^#(..)(..)(..)$/.exec(c).slice(1).map((x) => parseInt(x, 16)); return p.indexOf(Math.max(...p)); };
  for (const theme of ['dark', 'light']) {
    for (const hex of samples) {
      const ring = brand.ringColorFor(hex, theme);
      assert.ok(brand.contrastRatio(ring, brand.MAP_SURFACE[theme]) >= 3, `${hex} on ${theme} gave ${ring}`);
      if (brand.oklchChroma(hex) > 0.1 && brand.oklchChroma(ring) > 0.05) assert.equal(family(ring), family(hex), `${hex} on ${theme} changed hue family to ${ring}`);
    }
  }
  assert.equal(brand.ringColorFor('#e07850', 'dark'), '#e07850', 'a colour that already passes is left exactly as declared');
});

test('initials and ink stay readable', () => {
  assert.equal(brand.brandInitials('Agrici Daniel'), 'AD');
  assert.equal(brand.brandInitials('shopexample.com'), 'SH');
  assert.equal(brand.brandInitials('www.brand.example'), 'BR');
  assert.equal(brand.brandInitials('...'), '?');
  for (const fill of ['#e07850', '#ffe04a', '#0f1b2d', '#1786eb']) assert.ok(brand.contrastRatio(brand.inkOn(fill), fill) >= 4.5, fill);
  assert.equal(brand.pickBrandMark(base({ brandName: undefined })).label, 'shop.example');
  assert.equal(brand.pickBrandMark(null), null);
});

test('dev asset route serves only images inside a capture', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-obs-brand-'));
  const sites = path.join(root, 'sites');
  fs.mkdirSync(path.join(sites, 'shop.example', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(sites, 'shop.example', 'assets', 'logo.png'), 'png');
  fs.writeFileSync(path.join(sites, 'shop.example', 'notes.md'), 'md');
  fs.writeFileSync(path.join(root, 'secret.png'), 'outside');
  fs.symlinkSync(path.join(root, 'secret.png'), path.join(sites, 'shop.example', 'assets', 'escape.png'));
  fs.writeFileSync(path.join(sites, 'shop.example', 'assets', 'huge.png'), Buffer.alloc(server.MAX_SITE_IMAGE_BYTES + 1));
  const ok = server.resolveSiteImage(sites, 'sites/shop.example/assets/logo.png');
  assert.equal(ok && fs.readFileSync(ok, 'utf8'), 'png');
  for (const bad of ['sites/shop.example/notes.md', 'sites/shop.example/assets/escape.png', 'sites/shop.example/assets/huge.png',
    'sites/shop.example/../../secret.png', 'sites/../secret.png', 'secret.png', 'sites/shop.example/assets/missing.png',
    'sites/shop.example\\assets\\logo.png', null]) {
    assert.equal(server.resolveSiteImage(sites, bad), null, String(bad));
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('the map wires the badge to the host and keeps the home sphere as its click target', () => {
  const canvas = fs.readFileSync('src/components/SiteGlobeCanvas3D.tsx', 'utf8');
  const app = fs.readFileSync('src/App.tsx', 'utf8');
  const view = fs.readFileSync('src/plugin/SiteGlobeView.ts', 'utf8');
  assert.match(app, /readAssetBytes=\{activeHost\.readAssetBytes\}/);
  assert.match(canvas, /coreMat\.colorWrite = false/, 'the sphere still occludes links and takes clicks');
  assert.match(canvas, /entry\.home \? entry\.home\.coreMesh\.scale\.x/, 'picking tests the home sphere at its full badge size');
  assert.match(canvas, /entry\.badge\.texture\.dispose\(\)/, 'badge textures are released with the graph');
  assert.match(view, /readAssetBytes: async/);
  assert.match(view, /MAX_MAP_ASSET_BYTES/);
  assert.match(view, /MAP_ASSET_EXTENSIONS\.has\(file\.extension/, 'the Obsidian reader serves images only');
  assert.match(canvas, /coreMesh\.scale\.setScalar\(baseRadius \* \(BADGE_SCALE \/ 2\)\)/, 'the whole badge, rim included, is clickable');
  assert.match(fs.readFileSync('src/server/captureApi.ts', 'utf8'), /__web_obs\/asset[\s\S]{0,200}sec-fetch-site/, 'the dev asset route refuses cross-site requests');
});

console.log(`Brand mark: ${passed} deterministic cases passed. No network was used.`);
