import fs from 'node:fs';
import path from 'node:path';

const PLUGIN_ID = 'anima-phone-bridge-server';
const VERSION = '0.4.0';
const DATA_ROOT = path.resolve(globalThis.DATA_ROOT || path.join(process.cwd(), 'data'));
const ROOT_DIR = path.basename(DATA_ROOT) === 'default-user'
  ? path.join(DATA_ROOT, 'anima-phone-bridge')
  : path.join(DATA_ROOT, 'default-user', 'anima-phone-bridge');
const CONFIG_FILE = path.join(ROOT_DIR, 'config.json');

const defaultEndpoint = () => ({
  baseUrl: '', apiKey: '', model: '', temperature: 0.7, maxTokens: 4096, timeoutSeconds: 120,
});
const defaultConfig = () => ({
  version: 2, send: defaultEndpoint(), update: defaultEndpoint(), updateFallbackSeconds: 60,
});
const updateHealth = {
  mode: 'update', failures: 0, lastError: '', degradedUntil: 0, lastSuccessAt: 0, lastProvider: '',
};

function ensureDir() { fs.mkdirSync(ROOT_DIR, { recursive: true }); }

function cleanEndpoint(input, previous = defaultEndpoint()) {
  return {
    baseUrl: String(input?.baseUrl ?? previous.baseUrl).trim().slice(0, 1000),
    apiKey: String(input?.apiKey || previous.apiKey || '').trim().slice(0, 4000),
    model: String(input?.model ?? previous.model).trim().slice(0, 300),
    temperature: Math.max(0, Math.min(2, Number(input?.temperature ?? previous.temperature) || 0.7)),
    maxTokens: Math.max(128, Math.min(16000, Number(input?.maxTokens ?? previous.maxTokens) || 1200)),
    timeoutSeconds: Math.max(10, Math.min(300, Number(input?.timeoutSeconds ?? previous.timeoutSeconds) || 120)),
  };
}

function migrateConfig(input) {
  const source = input && typeof input === 'object' ? input : {};
  const legacy = source.baseUrl || source.apiKey || source.model ? source : null;
  const base = defaultConfig();
  return {
    version: 2,
    send: cleanEndpoint(source.send || legacy || {}, base.send),
    update: cleanEndpoint(source.update || {}, base.update),
    updateFallbackSeconds: Math.max(15, Math.min(900, Number(source.updateFallbackSeconds) || 60)),
  };
}

function loadConfig() {
  try { return migrateConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); }
  catch { return defaultConfig(); }
}

function cleanConfig(input, previous = defaultConfig()) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    version: 2,
    send: cleanEndpoint(source.send || {}, previous.send),
    update: cleanEndpoint(source.update || {}, previous.update),
    updateFallbackSeconds: Math.max(15, Math.min(900, Number(source.updateFallbackSeconds ?? previous.updateFallbackSeconds) || 60)),
  };
}

