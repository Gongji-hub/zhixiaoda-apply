import { build } from 'esbuild';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv';
import standaloneCode from 'ajv/dist/standalone/index.js';
import manifest from '../chrome-extension/manifest.js';

const source = 'chrome-extension';
const resolve = name => path.resolve(name);
const schemas = JSON.parse(await readFile(source + '/src/background/decisionSchemas.json', 'utf8'));
const ajv = new Ajv({ strict: false, code: { source: true, esm: true } });
for (const [key, schema] of Object.entries(schemas)) ajv.addSchema(schema, key);
const validators = standaloneCode.default(ajv);

await rm('dist', { recursive: true, force: true });
await mkdir('dist/settings', { recursive: true });
for (const asset of ['job-panel', 'settings', 'icon-128.png', 'icon-32.png', 'buildDomTree.js'])
  await cp(source + '/public/' + asset, 'dist/' + asset, { recursive: true });
await cp('packages/i18n/locales', 'dist/_locales', { recursive: true });
await writeFile('dist/manifest.json', JSON.stringify(manifest, null, 2));
await cp('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'dist/settings/pdf.worker.mjs');
await cp('node_modules/pdfjs-dist/cmaps', 'dist/settings/cmaps', { recursive: true });
const { metafile } = await build({
  metafile: true,
  entryPoints: { background: source + '/src/background/index.ts', 'settings/settings': source + '/src/settings/options.ts' },
  outdir: 'dist', bundle: true, format: 'esm', platform: 'browser', target: 'chrome120',
  minify: true, legalComments: 'eof',
  alias: {
    crypto: resolve('scripts/browser-crypto.mjs'),
    '@src': resolve(source + '/src'),
    '@extension/i18n': resolve('packages/i18n/lib/i18n-prod.ts'),
    '@extension/storage/lib/chat': resolve('packages/storage/lib/chat/index.ts'),
    '@extension/storage': resolve('packages/storage/lib/settings/generalSettings.ts'),
  },
  define: { 'import.meta.env.DEV': 'false', 'process.env.NODE_ENV': '"production"' },
  plugins: [{
    name: 'precompiled-schemas',
    setup(builder) {
      builder.onResolve({ filter: /^decision-validators$/ }, () => ({ path: 'validators', namespace: 'schemas' }));
      builder.onLoad({ filter: /.*/, namespace: 'schemas' }, () => ({ contents: validators, resolveDir: process.cwd() }));
    },
  }],
});

// Include license texts for dependencies bundled into the installable extension.
const packages = new Set(['pdfjs-dist']);
for (const input of Object.keys(metafile.inputs)) {
  const match = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
  if (match) packages.add(match[1].slice('node_modules/'.length));
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
