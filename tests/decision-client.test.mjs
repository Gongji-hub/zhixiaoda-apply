import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { build } from 'esbuild';
import { decisionValidatorsPlugin } from '../scripts/decision-validators.mjs';

const { outputFiles } = await build({
  entryPoints: ['chrome-extension/src/background/decisionClient.ts'],
  bundle: true,
  format: 'esm',
  write: false,
  plugins: [await decisionValidatorsPlugin()],
});
const { ModelDecisionClient, extractDecisionJson, formatControlStepMessages, validateDecisionResult } =
  await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`);
const schemas = JSON.parse(await readFile(new URL('../chrome-extension/src/background/decisionSchemas.json', import.meta.url), 'utf8'));
const done = { done: { text: '核对完成', success: true } };
const current_state = { evaluation_previous_goal: '完成', memory: '', next_goal: '核对' };
const option = candidate => ({ candidate, reason: '依据候选项' });
const optionHistory = [{ role: 'user', content: JSON.stringify({ candidates: [{ candidate: 0, text: '甲' }] }) }];
const control = { action: 'manual', target: null, value: null, reason: '需要人工操作' };
const samples = {
  navigator_output: { current_state, action: [done] },
  planner_output: { observation: '', challenges: '', done: false, next_steps: '', final_answer: '', reasoning: '', web_task: true },
  application_structure: { sections: [] },
  application_values: { values: [], ask: [] },
  application_repair: { values: [], ask: [] },
  application_option_choice: option(null),
  application_form_audit: { reviewed_ids: [], findings: [], unverifiable: [] },
  application_control_targets: { fields: [] },
  application_control_step: control,
  application_value_equivalence: { items: [{ id: 'degree', equivalent: true, reason: '显示缩写' }] },
};

test('all ten public schemas are compiled and enforce required fields', () => {
  assert.deepEqual(Object.keys(schemas).sort(), Object.keys(samples).sort());
  for (const [stage, sample] of Object.entries(samples)) {
    assert.equal(validateDecisionResult(stage, sample), true, stage);
    assert.equal(validateDecisionResult(stage, {}), false, stage);
  }
});

test('control observation moves the local JPEG into an image part', () => {
  const screenshot = 'data:image/jpeg;base64,/9j/2Q==';
  const user = content => [{ role: 'user', content: JSON.stringify(content) }];
  assert.deepEqual(formatControlStepMessages(user({ field: '年月', screenshot })), [{
    role: 'user',
    content: [{ type: 'text', text: '{"field":"年月"}' }, { type: 'image_url', image_url: { url: screenshot } }],
  }]);
  assert.deepEqual(formatControlStepMessages(user({ field: '年月' })), user({ field: '年月' }));
  for (const invalid of [null, 'https://example.test/image.jpg', 'data:image/png;base64,/9j/2Q==', 'data:image/jpeg;base64,AAAA',
    'data:image/jpeg;base64,/9j!', 'data:image/jpeg;base64,/9j/' + 'A'.repeat(240_030)]) {
    assert.throws(() => formatControlStepMessages(user({ field: '年月', screenshot: invalid })));
  }
  assert.throws(() => formatControlStepMessages([]));
  assert.throws(() => formatControlStepMessages([...user({}), ...user({})]));
});

test('extracts matching function args and JSON text, including optional fences', () => {
  const stage = 'application_control_step';
  const call = { function: { name: stage, arguments: JSON.stringify(control) } };
  assert.deepEqual(extractDecisionJson(stage, { tool_calls: [call] }), control);
  const json = JSON.stringify(control);
  for (const content of [json, `\n\x60\x60\x60JSON\n${json}\n\x60\x60\x60\n`, `\x60\x60\x60\n${json}\n\x60\x60\x60`]) {
    assert.deepEqual(extractDecisionJson(stage, { tool_calls: [], content }), control);
  }
  assert.throws(() => extractDecisionJson(stage, { tool_calls: [call, call], content: json }));
  assert.throws(() => extractDecisionJson(stage, { tool_calls: [{ function: { ...call.function, name: 'wrong' } }], content: json }));
  assert.throws(() => extractDecisionJson(stage, { content: 'not JSON' }));
});

test('enforces action count, action shape and candidate bounds beyond structural validation', () => {
  const navigator = action => validateDecisionResult('navigator_output', { current_state, action });
  assert.equal(navigator(Array(8).fill(done)), true);
  for (const actions of [[], Array(9).fill(done), [{}], [{ done: null }], [{ done: [] }], [{ ...done, wait: null }], [{ made_up: {} }]]) {
    assert.equal(navigator(actions), false);
  }
  const choice = (candidate, history = optionHistory) => validateDecisionResult('application_option_choice', option(candidate), history);
  assert.equal(choice(0), true);
  assert.equal(choice(null, []), true);
  for (const candidate of [-1, 1, 0.5]) assert.equal(choice(candidate), false);
  assert.equal(choice(0, []), false);
  assert.equal(choice(0, [{ role: 'user', content: 'bad input' }]), false);
});

const client = new ModelDecisionClient({ baseUrl: 'http://localhost:11434/v1', model: 'test-model', apiKey: 'fake-key' });
const message = { getType: () => 'human', content: optionHistory[0].content };
const response = content => Response.json({ choices: [{ message: { content } }] });

test('retries one invalid response using the same deadline and caller signal', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push(init);
    assert.equal(url, 'http://localhost:11434/v1/chat/completions');
    assert.equal(init.headers.Authorization, 'Bearer fake-key');
    assert.equal(init.redirect, 'error');
    return response(JSON.stringify(option(requests.length === 1 ? 2 : 0)));
  });
  assert.deepEqual(await client.decide('application_option_choice', [message]), option(0));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].signal, requests[1].signal);
  assert.notEqual(JSON.parse(requests[0].body).messages[0].content, JSON.parse(requests[1].body).messages[0].content);
});

test('retries malformed response bodies only once', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('<html>'));
  await assert.rejects(client.decide('application_option_choice', [message]), /结构化结果/);
  assert.equal(fetch.mock.callCount(), 2);
});

test('does not retry HTTP errors or caller cancellation', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 401 }));
  await assert.rejects(client.decide('application_option_choice', [message]), /HTTP 401/);
  assert.equal(fetch.mock.callCount(), 1);
  const caller = new AbortController();
  fetch.mock.mockImplementation(async (_url, init) => {
    caller.abort();
    assert.equal(init.signal.aborted, true);
    return response('malformed');
  });
  await assert.rejects(client.decide('application_option_choice', [message], caller.signal), { name: 'AbortError' });
  assert.equal(fetch.mock.callCount(), 2);
});