function saveConfig(config) {
  ensureDir();
  const temp = `${CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(config, null, 2), 'utf8');
  fs.renameSync(temp, CONFIG_FILE);
}

function endpointReady(config) { return Boolean(config?.baseUrl && config?.apiKey && config?.model); }
function publicEndpoint(config) { return { ...config, apiKey: '', hasApiKey: Boolean(config.apiKey) }; }

function publicHealth(config) {
  const updateConfigured = endpointReady(config.update);
  if (!updateConfigured) return { ...updateHealth, mode: 'shared', updateConfigured: false, degradedUntil: 0 };
  if (Date.now() >= updateHealth.degradedUntil && updateHealth.mode === 'fallback') {
    return { ...updateHealth, mode: 'checking', updateConfigured: true };
  }
  return { ...updateHealth, updateConfigured: true };
}

function publicConfig(config) {
  return {
    version: config.version,
    send: publicEndpoint(config.send),
    update: publicEndpoint(config.update),
    updateFallbackSeconds: config.updateFallbackSeconds,
    health: publicHealth(config),
  };
}

function chatEndpoint(baseUrl) {
  const value = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!value) throw new Error('请先填写 API 地址');
  if (/\/chat\/completions$/i.test(value)) return value;
  if (/\/models$/i.test(value)) return value.replace(/\/models$/i, '/chat/completions');
  return `${value}/chat/completions`;
}

export function modelsEndpoint(baseUrl) {
  const value = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!value) throw new Error('请先填写 API 地址');
  if (/\/models$/i.test(value)) return value;
  if (/\/chat\/completions$/i.test(value)) return value.replace(/\/chat\/completions$/i, '/models');
  return `${value}/models`;
}

export function extractModelIds(body) {
  const rows = Array.isArray(body?.data) ? body.data
    : Array.isArray(body?.models) ? body.models
      : Array.isArray(body) ? body : [];
  return [...new Set(rows
    .map(row => typeof row === 'string' ? row : row?.id ?? row?.name)
    .map(value => String(value || '').trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

async function responseBody(response) {
  const raw = await response.text();
  try { return raw ? JSON.parse(raw) : {}; } catch { return { raw }; }
}

async function callModel(config, messages, signal) {
  if (!config.model) throw new Error('请先填写模型名称');
  if (!config.apiKey) throw new Error('请先填写 API Key');
  const response = await fetch(chatEndpoint(config.baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({ model: config.model, messages, temperature: config.temperature, max_tokens: config.maxTokens }),
    signal,
  });
  const body = await responseBody(response);
  if (!response.ok) throw new Error(body?.error?.message || body?.message || `模型请求失败：HTTP ${response.status}`);
  const content = body?.choices?.[0]?.message?.content;
  if (!content) throw new Error('模型返回了空内容');
  return { content: String(content), model: body?.model || config.model };
}

async function listModels(config, signal) {
  if (!config.apiKey) throw new Error('请先填写 API Key');
  const response = await fetch(modelsEndpoint(config.baseUrl), {
    method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${config.apiKey}` }, signal,
  });
  const body = await responseBody(response);
  if (!response.ok) throw new Error(body?.error?.message || body?.message || `拉取模型失败：HTTP ${response.status}`);
  const models = extractModelIds(body);
  if (!models.length) throw new Error('接口没有返回可用模型，可继续手动填写模型名称');
  return models;
}

async function withTimeout(config, task) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutSeconds * 1000);
  try { return await task(controller.signal); }
  catch (error) {
    if (error?.name === 'AbortError') throw new Error('手机 API 请求超时');
    throw error;
  } finally { clearTimeout(timer); }
}

function safeMessages(input) {
  const messages = Array.isArray(input) ? input : [];
  if (!messages.length || messages.length > 80) throw new Error('无效的手机对话上下文');
  return messages.map(row => ({
    role: ['system', 'user', 'assistant'].includes(row?.role) ? row.role : 'user',
    content: String(row?.content || '').slice(0, 40000),
  }));
}

async function callSlot(config, slot, messages) {
  const selected = slot === 'update' ? config.update : config.send;
  if (!endpointReady(selected)) throw new Error(`${slot === 'update' ? '实时更新' : '发送'} API 尚未完整配置`);
  return withTimeout(selected, signal => callModel(selected, messages, signal));
}

export function normalizeJsonContent(content) {
  const raw = String(content || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || raw;
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型没有返回 JSON 对象');
  const json = fenced.slice(start, end + 1);
  try { return JSON.stringify(JSON.parse(json)); }
  catch (firstError) {
    try {
      let fixed='', quoted=false, escaped=false;
      for(let i=0;i<json.length;i++) {
        const c=json[i];
        if(quoted){fixed+=c;if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
        if(c==='"')quoted=true;
        if(c===',' && /^\s*[}\]]/.test(json.slice(i+1)))continue;
        fixed+=c;
      }
      return JSON.stringify(JSON.parse(fixed));
    }
    catch { throw new Error(`模型返回的 JSON 格式损坏：${firstError.message}`); }
  }
}

async function callJsonSlot(config, slot, messages) {
  const first = await callSlot(config, slot, messages);
  try { return { ...first, content: normalizeJsonContent(first.content), repaired: false }; }
  catch (firstError) {
    const repairMessages = [
      { role: 'system', content: '你是 JSON 修复器。修复输入中的语法错误，保留原字段和值，只输出一个合法 JSON 对象，不要解释，不要 Markdown。' },
      { role: 'user', content: String(first.content || '').slice(0, 39000) },
    ];
    const repaired = await callSlot(config, slot, repairMessages);
    try { return { ...repaired, content: normalizeJsonContent(repaired.content), repaired: true }; }
    catch (repairError) { throw new Error(`${firstError.message}；自动修复仍失败：${repairError.message}`); }
  }
}

