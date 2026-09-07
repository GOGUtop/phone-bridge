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
import { ensureWorld, extractPeople, mergePeople, validPerson, applyWorldDelta, worldPrompt, worldSnapshot, logWorld, hash } from './world.mjs';
import { createWorldUI, EXTRA_APPS, EXTRA_ICONS } from './world-ui.mjs';
import {createAppExperience} from './app-experience.mjs';
import {validateScene,mergeScene} from './scene.mjs';
import { animaModule, syncMemory, recallMemory, memoryRecords, localRecall, formatMemory, peerRecall } from './memory.mjs';
import {rosterPrompt,verifiedRoster,applyRoster} from './roster.mjs';

(() => {
  'use strict';

  const MODULE = 'anima_phone_bridge';
  const SERVER_BASE = '/api/plugins/anima-phone-bridge-server';
  const APP_NAMES = {
    ...EXTRA_APPS,
    wechat: '微信',
    moments: '朋友圈',
    wallet: '微信支付',
    eleme: '饿了么',
    meituan: '美团外卖',
    dianping: '大众点评',
    music: '网易云音乐',
    settings: '设置',
  };
  const APP_ICONS = {
    ...Object.fromEntries(Object.entries(EXTRA_ICONS).map(([key,icon])=>[key,`<i class="fa-solid fa-${icon}"></i>`])),
    ...Object.fromEntries(Object.entries({wechat:'comment',moments:'compass',wallet:'wallet',eleme:'utensils',meituan:'motorcycle',dianping:'location-dot',music:'music',settings:'gear'}).map(([key,icon])=>[key,`<i class="fa-solid fa-${icon}"></i>`])),
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
    memoryRunning: false,
    rosterCache: null,
    reconcilePending: false,
    backlogSkipped: '',
    backstageTab: 'promises',
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
      autonomyEveryTurns: 1,
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
    const stored = context()?.chatMetadata?.anima_phone_bridge || settings.chats[key];
    let phone = ensureWorld(normalizePhoneState(stored, characterName()));
    const main = phone.contacts.main;
    if (main && (!settings.chats[key] || main.name === '联系人')) {
      main.name = characterName();
      phone.threads.main.name = characterName();
      phone.groups.story.members = [...new Set([...(phone.groups.story.members || []), characterName()])];
    }
    const animaData = latestAnimaData();
    phone = applyAnimaDigest(phone, animaData?.手机);
    if (animaData?.幕后状态 && Number(animaData.幕后状态.updatedAt || 0) >= Number(phone.backstage?.updatedAt || 0)) {
      try {phone.backstage=mergeScene(phone.backstage,validateScene({backstage:animaData.幕后状态}),animaData.幕后状态.sourceFloor??latestAssistantMessageId());}catch{/* Incomplete Anima output must not erase the last valid scene. */}
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
    const phone = ensureWorld(normalizePhoneState(runtime.phone || defaultPhoneState(characterName()), characterName()));
    phone.updatedAt = Date.now();
    runtime.phone = phone;
    getRootSettings().chats[chatKey()] = phone;
    if (context()?.chatMetadata) context().chatMetadata.anima_phone_bridge = phone;
    context()?.saveMetadataDebounced?.();
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
      if (!isUser && !row?.is_system && row?.role!=='system') {
        return {
          id: row?.message_id ?? row?.mesid ?? index,
          text: narrativeText(row?.message ?? row?.mes ?? row?.content ?? ''),
          name: String(row?.name || context()?.name2 || '角色'),
        };
      }
    }
    return null;
  }

  function narrativeText(value) {
    const source=String(value||'').replace(/<(VVV_ECOT|thinking|think|analysis|reasoning)\b[^>]*>[\s\S]*?<\/\1>/gi,'').replace(/\{\{ANIMA_STATUS::\d+\}\}/g,'');
    const main=source.match(/<content\b[^>]*>([\s\S]*?)<\/content>/i);
    return main ? `${source.match(/<time\b[^>]*>[\s\S]*?<\/time>/i)?.[0]||''}\n${main[1]}` : source;
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
    const scope = runtime.currentChatKey;
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
        if (runtime.currentChatKey !== scope) return current;
        current.anima_data = { ...animaData, 手机: digest, 幕后状态: { ...normalizeBackstageState(runtime.phone.backstage), 扩展记录: worldSnapshot(runtime.phone, context()?.name1) } };
        current.apb_floor_record = { signature: runtime.phone.sync.lastNarrativeSignature, backstage: runtime.phone.backstage, journal: ensureWorld(runtime.phone).world.journal.filter(r=>r.floor===messageId) };
        return current;
      }, { type: 'message', message_id: messageId });
      if(runtime.currentChatKey!==scope)return false;
      const ctx = context();
      ctx?.eventSource?.emit?.('ANIMA_VARIABLE_UPDATE_ENDED', {
        type: 'phone_bridge', messageId, newData: { 手机: digest, 幕后状态: runtime.phone.backstage }, reason, timestamp: Date.now(),
      });
      await tavern.setChatMessages?.([{ message_id: messageId }]);
      if (runtime.currentChatKey !== scope) return false;
      await context()?.saveMetadata?.();
      try { const m = await animaModule('status_logic'); if (runtime.currentChatKey === scope) await m.syncStatusToWorldBook(null, true); } catch (e) { console.warn('[Anima Phone] status worldbook sync',e.message); }
      refreshMemoryContext();
      scheduleMemoryWrite();
      runtime.bridgeStatus = `已同步到正文 #${messageId}`;
      render();
      return true;
    } catch (error) {
      runtime.bridgeStatus = `同步失败：${error.message}`;
      render();
      return false;
    }
  }

  function refreshMemoryContext() {
    if (!runtime.phone) return;
    const query = chatMessages().slice(-3).map(r=>r.message||r.mes||r.content||'').join('\n');
    const content = localRecall(memoryRecords(runtime.phone,context()?.name1),query).map(formatMemory).join('\n\n');
    const promises = Object.values(runtime.phone.commitments).filter(r=>r.status==='未完成');
    context()?.setExtensionPrompt?.('apb_world_memory', `以下为同一故事世界的已发生事实，必须遵守各条知情者范围。私人日记/心声不是其他角色已知信息。\n${content}\n尚未完成约定：${JSON.stringify(promises)}\n纪念日：${JSON.stringify(ensureWorld(runtime.phone).world.anniversaries)}`, 1, 1, false, 0);
  }

  function scheduleMemoryWrite() {
    if (runtime.memoryRunning) {runtime.memoryPending=true;return;}
    if (!runtime.phone) return;
    const scope = runtime.currentChatKey;
    const snapshot = runtime.phone;
    runtime.memoryRunning = true;
    syncMemory(snapshot,scope,context()?.name1,()=>runtime.currentChatKey===scope,()=>{
      if(runtime.currentChatKey===scope){ensureWorld(runtime.phone).world.memory=snapshot.world.memory;savePhone();}
    }).finally(()=>{runtime.memoryRunning=false;if(runtime.memoryPending){runtime.memoryPending=false;scheduleMemoryWrite();}});
  }

  async function prepareMemory() {
    if(!runtime.phone)return;
    const scope=runtime.currentChatKey;
    const query=chatMessages().slice(-3).map(r=>r.message||r.mes||r.content||'').join('\n');
    const content=await recallMemory(runtime.phone,scope,context()?.name1,query);
    if(runtime.currentChatKey!==scope)return;
    refreshMemoryContext();
    context()?.setExtensionPrompt?.('apb_archive_recall', `手机与幕后历史召回；作者知道不代表角色知道。\n${content}`,1,2,false,0);
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
    const scope = runtime.currentChatKey;
    try {
      const names = new Set(name ? [name] : []);
      const binding = await helper()?.getCharWorldbookNames?.('current');
      if(binding?.primary)names.add(binding.primary);
      for(const book of binding?.additional || [])names.add(book);
      const chatBook = await helper()?.getChatWorldbookName?.('current');
      if(chatBook)names.add(chatBook);
      const card=currentCharacter();
      const entries = [{name:characterName(),content:[card.description||card.data?.description,card.personality||card.data?.personality,card.scenario||card.data?.scenario].filter(Boolean).join('\n')},...(card.data?.character_book?.entries||[])];
      for(const book of await helper()?.getGlobalWorldbookNames?.()||[])names.add(book);
      for(const book of names){
        const rows = helper()?.getWorldbook ? await helper().getWorldbook(book) : worldbookRows(await tavernRequest('/api/worldinfo/get',{method:'POST',body:JSON.stringify({name:book})}));
        entries.push(...rows.filter(r=>r.enabled!==false&&!r.disable&&!/anima_status|apb_/i.test(r.name||r.comment||'')));
      }
      entries.push({name:'已发生聊天正文',content:chatMessages().filter(r=>!r.is_system).map(r=>narrativeText(r.message||r.mes||r.content||'')).join('\n\n')});
      const excerpt = entries.map(r=>`[${r.name||r.comment||'条目'}]\n${r.content||''}`).join('\n\n');
      const fingerprint = hash(excerpt);
      if(runtime.rosterCache?.scope===scope&&runtime.rosterCache.fingerprint===fingerprint)return runtime.rosterCache.result;
      const result={name:[...names].join('、'),contacts:extractPeople(entries,context()?.name1).map(p=>({...p,known:true})),excerpt};
      if(runtime.currentChatKey===scope)runtime.rosterCache={scope,fingerprint,result};
      return result;
    } catch (error) {
      console.warn('[Anima Phone] worldbook read failed', error);
      return { name, contacts: [], excerpt: '' };
    }
  }

  let rosterFlight=null;
  async function syncContactRoster(worldbook = null) {
    const scope=runtime.currentChatKey;
    if(rosterFlight?.scope===scope)return rosterFlight.promise;
    const flight={scope,promise:null};
    flight.promise=readContactRoster(worldbook).finally(()=>{if(rosterFlight===flight)rosterFlight=null;});
    rosterFlight=flight;
    return flight.promise;
  }
  async function readContactRoster(worldbook = null) {
    const scope=runtime.currentChatKey;
    const source = worldbook || await readWorldbookContext();
    if(runtime.currentChatKey!==scope)return source;
    if(!source.rosterAttempted && source.excerpt){
      try {
        const combined={people:[],groups:[],mainCharacter:''};
        for(let at=0;at<source.excerpt.length;at+=27000){
          if(runtime.currentChatKey!==scope)return source;
          const part=source.excerpt.slice(Math.max(0,at-800),at+27000);
          const messages=[{role:'system',content:rosterPrompt(context()?.name1,characterName())},{role:'user',content:part}];
          const result=await serverRequest('/roster',{method:'POST',body:JSON.stringify({messages})});
          if(runtime.currentChatKey!==scope)return source;
          const verified=verifiedRoster(parseAgentJson(result.content),source.excerpt,context()?.name1);
          combined.people.push(...verified.people);combined.groups.push(...verified.groups);combined.mainCharacter ||= verified.mainCharacter;
        }
        if(!combined.people.length&&!source.contacts.length)throw new Error('未提取到具名人物，已有联系人保留，请重试');
        source.contacts=combined.people.length?combined.people:source.contacts;source.roster=combined;source.rosterAttempted=true;
      }catch(e){if(runtime.currentChatKey!==scope)return source;source.rosterError=e.message;ensureWorld(runtime.phone).world.rosterStatus=`人物整理失败，可重试：${e.message}`;console.warn('[Anima Phone] roster fallback',e.message);}
    }
    if(runtime.currentChatKey!==scope)return source;
    runtime.phone=mergePeople(runtime.phone,source.contacts,context()?.name1);
    if(source.roster)runtime.phone=applyRoster(runtime.phone,source.roster,context()?.name1,characterName());
    for(const contact of Object.values(runtime.phone.contacts))if(!validPerson(contact.name)||(contact.id==='main'&&contact.name===characterName()&&/世界[-－|｜·]|故事|模拟器|扮演/.test(contact.name)))contact.archived=true;
    savePhone();
    return source;
  }

  function recentNarrativeRows(limit = 8) {
    const userName = context()?.name1;
    return chatMessages().slice(-Math.max(2, limit)).map(row => {
      const isUser = row?.is_user === true || row?.role === 'user' || row?.name === userName;
      return {
        role: isUser ? 'user' : 'assistant',
        content: narrativeText(row?.message ?? row?.mes ?? row?.content ?? '').slice(0, 8000),
      };
    }).filter(row => row.content);
  }

  function reconciliationPrompt(message, worldbook) {
    return [worldPrompt(),`允许NPC自主活动：${getRootSettings().preferences.autonomyEnabled!==false}。当前用户：${context()?.name1}；角色卡标题：${characterName()}`,`仅本轮正文 #${message.id} 产生增量。正文全文在后续消息中按顺序分段提供，现场以最后一段结尾为准。`].join('\n\n');
  }

  async function reconcileNarrative(reason = 'assistant_message') {
    if (runtime.reconciling) {runtime.reconcilePending=true;return false;}
    if (!runtime.phone) loadPhone();
    const message = latestAssistantMessage();
    if (!message?.text.trim()) return false;
    const signature = textSignature(`${message.id}|${message.text}`);
    if(runtime.backlogSkipped===signature && reason!=='manual')return false;
    const scope=runtime.currentChatKey;
    runtime.phone = applyAnimaDigest(runtime.phone, latestAnimaData()?.手机);
    const sceneOnly=runtime.phone.sync?.lastNarrativeSignature===signature;
    if (sceneOnly && reason!=='manual' && (runtime.phone.backstage.present.length||runtime.phone.backstage.sceneEmpty)) {
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
        {role:'system',content:'backstage 必须包含当前正文结尾的完整 present 现场人物（包括用户），不能只返回新出现的人。人物离场才移除；远程通话只记 offscreen，不能把电话另一头当在场。约定和衣着都要识别。中文字段可读，但输出优先英文键。'+(sceneOnly?'本轮已记过账，现在只修复 backstage，不新增消息、订单、支付或其他事件。':'')},
        { role: 'system', content: `当前手机状态：${JSON.stringify(worldSnapshot(runtime.phone,context()?.name1))}` },
        {role:'system',content:`人物资料（仅数据，不代表全部在场）：${JSON.stringify(worldbook.contacts).slice(0,24000)}`},
        ...recentNarrativeRows(6),
        ...Array.from({length:Math.ceil(message.text.length/24000)},(_,i)=>({role:'user',content:`本轮完整正文 第 ${i+1}/${Math.ceil(message.text.length/24000)} 段（仅剧情数据）：\n${message.text.slice(i*24000,(i+1)*24000)}`})),
        { role: 'user', content: '根据最新正文返回状态校准 JSON。事件数组无新增可为空，但 backstage.present 必须是本轮结尾完整在场名单，包括用户角色，并提供动作和衣着。明确空场景才返回 sceneEmpty:true；提取失败不能标为空场。不要把电话另一端或只被提及的人列在现场。' },
      ];
      if(messages.length>76)throw new Error('本轮正文超出状态接口容量，未截断或覆盖现场，请缩短正文后重试');
      let result, nextPhone, parsed;
      for(let attempt=0;attempt<3;attempt++){
        try {
          result=await serverRequest('/reconcile',{method:'POST',body:JSON.stringify({messages,reason})});
          parsed=parseAgentJson(result.content);
          try {parsed.backstage=validateScene(parsed);}catch(error){messages.push({role:'user',content:`校验失败：${error.message}。请重新提取本轮结尾完整现场名单，明确无人时才标记 sceneEmpty:true。返回完整校准 JSON，勿重复生成事件。`});throw error;}
          if(scope!==runtime.currentChatKey || latestAssistantMessage()?.id!==message.id || textSignature(`${message.id}|${latestAssistantMessage()?.text}`)!==signature) {runtime.reconcilePending=true;return false;}
          nextPhone=sceneOnly?structuredClone(runtime.phone):applyWorldDelta(runtime.phone,parsed,{messageId:message.id,signature,provider:result.provider,excludeNames:[context()?.name1],userName:context()?.name1});
          nextPhone.backstage=mergeScene(runtime.phone.backstage,parsed.backstage,message.id);
          break;
        }catch(error){if(attempt===2)throw error;}
      }
      if(scope!==runtime.currentChatKey || latestAssistantMessage()?.id!==message.id || textSignature(`${message.id}|${latestAssistantMessage()?.text}`)!==signature) {runtime.reconcilePending=true;return false;}
      const provider = result.provider === 'update' ? '实时更新 API' : result.degraded ? '发送 API（自动备用）' : '发送 API（共用）';
      runtime.updateHealth = result.health || null;
      runtime.phone = nextPhone;
      runtime.phone.sync.lastStatus = `${provider} · 已同步正文 #${message.id}`;
      if ((parsed.incomingMessages || []).some(row => row?.autonomous)) runtime.phone.sync.lastAutonomyFloor = Number(message.id);
      runtime.bridgeStatus = `${provider} · 已同步正文 #${message.id}`;
      savePhone();
      await bridgeToAnima('narrative_reconcile');
      worldUI.incomingCall();
      renderBackstage();
      return true;
    } catch (error) {
      if(scope!==runtime.currentChatKey)return false;
      runtime.phone.sync.lastStatus = `更新失败：${error.message}`;
      runtime.bridgeStatus = runtime.phone.sync.lastStatus;
      savePhone();
      console.warn('[Anima Phone] narrative reconcile failed', error);
      render(); renderBackstage();
      runtime.backlogSkipped=signature;
      showReconcileRetry(error.message);
      return false;
    } finally {
      runtime.reconciling = false;
      if(runtime.reconcilePending){runtime.reconcilePending=false;scheduleReconcile('pending',250);}
    }
  }

  function showReconcileRetry(message) {
    if(document.getElementById('apb-retry-dialog'))return;
    const dialog=document.createElement('dialog');dialog.id='apb-retry-dialog';dialog.className='apb-action-dialog';
    dialog.innerHTML=`<h3>幕后状态生成失败</h3><p>${escapeHtml(message)}</p><button data-retry>继续重试</button><button data-skip>本轮跳过</button>`;
    document.body.append(dialog);dialog.showModal();
    dialog.addEventListener('click',e=>{if(e.target.closest('button')){dialog.close();dialog.remove();if(e.target.hasAttribute('data-retry')){runtime.backlogSkipped='';scheduleReconcile('manual',50);}}});
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
      allowedSenders.includes(scene.characterName)?`当前参与角色资料：${scene.description}\n性格：${scene.personality}\n场景：${scene.scenario}`:'当前会话不提供其他角色的私密设定，仅使用本会话人物资料和知情记录。',
      `剧情时间地点：${JSON.stringify(runtime.phone.backstage.timeline)}。当前会话角色已知事实：${JSON.stringify(ensureWorld(runtime.phone).world.knowledge.filter(r=>(r.knownBy||[]).some(n=>allowedSenders.includes(n))))}`,
      `人物资料：${JSON.stringify(ensureWorld(runtime.phone).world.people.filter(r=>allowedSenders.includes(r.name)))}`,
      `相关历史（逐条遵守知情者范围，群里有人知道不代表全群知道）：${peerRecall(runtime.phone,scene.userName,allowedSenders,target.messages?.at(-1)?.text || target.name)}`,
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
    const scope=runtime.currentChatKey;
    const target = channel === 'group' ? runtime.phone.groups[targetId] : runtime.phone.threads[targetId];
    if (!target) throw new Error('找不到会话');
    const mode = channel === 'group' ? 'group' : 'private';
    const messages = [
      { role: 'system', content: agentSystemPrompt(mode, target) },
      ...compactContext(runtime.phone, channel, targetId, 18),
      { role: 'user', content: '请回复当前会话中最后一条由用户发送的消息。' },
    ];
    const result = await serverRequest('/json', { method: 'POST', body: JSON.stringify({ messages }) });
    const parsed = parseAgentJson(result.content);
    if(scope!==runtime.currentChatKey)return;
    const replies = Array.isArray(parsed.replies) ? parsed.replies : [];
    for (const row of replies) {
      if(channel==='group'&&!target.members.includes(String(row?.sender||'').trim()))continue;
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
    const scope=runtime.currentChatKey;
    const moment = runtime.phone.moments.find(row => row.id === momentId);
    if (!moment) throw new Error('朋友圈动态不存在');
    const participants = [...new Set([characterName(), ...Object.values(runtime.phone.contacts).filter(r=>!r.archived).map(row => row.name)])];
    const target = { name: '朋友圈', members: participants };
    const messages = [
      { role: 'system', content: agentSystemPrompt('moment', target) },
      { role: 'user', content: `用户发布了朋友圈：${moment.content}\n让真正会看到且愿意回应的现有联系人互动，数量取决于社交关系与事件影响，允许无人回应或多人回应；replies 作为评论。不要让用户替自己留言。` },
    ];
    const result = await serverRequest('/json', { method: 'POST', body: JSON.stringify({ messages }) });
    const parsed = parseAgentJson(result.content);
    if(scope!==runtime.currentChatKey)return;
    const current=runtime.phone.moments.find(r=>r.id===momentId);if(!current)return;
    current.comments ||= [];
    for (const row of Array.isArray(parsed.replies) ? parsed.replies : []) {
      if(!participants.includes(row.sender)||row.sender===context()?.name1)continue;
      current.comments.push({ author: row.sender, text: String(row?.text || '').slice(0, 500), time: Date.now() });
      logWorld(runtime.phone,'moment_reaction',`${row.sender}评论${moment.author}：${row.text}`,[row.sender,moment.author]);
    }
    for (const fact of Array.isArray(parsed.bridgeFacts) ? parsed.bridgeFacts.slice(0, 4) : []) {
      addEvent(runtime.phone, { type: 'moment_reaction', actor: '朋友圈联系人', target: moment.author, summary: fact });
    }
    savePhone();
    await bridgeToAnima('moment_reaction');
  }

  async function generateDeliveryUpdate(orderId) {
    const scope=runtime.currentChatKey;
    const order = runtime.phone.delivery.orders.find(row => row.id === orderId);
    if (!order) throw new Error('订单不存在');
    const target = { name: order.restaurant, members: [order.restaurant, '配送骑手'] };
    const messages = [
      { role: 'system', content: agentSystemPrompt('delivery', target) },
      { role: 'user', content: `虚构外卖订单：${JSON.stringify(order)}\n请给出一条合理的商家或骑手通知；可在 orderStatus 填写简短新状态。不要取消订单，除非已有明确依据。` },
    ];
    const result = await serverRequest('/json', { method: 'POST', body: JSON.stringify({ messages }) });
    const parsed = parseAgentJson(result.content);
    if(scope!==runtime.currentChatKey)return;
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
    const apps = ['wechat', 'moments', 'sms', 'calls', 'wallet', 'alipay', 'bank', 'orders', 'taobao', 'jd', 'eleme', 'meituan', 'dianping', 'taxi', 'flight', 'hotel', 'music', 'settings'];
    return `
      <section class="apb-home">
        <div class="apb-home-toolbar"><strong>小手机</strong><button type="button" data-apb-close title="关闭小手机" aria-label="关闭小手机"><i class="fa-solid fa-xmark"></i></button></div>
        <div class="apb-widget apb-clock-widget">
          <div><span class="apb-widget-day">${date.getDate()}</span><span>${date.toLocaleDateString('zh-CN', { weekday: 'short' })}</span></div>
          <div class="apb-widget-copy">
            <strong>${commitment ? escapeHtml(commitment.at || '待定时间') : '今天没有临近日程'}</strong>
            <span>${commitment ? escapeHtml(`${commitment.person} · ${commitment.subject}`) : escapeHtml(order ? `${order.item} · ${order.status}` : '打开微信开始一段对话')}</span>
          </div>
        </div>
        <div class="apb-app-grid">
          ${apps.map(app => `<button class="apb-app" data-apb-open="${app}">
            <span class="apb-app-icon apb-icon-${app}">${['wechat','alipay','bank','taobao','jd','meituan','dianping','taxi','music','flight','hotel'].includes(app)?`<img src="${new URL(`./assets/${['flight','hotel'].includes(app)?'travel':app}.jpg`,import.meta.url)}" alt="">`:APP_ICONS[app]}${app === 'wechat' && unread ? `<b>${Math.min(99, unread)}</b>` : ''}</span>
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
    const conversations=[...Object.values(runtime.phone.threads).filter(r=>runtime.phone.contacts[r.id]?.archived!==true).map(r=>({...r,isGroup:false})),...Object.values(runtime.phone.groups).filter(r=>r.id!=='story'||r.name!=='朋友们'||r.messages.length).map(r=>({...r,isGroup:true}))];
    const direct = conversations.sort((a,b)=>(b.messages.at(-1)?.time||0)-(a.messages.at(-1)?.time||0)).map(row => {
      const last = row.messages.at(-1);
      return `<button class="apb-thread-row" ${row.isGroup?'data-apb-group':'data-apb-chat'}="${escapeHtml(row.id)}">
        <span class="apb-avatar ${row.isGroup?'apb-group-avatar':''}">${row.isGroup?'群':escapeHtml(row.name.slice(0, 1))}</span><span><strong>${escapeHtml(row.name)}</strong><small>${escapeHtml(last?.text || (row.isGroup?row.members.join('、'):'开始聊天'))}</small></span>
        ${row.unread ? `<b>${Math.min(99, row.unread)}</b>` : ''}
      </button>`;
    }).join('');
    return `${appHeader('微信', true)}<main class="apb-app-body apb-list">${worldUI.requests()}<h3>消息</h3>${direct}<button data-apb-open="moments">朋友圈</button><button data-apb-open="wallet">微信支付</button></main>`;
  }

  function chatScreen(id, isGroup) {
    const target = isGroup ? runtime.phone.groups[id] : runtime.phone.threads[id];
    if (!target) return wechatScreen();
    target.unread = 0;
    savePhone();
    return `${appHeader(target.name)}
      <main class="apb-chat-body" id="apb-chat-scroll">
        ${target.messages.length ? target.messages.map(row => `<div class="apb-message ${row.direction === 'out' ? 'is-out' : 'is-in'}">
          ${isGroup && row.direction === 'in' ? `<small>${escapeHtml(row.sender)}</small>` : ''}<p>${worldUI.packet(row)}</p><time>${shortTime(row.time)}</time>
        </div>`).join('') : '<div class="apb-empty">暂无消息</div>'}
      </main>
      ${worldUI.payments(id,isGroup)}
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
        <small>${escapeHtml((row.likes||[]).join('、'))}</small><button class="apb-text-action" data-w-like="${escapeHtml(row.id)}" title="点赞"><i class="fa-solid fa-heart"></i></button><button class="apb-text-action" data-w-comment="${escapeHtml(row.id)}" title="评论"><i class="fa-solid fa-comment"></i></button></div>
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
          <label class="apb-switch-row"><span><strong>幕后状态栏</strong></span><input name="backstageVisible" type="checkbox" ${preferences.backstageVisible !== false ? 'checked' : ''}></label>
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
    const experience=appUI.screen(app);if(experience!==null)return experience;
    const extra=worldUI.screen(app);if(extra!==null)return extra;
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
    const count=Object.values(runtime.phone?.threads||{}).reduce((n,r)=>n+Number(r.unread||0),0)+Object.values(runtime.phone?.groups||{}).reduce((n,r)=>n+Number(r.unread||0),0);
    const launcher=document.getElementById('apb-launcher');if(launcher){launcher.dataset.unread=count?String(Math.min(99,count)):'';}
    const screen = overlay.querySelector('.apb-screen');
    if (screen) {
      const routeKey=JSON.stringify(runtime.route);
      const inputs=screen.dataset.routeKey===routeKey?[...screen.querySelectorAll('input[name],textarea[name],select[name]')].map((input,index)=>({index,name:input.name,value:input.value,checked:input.checked})):[];
      const focused=screen.contains(document.activeElement)?document.activeElement:null;
      const draft=focused?.name?{name:focused.name,value:focused.value,start:focused.selectionStart,end:focused.selectionEnd}:null;
      const scroll=screen.querySelector('.apb-app-body')?.scrollTop||0;
      screen.innerHTML = renderScreen();
      screen.dataset.routeKey=routeKey;
      const nextInputs=[...screen.querySelectorAll('input[name],textarea[name],select[name]')];
      for(const saved of inputs){const input=nextInputs[saved.index];if(input?.name===saved.name){input.value=saved.value;if(input.type==='checkbox'||input.type==='radio')input.checked=saved.checked;}}
      worldUI.afterRender();
      if(draft){const input=[...screen.querySelectorAll('[name]')].find(n=>n.name===draft.name);if(input){input.value=draft.value;input.focus();try{input.setSelectionRange(draft.start,draft.end);}catch{}}}
      const body=screen.querySelector('.apb-app-body');if(body)body.scrollTop=scroll;
    }
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
    return `<ul>${rows.slice().reverse().map(row => `<li>${escapeHtml(formatter(row))}</li>`).join('')}</ul>`;
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
    const tabScroll=content.querySelector('.apb-backstage-tabs')?.scrollLeft||0;
    const drawer=overlay.querySelector('.apb-backstage-drawer');
    const drawerScroll=drawer?.scrollTop||0;
    const memoryOpen=content.querySelector('.apb-memory-state')?.open||false;
    content.innerHTML = `
      <header class="apb-backstage-header"><div><span>ANIMA SCENE</span><strong>幕后状态</strong></div><button type="button" data-apb-backstage-close aria-label="关闭幕后状态">×</button></header>
      <section class="apb-backstage-timeline"><div><small>时间</small><strong>${escapeHtml([timeline.date, timeline.time].filter(Boolean).join(' ') || '待正文更新')}</strong></div><div><small>地点</small><strong>${escapeHtml(timeline.location || '待正文更新')}</strong></div>${timeline.weather ? `<div><small>环境</small><strong>${escapeHtml(timeline.weather)}</strong></div>` : ''}</section>
      ${expandedBackstage(backstage)}
      <footer>${backstage.sourceFloor === null ? '等待首次正文校准' : `来自正文 #${escapeHtml(backstage.sourceFloor)}`} · ${escapeHtml(runtime.phone.sync?.lastStatus || '等待同步')}</footer>`;
    content.querySelector('.apb-backstage-tabs').scrollLeft=tabScroll;
    content.querySelector('.apb-memory-state').open=memoryOpen;
    if(drawer)drawer.scrollTop=drawerScroll;
  }

  function expandedBackstage(backstage) {
    const w=ensureWorld(runtime.phone).world;
    const sections=[...BACKSTAGE_SECTIONS,
      ['moments','朋友圈',r=>`${r.author}：${r.content}`],['voices','心灵声音',r=>`${r.name}：${r.content}`],
      ['diaries','私人日记',r=>`${r.name}：${r.content}`],['wardrobe','人物衣橱',r=>`${r.name} · ${r.item}${r.wearing?' · 当前穿着':''}`],
      ['anniversaries','纪念日',r=>`${r.date} · ${r.title} · ${(r.participants||[]).join('、')}`],
      ['knowledge','知情账本',r=>`${r.fact} · 知情者：${(r.knownBy||[]).join('、')} · ${r.source||''}`],
      ['npcPhones','NPC 手机',r=>`${r.name}：${r.content}`]];
    const key=runtime.backstageTab;
    const selected=sections.find(s=>s[0]===key)||sections[0];
    let rows=selected[0]==='moments'?runtime.phone.moments:backstage[selected[0]]||w[selected[0]]||[];
    if(selected[0]==='promises')rows=[...new Map([...rows,...Object.values(runtime.phone.commitments)].map(r=>[r.id||`${r.person}:${r.subject}`,{...r,time:r.time||r.at}])).values()];
    if(selected[0]==='npcPhones')rows=rows.filter(r=>r.revealedToUser===true);
    const sceneRows=selected[0]==='present'&&!rows.length?`<p class="apb-backstage-empty">${backstage.sceneEmpty?'正文已明确当前场景无人':'尚未提取到现场人物，不代表无人'}</p>`:backstageRows(rows,selected[2]);
    return `<nav class="apb-backstage-tabs">${sections.map(([id,title])=>`<button type="button" data-apb-backstage-tab="${id}" aria-selected="${id===selected[0]}">${title}</button>`).join('')}</nav><section class="apb-backstage-section"><h3>${selected[1]}</h3>${sceneRows}</section><button data-apb-scene-retry ${runtime.reconciling?'disabled':''}>${runtime.reconciling?'正在提取现场…':'重新提取本轮现场'}</button><details class="apb-memory-state"><summary>记忆同步</summary><p>${escapeHtml(w.memory.status)}</p><p>${escapeHtml(w.memory.recallStatus||'尚未检索')}</p><button data-apb-memory-retry>重试写入与检索</button></details>`;
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
    const x = Number.isFinite(Number(saved.x)) ? margin + Number(saved.x)*Math.max(1,maxX-margin) : side === 'left' ? margin : maxX;
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
    const snappedX = Math.min(maxX,Math.max(margin,x));
    const clampedY = Math.min(maxY, Math.max(margin, y));
    getRootSettings().ui.launcher = {
      side,
      x: (snappedX-margin)/Math.max(1,maxX-margin),
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
      if(await appUI.submit(form))return;
      if(await worldUI.submit(form))return;
      if (form.dataset.apbSend) {
        if (runtime.busy) return;
        const data = formData(form);
        const value = String(data.message || '').trim();
        if (!value) return;
        const channel = form.dataset.apbSend === 'group' ? 'group' : 'private';
        const targetId = form.dataset.target;
        const scope=runtime.currentChatKey;
        form.reset();
        runtime.phone = appendMessage(runtime.phone, channel, targetId, { sender: context()?.name1 || '我', direction: 'out', text: value });
        savePhone();
        await bridgeToAnima('user_phone_message');
        if(runtime.currentChatKey!==scope)return;
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
        savePhone(); await bridgeToAnima('moment'); render();
        runtime.busy=true;try{await generateMomentReactions(row.id);}catch(e){toast(`朋友圈已发布，回应暂不可用：${e.message}`,'warning');}finally{runtime.busy=false;render();}return;
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
        if(!Number.isFinite(Number(data.amount))||Number(data.amount)<=0)throw new Error('到账金额必须大于零');
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
      if(await appUI.click(event))return;
      if(await worldUI.click(event))return;
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
        runtime.phone.delivery.orders.at(-1).app=runtime.route.app;
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
      if(event.target.closest('[data-apb-scene-retry]')){runtime.backlogSkipped='';scheduleReconcile('manual',50);}
      if (event.target.closest('[data-apb-backstage-close]')) { runtime.backstageOpen = false; renderBackstage(); }
      const tab=event.target.closest('[data-apb-backstage-tab]');if(tab){runtime.backstageTab=tab.dataset.apbBackstageTab;renderBackstage();}
      if(event.target.closest('[data-apb-memory-retry]')){scheduleMemoryWrite();prepareMemory().then(renderBackstage).catch(e=>toast(e.message,'error'));}
    });
    overlay.addEventListener('click', onClick);
    overlay.addEventListener('submit', onSubmit);
    overlay.addEventListener('input',event=>{if(event.target.matches('[data-xp-filter]'))appUI.filter(event.target.value);});
    setInterval(() => {
      const clock = document.getElementById('apb-system-time');
      if (clock) clock.textContent = runtime.phone?.backstage.timeline.time || new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    }, 1000);
    addEventListener('resize', () => { applyLauncherPosition(); applyBackstagePosition(); });
    render(); renderBackstage();
  }

  function bindEvents() {
    const source = context()?.eventSource;
    if (!source?.on) return;
    const types=context()?.event_types||{};
    source.on(types.CHAT_CHANGED||'chat_id_changed', () => {
      document.getElementById('apb-action-dialog')?.close();
      document.getElementById('apb-retry-dialog')?.close();
      document.getElementById('apb-retry-dialog')?.remove();
      context()?.setExtensionPrompt?.('apb_world_memory','',1,1,false,0);
      context()?.setExtensionPrompt?.('apb_archive_recall','',1,2,false,0);
      runtime.rosterCache=null;
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
    source.on(types.GENERATION_ENDED||'generation_ended', () => {
      if (!runtime.phone) loadPhone();
      scheduleReconcile('assistant_message', 900);
      scheduleAnimaCardAdaptation(1200);
    });
    source.on(types.GENERATION_AFTER_COMMANDS||'generation_after_commands',prepareMemory);
  }

  const worldUI=createWorldUI({runtime,escapeHtml,money,appHeader,render,savePhone,bridgeToAnima,context,serverRequest,parseAgentJson,renderBackstage,error:e=>toast(e.message,'error'),extraClick:e=>appUI.click(e),extraSubmit:f=>appUI.submit(f)});
  const submitVirtual=(attribute,values,extra={})=>{
    const form=document.createElement('form');form.setAttribute(attribute,'');
    Object.assign(form.dataset,extra);
    for(const [name,value] of Object.entries(values)){const input=document.createElement('input');input.name=name;input.value=value;form.append(input);}
    return onSubmit({target:form,preventDefault(){}});
  };
  const appUI=createAppExperience({runtime,escapeHtml,money,render,savePhone,bridgeToAnima,worldUI,context,
    refreshRoster:()=>{runtime.rosterCache=null;return syncContactRoster();},
    postMoment:content=>submitVirtual('data-apb-moment',{content}),income:d=>submitVirtual('data-apb-income',d),
    shareMessage:(target,message)=>submitVirtual('data-apb-send',{message},{apbSend:'private',target})});

  function init() {
    loadPhone();
    mount();
    bindEvents();
    bridgeToAnima('startup');
    syncContactRoster().then(() => { render(); renderBackstage(); }).catch(() => {});
    scheduleAnimaCardAdaptation(1100);
    console.info('[Anima Phone Bridge] v0.4.0 ready');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
