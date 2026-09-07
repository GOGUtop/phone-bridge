import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractModelIds,
  modelsEndpoint,
  reconcileWithFallback,
} from '../server-plugin/anima-phone-bridge-server/index.mjs';

test('model endpoint follows OpenAI-compatible base URLs', () => {
  assert.equal(modelsEndpoint('https://example.com/v1'), 'https://example.com/v1/models');
  assert.equal(modelsEndpoint('https://example.com/v1/'), 'https://example.com/v1/models');
  assert.equal(modelsEndpoint('https://example.com/v1/chat/completions'), 'https://example.com/v1/models');
  assert.equal(modelsEndpoint('https://example.com/v1/models'), 'https://example.com/v1/models');
});

test('model list accepts common response shapes and removes duplicates', () => {
  assert.deepEqual(extractModelIds({ data: [
    { id: 'gemini-2.5-flash' },
    { id: 'gpt-4.1-mini' },
    { id: 'gemini-2.5-flash' },
  ] }), ['gemini-2.5-flash', 'gpt-4.1-mini']);
  assert.deepEqual(extractModelIds({ models: [{ name: 'model-b' }, 'model-a'] }), ['model-a', 'model-b']);
});

test('realtime update failure falls back to the send API', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(String(url));
    if (String(url).startsWith('https://update.example')) {
      return new Response(JSON.stringify({ error: { message: 'update unavailable' } }), { status: 503 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"backstage":{}}' } }], model: 'send-model' }), { status: 200 });
  };
  const endpoint = baseUrl => ({ baseUrl, apiKey: 'test-key', model: 'test-model', temperature: 0.2, maxTokens: 500, timeoutSeconds: 10 });
  try {
    const result = await reconcileWithFallback({
      send: endpoint('https://send.example/v1'),
      update: endpoint('https://update.example/v1'),
      updateFallbackSeconds: 60,
    }, [{ role: 'user', content: '校准' }]);
    assert.equal(result.provider, 'send');
    assert.equal(result.degraded, true);
    assert.equal(result.health.mode, 'fallback');
    assert.deepEqual(calls, ['https://update.example/v1/chat/completions', 'https://send.example/v1/chat/completions']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
