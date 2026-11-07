#!/usr/bin/env python3
"""Orb opacity and highlight: translucent orbs at rest, selection dims everything not linked, tuning overrides work.

Runs the standalone app on a synthetic 400 page capture in Chromium with explicit software WebGL (SwiftShader) and
compares the mean brightness of the map before, during and after a selection. Evidence class: standalone browser,
not native Obsidian. The thresholds are wide on purpose: they separate dimmed orbs from undimmed ones, not exact pixels.
"""
import base64
import importlib.util
from pathlib import Path
import sys

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
CLIP = {'x': 260, 'y': 160, 'width': 700, 'height': 560}

BRIGHTNESS = """
async (b64) => {
  const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const x = c.getContext('2d'); x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  let sum = 0; for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
  return sum / (d.length / 4);
}
"""


def load_large_map():
    """Reuses the synthetic site and the server launcher from the large map suite."""
    spec = importlib.util.spec_from_file_location('verify_large_map', ROOT / 'scripts' / 'verify-large-map.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def brightness(page, probe):
    return probe.evaluate(BRIGHTNESS, base64.b64encode(page.screenshot(clip=CLIP)).decode())


def settled(page, probe):
    """Waits for the fade to finish: two readings 400 ms apart that agree."""
    last = brightness(page, probe)
    for _ in range(25):
        page.wait_for_timeout(400)
        current = brightness(page, probe)
        if abs(current - last) < 0.4:
            return current
        last = current
    raise AssertionError('the map never settled')


def measure(browser, port, visuals):
    """Mean brightness at rest, with a page selected, and after the selection is cleared."""
    page = browser.new_page(viewport={'width': 1440, 'height': 900})
    probe = browser.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    if visuals:
        page.add_init_script('window.__WO_VISUAL__ = ' + visuals)
    page.goto(f'http://127.0.0.1:{port}/')
    page.wait_for_function("() => document.querySelector('.wo-node-pill')", timeout=120000)
    page.get_by_role('button', name='Map layers').click()
    page.get_by_role('menuitemcheckbox', name='Light flow').first.click()
    page.keyboard.press('Escape')
    page.get_by_role('button', name='Reset camera').first.click()
    page.mouse.move(3, 3)
    page.wait_for_timeout(6000)
    rest = settled(page, probe)
    page.evaluate("() => [...document.querySelectorAll('.wo-node-pill')].find(p => !p.classList.contains('is-hidden') && p.classList.contains('wo-kind-page')).click()")
    page.mouse.move(3, 3)
    page.wait_for_function("() => document.querySelectorAll('.wo-node-pill.is-active').length === 1", timeout=15000)
    selected = settled(page, probe)
    page.keyboard.press('Escape')
    page.wait_for_function("() => document.querySelectorAll('.wo-node-pill.is-active').length === 0", timeout=15000)
    restored = settled(page, probe)
    assert not errors, errors
    page.close()
    probe.close()
    return rest, selected, restored


def main():
    large_map = load_large_map()
    with large_map.serve(large_map.synthetic_site(400)) as port, sync_playwright() as pw:
        browser = pw.chromium.launch(args=['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        rest, selected, restored = measure(browser, port, None)
        print(f'defaults:        rest {rest:.1f}, selected {selected:.1f}, cleared {restored:.1f}')
        assert selected < rest * 0.8, f'selecting a page must dim the orbs that are not linked to it ({rest:.1f} -> {selected:.1f})'
        assert abs(restored - rest) < rest * 0.08, f'clearing the selection must restore the map ({rest:.1f} -> {restored:.1f})'

        flat_rest, flat_selected, _ = measure(browser, port, '{ defaultOpacity: 1, dimOpacity: 1, highlightOpacity: 1 }')
        print(f'fully opaque:    rest {flat_rest:.1f}, selected {flat_selected:.1f}')
        assert rest < flat_rest, f'orbs are translucent at rest by default ({rest:.1f} vs {flat_rest:.1f} fully opaque)'
        assert flat_selected > flat_rest * 0.85, f'dimOpacity: 1 turns the orb dimming off ({flat_rest:.1f} -> {flat_selected:.1f})'
        # Selection also dims edges, halos, glow and labels, so isolate the orbs: the drop with orb dimming on must exceed
        # the drop with it off by a clear margin.
        orb_share = (rest - selected) / rest - (flat_rest - flat_selected) / flat_rest
        assert orb_share > 0.1, f'dimming the orbs themselves must account for part of the drop (share {orb_share:.2f})'
        browser.close()
    print('[PASS] Orb highlight verified: translucent at rest, selection dims unlinked orbs and clearing restores them, '
          'and the tuning override changes both.')


if __name__ == '__main__':
    sys.exit(main())
