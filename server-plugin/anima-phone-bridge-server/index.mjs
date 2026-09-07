import fs from 'node:fs';
import path from 'node:path';

const PLUGIN_ID = 'anima-phone-bridge-server';
const VERSION = '0.1.0';
const DATA_ROOT = path.resolve(globalThis.DATA_ROOT || path.join(process.cwd(), 'data'));
const ROOT_DIR = path.basename(DATA_ROOT) === 'default-user'
  ? path.join(DATA_ROOT, 'anima-phone-bridge')
  : path.join(DATA_ROOT, 'default-user', 'anima-phone-bridge');
const CONFIG_FILE = path.join(ROOT_DIR, 'config.json');

const defaultConfig = () => ({
  baseUrl: '',
  apiKey: '',
  model: '',
  temperature: 0.7,
  maxTokens: 1200,
  timeoutSeconds: 120,
});

function ensureDir() {
  fs.mkdirSync(ROOT_DIR, { recursive: true });
}

function loadConfig() {
  try {
    return { ...defaultConfig(), ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
  } catch {
    return defaultConfig();
  }
}

function saveConfig(config) {
  ensureDir();
  const temp = `${CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(config, null, 2), 'utf8');
  fs.renameSync(temp, CONFIG_FILE);
}

function publicConfig(config) {
  return {
    ...config,
    apiKey: '',
    hasApiKey: Boolean(config.apiKey),
  };
}

function endpoint(baseUrl) {
  const value = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!value) throw new Error('请先填写 API 地址');
  if (/\/chat\/completions$/i.test(value)) return value;
  return `${value}/chat/completions`;
}

function cleanConfig(input, previous = defaultConfig()) {
  const next = {
    baseUrl: String(input?.baseUrl ?? previous.baseUrl).trim().slice(0, 1000),
    apiKey: String(input?.apiKey || previous.apiKey || '').trim().slice(0, 4000),
    model: String(input?.model ?? previous.model).trim().slice(0, 300),
    temperature: Math.max(0, Math.min(2, Number(input?.temperature ?? previous.temperature) || 0.7)),
    maxTokens: Math.max(128, Math.min(8000, Number(input?.maxTokens ?? previous.maxTokens) || 1200)),
    timeoutSeconds: Math.max(10, Math.min(300, Number(input?.timeoutSeconds ?? previous.timeoutSeconds) || 120)),
  };
  return next;
}

async function callModel(config, messages, signal) {
  if (!config.model) throw new Error('请先填写模型名称');
  if (!config.apiKey) throw new Error('请先填写 API Key');
  const response = await fetch(endpoint(config.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
    }),
    signal,
  });
  const raw = await response.text();
  let body;
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw }; }
  if (!response.ok) {
    throw new Error(body?.error?.message || body?.message || `模型请求失败：HTTP ${response.status}`);
  }
  const content = body?.choices?.[0]?.message?.content;
  if (!content) throw new Error('模型返回了空内容');
  return { content: String(content), model: body?.model || config.model };
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

export async function init(router) {
  ensureDir();
  router.get('/health', (_req, res) => res.json({ ok: true, version: VERSION }));

  router.get('/config', (_req, res) => {
    res.json({ ok: true, config: publicConfig(loadConfig()) });
  });

  router.post('/config', (req, res) => {
    try {
      const config = cleanConfig(req.body || {}, loadConfig());
      saveConfig(config);
      res.json({ ok: true, config: publicConfig(config) });
    } catch (error) {
      res.status(400).json({ ok: false, error: String(error?.message || error) });
    }
  });

  router.post('/test', async (_req, res) => {
    try {
      const config = loadConfig();
      const result = await withTimeout(config, signal => callModel(config, [
        { role: 'system', content: '你是虚构故事中的手机助手。只输出合法 JSON 对象。' },
        { role: 'user', content: '只输出 {"reply":"连接成功"}' },
      ], signal));
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(400).json({ ok: false, error: String(error?.message || error) });
    }
  });

  router.post('/generate', async (req, res) => {
    try {
      const config = loadConfig();
      const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
      if (!messages.length || messages.length > 60) throw new Error('无效的手机对话上下文');
      const safeMessages = messages.map(row => ({
        role: ['system', 'user', 'assistant'].includes(row?.role) ? row.role : 'user',
        content: String(row?.content || '').slice(0, 30000),
      }));
      const result = await withTimeout(config, signal => callModel(config, safeMessages, signal));
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(400).json({ ok: false, error: String(error?.message || error) });
    }
  });

  console.log(`[${PLUGIN_ID}] v${VERSION} loaded`);
}

export const info = {
  id: PLUGIN_ID,
  name: 'Anima 小手机桥服务端',
  description: '保存统一手机 API 配置，并代理 OpenAI 兼容的手机 Agent 请求。',
};
