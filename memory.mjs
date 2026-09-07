import { ensureWorld, hash } from './world.mjs';

export async function animaModule(file) {
  const urls = [...document.querySelectorAll('script[src],link[href]')].map(n => n.src || n.href);
  urls.push(...performance.getEntriesByType('resource').map(e => e.name));
  const asset = urls.find(url => /\/Anima-Memory-System\//i.test(url));
  const root = asset?.match(/^(.*\/Anima-Memory-System\/)/i)?.[1] || `${location.origin}/scripts/extensions/third-party/Anima-Memory-System/`;
  return import(`${root}scripts/${file}.js`);
}
export function memoryRecords(phone, userName) {
  ensureWorld(phone);
  const rows = new Map(phone.world.journal.map(r => [r.id, r]));
  for (const [channel, targets] of [['private',phone.threads], ['group',phone.groups]]) for (const target of Object.values(targets)) for (const msg of target.messages) {
    rows.set(msg.id, { id: msg.id, type: channel, summary: `${target.name}会话，${msg.sender}：${msg.text}`, knownBy: channel === 'group' ? [userName, ...target.members] : [userName, target.name], time: msg.time });
  }
  const sourceIds=new Set(rows.keys());
  for (const m of phone.moments) {
    const readers=[...new Set([m.author,...(m.seenBy||[]),...(m.likes||[]),...(m.comments||[]).map(c=>c.author)])].filter(Boolean);
    rows.set(m.id,{id:m.id,summary:`${m.author}的朋友圈：${m.content}`,knownBy:readers,time:m.time});
    for (const [i,c] of (m.comments||[]).entries())rows.set(c.id||`${m.id}-comment-${i}`,{id:c.id||`${m.id}-comment-${i}`,summary:`${c.author}评论${m.author}的朋友圈：${c.text}`,knownBy:[...new Set([...readers,c.author])],time:c.time||m.time});
  }
  for (const e of phone.eventLedger) if (!sourceIds.has(e.sourceId) && !sourceIds.has(e.id)) rows.set(e.id, { ...e, knownBy: [userName, e.actor, e.target].filter(Boolean) });
  return [...rows.values()];
}
export function formatMemory(row) {
  return `[手机世界事件 ${row.id}] ${row.summary}\n知情者：${(row.knownBy || []).join('、') || '未确认；不可自动赋予任何NPC'}；只有通过剧情中的观察、通讯、展示或转述才能扩散。`;
}
export function localRecall(rows, query, limit = 12) {
  const text = String(query).toLowerCase();
  const terms = [...new Set(text.match(/[a-z0-9]{2,}|[\u3400-\u9fff]{2}/g) || [])];
  return rows.map((r,i) => ({ r, i, score: terms.reduce((s,t) => s + (r.summary.toLowerCase().includes(t) ? 1 : 0),0) })).sort((a,b) => b.score-a.score || b.i-a.i).slice(0,limit).map(x=>x.r);
}
export function peerRecall(phone, userName, peers, query) {
  const rows = memoryRecords(phone, userName).filter(row => peers.some(peer => row.knownBy?.includes(peer)));
  return localRecall(rows, query, 16).map(formatMemory).join('\n\n');
}
export async function syncMemory(phone, scope, userName, isCurrent, save) {
  const memory = ensureWorld(phone).world.memory;
  const rows = memoryRecords(phone,userName);
  const pending = rows.filter(r => memory.written[r.id] !== hash(formatMemory(r)));
  if (!pending.length) return;
  try {
    const { callBackend } = await animaModule('db_api');
    if (!isCurrent()) return;
    const collectionId = `apb_${scope}`;
    for (let offset = 0; offset < pending.length; offset += 12) {
      if (!isCurrent()) return;
      const batch = pending.slice(offset,offset+12);
      const text = batch.map(formatMemory).join('\n\n');
      const batchKey = hash(batch.map(r => `${r.id}:${hash(formatMemory(r))}`).join('|'));
      memory.batchIds ||= {};
      const uuid = memory.batchIds[batchKey] ||= crypto.randomUUID();
      const result = await callBackend('/insert', { text, tags: ['小手机桥',scope], timestamp: Date.now(), collectionId, uuid, index: null, batch_id: batchKey, bm25Config: { enabled: false } });
      if (!result?.vectorId) throw new Error(result?.error || 'Anima 未返回向量写入凭据');
      for (const row of batch) memory.written[row.id] = hash(formatMemory(row));
      memory.status = `Anima 已写入 ${Object.keys(memory.written).length} 条记录`;
      save();
    }
  } catch (e) { memory.status = `完整记录已保存，Anima 向量待重试：${e.message}`; save(); }
}
export async function recallMemory(phone, scope, userName, query) {
  const rows = memoryRecords(phone,userName);
  let selected = localRecall(rows,query);
  const memory = ensureWorld(phone).world.memory;
  if (Object.keys(memory.written).length) try {
    const { callBackend } = await animaModule('db_api');
    const response = await callBackend('/query', { searchText: query, bm25SearchText: query, ignore_ids: [], sessionId: scope, chatContext: { ids: [`apb_${scope}`], strategy: { enabled: false, base_count: 8, min_score: 0.2 } }, kbContext: { ids: [], strategy: {} }, bm25Configs: [] });
    const matches = response?.chat_results || response?.merged_chat_results;
    if (!Array.isArray(matches)) throw new Error('检索响应无结果列表');
    // Only accept archive IDs still belonging to this chat; never inject raw unverified backend text.
    const content = JSON.stringify(matches);
    const recalled = rows.filter(r => content.includes(r.id));
    selected = [...new Map([...recalled,...selected].map(r=>[r.id,r])).values()].slice(0,18);
    const vectorCount = selected.filter(row => recalled.some(r => r.id === row.id)).length;
    memory.recallStatus = `Anima 召回 ${vectorCount} 条；本地补充 ${selected.length-vectorCount} 条`;
  } catch(e) { memory.recallStatus = `本地检索可用；Anima 检索待恢复：${e.message}`; }
  return selected.map(formatMemory).join('\n\n');
}
