export const SCHEMA_VERSION = 3;
export const ANIMA_PROMPT_RULE_TITLE = '📱Anima 小手机桥｜状态维护补充规则';
export const ANIMA_PROMPT_RULE_MARKER = '【Anima 小手机桥｜状态维护补充规则】';

const clone = value => JSON.parse(JSON.stringify(value));
const text = (value, max = 500) => String(value ?? '').trim().slice(0, max);

const stableId = (prefix, value) => {
  let hash = 2166136261;
  for (const char of String(value || '').trim().toLowerCase()) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}-${(hash >>> 0).toString(36)}`;
};

export function mergeAnimaPromptRule(rules, content) {
  if (!Array.isArray(rules) || !rules.length) return { changed: false, ready: false, rules: [] };
  const value = text(content, 30000);
  if (!value) return { changed: false, ready: true, rules: clone(rules) };
  const next = clone(rules);
  const isBridgeRule = row => row?.title === ANIMA_PROMPT_RULE_TITLE
    || String(row?.content || '').includes(ANIMA_PROMPT_RULE_MARKER);
  const existing = next.find(isBridgeRule) || {};
  const arranged = next.filter(row => !isBridgeRule(row));
  const bridgeRule = { ...existing, role: 'system', title: ANIMA_PROMPT_RULE_TITLE, content: value, enabled: true };
  const formatIndex = arranged.findIndex(row => {
    const title = String(row?.title || '');
    const body = String(row?.content || '');
    return /状态更新提示词|输出格式|强调/i.test(title) || /<response_format>/i.test(body);
  });
  arranged.splice(formatIndex < 0 ? arranged.length : formatIndex, 0, bridgeRule);
  return {
    changed: JSON.stringify(next) !== JSON.stringify(arranged),
    ready: true,
    rules: arranged,
  };
}

export function defaultBackstageState() {
  return {
    timeline: { date: '', time: '', location: '', weather: '' },
    present: [],
    clothing: [],
    promises: [],
    secrets: [],
    offscreen: [],
    world: [],
    updatedAt: 0,
    sourceFloor: null,
  };
}

export function normalizeBackstageState(input) {
  const base = defaultBackstageState();
  const source = input && typeof input === 'object' ? input : {};
  const timeline = source.timeline && typeof source.timeline === 'object' ? source.timeline : {};
  const cleanRows = (key, limit = 40) => Array.isArray(source[key])
    ? source[key].filter(row => row && typeof row === 'object').slice(-limit).map(row => clone(row))
    : [];
  return {
    ...base,
    timeline: {
      date: text(timeline.date, 80),
      time: text(timeline.time, 80),
      location: text(timeline.location, 160),
      weather: text(timeline.weather, 120),
    },
    present: cleanRows('present', 30),
    clothing: cleanRows('clothing', 30),
    promises: cleanRows('promises', 40),
    secrets: cleanRows('secrets', 40),
    offscreen: cleanRows('offscreen', 40),
    world: cleanRows('world', 40),
    updatedAt: Number(source.updatedAt) || 0,
    sourceFloor: source.sourceFloor ?? null,
  };
}

export function makeId(prefix = 'evt') {
  const random = globalThis.crypto?.randomUUID?.().slice(0, 8)
    || Math.random().toString(16).slice(2, 10);
  return `${prefix}-${Date.now()}-${random}`;
}

export function defaultPhoneState(characterName = '联系人') {
  const contact = text(characterName, 80) || '联系人';
  return {
    schemaVersion: SCHEMA_VERSION,
    contacts: {
      main: { id: 'main', name: contact, subtitle: '剧情联系人', color: '#4f7cac', source: '角色卡', aliases: [] },
    },
    threads: {
      main: { id: 'main', name: contact, unread: 0, messages: [] },
    },
    groups: {
      story: { id: 'story', name: '朋友们', members: [contact], unread: 0, messages: [] },
    },
    moments: [],
    wallet: {
      wechat: 520,
      alipay: 860,
      bank: 6800,
      transactions: [],
    },
    delivery: {
      restaurants: [
        { id: 'r1', name: '巷口食堂', category: '家常菜', eta: 32, items: [{ name: '番茄牛腩饭', price: 28 }, { name: '青椒肉丝饭', price: 24 }] },
        { id: 'r2', name: '月岛甜品', category: '甜品饮品', eta: 24, items: [{ name: '海盐奶盖', price: 16 }, { name: '草莓千层', price: 26 }] },
        { id: 'r3', name: '夜航烧烤', category: '烧烤夜宵', eta: 45, items: [{ name: '双人烤串套餐', price: 68 }, { name: '烤茄子', price: 15 }] },
      ],
      orders: [],
    },
    reviews: [],
    music: {
      playing: null,
      playlist: [
        { id: 'm1', title: '晚风来信', artist: '云端电台', duration: '03:42' },
        { id: 'm2', title: '城市慢慢醒来', artist: '北岸乐队', duration: '04:08' },
        { id: 'm3', title: '等你到五点', artist: '白日梦频道', duration: '03:18' },
      ],
    },
    commitments: {},
    eventLedger: [],
    backstage: defaultBackstageState(),
    sync: {
      lastNarrativeMessageId: null,
      lastNarrativeSignature: '',
      lastProvider: '',
      lastStatus: '等待同步',
      lastSyncedAt: 0,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function normalizePhoneState(input, characterName = '联系人') {
  const base = defaultPhoneState(characterName);
  const source = input && typeof input === 'object' ? input : {};
  const result = {
    ...base,
    ...clone(source),
    contacts: { ...base.contacts, ...(source.contacts || {}) },
    threads: { ...base.threads, ...(source.threads || {}) },
    groups: { ...base.groups, ...(source.groups || {}) },
    wallet: { ...base.wallet, ...(source.wallet || {}) },
    delivery: { ...base.delivery, ...(source.delivery || {}) },
    music: { ...base.music, ...(source.music || {}) },
    commitments: source.commitments && typeof source.commitments === 'object' ? source.commitments : {},
    backstage: normalizeBackstageState(source.backstage),
    sync: { ...base.sync, ...(source.sync || {}) },
  };
  result.schemaVersion = SCHEMA_VERSION;
  result.moments = Array.isArray(result.moments) ? result.moments.slice(-80) : [];
  result.reviews = Array.isArray(result.reviews) ? result.reviews.slice(-80) : [];
  result.eventLedger = Array.isArray(result.eventLedger) ? result.eventLedger.slice(-240) : [];
  result.wallet.transactions = Array.isArray(result.wallet.transactions) ? result.wallet.transactions.slice(-160) : [];
  result.delivery.orders = Array.isArray(result.delivery.orders) ? result.delivery.orders.slice(-80) : [];
  for (const thread of Object.values(result.threads)) {
    thread.messages = Array.isArray(thread.messages) ? thread.messages.slice(-160) : [];
  }
  for (const group of Object.values(result.groups)) {
    group.messages = Array.isArray(group.messages) ? group.messages.slice(-200) : [];
  }
  for (const contact of Object.values(result.contacts)) {
    contact.aliases = Array.isArray(contact.aliases) ? contact.aliases.map(alias => text(alias, 80)).filter(Boolean).slice(0, 12) : [];
    if (!result.threads[contact.id]) result.threads[contact.id] = { id: contact.id, name: contact.name, unread: 0, messages: [] };
  }
  return result;
}

export function mergeContacts(phone, candidates = [], options = {}) {
  const state = normalizePhoneState(phone);
  const excluded = new Set((options.excludeNames || []).map(name => text(name, 80).toLowerCase()).filter(Boolean));
  for (const candidate of Array.isArray(candidates) ? candidates.slice(0, 120) : []) {
    const name = text(typeof candidate === 'string' ? candidate : candidate?.name, 80);
    if (!name || excluded.has(name.toLowerCase()) || /^(我|用户|user|旁白|未知|路人|联系人)$/i.test(name)) continue;
    const aliases = Array.isArray(candidate?.aliases) ? candidate.aliases.map(alias => text(alias, 80)).filter(Boolean) : [];
    const existing = Object.values(state.contacts).find(row => {
      const known = [row.name, ...(row.aliases || [])].map(value => text(value, 80).toLowerCase());
      return known.includes(name.toLowerCase()) || aliases.some(alias => known.includes(alias.toLowerCase()));
    });
    if (existing) {
      existing.aliases = [...new Set([...(existing.aliases || []), ...aliases])].filter(alias => alias !== existing.name).slice(0, 12);
      if (!existing.subtitle && candidate?.subtitle) existing.subtitle = text(candidate.subtitle, 120);
      continue;
    }
    let id = text(candidate?.id, 100) || stableId('npc', name);
    if (state.contacts[id] && state.contacts[id].name !== name) id = `${id}-${Object.keys(state.contacts).length}`;
    state.contacts[id] = {
      id,
      name,
      subtitle: text(candidate?.subtitle, 120) || '世界联系人',
      color: text(candidate?.color, 30) || '#5f7f9f',
      source: text(candidate?.source, 40) || '世界书/正文',
      aliases: [...new Set(aliases.filter(alias => alias !== name))].slice(0, 12),
    };
    state.threads[id] = { id, name, unread: 0, messages: [] };
  }
  return state;
}

export function appendMessage(phone, channel, targetId, message) {
  const state = normalizePhoneState(phone);
  const container = channel === 'group' ? state.groups : state.threads;
  const target = container[targetId];
  if (!target) throw new Error('找不到目标会话');
  const row = {
    id: text(message?.id, 120) || makeId('msg'),
    sender: text(message?.sender, 80) || '我',
    direction: message?.direction === 'in' ? 'in' : 'out',
    text: text(message?.text, 3000),
    time: Number(message?.time) || Date.now(),
    status: text(message?.status, 30) || 'sent',
  };
  if (!row.text) throw new Error('消息不能为空');
  target.messages.push(row);
  target.messages = target.messages.slice(-200);
  if (row.direction === 'in') target.unread = Number(target.unread || 0) + 1;
  addEvent(state, {
    type: channel === 'group' ? 'group_message' : 'private_message',
    actor: row.sender,
    target: target.name,
    summary: `${row.sender}：${row.text}`,
    sourceId: row.id,
  });
  return state;
}

export function addEvent(phone, event) {
  const row = {
    id: text(event?.id, 120) || makeId('event'),
    type: text(event?.type, 60) || 'phone_event',
    actor: text(event?.actor, 80),
    target: text(event?.target, 120),
    summary: text(event?.summary, 1000),
    status: text(event?.status, 40) || 'active',
    sourceId: text(event?.sourceId, 120),
    time: Number(event?.time) || Date.now(),
  };
  if (!row.summary) return phone;
  phone.eventLedger = Array.isArray(phone.eventLedger) ? phone.eventLedger : [];
  phone.eventLedger.push(row);
  phone.eventLedger = phone.eventLedger.slice(-240);
  phone.updatedAt = Date.now();
  return phone;
}

export function recordTransaction(phone, transaction) {
  const state = normalizePhoneState(phone);
  const requestedId = text(transaction?.id || transaction?.sourceId, 120);
  if (requestedId && state.wallet.transactions.some(row => row.id === requestedId)) return state;
  const account = ['wechat', 'alipay', 'bank'].includes(transaction?.account) ? transaction.account : 'wechat';
  const amount = Number(transaction?.amount);
  if (!Number.isFinite(amount) || amount === 0) throw new Error('金额必须为非零数字');
  const balance = Number(state.wallet[account] || 0) + amount;
  if (balance < 0) throw new Error('余额不足');
  state.wallet[account] = Math.round(balance * 100) / 100;
  const row = {
    id: requestedId || makeId('tx'),
    account,
    amount,
    kind: text(transaction?.kind, 60) || (amount > 0 ? '收入' : '支出'),
    counterparty: text(transaction?.counterparty, 100),
    note: text(transaction?.note, 300),
    time: Date.now(),
  };
  state.wallet.transactions.push(row);
  addEvent(state, {
    type: 'payment',
    actor: amount > 0 ? row.counterparty : '我',
    target: amount > 0 ? '我' : row.counterparty,
    summary: `${row.kind} ¥${Math.abs(amount).toFixed(2)}${row.note ? `，${row.note}` : ''}`,
    sourceId: row.id,
  });
  return state;
}

export function addCommitment(phone, input) {
  const state = normalizePhoneState(phone);
  const id = text(input?.id, 120) || makeId('promise');
  state.commitments[id] = {
    id,
    person: text(input?.person, 80),
    at: text(input?.at, 80),
    place: text(input?.place, 120),
    subject: text(input?.subject, 300),
    status: text(input?.status, 30) || '未完成',
    source: text(input?.source, 80) || '手机',
    updatedAt: Date.now(),
  };
  addEvent(state, {
    type: 'commitment',
    actor: state.commitments[id].person,
    target: '我',
    summary: `${state.commitments[id].at || '时间待定'} ${state.commitments[id].place || ''} ${state.commitments[id].subject}`.trim(),
    status: state.commitments[id].status,
    sourceId: id,
  });
  return state;
}

export function placeOrder(phone, restaurantId, itemName, payment = 'wechat') {
  let state = normalizePhoneState(phone);
  const restaurant = state.delivery.restaurants.find(row => row.id === restaurantId);
  const item = restaurant?.items?.find(row => row.name === itemName);
  if (!restaurant || !item) throw new Error('餐品不存在');
  state = recordTransaction(state, {
    account: payment,
    amount: -Number(item.price),
    kind: '外卖支出',
    counterparty: restaurant.name,
    note: item.name,
  });
  const order = {
    id: makeId('order'),
    restaurant: restaurant.name,
    item: item.name,
    amount: Number(item.price),
    eta: Number(restaurant.eta),
    status: '商家已接单',
    placedAt: Date.now(),
  };
  state.delivery.orders.push(order);
  addEvent(state, {
    type: 'delivery_order',
    actor: '我',
    target: restaurant.name,
    summary: `已下单${item.name}，预计${order.eta}分钟送达，${order.status}`,
    sourceId: order.id,
  });
  return state;
}

export function applyAnimaDigest(phone, digest) {
  const state = normalizePhoneState(phone);
  if (!digest || typeof digest !== 'object') return state;
  const currentOrder = digest.当前订单;
  if (currentOrder && typeof currentOrder === 'object') {
    const order = state.delivery.orders.find(row => currentOrder.订单ID && row.id === currentOrder.订单ID)
      || state.delivery.orders.slice().reverse().find(row => !currentOrder.商家 || row.restaurant === currentOrder.商家);
    const nextStatus = text(currentOrder.状态, 80);
    if (order && nextStatus && order.status !== nextStatus) {
      order.status = nextStatus;
      order.lastMessage = text(currentOrder.最新通知, 600) || order.lastMessage;
    }
  }
  const promises = digest.未完成约定 && typeof digest.未完成约定 === 'object' ? digest.未完成约定 : {};
  for (const [id, row] of Object.entries(promises)) {
    if (state.commitments[id] && row?.状态) state.commitments[id].status = text(row.状态, 30);
  }
  return state;
}

export function applyNarrativeUpdate(phone, payload, meta = {}) {
  let state = normalizePhoneState(phone);
  const signature = text(meta.signature, 160);
  if (signature && state.sync.lastNarrativeSignature === signature) return state;
  state = mergeContacts(state, payload?.contacts, { excludeNames: meta.excludeNames || [] });

  for (const [index, update] of (Array.isArray(payload?.orderUpdates) ? payload.orderUpdates : []).slice(0, 12).entries()) {
    const order = state.delivery.orders.find(row => update?.orderId && row.id === update.orderId)
      || state.delivery.orders.slice().reverse().find(row => (!update?.restaurant || row.restaurant === update.restaurant) && (!update?.item || row.item === update.item));
    const status = text(update?.status, 80);
    if (!order || !status || order.status === status) continue;
    order.status = status;
    order.lastMessage = text(update?.lastMessage, 600) || order.lastMessage;
    order.updatedAt = Date.now();
    addEvent(state, {
      id: signature ? `${signature}-order-${index}` : '',
      type: 'delivery_update', actor: update?.actor || order.restaurant, target: '我',
      summary: `${status}${order.lastMessage ? `：${order.lastMessage}` : ''}`, sourceId: order.id,
    });
  }

  for (const update of (Array.isArray(payload?.commitmentUpdates) ? payload.commitmentUpdates : []).slice(0, 20)) {
    const id = text(update?.id, 120);
    const existing = (id && state.commitments[id]) || Object.values(state.commitments).find(row => update?.person && row.person === update.person && update?.subject && row.subject === update.subject);
    if (existing) {
      if (update?.status) existing.status = text(update.status, 30);
      if (update?.at) existing.at = text(update.at, 80);
      if (update?.place) existing.place = text(update.place, 120);
      existing.updatedAt = Date.now();
    } else if (text(update?.subject, 300)) {
      state = addCommitment(state, update);
    }
  }

  for (const [index, message] of (Array.isArray(payload?.incomingMessages) ? payload.incomingMessages : []).slice(0, 8).entries()) {
    const channel = message?.channel === 'group' ? 'group' : 'private';
    let targetId = text(message?.targetId, 100);
    if (channel === 'private' && (!targetId || !state.threads[targetId])) {
      const contact = Object.values(state.contacts).find(row => row.name === message?.targetName || row.name === message?.sender);
      targetId = contact?.id || '';
    }
    if (channel === 'group' && (!targetId || !state.groups[targetId])) {
      const group = Object.values(state.groups).find(row => row.name === message?.targetName);
      targetId = group?.id || '';
    }
    if (!targetId) continue;
    const messageId = text(message?.id, 120) || (signature ? `${signature}-message-${index}` : '');
    const target = channel === 'group' ? state.groups[targetId] : state.threads[targetId];
    if (target?.messages?.some(row => messageId && row.id === messageId)) continue;
    try {
      state = appendMessage(state, channel, targetId, {
        id: messageId, sender: message?.sender || target.name, direction: 'in', text: message?.text,
      });
    } catch {}
  }

  for (const [index, change] of (Array.isArray(payload?.walletChanges) ? payload.walletChanges : []).slice(0, 10).entries()) {
    try {
      state = recordTransaction(state, {
        ...change,
        id: text(change?.id, 120) || (signature ? `${signature}-wallet-${index}` : ''),
      });
    } catch {}
  }

  for (const [index, moment] of (Array.isArray(payload?.moments) ? payload.moments : []).slice(0, 6).entries()) {
    const id = text(moment?.id, 120) || (signature ? `${signature}-moment-${index}` : makeId('moment'));
    if (!text(moment?.content, 800) || state.moments.some(row => row.id === id)) continue;
    state.moments.push({ id, author: text(moment?.author, 80), content: text(moment.content, 800), comments: [], time: Date.now() });
  }

  if (payload?.backstage && typeof payload.backstage === 'object') {
    state.backstage = normalizeBackstageState({
      ...state.backstage,
      ...payload.backstage,
      timeline: { ...state.backstage.timeline, ...(payload.backstage.timeline || {}) },
      updatedAt: Date.now(),
      sourceFloor: meta.messageId ?? null,
    });
  }
  state.sync = {
    ...state.sync,
    lastNarrativeMessageId: meta.messageId ?? state.sync.lastNarrativeMessageId,
    lastNarrativeSignature: signature || state.sync.lastNarrativeSignature,
    lastProvider: text(meta.provider, 30),
    lastStatus: text(meta.status, 120) || '同步完成',
    lastSyncedAt: Date.now(),
  };
  return normalizePhoneState(state);
}

export function buildAnimaDigest(phone, options = {}) {
  const state = normalizePhoneState(phone);
  const recentLimit = Math.max(3, Math.min(20, Number(options.recentLimit) || 10));
  const recentEvents = state.eventLedger.slice(-recentLimit).reduce((out, row) => {
    out[row.id] = {
      类型: row.type,
      时间: new Date(row.time).toLocaleString('zh-CN', { hour12: false }),
      内容: row.summary,
      状态: row.status,
    };
    return out;
  }, {});
  const commitments = Object.values(state.commitments)
    .filter(row => row.status !== '已完成' && row.status !== '已取消')
    .slice(-12)
    .reduce((out, row) => {
      out[row.id] = {
        对象: row.person,
        时间: row.at,
        地点: row.place,
        事项: row.subject,
        状态: row.status,
      };
      return out;
    }, {});
  const unread = {};
  for (const row of [...Object.values(state.threads), ...Object.values(state.groups)]) {
    if (Number(row.unread || 0) > 0) unread[row.name] = Number(row.unread);
  }
  const latestOrder = state.delivery.orders.at(-1);
  return {
    同步版本: SCHEMA_VERSION,
    最近事件: recentEvents,
    未完成约定: commitments,
    未读消息: unread,
    账户摘要: {
      微信余额: Number(state.wallet.wechat || 0),
      支付宝余额: Number(state.wallet.alipay || 0),
      银行余额: Number(state.wallet.bank || 0),
    },
    当前订单: latestOrder ? {
      订单ID: latestOrder.id,
      商家: latestOrder.restaurant,
      内容: latestOrder.item,
      状态: latestOrder.status,
      预计送达分钟: latestOrder.eta,
      最新通知: latestOrder.lastMessage || '',
    } : {},
    联系人摘要: Object.values(state.contacts).slice(0, 30).map(row => row.name),
    正在播放: state.music.playing ? `${state.music.playing.title} - ${state.music.playing.artist}` : '',
    同步状态: state.sync.lastStatus,
    最后同步时间: new Date().toLocaleString('zh-CN', { hour12: false }),
  };
}

export function compactContext(phone, channel, targetId, limit = 16) {
  const state = normalizePhoneState(phone);
  const target = channel === 'group' ? state.groups[targetId] : state.threads[targetId];
  if (!target) return [];
  return target.messages.slice(-Math.max(4, Math.min(40, limit))).map(row => ({
    role: row.direction === 'out' ? 'user' : 'assistant',
    content: `${row.sender}：${row.text}`,
  }));
}
