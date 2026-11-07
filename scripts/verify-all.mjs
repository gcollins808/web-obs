#!/usr/bin/env node
/**
 * Comprehensive verification gate for web-obs:
 * 1. Dash hygiene check (zero em/en dashes across source, engine, scripts, docs)
 * 2. Python syntax compilation check
 * 3. End-to-end local HTTP mock business site crawl verification:
 *    - Step 1: robots.txt -> sitemap_index.xml -> child sitemap-pages.xml
 *    - Step 2: Content Markdown, SEO metadata, JSON-LD schema, contacts, local PNG image download
 *    - Step 3: Internal (body vs chrome) & external links, orphan + unlisted page detection,
 *              _site-graph.json, _site-summary.json, _sitemap.canvas, _pages.base, _dashboard.md
 * 4. TypeScript compilation & dist-plugin == .obsidian/plugins/web-obs SHA-256 parity
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { engineFileHashes, pythonCommand } from './engine-files.mjs';

const ROOT = path.resolve('.');

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function collectFiles(dir, exts) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === 'node_modules' ||
      entry.name === 'dist' ||
      entry.name === 'dist-plugin' ||
      entry.name === '.git' ||
      entry.name === '.venv' ||
      entry.name === '__pycache__' ||
      entry.name === '.obsidian' ||
      entry.name === 'sites'
    ) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full, exts));
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      results.push(full);
    }
  }
  return results;
}

function checkDashHygiene() {
  const files = collectFiles(ROOT, ['.ts', '.tsx', '.js', '.mjs', '.css', '.py', '.md', '.json', '.html']);
  const violations = [];
  for (const file of files) {
    if (path.basename(file) === 'package-lock.json') continue;
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].includes('\u2014') || lines[i].includes('\u2013')) {
        violations.push(`${path.relative(ROOT, file)}:${i + 1}`);
      }
    }
  }
  assert.equal(
    violations.length,
    0,
    `Found forbidden em/en dashes in:\n${violations.join('\n')}`
  );
  console.log(`[PASS] Dash hygiene verified across ${files.length} project files.`);
}

// Keep private project and employer branding out of the shipped code, docs and generated output.
// The pattern is assembled from pieces so this file does not match itself.
function checkNoPrivateBranding() {
  const pattern = new RegExp(['ai' + 'mh', 'TM-' + '023', 'marketing' + ' hub'].join('|'), 'i');
  const roots = ['src', 'engine', 'scripts', 'docs', '.github', 'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'manifest.json', 'package.json', 'esbuild.config.mjs'];
  const files = roots.flatMap((entry) => {
    const full = path.join(ROOT, entry);
    if (!fs.existsSync(full)) return [];
    return fs.statSync(full).isDirectory() ? collectFiles(full, ['.ts', '.tsx', '.js', '.mjs', '.css', '.py', '.md', '.json', '.html', '.yml', '.txt']) : [full];
  });
  const hits = [];
  for (const file of files) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (pattern.test(line)) hits.push(`${path.relative(ROOT, file)}:${index + 1}`);
    });
    if (pattern.test(path.basename(file))) hits.push(`${path.relative(ROOT, file)} (file name)`);
  }
  assert.equal(hits.length, 0, `Private branding found in shipped files:\n${hits.join('\n')}`);
  console.log(`[PASS] No private branding in ${files.length} shipped files.`);
}

function checkPythonSyntax() {
  const pyFiles = fs
    .readdirSync(path.join(ROOT, 'engine'))
    .filter((f) => f.endsWith('.py'))
    .map((f) => path.join(ROOT, 'engine', f));
  execFileSync(pythonCommand(ROOT), ['-m', 'py_compile', ...pyFiles], { stdio: 'inherit' });
  console.log(`[PASS] Python syntax compiled cleanly (${pyFiles.length} modules).`);
}

// 1x1 valid transparent PNG
const ONE_BY_ONE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

async function runEndToEndMockCrawlTest() {
  let baseUrl = '';

  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', baseUrl);
    const p = u.pathname;

    if (p === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(
        `User-agent: *\nAllow: /\nUser-agent: CCBot\nDisallow: /\nSitemap: ${baseUrl}/sitemap_index.xml\n`
      );
      return;
    }

    if (p === '/llms.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`# MockBusiness\n> Structured growth architecture studio.\n`);
      return;
    }

    if (p === '/sitemap_index.xml') {
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
      res.end(`<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${baseUrl}/sitemap-pages.xml</loc></sitemap>
</sitemapindex>`);
      return;
    }

    if (p === '/sitemap-pages.xml') {
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
      res.end(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${baseUrl}/</loc><priority>1.0</priority></url>
  <url><loc>${baseUrl}/services</loc><priority>0.8</priority></url>
  <url><loc>${baseUrl}/services/seo-audit</loc><priority>0.8</priority></url>
  <url><loc>${baseUrl}/pricing</loc><priority>0.7</priority></url>
  <url><loc>${baseUrl}/orphan-offer</loc><priority>0.5</priority></url>
</urlset>`);
      return;
    }

    if (p === '/img/hero.png' || p === '/img/chart.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(ONE_BY_ONE_PNG);
      return;
    }

    const navHtml = `
      <header>
        <nav>
          <a href="/">Home</a>
          <a href="/services">Services</a>
          <a href="/pricing">Pricing</a>
        </nav>
      </header>`;

    const footerHtml = `
      <footer>
        <a href="mailto:hello@mockbusiness.example">hello@mockbusiness.example</a>
        <a href="tel:+15550199">+1 555 0199</a>
        <a href="https://md.linkedin.com/company/mockbusiness">LinkedIn</a>
      </footer>`;

    if (p === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Strict-Transport-Security': 'max-age=31536000',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(`<!doctype html>
<html lang="en">
<head>
  <title>MockBusiness | Growth Architecture Studio</title>
  <meta name="description" content="Structured technical SEO and growth systems for modern businesses." />
  <meta property="og:site_name" content="MockBusiness" />
  <meta property="og:image" content="${baseUrl}/img/hero.png" />
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-MOCK12345"></script>
  <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Organization","name":"MockBusiness","url":"${baseUrl}"}
  </script>
</head>
<body>
  ${navHtml}
  <section class="hero-banner">
    <h1>Growth Architecture for Ambitious Companies</h1>
    <p>We map websites from sitemap first through content and internal link equity so teams can scale organic search.</p>
  </section>
  <main>
    <img src="/img/hero.png" alt="Growth Studio Hero Diagram" />
    <svg role="img" viewBox="0 0 240 120" width="240" height="120">
      <title>Organic Pipeline Growth Chart</title>
      <rect x="10" y="10" width="220" height="100" fill="#2563eb" />
      <text x="24" y="64" fill="#ffffff">+184% Pipeline</text>
    </svg>
    <table>
      <thead><tr><th>Tier</th><th>Deliverable</th></tr></thead>
      <tbody><tr><td>Core</td><td>Full Sitemap &amp; Link Graph</td></tr></tbody>
    </table>
    <div class="card-grid">
      <a href="/services/seo-audit" class="card-link">
        <h3>Technical SEO Audit</h3>
        <p>Complete crawl depth and link equity diagnostics.</p>
      </a>
    </div>
    <p>Also view our <a href="/unlisted-playbook">Unlisted Internal Playbook</a> or <a href="https://calendly.com/mockbusiness/intro">Book a Strategy Call</a>.</p>
    <p>Reference code is hosted on <a href="https://github.com/example/growth-kit">GitHub</a>.</p>
    <button aria-expanded="false" aria-controls="faq-panel-1">How fast is capture?</button>
    <div id="faq-panel-1"><p>Typical 60-page business sites finish in under 15 seconds.</p></div>
  </main>
  ${footerHtml}
</body>
</html>`);
      return;
    }

    if (p === '/services') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html lang="en">
<head>
  <title>Services | MockBusiness</title>
  <meta name="description" content="Core technical marketing services." />
</head>
<body>
  ${navHtml}
  <main>
    <h1>Our Services</h1>
    <p>Every engagement begins with a deep <a href="/services/seo-audit">Technical SEO Audit</a> and transparent <a href="/pricing">Pricing</a>.</p>
  </main>
  ${footerHtml}
</body>
</html>`);
      return;
    }

    if (p === '/services/seo-audit') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html lang="en">
<head>
  <title>Technical SEO Audit | MockBusiness</title>
  <meta name="description" content="Complete sitemap, content, and link graph audit." />
  <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Service","name":"Technical SEO Audit"}
  </script>
</head>
<body>
  ${navHtml}
  <main>
    <h1>Technical SEO Audit</h1>
    <p>We inspect crawl depth, orphan pages, schema markup, and internal anchor context across every section.</p>
    <img data-src="/img/chart.png" alt="Crawl Depth Chart" />
    <p>Follow official <a href="https://developers.google.com/search/docs">Google Search Documentation</a> and review our <a href="/pricing">Pricing Plans</a>.</p>
  </main>
  ${footerHtml}
</body>
</html>`);
      return;
    }

    if (p === '/pricing') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html lang="en">
<head>
  <title>Pricing | MockBusiness</title>
  <meta name="description" content="Simple transparent plans." />
</head>
<body>
  ${navHtml}
  <main>
    <h1>Transparent Pricing</h1>
    <p>Start with our <a href="/services/seo-audit">Technical SEO Audit</a> before scaling monthly retainers.</p>
  </main>
  ${footerHtml}
</body>
</html>`);
      return;
    }

    if (p === '/orphan-offer') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html lang="en">
<head>
  <title>Legacy Offer | MockBusiness</title>
  <meta name="description" content="A page still in XML sitemap with zero inbound internal links." />
</head>
<body>
  ${navHtml}
  <main>
    <h1>Legacy Partner Offer</h1>
    <p>This landing page is listed in sitemap-pages.xml, yet zero pages on the site link to it.</p>
  </main>
  ${footerHtml}
</body>
</html>`);
      return;
    }

    if (p === '/unlisted-playbook') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html lang="en">
<head>
  <title>Internal Playbook | MockBusiness</title>
  <meta name="description" content="Linked from homepage body, omitted from XML sitemap." />
</head>
<body>
  ${navHtml}
  <main>
    <h1>Internal Growth Playbook</h1>
    <p>Discovered along the internal link road even though it was omitted from the sitemap.</p>
  </main>
  ${footerHtml}
</body>
</html>`);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'web-obs-verify-'));
  fs.mkdirSync(path.join(tmpVault, '.obsidian'), { recursive: true });

  try {
    const events = [];
    await new Promise((resolve, reject) => {
      const proc = spawn(
        pythonCommand(ROOT),
        [
          path.join(ROOT, 'engine', 'crawl_site.py'),
          baseUrl,
          '--vault',
          tmpVault,
          '--max-pages',
          '25',
          '--no-check-external',
          '--render',
          'never',
          '--delay',
          '0',
        ],
        {
          env: {
            ...process.env,
            WEB_OBS_LOCAL_TARGETS: `127.0.0.1:${port}`,
          },
        }
      );

      let buf = '';
      let stderrBuf = '';
      proc.stdout.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) {
            events.push(JSON.parse(line));
          }
        }
      });
      proc.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString('utf8');
      });
      proc.on('close', (code) => {
        if (buf.trim()) events.push(JSON.parse(buf.trim()));
        if (code !== 0) {
          reject(new Error(`Crawler exited with code ${code}: ${stderrBuf}`));
        } else {
          resolve();
        }
      });
    });

    const completeEvt = events.find((e) => e.event === 'complete');
    assert.ok(completeEvt, 'Expected a complete JSONL event from crawl_site.py');

    const folder = `127.0.0.1-${port}`;
    const siteRoot = path.join(tmpVault, 'sites', folder);

    const graphPath = path.join(siteRoot, '_site-graph.json');
    const summaryPath = path.join(siteRoot, '_site-summary.json');
    const canvasPath = path.join(siteRoot, '_sitemap.canvas');
    const basePath = path.join(siteRoot, '_pages.base');
    const dashPath = path.join(siteRoot, '_dashboard.md');

    for (const p of [graphPath, summaryPath, canvasPath, basePath, dashPath]) {
      assert.ok(fs.existsSync(p), `Missing expected output file: ${p}`);
    }

    const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    const canvas = JSON.parse(fs.readFileSync(canvasPath, 'utf8'));

    // Step 1 verification: Sitemap index + child sitemap discovered, 5 sitemap URLs + 1 unlisted page = 6 crawled pages
    assert.equal(graph.stats.sitemapsFound, 2, 'Expected sitemap_index.xml + sitemap-pages.xml');
    assert.equal(graph.stats.sitemapUrlsTotal, 5, 'Expected 5 URLs from sitemap-pages.xml');
    assert.equal(graph.stats.pagesCrawled, 6, 'Expected 6 crawled pages (5 sitemap + 1 unlisted)');

    // Step 2 verification: Local images + inline SVG downloaded, full DOM Markdown (hero, table, FAQ, single-line card wikilinks)
    assert.ok(graph.stats.localImagesDownloaded >= 3, 'Expected hero.png, lazy chart.png, and inline SVG chart saved locally');
    const assetFiles = fs.readdirSync(path.join(siteRoot, 'assets'));
    assert.ok(assetFiles.some((f) => f.endsWith('.svg')), 'Expected inline <svg role="img"> saved as .svg in assets/');

    const homeNote = fs.readFileSync(path.join(siteRoot, 'pages', 'index.md'), 'utf8');
    assert.match(homeNote, /!\[\[sites\/127\.0\.0\.1-\d+\/assets\//, 'Home note should embed local image');
    assert.match(homeNote, /\[\[sites\/127\.0\.0\.1-\d+\/pages\/services\/seo-audit/, 'Home note should rewrite multi-line card link into clean wikilink');
    assert.match(homeNote, /\| Tier \| Deliverable \|/, 'Home note should preserve GFM table');
    assert.match(homeNote, /Typical 60-page business sites finish in under 15 seconds/, 'Home note should preserve button-controlled FAQ answer');

    // Step 3 verification: Orphan, Unlisted, Body vs Chrome links, Canonicalized External domains, Site Intelligence
    const orphanNode = graph.nodes.find((n) => n.path === '/orphan-offer');
    assert.ok(orphanNode, 'Expected /orphan-offer node');
    assert.equal(orphanNode.health, 'orphan', 'Expected /orphan-offer to be detected as orphan');

    const unlistedNode = graph.nodes.find((n) => n.path === '/unlisted-playbook');
    assert.ok(unlistedNode, 'Expected /unlisted-playbook node');
    assert.equal(unlistedNode.inSitemap, false, 'Expected /unlisted-playbook inSitemap=false');
    assert.equal(unlistedNode.health, 'unlisted', 'Expected /unlisted-playbook health=unlisted');

    const externalDomains = graph.nodes.filter((n) => n.kind === 'external-domain').map((n) => n.title);
    assert.ok(externalDomains.includes('github.com'), 'Expected github.com external node');
    assert.ok(externalDomains.includes('linkedin.com'), 'Expected md.linkedin.com canonicalized to linkedin.com');
    assert.ok(!externalDomains.includes('md.linkedin.com'), 'Expected regional md.linkedin.com normalized away');
    assert.ok(externalDomains.includes('calendly.com'), 'Expected calendly.com external node');
    assert.ok(externalDomains.includes('developers.google.com'), 'Expected developers.google.com external node');

    assert.ok(graph.siteIntel?.techStack?.measurementIds?.ga4?.includes('G-MOCK12345'), 'Expected GA4 ID G-MOCK12345 detected');
    assert.ok(graph.siteIntel?.techStack?.securityHeaders?.present?.includes('HSTS'), 'Expected HSTS security header detected');
    assert.equal(graph.siteIntel?.aiReadiness?.endpoints?.llmsTxt, true, 'Expected /llms.txt detected');
    assert.ok(fs.existsSync(path.join(siteRoot, 'llms.txt')), 'Expected llms.txt saved locally into site folder');
    assert.ok(graph.siteIntel?.aiReadiness?.blockedAiBots?.includes('CCBot'), 'Expected CCBot block detected from robots.txt');
    assert.ok(
      graph.siteIntel?.funnel?.platforms?.some((p) => p.platform === 'Calendly'),
      'Expected Calendly conversion platform detected'
    );

    const bodyInternalEdges = graph.edges.filter((e) => e.kind === 'internal-body');
    const chromeInternalEdges = graph.edges.filter((e) => e.kind === 'internal-chrome');
    assert.ok(bodyInternalEdges.length >= 4, 'Expected contextual body internal links');
    assert.ok(chromeInternalEdges.length >= 4, 'Expected nav/chrome internal links separated from body links');

    assert.ok(summary.contacts.emails.includes('hello@mockbusiness.example'), 'Expected extracted email in _site-summary.json');
    assert.ok(summary.schemaTypesUsed.includes('Organization'), 'Expected Organization schema in _site-summary.json');
    assert.ok(summary.schemaTypesUsed.includes('Service'), 'Expected Service schema in _site-summary.json');
    assert.ok(Array.isArray(canvas.nodes) && canvas.nodes.length >= 6, 'Expected valid Obsidian Canvas nodes');

    console.log(
      `[PASS] End-to-end 3-step crawler verified (${graph.stats.pagesCrawled} pages, ${graph.stats.localImagesDownloaded} local images, ${externalDomains.length} external domains, orphan & unlisted audited).`
    );

    // If Obsidian is installed as a Flatpak on this Linux host, ALSO verify running the bundled
    // plugin crawler inside md.obsidian.Obsidian's exact sandbox!
    let hasObsidianFlatpak = false;
    try {
      execFileSync('flatpak', ['info', 'md.obsidian.Obsidian'], { stdio: 'ignore' });
      hasObsidianFlatpak = true;
    } catch {
      hasObsidianFlatpak = false;
    }

    const bundledForFlatpak = path.join(ROOT, '.obsidian', 'plugins', 'web-obs', 'engine', 'crawl_site.py');
    if (hasObsidianFlatpak && !fs.existsSync(bundledForFlatpak)) {
      console.log('[SKIP] Flatpak sandbox check needs the plugin installed in this vault (npm run install:vault).');
    }
    if (hasObsidianFlatpak && fs.existsSync(bundledForFlatpak)) {
      const homeTmp = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'web-obs-flatpak-check-'));
      try {
        const venvPy = path.join(ROOT, 'engine', '.venv', 'bin', 'python3');
        const bundledScript = path.join(ROOT, '.obsidian', 'plugins', 'web-obs', 'engine', 'crawl_site.py');
        await new Promise((resolve, reject) => {
          const fpProc = spawn(
            'flatpak',
            [
              'run',
              `--env=WEB_OBS_LOCAL_TARGETS=127.0.0.1:${port}`,
              `--command=${venvPy}`,
              'md.obsidian.Obsidian',
              bundledScript,
              baseUrl,
              '--vault',
              homeTmp,
              '--max-pages',
              '10',
              '--no-check-external',
          '--render',
              'never',
              '--delay',
              '0',
            ],
            { stdio: ['ignore', 'pipe', 'pipe'] }
          );
          let errOut = '';
          fpProc.stderr.on('data', (d) => {
            errOut += d.toString('utf8');
          });
          fpProc.on('close', (code) => {
            if (code !== 0) {
              reject(new Error(`Flatpak crawler exited with code ${code}: ${errOut}`));
            } else {
              resolve();
            }
          });
        });
        const fpManifest = path.join(homeTmp, 'sites', `127.0.0.1-${port}`, '_site-graph.json');
        assert.ok(fs.existsSync(fpManifest), 'Expected _site-graph.json written from inside Obsidian Flatpak sandbox');
        const fpData = JSON.parse(fs.readFileSync(fpManifest, 'utf8'));
        assert.equal(fpData.stats.pagesCrawled, 6, 'Expected 6 pages crawled inside Obsidian Flatpak sandbox');
        console.log('[PASS] Obsidian Flatpak sandbox execution verified (bundled plugin + engine/.venv).');
      } finally {
        fs.rmSync(homeTmp, { recursive: true, force: true });
      }
    }
  } finally {
    server.close();
    fs.rmSync(tmpVault, { recursive: true, force: true });
  }
}

function checkBuildAndVaultParity() {
  execFileSync('npx', ['tsc', '-b'], { stdio: 'inherit' });
  // A fresh clone has no build output yet.
  execFileSync(process.execPath, ['esbuild.config.mjs'], { stdio: 'inherit' });

  const distMain = path.join(ROOT, 'dist-plugin', 'main.js');
  const vaultMain = path.join(ROOT, '.obsidian', 'plugins', 'web-obs', 'main.js');
  const distCss = path.join(ROOT, 'dist-plugin', 'styles.css');
  const vaultCss = path.join(ROOT, '.obsidian', 'plugins', 'web-obs', 'styles.css');
  const vaultCrawler = path.join(ROOT, '.obsidian', 'plugins', 'web-obs', 'engine', 'crawl_site.py');
  const vaultMdConv = path.join(ROOT, '.obsidian', 'plugins', 'web-obs', 'engine', 'markdown_converter.py');
  const expectedEngine = engineFileHashes(path.join(ROOT, 'engine'));
  const hasVaultInstall = fs.existsSync(vaultMain);
  if (!hasVaultInstall) {
    // A fresh clone has no installed copy, so check the built plugin on its own.
    assert.ok(fs.existsSync(distMain), 'Missing dist-plugin/main.js');
    assert.deepEqual(engineFileHashes(path.join(ROOT, 'dist-plugin', 'engine')), expectedEngine, 'Complete engine file/hash mismatch in dist-plugin');
    console.log('[PASS] TypeScript build verified (no installed vault copy to compare, skipped SHA parity).');
    return;
  }
  for (const directory of ['dist-plugin', '.obsidian/plugins/web-obs']) {
    assert.deepEqual(engineFileHashes(path.join(ROOT, directory, 'engine')), expectedEngine, `Complete engine file/hash mismatch in ${directory}`);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ROOT, directory, 'engine-manifest.json'), 'utf8')).files, expectedEngine, `Engine manifest mismatch in ${directory}`);
  }
  const vaultSiteIntel = path.join(ROOT, '.obsidian', 'plugins', 'web-obs', 'engine', 'site_intel.py');

  assert.ok(fs.existsSync(distMain), 'Missing dist-plugin/main.js');
  assert.ok(fs.existsSync(vaultMain), 'Missing .obsidian/plugins/web-obs/main.js');
  assert.equal(sha256File(distMain), sha256File(vaultMain), 'dist-plugin/main.js and vault main.js SHA-256 mismatch');
  assert.equal(sha256File(distCss), sha256File(vaultCss), 'dist-plugin/styles.css and vault styles.css SHA-256 mismatch');
  assert.ok(fs.existsSync(vaultCrawler), 'Missing bundled Python crawler inside .obsidian/plugins/web-obs/engine/');
  assert.ok(fs.existsSync(vaultMdConv), 'Missing bundled markdown_converter.py inside .obsidian/plugins/web-obs/engine/');
  assert.ok(fs.existsSync(vaultSiteIntel), 'Missing bundled site_intel.py inside .obsidian/plugins/web-obs/engine/');

  const communityPlugins = JSON.parse(
    fs.readFileSync(path.join(ROOT, '.obsidian', 'community-plugins.json'), 'utf8')
  );
  assert.ok(communityPlugins.includes('web-obs'), '"web-obs" is not enabled in .obsidian/community-plugins.json');

  console.log('[PASS] TypeScript build & Obsidian vault plugin SHA-256 parity verified.');
}

async function main() {
  checkDashHygiene();
  checkNoPrivateBranding();
  checkPythonSyntax();
  execFileSync(process.execPath, ['scripts/verify-resource-validation.mjs'], { stdio: 'inherit', timeout: 60_000 });
  execFileSync(process.execPath, ['scripts/verify-site-audit.mjs'], { stdio: 'inherit', timeout: 60_000 });
  execFileSync(process.execPath, ['scripts/verify-compare-sites.mjs'], { stdio: 'inherit', timeout: 60_000 });
  execFileSync(process.execPath, ['scripts/verify-vault-resync.mjs'], { stdio: 'inherit', timeout: 60_000 });
  execFileSync(process.execPath, ['scripts/verify-brand-mark.mjs'], { stdio: 'inherit', timeout: 60_000 });
  execFileSync(process.execPath, ['scripts/verify-discovery-checklist.mjs'], { stdio: 'inherit', timeout: 60_000 });
  execFileSync(process.execPath, ['scripts/verify-doctor.mjs'], { stdio: 'inherit', timeout: 60_000 });
  execFileSync(process.execPath, ['scripts/verify-engine-bundle.mjs'], { stdio: 'inherit', timeout: 60_000 });
  execFileSync(process.execPath, ['scripts/verify-map-discovery.mjs'], { stdio: 'inherit', timeout: 60_000 });
  execFileSync(process.execPath, ['scripts/verify-cluster-layout.mjs'], { stdio: 'inherit', timeout: 60_000 });
  execFileSync(process.execPath, ['scripts/verify-road-layout.mjs'], { stdio: 'inherit', timeout: 60_000 });
  execFileSync(process.execPath, ['scripts/verify-cluster-prefetch.mjs'], { stdio: 'inherit', timeout: 60_000 });
  execFileSync(process.execPath, ['scripts/verify-capture-host.mjs'], { stdio: 'inherit', timeout: 60_000 });
  execFileSync(process.execPath, ['scripts/verify-native-lifecycle.mjs'], { stdio: 'inherit', timeout: 60_000 });
  // A cold macOS runner spends most of a minute starting this suite (47 s for the whole suite on a passing run),
  // so 60 s timed out with no fault in the code.
  execFileSync(pythonCommand(ROOT), ['scripts/verify-no-api.py'], { stdio: 'inherit', timeout: 180_000 });
  for (const script of ['scripts/verify-browser-runtime.py', 'scripts/verify-link-policy.py', 'scripts/verify-evidence.py', 'scripts/verify-recapture.py', 'scripts/verify-system.py', 'scripts/verify-resources.py', 'scripts/verify-workers.py', 'scripts/verify-pipeline.py', 'scripts/verify-canvas-export.py', 'scripts/verify-link-continuation.py', 'scripts/verify-failure-paths.py', 'scripts/verify-trailing-slash.py', 'scripts/verify-render-on-demand.py', 'scripts/verify-large-map.py', 'scripts/verify-transport-checks.py', 'scripts/verify-audit-expansion.py', 'scripts/verify-browser-audit.py', 'scripts/verify-crawler-identity.py', 'scripts/verify-note-structure.py', 'scripts/verify-brand-logo.py', 'scripts/verify-page-snapshots.py', 'scripts/verify-capture-switches.py', 'scripts/verify-llms-txt.py', 'scripts/verify-seo-r2.py', 'scripts/verify-note-privacy.py', 'scripts/verify-note-render.py', 'scripts/verify-manifest-switches.py']) {
    // A guard against a hung suite, not a speed test: on GitHub's macOS runners the switch suite took 84 s of the
    // old 90 s when it passed, and a slower runner timed out with no test failing.
    execFileSync(pythonCommand(ROOT), [script, ...(script.endsWith('verify-pipeline.py') ? ['--benchmark'] : [])], { stdio: 'inherit', timeout: 300_000 });
  }
  await runEndToEndMockCrawlTest();
  checkBuildAndVaultParity();
  console.log('\nAll web-obs verification gates PASSED.');
}

main().catch((err) => {
  console.error('\n[FAIL] Verification failed:', err);
  process.exit(1);
});
