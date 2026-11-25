import { build } from 'esbuild';
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import manifest from '../chrome-extension/manifest.js';
import { decisionValidatorsPlugin } from './decision-validators.mjs';

const source = 'chrome-extension';
const resolve = name => path.resolve(name);
const options = {
  metafile: true,
  outdir: 'dist',
  bundle: true,
  platform: 'browser',
  target: 'chrome120',
  minify: true,
  sourcemap: false,
  legalComments: 'eof',
  alias: {
    crypto: resolve('scripts/browser-crypto.mjs'),
    '@src': resolve(source + '/src'),
    '@extension/i18n': resolve('packages/i18n/lib/i18n-prod.ts'),
    '@extension/storage/lib/chat': resolve('packages/storage/lib/chat/index.ts'),
    '@extension/storage': resolve('packages/storage/lib/settings/generalSettings.ts'),
  },
  define: { 'import.meta.env.DEV': 'false', 'process.env.NODE_ENV': '"production"' },
};
const validatorsPlugin = await decisionValidatorsPlugin();

await rm('dist', { recursive: true, force: true });
await mkdir('dist/job-panel', { recursive: true });
for (const asset of ['job-panel/brand-symbol.png', 'settings', 'icon-128.png', 'icon-32.png', 'brand-icon.svg']) {
  await cp(`${source}/public/${asset}`, `dist/${asset}`, { recursive: true });
}
await cp('packages/i18n/locales', 'dist/_locales', { recursive: true });
await cp('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'dist/settings/pdf.worker.mjs');
await cp('node_modules/pdfjs-dist/cmaps', 'dist/settings/cmaps', { recursive: true });
const builds = await Promise.all([
  build({
    ...options,
    entryPoints: {
      background: `${source}/src/background/index.ts`,
      'settings/settings': `${source}/src/settings/options.ts`,
    },
    format: 'esm',
    plugins: [validatorsPlugin],
  }),
  build({
    ...options,
    entryPoints: {
      'feedback-overlay': `${source}/src/background/feedback/install.ts`,
      buildDomTree: `${source}/src/content/domTree/index.js`,
    },
    format: 'iife',
  }),
]);

const packages = new Set(['pdfjs-dist']);
for (const { metafile } of builds) {
  for (const input of Object.keys(metafile.inputs)) {
    const match = input.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//);
    if (match) packages.add(match[1]);
  }
}
await cp('LICENSE', 'dist/LICENSE');
await cp('UPSTREAM.md', 'dist/UPSTREAM.md');
for (const name of packages) {
  const root = path.join('node_modules', name);
  const destination = path.join('dist/licenses', name);
  for (const file of await readdir(root, { withFileTypes: true })) {
    if (file.isFile() && /^(licen[cs]e|copying|notice)([.-]|$)/i.test(file.name)) {
      await mkdir(destination, { recursive: true });
      await cp(path.join(root, file.name), path.join(destination, file.name));
    }
  }
}
await writeFile('dist/manifest.json', JSON.stringify(manifest, null, 2));
