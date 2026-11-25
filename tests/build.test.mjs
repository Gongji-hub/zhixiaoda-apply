import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const dist = 'dist';

test('packaged manifest and settings only reference present, standalone assets', async () => {
  const manifest = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, '0.9.13');
  assert.equal(manifest.default_locale, 'zh_CN');
  assert.ok(!manifest.side_panel);
  assert.ok(!manifest.permissions.includes('sidePanel'));
  const options = await readFile(join(dist, manifest.options_page), 'utf8');
  const optionsAssets = Array.from(options.matchAll(/(?:src|href)="([^"]+)"/g), match => join('settings', match[1]));
  const required = [manifest.background.service_worker, manifest.options_page, manifest.action.default_icon,
    ...Object.values(manifest.icons), ...manifest.web_accessible_resources.flatMap(entry => entry.resources), ...optionsAssets,
    ...['zh_CN', 'en', 'pt_BR', 'zh_TW'].map(locale => `_locales/${locale}/messages.json`),
    'feedback-overlay.js', 'buildDomTree.js', 'settings/pdf.worker.mjs', 'LICENSE', 'UPSTREAM.md'];
  for (const asset of required) assert.ok((await stat(join(dist, asset))).isFile(), asset);
  assert.ok((await readdir(join(dist, 'settings/cmaps'))).some(name => name.endsWith('.bcmap')));
  assert.deepEqual(await readdir(join(dist, 'job-panel')), ['brand-symbol.png']);
});

test('dist has no source maps, private specification or hosted service references', async () => {
  const entries = await readdir(dist, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter(entry => entry.isFile())) {
    const filename = join(entry.parentPath, entry.name);
    assert.doesNotMatch(entry.name, /\.map$|^(specs|demo_config\.local|release-config)\.json$/i, filename);
    if (/\.(?:m?js|json|html|css|svg)$/i.test(filename)) {
      assert.doesNotMatch(await readFile(filename, 'utf8'), /zhixiaoda\.net|demo_config\.local\.json|release-config\.json|\/api\/agent\/feedback/i, filename);
    }
  }
});
