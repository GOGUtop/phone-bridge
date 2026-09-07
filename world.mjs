import { normalizePhoneState, mergeContacts, appendMessage, recordTransaction, addEvent, makeId, applyNarrativeUpdate } from './core.mjs';

export const SERVICE_NAMES = { taobao: '淘宝', jd: '京东', taxi: '打车', flight: '航班', hotel: '酒店', eleme: '饿了么', meituan: '美团外卖' };
export const clean = (value, max = 1600) => String(value ?? '').trim().slice(0, max);
export const hash = value => {
  let n = 2166136261;
  for (const c of String(value)) n = Math.imul(n ^ c.charCodeAt(0), 16777619);
  return (n >>> 0).toString(36);
};
export function ensureWorld(phone) {
  phone.world ||= {};
  for (const key of ['people','requests','sms','calls','orders','packets','voices','diaries','wardrobe','anniversaries','knowledge','npcPhones','journal']) {
    if (!Array.isArray(phone.world[key])) phone.world[key] = [];
  }
  phone.world.applied ||= {};
  phone.world.memory ||= { written: {}, status: '等待写入' };
  return phone;
}
export function validPerson(name) {
  const value = clean(name, 80);
  return /^[\p{L}][\p{L} .·・'-]{1,39}$/u.test(value)
    && !/(世界观|设定|目录|规则|流程|背景|关系网|公司|学院|学校|集团|组织|银行|外卖|快递|省|市|商场|角色卡|主角|联系人|用户|玩家|父亲|母亲|同事|朋友|工作|性格|姓名|年龄|身份|职业|费用|毕业后|成长环境)/.test(value);
}
export function extractPeople(entries, userName = '') {
  const people = new Map();
  for (const entry of entries) {
    if (entry.enabled === false || entry.disable) continue;
    const body = clean(entry.content, 40000);
    // Keys are triggers, never names. Accept explicit name fields and person profiles only.
    const add = (name, evidence, relation = '') => {
      name = clean(name).replace(/^["'「]|["'」]$/g, '').trim();
      if (!validPerson(name) || name === userName) return;
      people.set(name, { name, aliases: [], evidence: clean(evidence, 500), identity: clean(entry.comment || entry.name, 120), relationToUser: relation, known: Boolean(relation), source: '世界书证据' });
    };
    for (const m of body.matchAll(/(?:姓名|名字|人物名|角色名|name)\s*["']?\s*[:：]\s*["']?([^\n,，;；。"']{2,40})/gi)) add(m[1], m[0], /(?:与|是)\s*(?:\{\{user\}\}|用户|玩家)\s*(?:的)?\s*(家人|朋友|同学|同事|父亲|母亲|兄弟|姐妹|上司)/.exec(body)?.[1] || '');
    for (const m of body.matchAll(/(?:同学|同事|父亲|母亲|朋友|上司|妹妹|姐姐|哥哥|弟弟)\s*(?:名叫|叫做|叫|：|:)?\s*([\u3400-\u9fff]{2,4})(?=[，。；\s]|$)/g)) add(m[1], m[0]);
    const title = clean(entry.comment || entry.name).replace(/^(人物|角色|NPC)\s*[:：]\s*/i, '');
    const evidenceCount = [...body.matchAll(/(?:年龄|性别|职业|性格|外貌|身份)\s*[:：]/g)].length;
    if (evidenceCount >= 4) add(title, body.slice(0, 500));
  }
  return [...people.values()];
}
export function mergePeople(phone, people, userName) {
  let state = ensureWorld(normalizePhoneState(phone));
  for (const person of people || []) {
    if (!validPerson(person.name) || person.name === userName || !person.evidence) continue;
    const aliases=[...new Set([person.name,...(Array.isArray(person.aliases)?person.aliases:[])])].filter(n=>typeof n==='string'&&n!==userName&&n.length<60);
    const matchingPeople=state.world.people.filter(p => [p.name,...(p.aliases||[])].some(n=>aliases.includes(n)));
    const existing = matchingPeople[0];
    const row = { ...existing, ...person, name: clean(person.name, 80), aliases:[...new Set([...aliases,...matchingPeople.flatMap(p=>[p.name,...(p.aliases||[])])].filter(n=>n&&n!==person.name))] };
    if (existing) Object.assign(existing, row); else state.world.people.push(row);
    state.world.people=state.world.people.filter(p=>p===existing||!matchingPeople.includes(p));
    if (person.known === true || person.relationToUser) {
      state = mergeContacts(state, [row], { excludeNames: [userName] });
      const matches=Object.values(state.contacts).filter(c=>[row.name,...row.aliases].some(n=>[c.name,...(c.aliases||[])].includes(n)));
      const keep=matches.find(c=>c.id==='main')||matches[0];
      if(keep){
        const oldNames=[...new Set(matches.flatMap(c=>[c.name,...(c.aliases||[])]).concat(row.aliases))];
        keep.name=row.name;keep.aliases=oldNames.filter(n=>n!==row.name);keep.archived=false;keep.source=person.source||'世界书/正文证据';
        state.threads[keep.id].name=row.name;
        for(const other of matches.filter(c=>c.id!==keep.id)){
          const thread=state.threads[other.id];
          state.threads[keep.id].messages=[...new Map([...state.threads[keep.id].messages,...(thread?.messages||[])].map(m=>[m.id,m])).values()].sort((a,b)=>a.time-b.time);
          state.threads[keep.id].unread+=Number(thread?.unread||0);
          for(const p of state.world.packets)if(p.targetId===other.id&&p.channel!=='group')p.targetId=keep.id;
          delete state.contacts[other.id];delete state.threads[other.id];
        }
        const canon=n=>oldNames.includes(n)?row.name:n;
        for(const g of Object.values(state.groups))g.members=[...new Set(g.members.map(canon))];
        for(const r of state.world.journal)r.knownBy=[...new Set((r.knownBy||[]).map(canon))];
        for(const r of state.world.knowledge)r.knownBy=[...new Set((r.knownBy||[]).map(canon))];
      }
    }
  }
  return state;
}
export function logWorld(phone, type, summary, knownBy = [], sourceId = '') {
  ensureWorld(phone);
  const id = sourceId || makeId(type);
  if (phone.world.journal.some(r => r.id === id)) return;
  phone.world.journal.push({ id, type, summary: clean(summary, 4000), knownBy: [...new Set(knownBy.filter(Boolean))], floor: phone.sync?.lastNarrativeMessageId ?? null, time: Date.now() });
  addEvent(phone, { id, type, summary, sourceId: id });
}
export function createPayment(phone, { channel = 'private', targetId, amount, kind = '转账', count = 1, note = '', sender, direction = 'out', id = makeId('packet'), received = false }) {
  let state = ensureWorld(normalizePhoneState(phone));
  if (state.world.packets.some(r => r.id === id)) return state;
  const target = channel === 'group' ? state.groups[targetId] : state.threads[targetId];
  if (!target) throw new Error('请先选择真实会话');
  if(direction==='in'&&!(channel==='group'?target.members.includes(sender):target.name===sender))throw new Error('红包发送人不属于当前会话');
  const cents = Math.round(Number(amount) * 100);
  if (!Number.isSafeInteger(cents) || cents < 1) throw new Error('请输入有效金额');
  count = channel === 'group' && kind === '红包' ? Math.max(1, Math.floor(Number(count) || 1)) : 1;
  if (count > cents || count > 100) throw new Error('红包份数为 1 至 100，且每份至少一分钱');
  if (direction === 'out') state = recordTransaction(state, { id, account: 'wechat', amount: -cents / 100, counterparty: target.name, kind, note });
  state.world.packets.push({ id, channel, targetId, amount: cents / 100, remaining: cents, count, claimed: [], kind, note: clean(note), sender, direction, status: '待领取' });
  state = appendMessage(state, channel, targetId, { id: `msg-${id}`, sender, direction, text: `[${kind}] ¥${(cents / 100).toFixed(2)} ${note}`, packetId: id });
  if (received && direction === 'in') state = claimPayment(state, id, target.userName || '我');
  logWorld(state, 'payment_offer', `${sender}向${target.name}发出${kind} ¥${(cents/100).toFixed(2)}，${received ? '已领取' : '待领取'}`, [sender, ...(channel === 'group' ? target.members : [target.name])], `offer-${id}`);
  return state;
}
export function claimPayment(phone, id, userName) {
  let state = ensureWorld(normalizePhoneState(phone));
  const packet = state.world.packets.find(p => p.id === id);
  if (!packet || packet.remaining <= 0 || packet.claimed.some(p => p.name === userName)) return state;
  if (packet.direction === 'out' && (packet.channel !== 'group' || packet.kind !== '红包')) throw new Error('不能领取自己发出的私聊转账或红包');
  const slots = packet.count - packet.claimed.length;
  const cents = slots === 1 ? packet.remaining : Math.max(1, Math.floor(packet.remaining / slots));
  state = recordTransaction(state, { id: `claim-${id}-${hash(userName)}`, account: 'wechat', amount: cents / 100, kind: '领取' + packet.kind, counterparty: packet.sender });
  const updated = state.world.packets.find(p => p.id === id);
  updated.remaining -= cents;
  updated.claimed.push({ name: userName, amount: cents / 100 });
  updated.status = updated.remaining ? '部分领取' : '已领完';
  logWorld(state, 'payment_claim', `${userName}领取${packet.sender}的${packet.kind} ¥${(cents/100).toFixed(2)}`, [userName, packet.sender], `claim-${id}-${hash(userName)}`);
  return state;
}
export function acceptRequest(phone, id, accept) {
  let state = ensureWorld(normalizePhoneState(phone));
  const req = state.world.requests.find(r => r.id === id);
  if (!req || req.status !== '待处理') return state;
  req.status = accept ? '已接受' : '已拒绝';
  if (accept && req.type === 'group') {const groupId=req.groupId||id;const previous=state.groups[groupId];state.groups[groupId]={id:groupId,name:req.name,members:req.members||previous?.members||[],messages:previous?.messages||[],unread:previous?.unread||0};}
  else if (accept) state = mergeContacts(state, [{ name: req.name, source: '已接受申请', aliases: req.aliases || [] }]);
  logWorld(state, 'contact_request', `${req.status}${req.name}的${req.type === 'group' ? '群邀请' : '好友申请'}`, [req.name]);
  return state;
}
export function addServiceOrder(phone, input, userName = '我') {
  let state = ensureWorld(normalizePhoneState(phone));
  const id = input.id || makeId('service-order');
  if (state.world.orders.some(o => o.id === id)) return state;
  const app = SERVICE_NAMES[input.app] ? input.app : 'taobao';
  const amount = input.amount === null || input.amount === '' || input.amount === undefined ? null : Number(input.amount);
  if (amount !== null && (!Number.isFinite(amount) || amount < 0)) throw new Error('订单金额无效');
  let account = input.account;
  if (!account) account = amount !== null && state.wallet.wechat < amount ? 'alipay' : 'wechat';
  if (amount > 0 && !input.alreadyCharged) state = recordTransaction(state, { id: input.transactionId || `pay-${id}`, account, amount: -amount, counterparty: input.merchant || SERVICE_NAMES[app], kind: '订单支付', note: input.item });
  const row = { ...input, id, app, amount, account, item: clean(input.item, 200), merchant: clean(input.merchant || SERVICE_NAMES[app]), status: clean(input.status || (app === 'taxi' ? '等待接单' : app === 'flight' ? '已订票' : '已付款')), time: Date.now() };
  if (!row.item) throw new Error('订单内容不能为空');
  state.world.orders.push(row);
  logWorld(state, 'order', `${userName}在${SERVICE_NAMES[app]}下单${row.item}；${row.status}；金额${amount === null ? '未明确' : amount}`, [userName, row.merchant], id);
  return state;
}
export function mergeRecords(current, incoming, keyFn) {
  const map = new Map(current.map(r => [keyFn(r), r]));
  for (const row of incoming || []) {
    if (!row || typeof row !== 'object') continue;
    const key = keyFn(row);
    if (!key) continue;
    map.set(key, { ...map.get(key), ...row });
  }
  return [...map.values()];
}
export function applyWorldDelta(phone, payload, meta = {}) {
  let state = ensureWorld(normalizePhoneState(phone));
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') throw new Error('后台结果不是有效对象');
  if (Object.hasOwn(state.world.applied, meta.signature)) return state;
  payload = structuredClone(payload);
  const user = meta.userName || '我';
  state = mergePeople(state, payload.people, user);
  for (const group of payload.groups || []) {
    if (!group.name || !Array.isArray(group.members)) continue;
    const id = group.id || `group-${hash(group.name)}`;
    if (group.alreadyMember === true) {const previous=state.groups[id];state.groups[id]={...previous,...group,id,members:[...new Set(group.members)],unread:previous?.unread||0,messages:previous?.messages||[]};}
    else payload.requests = [...(payload.requests || []), { ...group, type: 'group', groupId: id }];
  }
  const previous = structuredClone(state.backstage);
  const contacts = (payload.contacts || []).filter(p => p.known === true && p.evidence && validPerson(p.name));
  const incomingMessages = (payload.incomingMessages || []).filter(m => {
    if (m.sender === user) return false;
    if (m.channel === 'group') return Object.values(state.groups).some(g => (g.id === m.targetId || g.name === m.targetName) && g.members.includes(m.sender));
    return Object.values(state.contacts).some(c => !c.archived && c.name === m.sender);
  });
  state = applyNarrativeUpdate(state, { ...payload, contacts, incomingMessages, walletChanges: [], moments: [] }, meta);
  ensureWorld(state);
  for (const key of ['promises','secrets','offscreen','world']) state.backstage[key] = mergeRecords(previous[key], payload.backstage?.[key], r => r.id || r.name || r.title || r.subject || r.content);
  let n = 0;
  const stable = (type, row) => row.id || `${meta.signature}-${type}-${hash(JSON.stringify(row))}`;
  for (const req of payload.requests || []) {
    if (!req.name || req.name === user) continue;
    const id = stable('request', req);
    if (!state.world.requests.some(r => r.id === id || (r.name === req.name && r.status === '待处理'))) state.world.requests.push({ ...req, id, status: '待处理' });
  }
  for (const msg of payload.sms || []) {
    if (!msg.text || !msg.sender) continue;
    const id = stable('sms', msg);
    if (!state.world.sms.some(r => r.id === id)) state.world.sms.push({ ...msg, id, direction: 'in', time: Date.now(), read: false });
    logWorld(state, 'sms', `${msg.sender}短信：${msg.text}`, [user, msg.sender], id);
  }
  for (const call of payload.calls || []) {
    if (!call.name) continue;
    const id = stable('call', call);
    if (!state.world.calls.some(r => r.id === id)) state.world.calls.push({ ...call, id, status: '来电中', messages: [], time: Date.now() });
    logWorld(state, 'call', `${call.name}向${user}来电`, [user, call.name], id);
  }
  for (const order of payload.orders || []) state = addServiceOrder(state, { ...order, id: stable('order', order) }, user);
  for (const update of payload.serviceOrderUpdates || []) {
    const order = state.world.orders.find(o => o.id === update.id);
    if (order && update.status) { Object.assign(order, update); logWorld(state, 'order_update', `${order.item}：${order.status}`, [user, order.merchant], `${meta.signature}-order-update-${order.id}`); }
  }
  for (const tx of payload.walletChanges || []) {
    if (!Number.isFinite(Number(tx.amount)) || !Number(tx.amount)) continue;
    // Order-linked payments are charged by addServiceOrder; never also apply them here.
    if (tx.orderId && state.world.orders.some(o => o.id === tx.orderId)) continue;
    const id = stable('wallet', tx);
    const account = tx.account || (Number(tx.amount) > 0 ? 'bank' : state.wallet.wechat >= -Number(tx.amount) ? 'wechat' : 'alipay');
    state = recordTransaction(state, { ...tx, id, account });
    if (account === 'wechat' && /转账|红包/.test(tx.kind || '')) {
      const target = Object.values(state.threads).find(t => t.name === tx.counterparty);
      if (target) state = appendMessage(state, 'private', target.id, { id: `receipt-${id}`, sender: Number(tx.amount) > 0 ? tx.counterparty : user, direction: Number(tx.amount) > 0 ? 'in' : 'out', text: `[${tx.kind}] ¥${Math.abs(Number(tx.amount)).toFixed(2)} · 已完成` });
    }
  }
  for (const packet of payload.packets || []) state = createPayment(state, { ...packet, id: stable('packet', packet), direction: 'in' });
  for(const claim of payload.packetClaims || []){
    const packet=state.world.packets.find(p=>p.id===claim.packetId);
    if(!packet||packet.direction!=='out'||!packet.remaining||claim.name===user||packet.claimed.some(c=>c.name===claim.name))continue;
    const target=packet.channel==='group'?state.groups[packet.targetId]:state.threads[packet.targetId];
    if(!(packet.channel==='group'?target?.members.includes(claim.name):target?.name===claim.name))continue;
    const slots=packet.count-packet.claimed.length;
    const cents=slots===1?packet.remaining:Math.max(1,Math.floor(packet.remaining/slots));
    packet.remaining-=cents;packet.claimed.push({name:claim.name,amount:cents/100});packet.status=packet.remaining?'部分领取':'已领完';
    logWorld(state,'payment_claim',`${claim.name}领取${packet.sender}的${packet.kind} ¥${(cents/100).toFixed(2)}`,[claim.name,packet.sender],`claim-${packet.id}-${hash(claim.name)}`);
  }
  for (const moment of payload.moments || []) {
    if (!moment.content || moment.author === user) continue;
    const id = stable('moment', moment);
    if (!state.moments.some(r => r.id === id)) state.moments.push({ ...moment, id, time: Date.now(), comments: moment.comments || [], likes: moment.likes || [] });
    logWorld(state, 'moment', `${moment.author}发布朋友圈：${moment.content}`, [moment.author, ...(moment.seenBy || [])], id);
  }
  for (const reaction of payload.reactions || []) {
    const moment = state.moments.find(m => m.id === reaction.momentId);
    if (!moment || !reaction.author || reaction.author === user) continue;
    if (reaction.like) moment.likes = [...new Set([...(moment.likes || []), reaction.author])];
    if (reaction.text) moment.comments = mergeRecords(moment.comments || [], [{ ...reaction, id: stable('reaction', reaction) }], r => r.id || `${r.author}:${r.text}`);
    logWorld(state, 'moment_reaction', `${reaction.author}回应${moment.author}的朋友圈：${reaction.text || '点赞'}`, [reaction.author, moment.author], stable('reaction', reaction));
  }
  for (const key of ['voices','diaries','wardrobe','anniversaries','knowledge','npcPhones']) {
    const rows = (payload[key] || []).filter(r => r && typeof r === 'object' && !(key === 'diaries' && r.name === user));
    const enriched = rows.map(r => ({ ...r, id: r.id || (['wardrobe','anniversaries','knowledge'].includes(key) ? `${key}-${hash(r.name + '|' + (r.item || r.title || r.fact))}` : `${meta.signature}-${key}-${n++}`), floor: meta.messageId, time: Date.now() }));
    if(key==='wardrobe')for(const old of state.world.wardrobe)if(enriched.some(r=>r.name===old.name&&r.wearing&&r.item!==old.item))old.wearing=false;
    state.world[key] = key === 'voices' ? enriched : mergeRecords(state.world[key], enriched, r => r.id);
    for (const row of enriched) {
      const knownBy=['voices','diaries','npcPhones'].includes(key)?[row.name,...(Array.isArray(row.knownBy)?row.knownBy:[])]:row.knownBy?.length?row.knownBy:row.participants||[user,row.name];
      logWorld(state,key,JSON.stringify(row),knownBy,`${row.id}-${hash(JSON.stringify(row))}`);
    }
  }
  state.world.applied[meta.signature] = meta.messageId;
  for (const row of state.world.journal) if (row.floor === undefined) row.floor = meta.messageId;
  return state;
}
export function worldSnapshot(phone, userName = '') {
  const state = ensureWorld(phone);
  const conversations = [...Object.values(state.threads), ...Object.values(state.groups)].filter(t=>t.messages.length).sort((a,b)=>b.messages.at(-1).time-a.messages.at(-1).time).slice(0,12).map(t=>({id:t.id,name:t.name,members:t.members,messages:t.messages.slice(-8)}));
  return { userName, conversations, commitments:Object.values(state.commitments), recentEvents:state.world.journal.slice(-20), contacts: Object.values(state.contacts).filter(p=>!p.archived).map(({id,name,aliases})=>({id,name,aliases})), groups: Object.values(state.groups).map(({id,name,members}) => ({id,name,members})), wallet: {wechat:state.wallet.wechat,alipay:state.wallet.alipay,bank:state.wallet.bank,transactions:state.wallet.transactions.slice(-15)}, orders: [...state.delivery.orders, ...state.world.orders].slice(-20).map(({messages,...o})=>o), packets: state.world.packets.filter(p => p.remaining > 0).slice(-20), moments: state.moments.slice(-10), backstage: state.backstage, voices: state.world.voices, diaries: state.world.diaries.slice(-10), wardrobe: state.world.wardrobe.slice(-60), anniversaries: state.world.anniversaries, knowledge: state.world.knowledge.slice(-30), npcPhones: state.world.npcPhones.slice(-10) };
}
export function worldPrompt() {
  return `你负责当前故事的手机和幕后生活。只输出合法JSON对象。每轮只新增本轮事件，不重复总结旧事件。正文已发生事实优先；没有明确结果的计划不能提前完成。NPC具有自己的人设、目标、日程和知情范围；允许零条或多条自主通讯与朋友圈，但不要机械刷屏。禁止替用户发消息、发朋友圈、接受邀请或写日记。
已存在的人物用相同名字和id；联系人关键词不是人名。未知人物只能发好友申请、群邀请或短信，不能直接进入微信会话。group.alreadyMember仅限正文/设定明确用户已在该群，否则发邀请。phone和线下是同一世界。NPC领取用户已发红包/转账，另外返回packetClaims:[{packetId:"已有红包id",name:"领取人姓名"}]，不可因此再次扣款。用户心声只能依据用户明确表达的心理，不擅自替用户决定感情。
只允许明确金额的交易；工资进银行。订单在orders处理支付，不要在walletChanges再扣一次；UI里已经记过的交易和消息不重复。待领取红包用packets，已完成交易用walletChanges，绝不同时填两处。所有订单状态按剧情时间和正文事实推进。历史衣物、纪念日、约定保留；已完成约定改变状态。秘密、心声和日记默认本人知情，公开资料必须明确seenBy/knownBy，不能让其他NPC全知。NPC手机为后台状态，仅当正文展示或查看手机时设置revealedToUser=true。
返回以下需要变化的字段，backstage包含最新现场；没有新内容返回空数组。必须至少有backstage或一个事件数组：
{"people":[{"name":"","aliases":[],"identity":"","evidence":"原文证据","relationToUser":"","known":false}],"groups":[{"id":"","name":"","members":[],"alreadyMember":false}],"requests":[{"type":"friend|group","name":"","avatar":"","source":"","text":"","members":[]}],"incomingMessages":[{"channel":"private|group","targetId":"","targetName":"","sender":"","text":"","autonomous":true}],"sms":[{"sender":"","text":""}],"calls":[{"name":"","number":""}],"orders":[{"id":"稳定订单ID","app":"taobao|jd|meituan|eleme|taxi|flight|hotel","item":"","merchant":"","amount":null,"status":"","account":"wechat"}],"serviceOrderUpdates":[{"id":"","status":""}],"orderUpdates":[{"orderId":"","status":"","lastMessage":""}],"walletChanges":[{"id":"稳定交易ID","account":"wechat|alipay|bank","amount":0,"counterparty":"","kind":""}],"packets":[{"sender":"","channel":"private|group","targetId":"","amount":1,"kind":"红包|转账","count":1}],"commitmentUpdates":[],"moments":[{"author":"","content":"","seenBy":[]}],"reactions":[{"momentId":"","author":"","like":true,"text":""}],"voices":[{"name":"","content":"","knownBy":[]}],"diaries":[{"name":"","content":"","knownBy":[]}],"wardrobe":[{"name":"","item":"","wearing":true}],"anniversaries":[{"title":"","date":"YYYY-MM-DD","participants":[]}],"knowledge":[{"fact":"","knownBy":[],"source":""}],"npcPhones":[{"name":"","content":"","revealedToUser":false}],"backstage":{"timeline":{"date":"","time":"","location":"","weather":""},"present":[],"clothing":[],"promises":[],"secrets":[],"offscreen":[],"world":[]}}`;
}
