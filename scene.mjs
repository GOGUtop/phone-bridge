import {normalizeBackstageState} from './core.mjs';

// Scene occupancy is a snapshot; durable plot records are incremental.
export function validateScene(payload) {
  const raw=payload?.backstage??payload?.幕后状态;
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('结果缺少现场状态，未覆盖旧记录');
  const scene=normalizeBackstageState(raw);
  scene.present=scene.present.filter(r=>typeof r.name==='string'&&r.name.trim());
  scene.sceneEmpty=payload.sceneEmpty===true||raw.sceneEmpty===true;
  if(!scene.present.length&&!scene.sceneEmpty)throw new Error('现场人物未提取到，不能判定为无人');
  if(scene.present.length)scene.sceneEmpty=false;
  return scene;
}

export function mergeScene(previous, scene, floor) {
  const old=normalizeBackstageState(previous),next=normalizeBackstageState(scene);
  for(const key of ['date','time','location','weather'])next.timeline[key] ||= old.timeline[key];
  const presentNames=new Set(next.present.map(r=>r.name));
  next.clothing=[...new Map([...old.clothing,...next.clothing].filter(r=>presentNames.has(r.name)).map(r=>[r.name,r])).values()];
  for(const key of ['promises','secrets','offscreen','world']){
    const identity=r=>r.id||r.name||r.subject||r.title||r.content||JSON.stringify(r);
    next[key]=[...new Map([...old[key],...next[key]].map(r=>[identity(r),r])).values()];
  }
  next.offscreen=next.offscreen.filter(r=>!next.present.some(p=>p.name===r.name));
  next.updatedAt=Date.now();next.sourceFloor=floor;
  return next;
}
