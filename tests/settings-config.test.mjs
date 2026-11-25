import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const { outputFiles } = await build({ entryPoints: ['chrome-extension/src/settings/config.ts'], format: 'esm', write: false });
const { hasReadyConfig, modelEndpoint, readConfig } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
const config = {
  baseUrl: 'https://model.example.test/v1', model: 'example', apiKey: '',
  resume: { name: '简历正文', text: '测试简历', revision: 'rev-1' },
};

test('accepts HTTPS and the manifest-supported loopback HTTP endpoints', () => {
  for (const [base, endpoint] of [
    ['https://model.example.test/v1///', 'https://model.example.test/v1/chat/completions'],
    ['https://model.example.test/chat/completions', 'https://model.example.test/chat/completions'],
    ['http://127.0.0.1:8080', 'http://127.0.0.1:8080/chat/completions'],
    ['http://localhost:11434/v1', 'http://localhost:11434/v1/chat/completions'],
  ]) assert.equal(modelEndpoint(base), endpoint);
  for (const url of ['invalid', 'http://example.test', 'http://localhost.example.test/v1', 'http://[::1]/v1',
    'https://user:pass@example.test/v1', 'https://example.test/v1?secret=x', 'https://example.test/v1?', 'https://example.test/v1#part', 'file:///tmp/api']) {
    assert.throws(() => modelEndpoint(url), /API 地址/);
  }
});

test('validates both legacy and current local settings', () => {
  assert.equal(hasReadyConfig(config), true);
  assert.equal(hasReadyConfig({ ...config, resumeFile: null, autoUploadResume: false }), true);
  for (const value of [null, {}, { ...config, baseUrl: 'http://example.test' }, { ...config, model: ' ' },
    { ...config, resume: { ...config.resume, text: ' ' } }, { ...config, resume: { ...config.resume, revision: '' } }]) {
    assert.equal(hasReadyConfig(value), false);
  }
});

test('restricts storage access and returns only usable saved settings', async () => {
  let stored = config;
  const calls = [];
  globalThis.chrome = { storage: { local: {
    async setAccessLevel(level) { calls.push(level); },
    async get(key) { calls.push(key); return { [key]: stored }; },
  } } };
  try {
    assert.equal(await readConfig(), config);
    assert.deepEqual(calls, [{ accessLevel: 'TRUSTED_CONTEXTS' }, 'applyConfig']);
    stored = undefined;
    await assert.rejects(readConfig(), /导入简历/);
  } finally {
    delete globalThis.chrome;
  }
});
