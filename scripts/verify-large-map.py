#!/usr/bin/env python3
"""Large-site map regression: draw calls, DOM size, label pool state and hover behaviour on a 1,500 page site.

Builds a synthetic capture in a temporary vault, runs the standalone app against it in Chromium with explicit
software WebGL (SwiftShader), and checks the properties the instanced renderer and the pooled labels exist to
provide. Evidence class: standalone browser, not native Obsidian and not a GPU measurement; the checks are
counts and state, not frame times, so they do not depend on the machine.
"""
import contextlib
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PAGES = 1500
SECTIONS = 9
SITE = 'large-map.test'

INIT = """
(() => {
  // This suite checks counts and label state, not how orbs look. Software rendering is slow with detailed or
  // translucent orbs (a frame can outlast a 180 ms label fade), so ask for light opaque ones where the build supports
  // tuning; builds without it ignore the setting. Orb opacity has its own suite.
  window.__WO_VISUAL__ = { sphereWidthSegments: 8, sphereHeightSegments: 6, defaultOpacity: 1, dimOpacity: 1, highlightOpacity: 1 };
  window.__p = { draws: 0, frames: 0 };
  for (const C of [WebGL2RenderingContext, WebGLRenderingContext]) {
    for (const f of ['drawElements','drawArrays','drawElementsInstanced','drawArraysInstanced']) {
      const o = C.prototype[f]; if (!o) continue;
      C.prototype[f] = function(...a){ window.__p.draws++; return o.apply(this,a); };
    }
  }
  const tick = () => { window.__p.frames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
})();
"""


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def page_node(node_id, kind, health, title, url, path, section, depth, **extra):
    node = {
        'id': node_id, 'kind': kind, 'health': health, 'title': title, 'url': url, 'path': path, 'section': section,
        'obsidianPath': '', 'metaDescription': '', 'canonical': '', 'metaRobots': '', 'h1': [title], 'schemaTypes': [],
        'inSitemap': kind != 'external-domain', 'renderUsed': False, 'statusCode': 0 if kind == 'external-domain' else 200,
        'urlDepth': depth, 'wordCount': 300, 'h2Count': 2, 'imagesCount': 0, 'localImagesCount': 0,
        'inlinksBody': 4, 'inlinksTotal': 5, 'outlinksBody': 4, 'outlinksTotal': 5, 'externalDomainsOut': 0,
        'clickDepth': None if kind == 'external-domain' else depth,
    }
    node.update(extra)
    return node


def synthetic_site(pages=None):
    """One home, SECTIONS hubs, `pages` (default PAGES) pages with hierarchy, body and chrome links, and a few external domains."""
    count = PAGES if pages is None else pages
    nodes = [page_node('home', 'home', 'home', SITE, f'https://{SITE}/', '/', 'root', 0)]
    edges = []

    def link(source, target, kind):
        edges.append({'id': f'e{len(edges)}', 'source': source, 'target': target, 'kind': kind, 'anchor': '', 'rel': []})

    for s in range(SECTIONS):
        nodes.append(page_node(f'hub{s}', 'hub', 'hub', f'Section {s}', f'https://{SITE}/section-{s}/', f'/section-{s}/', f'section-{s}', 1))
        link('home', f'hub{s}', 'internal-body')
    per_section = [[] for _ in range(SECTIONS)]
    for i in range(count):
        s = i % SECTIONS
        per_section[s].append(f'p{i}')
        nodes.append(page_node(f'p{i}', 'page', 'healthy', f'Page {i}', f'https://{SITE}/section-{s}/page-{i}', f'/section-{s}/page-{i}', f'section-{s}', 2))
        link(f'hub{s}', f'p{i}', 'sitemap-hierarchy')
        link(f'p{i}', 'home', 'internal-chrome')
    for pages in per_section:
        for index, source in enumerate(pages):
            for step in (1, 7, 31):
                link(source, pages[(index + step) % len(pages)], 'internal-body')
    for x in range(5):
        nodes.append(page_node(f'ext{x}', 'external-domain', 'external', f'external-{x}.test', f'https://external-{x}.test/', '', '', 0))
        link(f'p{x * 37 % count}', f'ext{x}', 'external')
    return {
        'schemaVersion': '1.0.0', 'siteId': SITE, 'domain': SITE, 'origin': f'https://{SITE}',
        'capturedAt': '2026-01-01T00:00:00.000Z', 'elapsedSec': 0, 'captureStatus': 'complete',
        'captureWarnings': ['Synthetic site for the large map regression test. Not a real capture.'],
        'stats': {'pagesCrawled': count + SECTIONS + 1, 'sitemapsFound': 0, 'sitemapUrlsTotal': 0, 'internalEdges': len(edges) - 5,
                  'externalDomains': 5, 'externalEdges': 5, 'localImagesDownloaded': 0, 'orphanPages': 0, 'unlistedPages': 0,
                  'brokenOrRedirectPages': 0},
        'sections': [{'id': 'root', 'label': '/', 'pageCount': 1}] +
                    [{'id': f'section-{s}', 'label': f'/section-{s}', 'pageCount': len(per_section[s])} for s in range(SECTIONS)],
        'sitemaps': [], 'nodes': nodes, 'edges': edges,
    }


