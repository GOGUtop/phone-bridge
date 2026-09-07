import {
  ANIMA_PROMPT_RULE_TITLE,
  addCommitment,
  addEvent,
  applyAnimaDigest,
  applyNarrativeUpdate,
  appendMessage,
  buildAnimaDigest,
  compactContext,
  defaultPhoneState,
  makeId,
  mergeAnimaPromptRule,
  mergeContacts,
  normalizeBackstageState,
  normalizePhoneState,
  placeOrder,
  recordTransaction,
} from './core.mjs';

(() => {
  'use strict';

  const MODULE = 'anima_phone_bridge';
  const SERVER_BASE = '/api/plugins/anima-phone-bridge-server';
  const APP_NAMES = {
    wechat: '微信',
    moments: '朋友圈',
    wallet: '钱包',
    eleme: '饿了么',
    meituan: '美团外卖',
    dianping: '大众点评',
    music: '网易云音乐',
    settings: '设置',
  };
  const APP_ICONS = {
    wechat: '💬', moments: '🧭', wallet: '💳', eleme: '🥡',
    meituan: '🛵', dianping: '📍', music: '🎵', settings: '⚙️',
  };

  const runtime = {
    open: false,
    route: { app: 'home', view: 'root', id: '' },
    phone: null,
    busy: false,
    reconciling: false,
    reconcileTimer: null,
    apiConfig: null,
    modelOptions: { send: [], update: [] },
    updateHealth: null,
    bridgeStatus: '尚未同步',
    currentChatKey: '',
    backstageOpen: false,
    suppressLauncherClick: false,
    suppressBackstageClick: false,
    animaAdapting: false,
    animaAdaptTimer: null,
    animaAdaptStatus: '尚未检查当前角色卡',
    animaAddonContent: '',
  };

  const context = () => globalThis.SillyTavern?.getContext?.() || null;
  const helper = () => globalThis.TavernHelper || null;
  const escapeHtml = value => String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  const money = value => `¥${Number(value || 0).toFixed(2)}`;
  const shortTime = value => new Date(Number(value) || Date.now()).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const longTime = value => new Date(Number(value) || Date.now()).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

  function toast(message, type = 'info') {
    if (globalThis.toastr?.[type]) globalThis.toastr[type](message);
    else console[type === 'error' ? 'error' : 'log'](`[Anima Phone] ${message}`);
  }

  function getRootSettings() {
    const ctx = context();
    if (!ctx) return { chats: {} };
    const root = ctx.extensionSettings || (ctx.extensionSettings = {});
    const settings = root[MODULE] || (root[MODULE] = { version: 3, chats: {}, ui: {}, preferences: {} });
    if (!settings.chats || typeof settings.chats !== 'object') settings.chats = {};
    if (!settings.ui || typeof settings.ui !== 'object') settings.ui = {};
    if (!settings.preferences || typeof settings.preferences !== 'object') settings.preferences = {};
    settings.preferences = {
      autonomyEnabled: true,
      autonomyEveryTurns: 3,
      backstageVisible: true,
      autoAnimaAdapt: true,
      ...settings.preferences,
    };
    settings.version = 3;
    return settings;
  }

  function chatKey(ctx = context()) {
    const character = ctx?.characters?.[ctx?.characterId];
    const parts = [ctx?.chatId || ctx?.chatMetadata?.chat_id || 'no-chat', character?.avatar || '', character?.name || ctx?.name2 || 'character'];
    let hash = 2166136261;
    for (const char of parts.join('|')) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return `chat-${(hash >>> 0).toString(16)}`;
  }

  function characterName() {
    const ctx = context();
    return String(ctx?.name2 || ctx?.characters?.[ctx?.characterId]?.name || '联系人').trim();
  }

  function loadPhone() {
    const key = chatKey();
    const settings = getRootSettings();
    let phone = normalizePhoneState(settings.chats[key], characterName());
    const main = phone.contacts.main;
    if (main && (!settings.chats[key] || main.name === '联系人')) {
      main.name = characterName();
      phone.threads.main.name = characterName();
      phone.groups.story.members = [...new Set([...(phone.groups.story.members || []), characterName()])];
    }
    const animaData = latestAnimaData();
    phone = applyAnimaDigest(phone, animaData?.手机);
    if (animaData?.幕后状态 && Number(animaData.幕后状态.updatedAt || 0) >= Number(phone.backstage?.updatedAt || 0)) {
      phone.backstage = normalizeBackstageState(animaData.幕后状态);
    }
    settings.chats[key] = phone;
    runtime.currentChatKey = key;
    runtime.phone = phone;
    return phone;
  }

  function latestAnimaData() {
    const messageId = latestAssistantMessageId();
    if (messageId === null) return {};
    try {
      const variables = helper()?.getVariables?.({ type: 'message', message_id: messageId });
      return variables?.anima_data && typeof variables.anima_data === 'object' ? variables.anima_data : {};
    } catch { return {}; }
  }

  function savePhone() {
    const phone = normalizePhoneState(runtime.phone || defaultPhoneState(characterName()), characterName());
    phone.updatedAt = Date.now();
    runtime.phone = phone;
    getRootSettings().chats[chatKey()] = phone;
    context()?.saveSettingsDebounced?.();
  }

  async function requestHeaders() {
    try {
      const direct = context()?.getRequestHeaders ?? globalThis.getRequestHeaders;
      if (typeof direct === 'function') return { ...direct(), 'Content-Type': 'application/json' };
    } catch {}
    const token = document.querySelector('meta[name="csrf-token"],meta[name="x-csrf-token"]')?.content;
    return { 'Content-Type': 'application/json', ...(token ? { 'x-csrf-token': token } : {}) };
  }

  async function serverRequest(path, options = {}) {
    const response = await fetch(`${SERVER_BASE}${path}`, {
      ...options,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { ...(await requestHeaders()), ...(options.headers || {}) },
    });
    const raw = await response.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { error: raw.slice(0, 800) }; }
    if (!response.ok || data?.ok === false) {
      if (response.status === 404) throw new Error('服务端插件未安装或未启用，请查看安装说明并重启 SillyTavern');
      throw new Error(data?.error || `HTTP ${response.status}`);
    }
    return data;
  }

  async function tavernRequest(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { ...(await requestHeaders()), ...(options.headers || {}) },
    });
    if (!response.ok) throw new Error(`酒馆资料读取失败：HTTP ${response.status}`);
    return response.json();
  }

  function chatMessages() {
    try {
      const rows = helper()?.getChatMessages?.('0-{{lastMessageId}}', { include_swipes: false });
      if (Array.isArray(rows) && rows.length) return rows;
    } catch {}
    return Array.isArray(context()?.chat) ? context().chat.map((row, index) => ({ ...row, message_id: index })) : [];
  }

  function latestAssistantMessage() {
    const userName = context()?.name1;
    const rows = chatMessages();
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      const isUser = row?.is_user === true || row?.role === 'user' || row?.name === userName || String(row?.name || '').toLowerCase() === 'you';
      if (!isUser) {
        return {
          id: row?.message_id ?? row?.mesid ?? index,
          text: String(row?.message ?? row?.mes ?? row?.content ?? ''),
          name: String(row?.name || context()?.name2 || '角色'),
        };
      }
    }
    return null;
  }

  function textSignature(value) {
    let hash = 2166136261;
    for (const char of String(value || '')) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return `floor-${(hash >>> 0).toString(36)}`;
  }

  function latestAssistantMessageId() {
    return latestAssistantMessage()?.id ?? null;
  }

  async function bridgeToAnima(reason = 'phone_event') {
    const tavern = helper();
    const messageId = latestAssistantMessageId();
    if (!tavern || messageId === null) {
      runtime.bridgeStatus = tavern ? '等待第一条 AI 正文' : '未检测到酒馆助手/Anima 接口';
      render();
      return false;
    }
    const digest = buildAnimaDigest(runtime.phone, { recentLimit: 12 });
    try {
      await tavern.updateVariablesWith(variables => {
        const current = variables && typeof variables === 'object' ? variables : {};
        const animaData = current.anima_data && typeof current.anima_data === 'object' ? current.anima_data : {};
        current.anima_data = { ...animaData, 手机: digest, 幕后状态: normalizeBackstageState(runtime.phone.backstage) };
        return current;
      }, { type: 'message', message_id: messageId });
      const ctx = context();
      ctx?.eventSource?.emit?.('ANIMA_VARIABLE_UPDATE_ENDED', {
        type: 'phone_bridge', messageId, newData: { 手机: digest, 幕后状态: runtime.phone.backstage }, reason, timestamp: Date.now(),
      });
      await tavern.setChatMessages?.([{ message_id: messageId }]);
      runtime.bridgeStatus = `已同步到正文 #${messageId}`;
      render();
      return true;
    } catch (error) {
      runtime.bridgeStatus = `同步失败：${error.message}`;
      render();
      return false;
    }
  }

  function characterContext() {
    const ctx = context();
    const character = ctx?.characters?.[ctx?.characterId] || {};
    let worldState = {};
    const messageId = latestAssistantMessageId();
    try {
      const variables = helper()?.getVariables?.({ type: 'message', message_id: messageId });
      worldState = variables?.anima_data || {};
      if (worldState?.手机) worldState = { ...worldState, 手机: undefined };
    } catch {}
    return {
      userName: String(ctx?.name1 || '{{user}}').slice(0, 80),
      characterName: characterName(),
      description: String(character?.description || '').slice(0, 6000),
      personality: String(character?.personality || '').slice(0, 3000),
      scenario: String(character?.scenario || '').slice(0, 2500),
      worldState,
    };
  }

  function currentCharacter() {
    const ctx = context();
    return ctx?.characters?.[ctx?.characterId] || {};
  }

  async function loadAnimaAddonContent() {
    if (runtime.animaAddonContent) return runtime.animaAddonContent;
    const response = await fetch(new URL('./presets/anima-status-addon.txt', import.meta.url), { cache: 'no-store' });
    if (!response.ok) throw new Error(`无法读取 Anima 适配规则：HTTP ${response.status}`);
    const content = String(await response.text()).trim();
    if (!content) throw new Error('Anima 适配规则为空');
    runtime.animaAddonContent = content;
    return content;
  }

  async function refreshAnimaStatusPanel() {
    if (!document.getElementById('anima_status_prompt_list')) return false;
    try {
      const animaAsset = [...document.querySelectorAll('script[src],link[href]')]
        .map(node => node.src || node.href || '')
        .find(url => url.includes('/Anima-Memory-System/'));
      const moduleUrl = animaAsset
        ? `${animaAsset.slice(0, animaAsset.indexOf('/Anima-Memory-System/') + '/Anima-Memory-System/'.length)}scripts/status.js`
        : new URL('/scripts/extensions/third-party/Anima-Memory-System/scripts/status.js', location.origin).href;
      const animaStatus = await import(moduleUrl);
      if (typeof animaStatus.initStatusSettings !== 'function') return false;
      animaStatus.initStatusSettings();
      return true;
    } catch (error) {
      console.warn('[Anima Phone] unable to refresh Anima status panel', error);
      return false;
    }
  }

  async function ensureAnimaCardAdaptation({ manual = false, attempt = 0 } = {}) {
    const settings = getRootSettings();
    if (!manual && settings.preferences.autoAnimaAdapt === false) return false;
    if (runtime.animaAdapting) return false;
    const ctx = context();
    const characterId = ctx?.characterId;
    const character = characterId === undefined || characterId === null ? null : ctx?.characters?.[characterId];
    if (!character) {
      runtime.animaAdaptStatus = '当前不是单角色卡会话，未执行自动适配';
      render();
      return false;
    }
    const rules = character?.data?.extensions?.anima_prompt_config;
    if (!Array.isArray(rules) || !rules.length) {
      runtime.animaAdaptStatus = '等待 Anima 初始化当前角色卡';
      render();
      if (attempt < 3) {
        clearTimeout(runtime.animaAdaptTimer);
        runtime.animaAdaptTimer = setTimeout(() => ensureAnimaCardAdaptation({ manual, attempt: attempt + 1 }), 500 + attempt * 700);
      } else if (manual) toast('Anima 尚未为当前角色卡建立默认提示词，请打开一次 Anima 状态页面后重试', 'warning');
      return false;
    }
    if (typeof ctx.writeExtensionField !== 'function') {
      runtime.animaAdaptStatus = '当前 SillyTavern 不支持写入角色卡扩展字段';
      if (manual) toast(runtime.animaAdaptStatus, 'warning');
      render();
      return false;
    }
    runtime.animaAdapting = true;
    runtime.animaAdaptStatus = '正在检查当前角色卡…';
    render();
    try {
      const content = await loadAnimaAddonContent();
      const merged = mergeAnimaPromptRule(rules, content);
      if (!merged.ready) return false;
      if (!merged.changed) {
        runtime.animaAdaptStatus = `当前角色卡已适配：${ANIMA_PROMPT_RULE_TITLE}`;
        const refreshed = await refreshAnimaStatusPanel();
        if (manual) toast(refreshed ? '当前角色卡已经适配，Anima 列表已刷新' : '当前角色卡已经适配；如列表未显示，请关闭后重新打开 Anima 面板', 'info');
        return true;
      }
      if (context()?.characterId !== characterId) throw new Error('适配过程中角色卡已切换，请重试');
      await ctx.writeExtensionField(characterId, 'anima_prompt_config', merged.rules);
      character.data ||= {};
      character.data.extensions ||= {};
      character.data.extensions.anima_prompt_config = merged.rules;
      runtime.animaAdaptStatus = `已自动适配：${character.name || characterName()}`;
      const refreshed = await refreshAnimaStatusPanel();
      if (manual) toast(refreshed ? '已加入小手机规则并刷新 Anima 列表' : '已加入小手机规则；如列表未显示，请关闭后重新打开 Anima 面板', 'success');
      return true;
    } catch (error) {
      runtime.animaAdaptStatus = `适配失败：${error.message}`;
      if (manual) toast(runtime.animaAdaptStatus, 'error');
      console.warn('[Anima Phone] card adaptation failed', error);
      return false;
    } finally {
      runtime.animaAdapting = false;
      render();
    }
  }

  function scheduleAnimaCardAdaptation(delay = 900) {
    clearTimeout(runtime.animaAdaptTimer);
    runtime.animaAdaptTimer = setTimeout(() => ensureAnimaCardAdaptation(), delay);
  }

  function characterWorldbookName() {
    const character = currentCharacter();
    return String(
      character?.data?.extensions?.world
      || character?.extensions?.world
      || character?.world
      || character?.worldName
      || '',
    ).trim();
  }

  function worldbookRows(data) {
    if (Array.isArray(data?.entries)) return data.entries;
    if (data?.entries && typeof data.entries === 'object') return Object.values(data.entries);
    return [];
  }

  function worldbookContactName(value) {
    const name = String(value || '').trim().split(/[，,、|/]/)[0].replace(/^(角色|人物|NPC)[:：]?/i, '').trim();
    if (!/^[\u3400-\u9fffA-Za-z·._-]{2,24}$/.test(name)) return '';
    if (/^(世界观|设定|背景|地点|城市|学校|公司|组织|规则|剧情|事件|物品|用户|玩家|主角)$/i.test(name)) return '';
    return name;
  }

  async function readWorldbookContext() {
    const name = characterWorldbookName();
    if (!name) return { name: '', contacts: [], excerpt: '' };
    try {
      const data = await tavernRequest('/api/worldinfo/get', { method: 'POST', body: JSON.stringify({ name }) });
      const contacts = [];
      const excerpts = [];
      for (const entry of worldbookRows(data).filter(row => row?.enabled !== false && !row?.disable).slice(0, 240)) {
        const content = String(entry?.content || '').trim();
        if (!content) continue;
        const keys = Array.isArray(entry?.key) ? entry.key : Array.isArray(entry?.keys) ? entry.keys : [entry?.key || entry?.comment || entry?.name];
        const personLike = /(?:姓名|人物|角色|NPC|性别|年龄|身份|职业|性格|外貌|关系|称呼)/i.test(content);
        if (personLike) {
          for (const key of keys.slice(0, 4)) {
            const candidate = worldbookContactName(key);
            if (candidate) contacts.push({ name: candidate, subtitle: String(entry?.comment || entry?.name || '世界书角色').slice(0, 120), source: `世界书:${name}` });
          }
          for (const match of content.matchAll(/(?:姓名|角色名|人物名)\s*[:：]\s*([\u3400-\u9fffA-Za-z·._-]{2,24})/gi)) {
            const candidate = worldbookContactName(match[1]);
            if (candidate) contacts.push({ name: candidate, subtitle: String(entry?.comment || entry?.name || '世界书角色').slice(0, 120), source: `世界书:${name}` });
          }
        }
        if (excerpts.join('\n').length < 16000) excerpts.push(`[${keys.filter(Boolean).join('、') || '条目'}]\n${content.slice(0, 1800)}`);
      }
      return { name, contacts, excerpt: excerpts.join('\n\n').slice(0, 16000) };
    } catch (error) {
      console.warn('[Anima Phone] worldbook read failed', error);
      return { name, contacts: [], excerpt: '' };
    }
  }

  async function syncContactRoster(worldbook = null) {
    const source = worldbook || await readWorldbookContext();
    const candidates = [{ name: characterName(), subtitle: '当前角色', source: '角色卡', id: 'main' }, ...source.contacts];
    runtime.phone = mergeContacts(runtime.phone, candidates, { excludeNames: [context()?.name1] });
    const main = runtime.phone.contacts.main;
    if (main) {
      main.name = characterName();
      runtime.phone.threads.main.name = characterName();
    }
    savePhone();
    return source;
  }

  function recentNarrativeRows(limit = 8) {
    const userName = context()?.name1;
    return chatMessages().slice(-Math.max(2, limit)).map(row => {
      const isUser = row?.is_user === true || row?.role === 'user' || row?.name === userName;
      return {
        role: isUser ? 'user' : 'assistant',
        content: String(row?.message ?? row?.mes ?? row?.content ?? '').slice(0, 8000),
      };
    }).filter(row => row.content);
  }

  function reconciliationPrompt(message, worldbook) {
    const settings = getRootSettings();
    const interval = Math.max(1, Math.min(20, Number(settings.preferences.autonomyEveryTurns) || 3));
    const lastAutonomy = Number(runtime.phone.sync?.lastAutonomyFloor ?? -999);
    const autonomyDue = settings.preferences.autonomyEnabled !== false && Number(message.id) - lastAutonomy >= interval;
    const phoneSnapshot = {
      contacts: Object.values(runtime.phone.contacts).map(row => ({ id: row.id, name: row.name, aliases: row.aliases || [] })).slice(0, 80),
      groups: Object.values(runtime.phone.groups).map(row => ({ id: row.id, name: row.name, members: row.members })).slice(0, 30),
      orders: runtime.phone.delivery.orders.slice(-12),
      commitments: Object.values(runtime.phone.commitments).slice(-30),
      wallet: runtime.phone.wallet,
      backstage: runtime.phone.backstage,
    };
    return [
      '你是角色扮演世界的手机与幕后状态校准器。只提取当前正文已经发生的事实，并输出一个合法 JSON 对象。禁止续写正文，禁止解释。',
      '订单状态必须跟随剧情时间和明确结果；正文已送达就更新为已送达，正文未推进则保持原状。不要按现实墙上时间擅自推进。',
      'contacts 只收录具名人物；店名、地点、组织、泛称路人不能成为联系人。联系人存在不代表其知道所有事件。',
      'incomingMessages 只记录正文明确出现的手机消息、通知，或在允许自主消息时生成至多1条来自现有镜头外联系人的低影响日常消息。不得让同场人物凭空远程发消息。',
      'walletChanges 只处理正文明确发生且尚未记录的到账、退款或扣款。金额不明确则不要填写。',
      'backstage 必须完整返回七栏：timeline、present、clothing、promises、secrets、offscreen、world。衣着只写正文明确证据；未知秘密不得让不知情角色获得。',
      `本轮允许自主消息：${autonomyDue ? '是，最多1条' : '否'}。当前用户：${context()?.name1 || '用户'}；当前主角色：${characterName()}。`,
      'JSON 格式：{"contacts":[{"name":"","subtitle":"","aliases":[]}],"orderUpdates":[{"orderId":"","restaurant":"","item":"","status":"","lastMessage":"","actor":""}],"commitmentUpdates":[{"id":"","person":"","at":"","place":"","subject":"","status":""}],"incomingMessages":[{"id":"","channel":"private|group","targetId":"","targetName":"","sender":"","text":"","autonomous":false}],"walletChanges":[{"id":"","account":"wechat|alipay|bank","amount":0,"kind":"","counterparty":"","note":""}],"moments":[{"id":"","author":"","content":""}],"backstage":{"timeline":{"date":"","time":"","location":"","weather":""},"present":[{"name":"","action":"","mood":""}],"clothing":[{"name":"","outfit":""}],"promises":[{"person":"","time":"","place":"","subject":"","status":""}],"secrets":[{"content":"","knownBy":[]}],"offscreen":[{"name":"","location":"","activity":"","goal":""}],"world":[{"title":"","detail":""}]}}',
      `当前手机与幕后状态：${JSON.stringify(phoneSnapshot).slice(0, 22000)}`,
      `当前角色世界书“${worldbook.name || '未绑定'}”摘录：${worldbook.excerpt || '无'}`,
      `最新正文（楼层 ${message.id}）：${message.text.slice(0, 16000)}`,
    ].join('\n\n');
  }

  async function reconcileNarrative(reason = 'assistant_message') {
    if (runtime.reconciling) return false;
    if (!runtime.phone) loadPhone();
    const message = latestAssistantMessage();
    if (!message?.text.trim()) return false;
    const signature = textSignature(`${message.id}|${message.text}`);
    runtime.phone = applyAnimaDigest(runtime.phone, latestAnimaData()?.手机);
    if (runtime.phone.sync?.lastNarrativeSignature === signature) {
      savePhone();
      renderBackstage();
      return true;
    }
    runtime.reconciling = true;
    runtime.phone.sync.lastStatus = '正在校准正文…';
    render(); renderBackstage();
    try {
      const worldbook = await syncContactRoster();
      const messages = [
        { role: 'system', content: reconciliationPrompt(message, worldbook) },
        ...recentNarrativeRows(6),
        { role: 'user', content: '根据最新正文返回一次状态校准 JSON。没有变化的数组保持为空，backstage 七栏仍需完整。' },
      ];
      const result = await serverRequest('/reconcile', { method: 'POST', body: JSON.stringify({ messages, reason }) });
      const parsed = parseAgentJson(result.content);
      const provider = result.provider === 'update' ? '实时更新 API' : result.degraded ? '发送 API（自动备用）' : '发送 API（共用）';
      runtime.updateHealth = result.health || null;
      runtime.phone = applyNarrativeUpdate(runtime.phone, parsed, {
        messageId: message.id,
        signature,
        provider: result.provider,
        status: `${provider} · 已同步正文 #${message.id}`,
        excludeNames: [context()?.name1],
      });
      if ((parsed.incomingMessages || []).some(row => row?.autonomous)) runtime.phone.sync.lastAutonomyFloor = Number(message.id);
      runtime.bridgeStatus = `${provider} · 已同步正文 #${message.id}`;
      savePhone();
      await bridgeToAnima('narrative_reconcile');
      renderBackstage();
      return true;
    } catch (error) {
      runtime.phone.sync.lastStatus = `更新失败：${error.message}`;
      runtime.bridgeStatus = runtime.phone.sync.lastStatus;
      savePhone();
      console.warn('[Anima Phone] narrative reconcile failed', error);
      render(); renderBackstage();
      return false;
    } finally {
      runtime.reconciling = false;
    }
  }

  function scheduleReconcile(reason = 'assistant_message', delay = 1000) {
    clearTimeout(runtime.reconcileTimer);
    runtime.reconcileTimer = setTimeout(() => reconcileNarrative(reason), delay);
  }

  function agentSystemPrompt(mode, target) {
    const scene = characterContext();
    const allowedSenders = Array.isArray(target.members) && target.members.length ? target.members : [target.name];
    return [
      '你是虚构故事中唯一的手机交互 Agent。所有内容都是角色扮演世界内的虚构通讯。',
      '保持人物人设、关系、时间线和知情边界。手机中不知情的角色不能凭空知道现场私密事件。',
      `当前模式：${mode}；会话：${target.name}；允许回复者：${allowedSenders.join('、') || target.name}。`,
      `用户角色：${scene.userName}；主要角色：${scene.characterName}。`,
      `角色资料：${scene.description}\n性格：${scene.personality}\n场景：${scene.scenario}`,
      `Anima 当前世界状态：${JSON.stringify(scene.worldState).slice(0, 12000)}`,
      '只输出一个合法 JSON 对象，不要 Markdown。格式：',
      '{"replies":[{"sender":"现有角色名","text":"自然简短的手机回复"}],"commitments":[{"person":"角色名","at":"明确时间或空字符串","place":"地点或空字符串","subject":"已明确成立的约定","status":"未完成"}],"bridgeFacts":["会影响后续正文的简短事实"],"orderStatus":"仅外卖任务可填写"}',
      '没有明确约定时 commitments 必须是空数组。bridgeFacts 只写对后续剧情有用的事实，不复述闲聊。',
    ].join('\n\n');
  }

  function parseAgentJson(content) {
    const raw = String(content || '').trim();
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || raw;
    const start = fenced.indexOf('{');
    const end = fenced.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('手机 API 没有返回合法 JSON');
    return JSON.parse(fenced.slice(start, end + 1));
  }

  async function generatePhoneReply(channel, targetId) {
    const target = channel === 'group' ? runtime.phone.groups[targetId] : runtime.phone.threads[targetId];
    if (!target) throw new Error('找不到会话');
    const mode = channel === 'group' ? 'group' : 'private';
    const messages = [
      { role: 'system', content: agentSystemPrompt(mode, target) },
      ...compactContext(runtime.phone, channel, targetId, 18),
      { role: 'user', content: '请回复当前会话中最后一条由用户发送的消息。' },
    ];
    const result = await serverRequest('/generate', { method: 'POST', body: JSON.stringify({ messages }) });
    const parsed = parseAgentJson(result.content);
    const replies = Array.isArray(parsed.replies) ? parsed.replies.slice(0, channel === 'group' ? 4 : 2) : [];
    for (const row of replies) {
      const sender = channel === 'group' && target.members.includes(String(row?.sender || '').trim())
        ? String(row.sender).trim() : target.name;
      runtime.phone = appendMessage(runtime.phone, channel, targetId, {
        sender, direction: 'in', text: row?.text,
      });
    }
    for (const row of Array.isArray(parsed.commitments) ? parsed.commitments.slice(0, 4) : []) {
      if (!String(row?.subject || '').trim()) continue;
      runtime.phone = addCommitment(runtime.phone, row);
    }
    for (const fact of Array.isArray(parsed.bridgeFacts) ? parsed.bridgeFacts.slice(0, 6) : []) {
      addEvent(runtime.phone, { type: 'phone_fact', actor: target.name, target: '正文', summary: fact });
    }
    savePhone();
    await bridgeToAnima('phone_reply');
  }

  async function generateMomentReactions(momentId) {
    const moment = runtime.phone.moments.find(row => row.id === momentId);
    if (!moment) throw new Error('朋友圈动态不存在');
    const participants = [...new Set([characterName(), ...Object.values(runtime.phone.contacts).map(row => row.name)])].slice(0, 8);
    const target = { name: '朋友圈', members: participants };
    const messages = [
      { role: 'system', content: agentSystemPrompt('moment', target) },
      { role: 'user', content: `用户发布了朋友圈：${moment.content}\n请让0到2名真正会看到且愿意回应的现有联系人点赞式简短留言；replies 作为评论。` },
    ];
    const result = await serverRequest('/generate', { method: 'POST', body: JSON.stringify({ messages }) });
    const parsed = parseAgentJson(result.content);
    moment.comments = Array.isArray(moment.comments) ? moment.comments : [];
    for (const row of Array.isArray(parsed.replies) ? parsed.replies.slice(0, 2) : []) {
      moment.comments.push({ author: String(row?.sender || characterName()).slice(0, 80), text: String(row?.text || '').slice(0, 500), time: Date.now() });
    }
    for (const fact of Array.isArray(parsed.bridgeFacts) ? parsed.bridgeFacts.slice(0, 4) : []) {
      addEvent(runtime.phone, { type: 'moment_reaction', actor: '朋友圈联系人', target: moment.author, summary: fact });
    }
    savePhone();
    await bridgeToAnima('moment_reaction');
  }

  async function generateDeliveryUpdate(orderId) {
    const order = runtime.phone.delivery.orders.find(row => row.id === orderId);
    if (!order) throw new Error('订单不存在');
    const target = { name: order.restaurant, members: [order.restaurant, '配送骑手'] };
    const messages = [
      { role: 'system', content: agentSystemPrompt('delivery', target) },
      { role: 'user', content: `虚构外卖订单：${JSON.stringify(order)}\n请给出一条合理的商家或骑手通知；可在 orderStatus 填写简短新状态。不要取消订单，除非已有明确依据。` },
    ];
    const result = await serverRequest('/generate', { method: 'POST', body: JSON.stringify({ messages }) });
    const parsed = parseAgentJson(result.content);
    const reply = Array.isArray(parsed.replies) ? parsed.replies[0] : null;
    if (String(parsed.orderStatus || '').trim()) order.status = String(parsed.orderStatus).trim().slice(0, 80);
    if (reply?.text) {
      order.lastMessage = String(reply.text).slice(0, 600);
      addEvent(runtime.phone, { type: 'delivery_update', actor: reply.sender || order.restaurant, target: '我', summary: `${order.status}：${order.lastMessage}`, sourceId: order.id });
    }
    for (const fact of Array.isArray(parsed.bridgeFacts) ? parsed.bridgeFacts.slice(0, 4) : []) {
      addEvent(runtime.phone, { type: 'delivery_fact', actor: order.restaurant, target: '正文', summary: fact, sourceId: order.id });
    }
    savePhone();
    await bridgeToAnima('delivery_update');
  }

  function homeScreen() {
    const date = new Date();
    const unread = [...Object.values(runtime.phone.threads), ...Object.values(runtime.phone.groups)].reduce((sum, row) => sum + Number(row.unread || 0), 0);
    const order = runtime.phone.delivery.orders.at(-1);
    const commitment = Object.values(runtime.phone.commitments).find(row => row.status === '未完成');
    const apps = ['wechat', 'moments', 'wallet', 'eleme', 'meituan', 'dianping', 'music', 'settings'];
    return `
      <section class="apb-home">
        <div class="apb-widget apb-clock-widget">
          <div><span class="apb-widget-day">${date.getDate()}</span><span>${date.toLocaleDateString('zh-CN', { weekday: 'short' })}</span></div>
          <div class="apb-widget-copy">
            <strong>${commitment ? escapeHtml(commitment.at || '待定时间') : '今天没有临近日程'}</strong>
            <span>${commitment ? escapeHtml(`${commitment.person} · ${commitment.subject}`) : escapeHtml(order ? `${order.item} · ${order.status}` : '打开微信开始一段对话')}</span>
          </div>
        </div>
        <div class="apb-app-grid">
          ${apps.map(app => `<button class="apb-app" data-apb-open="${app}">
            <span class="apb-app-icon apb-icon-${app}">${APP_ICONS[app]}${app === 'wechat' && unread ? `<b>${Math.min(99, unread)}</b>` : ''}</span>
            <span>${APP_NAMES[app]}</span>
          </button>`).join('')}
        </div>
        <div class="apb-now-playing">
          <span class="apb-vinyl ${runtime.phone.music.playing ? 'is-playing' : ''}">♪</span>
          <div><strong>${escapeHtml(runtime.phone.music.playing?.title || '未在播放')}</strong><span>${escapeHtml(runtime.phone.music.playing?.artist || '网易云音乐')}</span></div>
          <button data-apb-open="music" title="打开音乐">›</button>
        </div>
        <div class="apb-bridge-pill"><span></span>${escapeHtml(runtime.bridgeStatus)}</div>
      </section>`;
  }

  function appHeader(title, root = false) {
    return `<header class="apb-app-header">
      <button data-apb-back="${root ? 'home' : 'app'}" title="返回">‹</button>
      <strong>${escapeHtml(title)}</strong>
      <button data-apb-close title="关闭手机">×</button>
    </header>`;
  }

  function wechatScreen() {
    if (runtime.route.view === 'chat') return chatScreen(runtime.route.id, false);
    if (runtime.route.view === 'group') return chatScreen(runtime.route.id, true);
    const direct = Object.values(runtime.phone.threads).map(row => {
      const last = row.messages.at(-1);
      return `<button class="apb-thread-row" data-apb-chat="${escapeHtml(row.id)}">
        <span class="apb-avatar">${escapeHtml(row.name.slice(0, 1))}</span><span><strong>${escapeHtml(row.name)}</strong><small>${escapeHtml(last?.text || '开始聊天')}</small></span>
        ${row.unread ? `<b>${Math.min(99, row.unread)}</b>` : ''}
      </button>`;
    }).join('');
    const groups = Object.values(runtime.phone.groups).map(row => {
      const last = row.messages.at(-1);
      return `<button class="apb-thread-row" data-apb-group="${escapeHtml(row.id)}">
        <span class="apb-avatar apb-group-avatar">群</span><span><strong>${escapeHtml(row.name)}</strong><small>${escapeHtml(last?.text || row.members.join('、'))}</small></span>
        ${row.unread ? `<b>${Math.min(99, row.unread)}</b>` : ''}
      </button>`;
    }).join('');
    return `${appHeader('微信', true)}<main class="apb-app-body apb-list"><h3>消息</h3>${direct}<h3>群聊</h3>${groups}</main>`;
  }

  function chatScreen(id, isGroup) {
    const target = isGroup ? runtime.phone.groups[id] : runtime.phone.threads[id];
    if (!target) return wechatScreen();
    target.unread = 0;
    savePhone();
    return `${appHeader(target.name)}
      <main class="apb-chat-body" id="apb-chat-scroll">
        ${target.messages.length ? target.messages.map(row => `<div class="apb-message ${row.direction === 'out' ? 'is-out' : 'is-in'}">
          ${isGroup && row.direction === 'in' ? `<small>${escapeHtml(row.sender)}</small>` : ''}<p>${escapeHtml(row.text)}</p><time>${shortTime(row.time)}</time>
        </div>`).join('') : '<div class="apb-empty">暂无消息</div>'}
      </main>
      <form class="apb-compose" data-apb-send="${isGroup ? 'group' : 'private'}" data-target="${escapeHtml(id)}">
        <input name="message" autocomplete="off" maxlength="1200" placeholder="发消息…" ${runtime.busy ? 'disabled' : ''}>
        <button type="submit" ${runtime.busy ? 'disabled' : ''}>${runtime.busy ? '…' : '发送'}</button>
      </form>`;
  }

  function momentsScreen() {
    return `${appHeader('朋友圈', true)}<main class="apb-app-body">
      <form class="apb-inline-form" data-apb-moment><textarea name="content" maxlength="800" placeholder="分享这一刻…"></textarea><button>发布</button></form>
      <div class="apb-feed">${runtime.phone.moments.slice().reverse().map(row => `<article class="apb-moment">
        <span class="apb-avatar">${escapeHtml((row.author || '我').slice(0, 1))}</span><div><strong>${escapeHtml(row.author || '我')}</strong><p>${escapeHtml(row.content)}</p><time>${longTime(row.time)}</time>
        ${(row.comments || []).map(comment => `<small><b>${escapeHtml(comment.author)}：</b>${escapeHtml(comment.text)}</small>`).join('')}
        <button class="apb-text-action" data-apb-react-moment="${escapeHtml(row.id)}">让好友回应</button></div>
      </article>`).join('') || '<div class="apb-empty">还没有朋友圈</div>'}</div>
    </main>`;
  }

  function walletScreen() {
    const wallet = runtime.phone.wallet;
    return `${appHeader('钱包', true)}<main class="apb-app-body">
      <div class="apb-balance-grid">
        <div><span>微信支付</span><strong>${money(wallet.wechat)}</strong></div>
        <div><span>支付宝</span><strong>${money(wallet.alipay)}</strong></div>
        <div class="wide"><span>银行卡</span><strong>${money(wallet.bank)}</strong></div>
      </div>
      <h3>转账 / 红包</h3>
      <form class="apb-stack-form" data-apb-payment>
        <select name="kind"><option>微信转账</option><option>私聊红包</option><option>群红包</option><option>支付宝付款</option></select>
        <input name="counterparty" maxlength="80" placeholder="收款人或群名" required>
        <div class="apb-form-row"><input name="amount" type="number" min="0.01" step="0.01" placeholder="金额" required><input name="note" maxlength="120" placeholder="备注"></div>
        <button>确认支付</button>
      </form>
      <h3>银行入账</h3>
      <form class="apb-stack-form" data-apb-income><div class="apb-form-row"><input name="source" value="工资" maxlength="80"><input name="amount" type="number" min="0.01" step="0.01" placeholder="金额" required></div><button>模拟到账</button></form>
      <div class="apb-transactions">${wallet.transactions.slice(-12).reverse().map(row => `<div><span>${escapeHtml(row.kind)}<small>${escapeHtml(row.counterparty || row.note)}</small></span><strong class="${row.amount > 0 ? 'positive' : ''}">${row.amount > 0 ? '+' : '-'}${money(Math.abs(row.amount))}</strong></div>`).join('')}</div>
    </main>`;
  }

  function deliveryScreen(appName) {
    return `${appHeader(APP_NAMES[appName], true)}<main class="apb-app-body">
      <div class="apb-delivery-banner"><strong>${appName === 'eleme' ? '准时达' : '今天吃点好的'}</strong><span>订单会同步到 Anima 剧情状态</span></div>
      <div class="apb-restaurants">${runtime.phone.delivery.restaurants.map(restaurant => `<article>
        <div><span class="apb-store-icon">${restaurant.name.slice(0, 1)}</span><span><strong>${escapeHtml(restaurant.name)}</strong><small>${escapeHtml(restaurant.category)} · ${restaurant.eta} 分钟</small></span></div>
        ${restaurant.items.map(item => `<button data-apb-order="${restaurant.id}" data-item="${escapeHtml(item.name)}"><span>${escapeHtml(item.name)}</span><b>${money(item.price)}</b></button>`).join('')}
      </article>`).join('')}</div>
      <h3>最近订单</h3>${runtime.phone.delivery.orders.slice(-5).reverse().map(order => `<div class="apb-order"><span><strong>${escapeHtml(order.item)}</strong><small>${escapeHtml(order.restaurant)}${order.lastMessage ? ` · ${escapeHtml(order.lastMessage)}` : ''}</small></span><b>${escapeHtml(order.status)}</b></div>`).join('') || '<div class="apb-empty">暂无订单</div>'}
    </main>`;
  }

  function dianpingScreen() {
    const venues = ['桥下咖啡', '白塔电影院', '春风书店'];
    return `${appHeader('大众点评', true)}<main class="apb-app-body">
      <div class="apb-search">⌕ 搜索附近好去处</div>
      ${venues.map((name, index) => `<article class="apb-venue"><span>${index === 0 ? '☕' : index === 1 ? '🎬' : '📚'}</span><div><strong>${name}</strong><small>★★★★${index === 1 ? '☆' : '★'} · 距离 ${(index + 1) * 0.8}km</small></div></article>`).join('')}
      <form class="apb-stack-form" data-apb-review><select name="venue">${venues.map(name => `<option>${name}</option>`).join('')}</select><textarea name="content" maxlength="500" placeholder="写下你的评价" required></textarea><button>发布评价</button></form>
      ${runtime.phone.reviews.slice(-8).reverse().map(row => `<div class="apb-review"><strong>${escapeHtml(row.venue)}</strong><p>${escapeHtml(row.content)}</p></div>`).join('')}
    </main>`;
  }

  function musicScreen() {
    return `${appHeader('网易云音乐', true)}<main class="apb-app-body apb-music">
      <div class="apb-music-hero"><div class="apb-record ${runtime.phone.music.playing ? 'is-playing' : ''}">♪</div><strong>${escapeHtml(runtime.phone.music.playing?.title || '选择一首歌')}</strong><span>${escapeHtml(runtime.phone.music.playing?.artist || '你的剧情歌单')}</span></div>
      ${runtime.phone.music.playlist.map(song => `<button class="apb-song ${runtime.phone.music.playing?.id === song.id ? 'active' : ''}" data-apb-song="${song.id}"><span>♪</span><span><strong>${escapeHtml(song.title)}</strong><small>${escapeHtml(song.artist)}</small></span><time>${song.duration}</time></button>`).join('')}
    </main>`;
  }

  function apiSettingsSection(slot, title, description) {
    const config = runtime.apiConfig?.[slot] || {};
    const models = Array.isArray(runtime.modelOptions?.[slot]) ? runtime.modelOptions[slot] : [];
    const options = models.map(model => `<option value="${escapeHtml(model)}"></option>`).join('');
    const hint = models.length ? `已拉取 ${models.length} 个模型，可输入关键词筛选` : '可手动填写，或从当前 API 拉取模型';
    return `<section class="apb-api-section" data-api-slot="${slot}">
      <header><span>${slot === 'send' ? '对话' : '校准'}</span><div><strong>${title}</strong><small>${description}</small></div><i class="apb-api-dot"></i></header>
      <label>API 地址<input name="${slot}BaseUrl" value="${escapeHtml(config.baseUrl || '')}" placeholder="https://example.com/v1" ${slot === 'send' ? 'required' : ''}></label>
      <label>API Key<input name="${slot}ApiKey" type="password" placeholder="${config.hasApiKey ? '已保存，留空保持不变' : 'sk-...'}"></label>
      <label>模型<div class="apb-model-picker"><input name="${slot}Model" list="apb-${slot}-model-options" value="${escapeHtml(config.model || '')}" placeholder="模型名称" autocomplete="off" ${slot === 'send' ? 'required' : ''}><button type="button" data-apb-fetch-models="${slot}">拉取模型</button></div><datalist id="apb-${slot}-model-options">${options}</datalist><small class="apb-field-note">${slot === 'update' ? `整组留空时共用发送 API；${hint}` : hint}</small></label>
      <div class="apb-form-row"><label>温度<input name="${slot}Temperature" type="number" min="0" max="2" step="0.1" value="${Number(config.temperature ?? 0.7)}"></label><label>最大输出<input name="${slot}MaxTokens" type="number" min="128" max="16000" value="${Number(config.maxTokens ?? 1200)}"></label></div>
      <button type="button" class="apb-api-test" data-apb-test-api="${slot}">测试${title}</button>
    </section>`;
  }

  function updateHealthLabel() {
    const health = runtime.updateHealth || runtime.apiConfig?.health;
    if (!health?.updateConfigured) return '更新 API 未配置，将共用发送 API';
    if (health.mode === 'fallback') return `更新 API 暂不可用，正在使用发送 API 备用`;
    if (health.mode === 'checking') return '准备检测更新 API，恢复后自动切回';
    return '更新 API 正常';
  }

  function settingsScreen() {
    const preferences = getRootSettings().preferences;
    return `${appHeader('设置', true)}<main class="apb-app-body apb-settings-body">
      <div class="apb-settings-head"><span>双 API 自动接管</span><strong>发送与实时更新</strong><small>密钥只保存在 SillyTavern 服务端；更新失败会自动使用发送 API</small></div>
      <form class="apb-api-form" data-apb-api>
        ${apiSettingsSection('send', '发送 API', '微信、群聊、朋友圈和应用交互')}
        ${apiSettingsSection('update', '实时更新 API', '正文完成后同步订单、联系人与幕后状态')}
        <section class="apb-sync-options">
          <label>恢复检测间隔<input name="updateFallbackSeconds" type="number" min="15" max="900" value="${Number(runtime.apiConfig?.updateFallbackSeconds ?? 60)}"><small>秒</small></label>
          <label class="apb-switch-row"><span><strong>NPC 自主消息</strong><small>按剧情楼层生成低影响后台消息</small></span><input name="autonomyEnabled" type="checkbox" ${preferences.autonomyEnabled !== false ? 'checked' : ''}></label>
          <label>自主消息间隔<input name="autonomyEveryTurns" type="number" min="1" max="20" value="${Number(preferences.autonomyEveryTurns || 3)}"><small>层</small></label>
          <label class="apb-switch-row"><span><strong>幕后状态栏</strong><small>显示 Anima 的七项剧情状态</small></span><input name="backstageVisible" type="checkbox" ${preferences.backstageVisible !== false ? 'checked' : ''}></label>
          <label class="apb-switch-row"><span><strong>自动适配新角色卡</strong><small>保留原提示词，只追加一次手机与幕后状态规则</small></span><input name="autoAnimaAdapt" type="checkbox" ${preferences.autoAnimaAdapt !== false ? 'checked' : ''}></label>
          <div class="apb-adapt-row"><span><strong>Anima 角色卡适配</strong><small>${escapeHtml(runtime.animaAdaptStatus)}</small></span><button type="button" data-apb-adapt-card ${runtime.animaAdapting ? 'disabled' : ''}>${runtime.animaAdapting ? '适配中…' : '立即适配'}</button></div>
        </section>
        <button class="apb-save-wide" type="submit">保存全部设置</button>
      </form>
      <div class="apb-bridge-card"><span class="apb-bridge-dot"></span><div><strong>${escapeHtml(updateHealthLabel())}</strong><small>${escapeHtml(runtime.bridgeStatus)}</small></div><button data-apb-sync>立即同步</button></div>
    </main>`;
  }

  function renderScreen() {
    const app = runtime.route.app;
    if (app === 'home') return homeScreen();
    if (app === 'wechat') return wechatScreen();
    if (app === 'moments') return momentsScreen();
    if (app === 'wallet') return walletScreen();
    if (app === 'eleme' || app === 'meituan') return deliveryScreen(app);
    if (app === 'dianping') return dianpingScreen();
    if (app === 'music') return musicScreen();
    if (app === 'settings') return settingsScreen();
    return homeScreen();
  }

  function render() {
    const overlay = document.getElementById('apb-overlay');
    if (!overlay) return;
    overlay.classList.toggle('is-open', runtime.open);
    overlay.setAttribute('aria-hidden', runtime.open ? 'false' : 'true');
    const screen = overlay.querySelector('.apb-screen');
    if (screen) screen.innerHTML = renderScreen();
    requestAnimationFrame(() => {
      const chat = document.getElementById('apb-chat-scroll');
      if (chat) chat.scrollTop = chat.scrollHeight;
    });
  }

  const BACKSTAGE_SECTIONS = [
    ['present', '现场人物', row => `${row.name || '未知'}${row.action ? ` · ${row.action}` : ''}${row.mood ? ` · ${row.mood}` : ''}`],
    ['clothing', '衣着状态', row => `${row.name || '未知'}${row.outfit ? ` · ${row.outfit}` : ''}`],
    ['promises', '约定与待办', row => `${row.person || '相关人物'}${row.subject ? ` · ${row.subject}` : ''}${row.time ? ` · ${row.time}` : ''}${row.place ? ` · ${row.place}` : ''}${row.status ? ` · ${row.status}` : ''}`],
    ['secrets', '秘密与伏笔', row => `${row.content || '未记录'}${Array.isArray(row.knownBy) && row.knownBy.length ? ` · 知情：${row.knownBy.join('、')}` : ''}`],
    ['offscreen', '幕后人物', row => `${row.name || '未知'}${row.location ? ` · ${row.location}` : ''}${row.activity ? ` · ${row.activity}` : ''}${row.goal ? ` · 目标：${row.goal}` : ''}`],
    ['world', '世界事件', row => `${row.title || '事件'}${row.detail ? ` · ${row.detail}` : ''}`],
  ];

  function backstageSummary(backstage) {
    const timeline = backstage.timeline || {};
    const when = [timeline.date, timeline.time].filter(Boolean).join(' ');
    const where = timeline.location || '地点待更新';
    return [when || '时间待更新', where].join(' · ');
  }

  function backstageRows(rows, formatter) {
    if (!Array.isArray(rows) || !rows.length) return '<p class="apb-backstage-empty">暂无明确记录</p>';
    return `<ul>${rows.slice(-10).map(row => `<li>${escapeHtml(formatter(row))}</li>`).join('')}</ul>`;
  }

  function renderBackstage() {
    const pill = document.getElementById('apb-backstage-pill');
    const overlay = document.getElementById('apb-backstage-overlay');
    if (!pill || !overlay || !runtime.phone) return;
    const preferences = getRootSettings().preferences;
    const backstage = normalizeBackstageState(runtime.phone.backstage);
    pill.hidden = preferences.backstageVisible === false;
    pill.innerHTML = `<span class="apb-backstage-live"></span><span><strong>${escapeHtml(backstageSummary(backstage))}</strong><small>${backstage.present.length ? `${backstage.present.length} 人在场` : '幕后状态'}</small></span>`;
    overlay.classList.toggle('is-open', runtime.backstageOpen && preferences.backstageVisible !== false);
    overlay.setAttribute('aria-hidden', runtime.backstageOpen ? 'false' : 'true');
    const timeline = backstage.timeline || {};
    const content = overlay.querySelector('.apb-backstage-content');
    if (!content) return;
    content.innerHTML = `
      <header class="apb-backstage-header"><div><span>ANIMA SCENE</span><strong>幕后状态</strong></div><button type="button" data-apb-backstage-close aria-label="关闭幕后状态">×</button></header>
      <section class="apb-backstage-timeline"><div><small>时间</small><strong>${escapeHtml([timeline.date, timeline.time].filter(Boolean).join(' ') || '待正文更新')}</strong></div><div><small>地点</small><strong>${escapeHtml(timeline.location || '待正文更新')}</strong></div>${timeline.weather ? `<div><small>环境</small><strong>${escapeHtml(timeline.weather)}</strong></div>` : ''}</section>
      <div class="apb-backstage-grid">${BACKSTAGE_SECTIONS.map(([key, title, formatter], index) => `<section class="apb-backstage-section"><header><span>${String(index + 2).padStart(2, '0')}</span><strong>${title}</strong></header>${backstageRows(backstage[key], formatter)}</section>`).join('')}</div>
      <footer>${backstage.sourceFloor === null ? '等待首次正文校准' : `来自正文 #${escapeHtml(backstage.sourceFloor)}`} · ${escapeHtml(runtime.phone.sync?.lastStatus || '等待同步')}</footer>`;
  }

  function applyLauncherPosition() {
    const launcher = document.getElementById('apb-launcher');
    if (!launcher) return;
    const saved = getRootSettings().ui.launcher || {};
    const width = launcher.offsetWidth || 48;
    const height = launcher.offsetHeight || 48;
    const margin = 12;
    const maxX = Math.max(margin, innerWidth - width - margin);
    const maxY = Math.max(margin, innerHeight - height - margin);
    const side = saved.side === 'left' ? 'left' : 'right';
    const x = side === 'left' ? margin : maxX;
    const fallbackY = Math.max(margin, maxY - 74);
    const y = Number.isFinite(Number(saved.y)) ? margin + Number(saved.y) * Math.max(1, maxY - margin) : fallbackY;
    launcher.style.left = `${Math.min(maxX, Math.max(margin, x))}px`;
    launcher.style.top = `${Math.min(maxY, Math.max(margin, y))}px`;
  }

  function saveLauncherPosition(x, y) {
    const launcher = document.getElementById('apb-launcher');
    if (!launcher) return;
    const margin = 12;
    const maxX = Math.max(margin, innerWidth - launcher.offsetWidth - margin);
    const maxY = Math.max(margin, innerHeight - launcher.offsetHeight - margin);
    const side = x + launcher.offsetWidth / 2 < innerWidth / 2 ? 'left' : 'right';
    const snappedX = side === 'left' ? margin : maxX;
    const clampedY = Math.min(maxY, Math.max(margin, y));
    getRootSettings().ui.launcher = {
      side,
      y: (clampedY - margin) / Math.max(1, maxY - margin),
    };
    context()?.saveSettingsDebounced?.();
    launcher.style.left = `${snappedX}px`;
    launcher.style.top = `${clampedY}px`;
  }

  function bindLauncherDrag(launcher) {
    let drag = null;
    launcher.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      const rect = launcher.getBoundingClientRect();
      drag = { pointerId: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top, startX: event.clientX, startY: event.clientY, moved: false };
      launcher.setPointerCapture?.(event.pointerId);
      launcher.classList.add('is-dragging');
    });
    launcher.addEventListener('pointermove', event => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (distance > 6) drag.moved = true;
      if (!drag.moved) return;
      const x = Math.min(innerWidth - launcher.offsetWidth - 8, Math.max(8, event.clientX - drag.dx));
      const y = Math.min(innerHeight - launcher.offsetHeight - 8, Math.max(8, event.clientY - drag.dy));
      launcher.style.left = `${x}px`;
      launcher.style.top = `${y}px`;
    });
    const finish = event => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (drag.moved) {
        runtime.suppressLauncherClick = true;
        const rect = launcher.getBoundingClientRect();
        saveLauncherPosition(rect.left, rect.top);
      }
      launcher.classList.remove('is-dragging');
      launcher.releasePointerCapture?.(event.pointerId);
      drag = null;
    };
    launcher.addEventListener('pointerup', finish);
    launcher.addEventListener('pointercancel', finish);
  }

  function applyBackstagePosition() {
    const pill = document.getElementById('apb-backstage-pill');
    if (!pill || pill.hidden) return;
    const saved = getRootSettings().ui.backstage || {};
    const margin = 8;
    const width = pill.offsetWidth || Math.min(430, Math.max(220, innerWidth - 84));
    const height = pill.offsetHeight || 42;
    const maxX = Math.max(margin, innerWidth - width - margin);
    const maxY = Math.max(margin, innerHeight - height - margin);
    const defaultX = Math.max(margin, (innerWidth - width) / 2);
    const x = Number.isFinite(Number(saved.x)) ? margin + Number(saved.x) * Math.max(1, maxX - margin) : defaultX;
    const y = Number.isFinite(Number(saved.y)) ? margin + Number(saved.y) * Math.max(1, maxY - margin) : margin;
    pill.style.left = `${Math.min(maxX, Math.max(margin, x))}px`;
    pill.style.top = `${Math.min(maxY, Math.max(margin, y))}px`;
    pill.style.transform = 'none';
  }

  function saveBackstagePosition(x, y) {
    const pill = document.getElementById('apb-backstage-pill');
    if (!pill) return;
    const margin = 8;
    const maxX = Math.max(margin, innerWidth - pill.offsetWidth - margin);
    const maxY = Math.max(margin, innerHeight - pill.offsetHeight - margin);
    const clampedX = Math.min(maxX, Math.max(margin, x));
    const clampedY = Math.min(maxY, Math.max(margin, y));
    getRootSettings().ui.backstage = {
      x: (clampedX - margin) / Math.max(1, maxX - margin),
      y: (clampedY - margin) / Math.max(1, maxY - margin),
    };
    context()?.saveSettingsDebounced?.();
    pill.style.left = `${clampedX}px`;
    pill.style.top = `${clampedY}px`;
  }

  function bindBackstageDrag(pill) {
    let drag = null;
    pill.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      const rect = pill.getBoundingClientRect();
      drag = { pointerId: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top, startX: event.clientX, startY: event.clientY, moved: false };
      pill.setPointerCapture?.(event.pointerId);
      pill.classList.add('is-dragging');
    });
    pill.addEventListener('pointermove', event => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 6) drag.moved = true;
      if (!drag.moved) return;
      const x = Math.min(innerWidth - pill.offsetWidth - 8, Math.max(8, event.clientX - drag.dx));
      const y = Math.min(innerHeight - pill.offsetHeight - 8, Math.max(8, event.clientY - drag.dy));
      pill.style.left = `${x}px`;
      pill.style.top = `${y}px`;
    });
    const finish = event => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (drag.moved) {
        runtime.suppressBackstageClick = true;
        const rect = pill.getBoundingClientRect();
        saveBackstagePosition(rect.left, rect.top);
      }
      pill.classList.remove('is-dragging');
      pill.releasePointerCapture?.(event.pointerId);
      drag = null;
    };
    pill.addEventListener('pointerup', finish);
    pill.addEventListener('pointercancel', finish);
  }

  function openApp(app) {
    runtime.route = { app, view: 'root', id: '' };
    if (app === 'settings') loadApiConfig();
    render();
  }

  async function loadApiConfig() {
    try {
      const data = await serverRequest('/config');
      runtime.apiConfig = data.config;
      runtime.updateHealth = data.config?.health || null;
    } catch (error) {
      runtime.apiConfig = {};
      runtime.bridgeStatus = error.message;
    }
    render();
  }

  function formData(form) {
    return Object.fromEntries(new FormData(form).entries());
  }

  function apiFormPayload(form) {
    const value = name => String(form.elements?.[name]?.value || '').trim();
    const endpoint = slot => ({
      baseUrl: value(`${slot}BaseUrl`),
      apiKey: value(`${slot}ApiKey`),
      model: value(`${slot}Model`),
      temperature: Number(value(`${slot}Temperature`) || 0.7),
      maxTokens: Number(value(`${slot}MaxTokens`) || 1200),
    });
    return {
      send: endpoint('send'),
      update: endpoint('update'),
      updateFallbackSeconds: Number(value('updateFallbackSeconds') || 60),
    };
  }

  function savePreferenceForm(form) {
    const settings = getRootSettings();
    settings.preferences.autonomyEnabled = Boolean(form.elements?.autonomyEnabled?.checked);
    settings.preferences.autonomyEveryTurns = Math.max(1, Math.min(20, Number(form.elements?.autonomyEveryTurns?.value) || 3));
    settings.preferences.backstageVisible = Boolean(form.elements?.backstageVisible?.checked);
    settings.preferences.autoAnimaAdapt = Boolean(form.elements?.autoAnimaAdapt?.checked);
    context()?.saveSettingsDebounced?.();
  }

  async function onSubmit(event) {
    const form = event.target.closest('form');
    if (!form) return;
    event.preventDefault();
    try {
      if (form.dataset.apbSend) {
        if (runtime.busy) return;
        const data = formData(form);
        const value = String(data.message || '').trim();
        if (!value) return;
        const channel = form.dataset.apbSend === 'group' ? 'group' : 'private';
        const targetId = form.dataset.target;
        runtime.phone = appendMessage(runtime.phone, channel, targetId, { sender: context()?.name1 || '我', direction: 'out', text: value });
        savePhone();
        await bridgeToAnima('user_phone_message');
        runtime.busy = true;
        render();
        try { await generatePhoneReply(channel, targetId); }
        finally { runtime.busy = false; render(); }
        return;
      }
      if (form.hasAttribute('data-apb-moment')) {
        const content = String(formData(form).content || '').trim();
        if (!content) return;
        const row = { id: makeId('moment'), author: context()?.name1 || '我', content, comments: [], time: Date.now() };
        runtime.phone.moments.push(row);
        addEvent(runtime.phone, { type: 'moment', actor: row.author, target: '朋友圈', summary: `发布朋友圈：${content}`, sourceId: row.id });
        savePhone(); await bridgeToAnima('moment'); render(); return;
      }
      if (form.hasAttribute('data-apb-payment')) {
        const data = formData(form);
        const amount = Number(data.amount);
        const account = data.kind === '支付宝付款' ? 'alipay' : 'wechat';
        runtime.phone = recordTransaction(runtime.phone, { account, amount: -amount, kind: data.kind, counterparty: data.counterparty, note: data.note });
        const channel = data.kind === '群红包' ? 'group' : 'private';
        const targetId = channel === 'group' ? 'story' : 'main';
        runtime.phone = appendMessage(runtime.phone, channel, targetId, { sender: context()?.name1 || '我', direction: 'out', text: `[${data.kind}] ${money(amount)}${data.note ? ` · ${data.note}` : ''}` });
        savePhone(); await bridgeToAnima('payment'); toast('支付事件已写入手机并同步 Anima', 'success'); render(); return;
      }
      if (form.hasAttribute('data-apb-income')) {
        const data = formData(form);
        runtime.phone = recordTransaction(runtime.phone, { account: 'bank', amount: Number(data.amount), kind: '银行入账', counterparty: data.source, note: `${data.source}到账` });
        savePhone(); await bridgeToAnima('income'); toast('银行入账已同步', 'success'); render(); return;
      }
      if (form.hasAttribute('data-apb-review')) {
        const data = formData(form);
        const row = { id: makeId('review'), venue: String(data.venue), content: String(data.content), time: Date.now() };
        runtime.phone.reviews.push(row);
        addEvent(runtime.phone, { type: 'review', actor: context()?.name1 || '我', target: row.venue, summary: `在大众点评评价${row.venue}：${row.content}`, sourceId: row.id });
        savePhone(); await bridgeToAnima('review'); render(); return;
      }
      if (form.hasAttribute('data-apb-api')) {
        const data = apiFormPayload(form);
        savePreferenceForm(form);
        const response = await serverRequest('/config', { method: 'POST', body: JSON.stringify(data) });
        runtime.apiConfig = response.config;
        runtime.updateHealth = response.config?.health || null;
        toast('手机 API 设置已保存', 'success'); render();
        renderBackstage();
        if (getRootSettings().preferences.autoAnimaAdapt !== false) scheduleAnimaCardAdaptation(50);
      }
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  async function onClick(event) {
    const target = event.target.closest('button,[data-apb-open],[data-apb-chat],[data-apb-group]');
    if (!target) return;
    try {
      if (target.hasAttribute('data-apb-close')) { runtime.open = false; render(); return; }
      if (target.dataset.apbOpen) { openApp(target.dataset.apbOpen); return; }
      if (target.dataset.apbBack) {
        if (target.dataset.apbBack === 'app') runtime.route = { app: 'wechat', view: 'root', id: '' };
        else runtime.route = { app: 'home', view: 'root', id: '' };
        render(); return;
      }
      if (target.dataset.apbChat) { runtime.route = { app: 'wechat', view: 'chat', id: target.dataset.apbChat }; render(); return; }
      if (target.dataset.apbGroup) { runtime.route = { app: 'wechat', view: 'group', id: target.dataset.apbGroup }; render(); return; }
      if (target.dataset.apbOrder) {
        runtime.phone = placeOrder(runtime.phone, target.dataset.apbOrder, target.dataset.item, 'wechat');
        const orderId = runtime.phone.delivery.orders.at(-1)?.id;
        savePhone(); await bridgeToAnima('delivery_order'); toast('下单成功，订单已同步到剧情', 'success'); render();
        runtime.busy = true;
        try { await generateDeliveryUpdate(orderId); }
        catch (error) { toast(`订单已保存；商家回应暂不可用：${error.message}`, 'warning'); }
        finally { runtime.busy = false; render(); }
        return;
      }
      if (target.dataset.apbReactMoment) {
        if (runtime.busy) return;
        runtime.busy = true; target.disabled = true; target.textContent = '等待回应…';
        try { await generateMomentReactions(target.dataset.apbReactMoment); }
        finally { runtime.busy = false; render(); }
        return;
      }
      if (target.dataset.apbSong) {
        const song = runtime.phone.music.playlist.find(row => row.id === target.dataset.apbSong);
        runtime.phone.music.playing = runtime.phone.music.playing?.id === song?.id ? null : song;
        addEvent(runtime.phone, { type: 'music', actor: context()?.name1 || '我', target: '网易云音乐', summary: runtime.phone.music.playing ? `正在播放《${song.title}》` : '停止播放音乐' });
        savePhone(); await bridgeToAnima('music'); render(); return;
      }
      if (target.hasAttribute('data-apb-sync')) {
        savePhone();
        const synced = await reconcileNarrative('manual');
        if (!synced) await bridgeToAnima('manual');
        toast(runtime.bridgeStatus, synced ? 'success' : 'info');
        return;
      }
      if (target.hasAttribute('data-apb-adapt-card')) {
        await ensureAnimaCardAdaptation({ manual: true });
        return;
      }
      if (target.hasAttribute('data-apb-fetch-models')) {
        const form = target.closest('form[data-apb-api]');
        if (!form) return;
        const slot = target.dataset.apbFetchModels === 'update' ? 'update' : 'send';
        target.disabled = true; target.textContent = '拉取中…';
        try {
          savePreferenceForm(form);
          const saved = await serverRequest('/config', { method: 'POST', body: JSON.stringify(apiFormPayload(form)) });
          const response = await serverRequest('/models', { method: 'POST', body: JSON.stringify({ slot }) });
          runtime.apiConfig = saved.config;
          runtime.updateHealth = saved.config?.health || null;
          runtime.modelOptions[slot] = Array.isArray(response.models) ? response.models : [];
          toast(`${slot === 'update' ? '实时更新' : '发送'} API 已拉取 ${runtime.modelOptions[slot].length} 个模型`, 'success');
        } finally {
          target.disabled = false; target.textContent = '拉取模型';
        }
        render(); return;
      }
      if (target.hasAttribute('data-apb-test-api')) {
        const form = target.closest('form[data-apb-api]');
        if (!form) return;
        const slot = target.dataset.apbTestApi === 'update' ? 'update' : 'send';
        target.disabled = true; target.textContent = '测试中…';
        try {
          savePreferenceForm(form);
          const saved = await serverRequest('/config', { method: 'POST', body: JSON.stringify(apiFormPayload(form)) });
          runtime.apiConfig = saved.config;
          runtime.updateHealth = saved.config?.health || null;
          await serverRequest('/test', { method: 'POST', body: JSON.stringify({ slot }) });
          toast(`${slot === 'update' ? '实时更新' : '发送'} API 连接成功`, 'success');
        }
        finally { target.disabled = false; target.textContent = '测试连接'; }
      }
    } catch (error) { toast(error.message, 'error'); render(); }
  }

  function mount() {
    if (document.getElementById('apb-overlay')) return;
    document.body.insertAdjacentHTML('beforeend', `
      <button id="apb-launcher" type="button" title="打开 Anima 小手机" aria-label="打开 Anima 小手机">📱</button>
      <button id="apb-backstage-pill" type="button" title="查看幕后状态" aria-label="查看幕后状态"></button>
      <div id="apb-backstage-overlay" class="apb-backstage-overlay" aria-hidden="true">
        <button class="apb-backstage-backdrop" type="button" data-apb-backstage-close aria-label="关闭幕后状态"></button>
        <aside class="apb-backstage-drawer" role="dialog" aria-label="Anima 幕后状态"><div class="apb-backstage-content"></div></aside>
      </div>
      <div id="apb-overlay" class="apb-overlay" aria-hidden="true">
        <button class="apb-backdrop" data-apb-close aria-label="关闭小手机"></button>
        <section class="apb-phone" role="dialog" aria-label="Anima 小手机">
          <div class="apb-status-bar"><time id="apb-system-time">00:00</time><span class="apb-island"></span><span>●●● ᴡɪꜰɪ ▰</span></div>
          <div class="apb-screen"></div>
          <div class="apb-home-indicator"></div>
        </section>
      </div>`);
    const launcher = document.getElementById('apb-launcher');
    const overlay = document.getElementById('apb-overlay');
    const backstagePill = document.getElementById('apb-backstage-pill');
    const backstageOverlay = document.getElementById('apb-backstage-overlay');
    bindLauncherDrag(launcher);
    bindBackstageDrag(backstagePill);
    applyLauncherPosition();
    applyBackstagePosition();
    launcher.addEventListener('click', () => {
      if (runtime.suppressLauncherClick) { runtime.suppressLauncherClick = false; return; }
      runtime.open = true;
      runtime.route = { app: 'home', view: 'root', id: '' };
      loadPhone(); render(); renderBackstage();
      syncContactRoster().then(() => render()).catch(() => {});
      scheduleReconcile('phone_open', 250);
    });
    backstagePill.addEventListener('click', () => {
      if (runtime.suppressBackstageClick) { runtime.suppressBackstageClick = false; return; }
      runtime.backstageOpen = true;
      renderBackstage();
    });
    backstageOverlay.addEventListener('click', event => {
      if (event.target.closest('[data-apb-backstage-close]')) { runtime.backstageOpen = false; renderBackstage(); }
    });
    overlay.addEventListener('click', onClick);
    overlay.addEventListener('submit', onSubmit);
    setInterval(() => {
      const clock = document.getElementById('apb-system-time');
      if (clock) clock.textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    }, 1000);
    addEventListener('resize', () => { applyLauncherPosition(); applyBackstagePosition(); });
    render(); renderBackstage();
  }

  function bindEvents() {
    const source = context()?.eventSource;
    if (!source?.on) return;
    source.on('CHAT_CHANGED', () => {
      runtime.phone = null;
      loadPhone();
      runtime.route = { app: 'home', view: 'root', id: '' };
      applyLauncherPosition();
      applyBackstagePosition();
      render(); renderBackstage();
      syncContactRoster().then(() => { render(); renderBackstage(); }).catch(() => {});
      scheduleReconcile('chat_changed', 700);
      scheduleAnimaCardAdaptation(1100);
    });
    source.on('CHARACTER_MESSAGE_RENDERED', () => {
      if (!runtime.phone) loadPhone();
      scheduleReconcile('assistant_message', 900);
      scheduleAnimaCardAdaptation(1200);
    });
  }

  function init() {
    loadPhone();
    mount();
    bindEvents();
    bridgeToAnima('startup');
    syncContactRoster().then(() => { render(); renderBackstage(); }).catch(() => {});
    scheduleAnimaCardAdaptation(1100);
    console.info('[Anima Phone Bridge] v0.3.3 ready');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
