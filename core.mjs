export const SCHEMA_VERSION = 1;

const clone = value => JSON.parse(JSON.stringify(value));
const text = (value, max = 500) => String(value ?? '').trim().slice(0, max);

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
      main: { id: 'main', name: contact, subtitle: '剧情联系人', color: '#4f7cac' },
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
  return result;
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
  const account = ['wechat', 'alipay', 'bank'].includes(transaction?.account) ? transaction.account : 'wechat';
  const amount = Number(transaction?.amount);
  if (!Number.isFinite(amount) || amount === 0) throw new Error('金额必须为非零数字');
  const balance = Number(state.wallet[account] || 0) + amount;
  if (balance < 0) throw new Error('余额不足');
  state.wallet[account] = Math.round(balance * 100) / 100;
  const row = {
    id: makeId('tx'),
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
      商家: latestOrder.restaurant,
      内容: latestOrder.item,
      状态: latestOrder.status,
      预计送达分钟: latestOrder.eta,
    } : {},
    正在播放: state.music.playing ? `${state.music.playing.title} - ${state.music.playing.artist}` : '',
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