@contextlib.contextmanager
def serve(manifest):
    """Runs the standalone app against a temporary vault holding one capture and yields the port."""
    vite = ROOT / 'node_modules' / 'vite' / 'bin' / 'vite.js'
    if not vite.exists():
        raise SystemExit(f'Vite is not installed at {vite}. Run npm ci first.')
    port = free_port()
    with tempfile.TemporaryDirectory() as vault:
        site_dir = Path(vault) / 'sites' / manifest['siteId']
        site_dir.mkdir(parents=True)
        (site_dir / '_site-graph.json').write_text(json.dumps(manifest), encoding='utf-8')
        # The dev API reads captures from the working directory, so the server runs in the vault and serves the repo.
        server = subprocess.Popen(['node', str(vite), str(ROOT), '--host', '127.0.0.1', '--port', str(port), '--strictPort'],
                                  cwd=vault, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(90):
                try:
                    urllib.request.urlopen(f'http://127.0.0.1:{port}/', timeout=1)
                    break
                except Exception:
                    time.sleep(0.5)
            else:
                raise RuntimeError('Standalone app did not start.')
            yield port
        finally:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()


def main():
    with serve(synthetic_site()) as port:
        run(port)


def run(port):
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        page = browser.new_page(viewport={'width': 1440, 'height': 900})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.add_init_script(INIT)
        page.goto(f'http://127.0.0.1:{port}/')
        page.wait_for_selector('.wo-canvas-stage', timeout=60000)
        page.wait_for_function("() => document.querySelector('.wo-node-pill')", timeout=120000)
        page.wait_for_timeout(5000)

        def measure(ms):
            page.evaluate('() => { window.__p.draws = 0; window.__p.frames = 0; }')
            page.wait_for_timeout(ms)
            return page.evaluate('() => ({ ...window.__p })')

        def visible_pills():
            return page.evaluate("() => [...document.querySelectorAll('.wo-node-pill')].filter(p => !p.classList.contains('is-hidden') && p.dataset.nodeId).length")

        def hover_state():
            return page.evaluate("""() => {
              const shown = (p) => !p.classList.contains('is-hidden') && getComputedStyle(p).display !== 'none';
              const pills = [...document.querySelectorAll('.wo-node-pill')];
              return {
                layer: document.querySelector('.wo-css2d-layer').classList.contains('is-hovering-node'),
                targets: pills.filter(p => p.classList.contains('is-hover-target') && shown(p)).length,
                stale: pills.filter(p => (p.classList.contains('is-hover-target') || p.classList.contains('is-active')) && !shown(p)).length,
              };
            }""")

        # The synthetic site has well over a thousand nodes. One draw call per node would be thousands per frame.
        busy = measure(3000)
        assert busy['frames'] > 0, busy
        per_frame = busy['draws'] / busy['frames']
        assert per_frame <= 40, f'draw calls per frame must not scale with the site: {per_frame:.1f} ({busy})'

        # Labels come from a pool, not one element per page.
        pills = page.evaluate("() => document.querySelectorAll('.wo-node-pill').length")
        assert pills <= 800, f'label pills must be pooled, found {pills}'
        assert visible_pills() > 5, 'resting labels must be placed'

        # A settled map stops drawing once Light flow is off.
        page.get_by_role('button', name='Map layers').click()
        toggle = page.get_by_role('menuitemcheckbox', name='Light flow')
        toggle.first.click()
        page.keyboard.press('Escape')
        # Nodes and the camera keep moving until they arrive, which takes longer under software rendering on a
        # big site, so wait for the map to go quiet. A map that never stops drawing still fails at the deadline.
        deadline = time.time() + 40
        while measure(2000)['draws'] != 0:
            assert time.time() < deadline, 'the map never stopped drawing with Light flow off'
        assert measure(2500)['draws'] == 0, 'a settled map with Light flow off must not draw'

        # Visit resting labels: hover must highlight exactly one visible pill and leave nothing behind when it ends.
        # Software rendering can take a while per frame on a big site, so wait for the state instead of sleeping.
        layer_hovering = "() => document.querySelector('.wo-css2d-layer').classList.contains('is-hovering-node')"
        faded = 0
        for index in range(6):
            centre = page.evaluate("""(index) => {
              const pills = [...document.querySelectorAll('.wo-node-pill')].filter(p => !p.classList.contains('is-hidden') && p.dataset.nodeId);
              const p = pills[index % pills.length];
              const r = p.getBoundingClientRect();
              return [r.x + r.width / 2, r.y + r.height / 2];
            }""", index)
            page.mouse.move(centre[0], centre[1])
            page.wait_for_function(layer_hovering, timeout=15000)
            page.wait_for_timeout(400)
            state = hover_state()
            assert state['layer'] and state['targets'] == 1, f'hover must highlight exactly one label: {state}'
            page.mouse.move(3, 3)
            # CSS transitions are timed in wall-clock time, but a software-rendered frame on a big site can take half a
            # second, so sample on a timer for a while instead of reading once and risking a gap between frames.
            faded = max(faded, page.evaluate("""() => new Promise((resolve) => {
              let most = 0; const started = performance.now();
              const timer = setInterval(() => {
                const mid = [...document.querySelectorAll('.wo-node-pill')]
                  .filter(p => getComputedStyle(p).display !== 'none')
                  .filter(p => { const o = parseFloat(getComputedStyle(p).opacity); return o > 0.02 && o < 0.98; }).length;
                most = Math.max(most, mid);
                if (performance.now() - started > 1500) { clearInterval(timer); resolve(most); }
              }, 10);
            })"""))
            page.wait_for_function('() => !(' + layer_hovering[6:] + ')', timeout=15000)
            page.wait_for_timeout(600)
            state = hover_state()
            assert not state['layer'] and state['targets'] == 0 and state['stale'] == 0, f'hover must leave no state behind: {state}'
        assert faded > 0, 'labels must fade rather than snap when hover ends'

        # Selecting then leaving still works, the map redraws on camera drag, and views switch without errors.
        page.evaluate("() => document.querySelector('.wo-node-pill:not(.is-hidden)').click()")
        page.wait_for_timeout(1200)
        assert page.evaluate("() => document.querySelectorAll('.wo-node-pill.is-active').length") == 1
        page.evaluate('() => { window.__p.draws = 0; }')
        page.mouse.move(700, 500)
        page.mouse.down()
        for i in range(20):
            page.mouse.move(700 + i * 8, 500 + i * 3)
            page.wait_for_timeout(60)
        page.mouse.up()
        assert page.evaluate('() => window.__p.draws') > 0, 'dragging the camera must render'
        page.keyboard.press('Escape')
        page.wait_for_timeout(500)
        for tab in ('Road', 'Clusters', 'Globe'):
            page.get_by_role('tab', name=tab).click()
            # Nodes travel to their new positions over many frames; wait for labels instead of sleeping.
            page.wait_for_function("() => [...document.querySelectorAll('.wo-node-pill')].filter(p => !p.classList.contains('is-hidden') && p.dataset.nodeId).length > 3", timeout=30000)
            assert visible_pills() > 3, f'{tab} view must show labels'
        assert not errors, errors
        browser.close()
    print(f'[PASS] Large map verified on {PAGES} pages: constant draw calls, pooled labels, settled map stops drawing, '
          'hover leaves no state behind, labels fade, drag and view switches render.')


if __name__ == '__main__':
    sys.exit(main())
