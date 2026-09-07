import {
  addCommitment,
  addEvent,
  appendMessage,
  buildAnimaDigest,
  compactContext,
  defaultPhoneState,
  makeId,
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
    apiConfig: null,
    bridgeStatus: '尚未同步',
    currentChatKey: '',
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
    const settings = root[MODULE] || (root[MODULE] = { version: 1, chats: {} });
    if (!settings.chats || typeof settings.chats !== 'object') settings.chats = {};
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
    const phone = normalizePhoneState(settings.chats[key], characterName());
    const main = phone.contacts.main;
    if (main && (!settings.chats[key] || main.name === '联系人')) {
      main.name = characterName();
      phone.threads.main.name = characterName();
      phone.groups.story.members = [...new Set([...(phone.groups.story.members || []), characterName()])];
    }
    settings.chats[key] = phone;
    runtime.currentChatKey = key;
    runtime.phone = phone;
    return phone;
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

  function latestAssistantMessageId() {
    const tavern = helper();
    if (!tavern) return null;
    let rows = [];
    try { rows = tavern.getChatMessages('0-{{lastMessageId}}', { include_swipes: false }) || []; } catch { return null; }
    const userName = context()?.name1;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      const isUser = row?.is_user === true || row?.role === 'user' || row?.name === userName || String(row?.name || '').toLowerCase() === 'you';
      if (!isUser && row?.message_id !== undefined) return row.message_id;
    }
    return null;
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
        current.anima_data = { ...animaData, 手机: digest };
        return current;
      }, { type: 'message', message_id: messageId });
      const ctx = context();
      ctx?.eventSource?.emit?.('ANIMA_VARIABLE_UPDATE_ENDED', {
        type: 'phone_bridge', messageId, newData: digest, reason, timestamp: Date.now(),
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

  function settingsScreen() {
    const config = runtime.apiConfig || {};
    return `${appHeader('设置', true)}<main class="apb-app-body">
      <div class="apb-settings-head"><span>一个 API</span><strong>整部手机共用</strong><small>API Key 只保存在 SillyTavern 服务端数据目录</small></div>
      <form class="apb-stack-form" data-apb-api>
        <label>API 地址<input name="baseUrl" value="${escapeHtml(config.baseUrl || '')}" placeholder="https://example.com/v1" required></label>
        <label>API Key<input name="apiKey" type="password" placeholder="${config.hasApiKey ? '已保存，留空保持不变' : 'sk-...'}"></label>
        <label>模型<input name="model" value="${escapeHtml(config.model || '')}" placeholder="模型名称" required></label>
        <div class="apb-form-row"><label>温度<input name="temperature" type="number" min="0" max="2" step="0.1" value="${Number(config.temperature ?? 0.7)}"></label><label>最大输出<input name="maxTokens" type="number" min="128" max="8000" value="${Number(config.maxTokens ?? 1200)}"></label></div>
        <div class="apb-form-actions"><button type="submit">保存</button><button type="button" class="secondary" data-apb-test-api>测试连接</button></div>
      </form>
      <div class="apb-bridge-card"><span class="apb-bridge-dot"></span><div><strong>Anima 桥</strong><small>${escapeHtml(runtime.bridgeStatus)}</small></div><button data-apb-sync>立即同步</button></div>
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

  function openApp(app) {
    runtime.route = { app, view: 'root', id: '' };
    if (app === 'settings') loadApiConfig();
    render();
  }

  async function loadApiConfig() {
    try {
      const data = await serverRequest('/config');
      runtime.apiConfig = data.config;
    } catch (error) {
      runtime.apiConfig = {};
      runtime.bridgeStatus = error.message;
    }
    render();
  }

  function formData(form) {
    return Object.fromEntries(new FormData(form).entries());
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
        const data = formData(form);
        const response = await serverRequest('/config', { method: 'POST', body: JSON.stringify(data) });
        runtime.apiConfig = response.config;
        toast('手机 API 设置已保存', 'success'); render();
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
      if (target.hasAttribute('data-apb-sync')) { savePhone(); await bridgeToAnima('manual'); toast(runtime.bridgeStatus, 'success'); return; }
      if (target.hasAttribute('data-apb-test-api')) {
        target.disabled = true; target.textContent = '测试中…';
        try { await serverRequest('/test', { method: 'POST', body: '{}' }); toast('手机 API 连接成功', 'success'); }
        finally { target.disabled = false; target.textContent = '测试连接'; }
      }
    } catch (error) { toast(error.message, 'error'); render(); }
  }

  function mount() {
    if (document.getElementById('apb-overlay')) return;
    document.body.insertAdjacentHTML('beforeend', `
      <button id="apb-launcher" type="button" title="打开 Anima 小手机" aria-label="打开 Anima 小手机">📱</button>
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
    launcher.addEventListener('click', () => { runtime.open = true; runtime.route = { app: 'home', view: 'root', id: '' }; loadPhone(); render(); });
    overlay.addEventListener('click', onClick);
    overlay.addEventListener('submit', onSubmit);
    setInterval(() => {
      const clock = document.getElementById('apb-system-time');
      if (clock) clock.textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    }, 1000);
    render();
  }

  function bindEvents() {
    const source = context()?.eventSource;
    if (!source?.on) return;
    source.on('CHAT_CHANGED', () => {
      runtime.phone = null;
      loadPhone();
      runtime.route = { app: 'home', view: 'root', id: '' };
      render();
    });
    source.on('CHARACTER_MESSAGE_RENDERED', () => {
      setTimeout(() => {
        if (!runtime.phone) loadPhone();
        bridgeToAnima('assistant_floor_refresh');
      }, 900);
    });
  }

  function init() {
    loadPhone();
    mount();
    bindEvents();
    bridgeToAnima('startup');
    console.info('[Anima Phone Bridge] v0.1.0 ready');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
