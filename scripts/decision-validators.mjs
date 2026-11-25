import { readFile } from 'node:fs/promises';
import Ajv from 'ajv';
import standaloneCode from 'ajv/dist/standalone/index.js';

export async function decisionValidatorsPlugin() {
  const schemas = JSON.parse(await readFile(new URL('../chrome-extension/src/background/decisionSchemas.json', import.meta.url), 'utf8'));
  const ajv = new Ajv({ strict: false, code: { source: true, esm: true } });
  for (const [key, schema] of Object.entries(schemas)) ajv.addSchema(schema, key);
  const validators = standaloneCode.default(ajv);
  return {
    name: 'precompiled-schemas',
    setup(builder) {
      builder.onResolve({ filter: /^decision-validators$/ }, () => ({ path: 'validators', namespace: 'schemas' }));
      builder.onLoad({ filter: /.*/, namespace: 'schemas' }, () => ({ contents: validators, resolveDir: process.cwd() }));
    },
  };
}