export async function reconcileWithFallback(config, messages) {
  const updateConfigured = endpointReady(config.update);
  if (updateConfigured && Date.now() >= updateHealth.degradedUntil) {
    try {
      const result = await callJsonSlot(config, 'update', messages);
      Object.assign(updateHealth, {
        mode: 'update', failures: 0, lastError: '', degradedUntil: 0,
        lastSuccessAt: Date.now(), lastProvider: 'update',
      });
      return { ...result, provider: 'update', degraded: false, health: publicHealth(config) };
    } catch (error) {
      Object.assign(updateHealth, {
        mode: 'fallback', failures: updateHealth.failures + 1,
        lastError: String(error?.message || error).slice(0, 500),
        degradedUntil: Date.now() + config.updateFallbackSeconds * 1000,
        lastProvider: 'send',
      });
    }
  }
  try {
    const result = await callJsonSlot(config, 'send', messages);
    updateHealth.lastProvider = 'send';
    return { ...result, provider: 'send', degraded: updateConfigured, health: publicHealth(config) };
  } catch (fallbackError) {
    const prefix = updateHealth.lastError ? `实时更新 API 失败：${updateHealth.lastError}；` : '';
    throw new Error(`${prefix}备用发送 API 失败：${fallbackError.message}`);
  }
}

export async function init(router) {
  ensureDir();
  router.get('/health', (_req, res) => {
    const config = loadConfig();
    res.json({ ok: true, version: VERSION, health: publicHealth(config) });
  });
  router.get('/config', (_req, res) => res.json({ ok: true, config: publicConfig(loadConfig()) }));
  router.post('/config', (req, res) => {
    try {
      const previous = loadConfig();
      const config = cleanConfig(req.body || {}, previous);
      const updateChanged = JSON.stringify({ ...previous.update, apiKey: Boolean(previous.update.apiKey) })
        !== JSON.stringify({ ...config.update, apiKey: Boolean(config.update.apiKey) });
      saveConfig(config);
      if (updateChanged) Object.assign(updateHealth, { mode: 'update', failures: 0, lastError: '', degradedUntil: 0 });
      res.json({ ok: true, config: publicConfig(config) });
    } catch (error) { res.status(400).json({ ok: false, error: String(error?.message || error) }); }
  });
  router.post('/models', async (req, res) => {
    try {
      const config = loadConfig();
      const slot = req.body?.slot === 'update' ? 'update' : 'send';
      const selected = config[slot];
      const models = await withTimeout(selected, signal => listModels(selected, signal));
      res.json({ ok: true, slot, models });
    } catch (error) { res.status(400).json({ ok: false, error: String(error?.message || error) }); }
  });
  router.post('/test', async (req, res) => {
    try {
      const config = loadConfig();
      const slot = req.body?.slot === 'update' ? 'update' : 'send';
      const result = await callSlot(config, slot, [
        { role: 'system', content: '你是虚构故事中的手机助手。只输出合法 JSON 对象。' },
        { role: 'user', content: '只输出 {"reply":"连接成功"}' },
      ]);
      res.json({ ok: true, slot, ...result });
    } catch (error) { res.status(400).json({ ok: false, error: String(error?.message || error) }); }
  });
  router.post('/generate', async (req, res) => {
    try {
      const config = loadConfig();
      const result = await callSlot(config, 'send', safeMessages(req.body?.messages));
      res.json({ ok: true, provider: 'send', ...result });
    } catch (error) { res.status(400).json({ ok: false, error: String(error?.message || error) }); }
  });
  router.post('/roster', async (req, res) => {
    try { res.json({ ok: true, ...await reconcileWithFallback(loadConfig(), safeMessages(req.body?.messages)) }); }
    catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });
  router.post('/json', async (req, res) => {
    try { res.json({ ok: true, ...await callJsonSlot(loadConfig(), 'send', safeMessages(req.body?.messages)) }); }
    catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });
  router.post('/reconcile', async (req, res) => {
    const config = loadConfig();
    try {
      const result = await reconcileWithFallback(config, safeMessages(req.body?.messages));
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(400).json({ ok: false, error: String(error?.message || error), health: publicHealth(config) });
    }
  });
  console.log(`[${PLUGIN_ID}] v${VERSION} loaded`);
}

export const info = {
  id: PLUGIN_ID,
  name: 'Anima 小手机桥服务端',
  description: '保存发送与实时更新 API，提供模型拉取、故障切换和双向剧情同步。',
};
