import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {defaultPhoneState,mergeContacts,appendMessage,normalizeBackstageState} from '../core.mjs';
import {mergePeople,ensureWorld,createPayment} from '../world.mjs';
import {verifiedRoster,applyRoster} from '../roster.mjs';
import {validateScene,mergeScene} from '../scene.mjs';
import {memoryUuid} from '../memory.mjs';
test('UUID creation works on HTTP without randomUUID and with no crypto API',()=>{
  for(const cryptoApi of [{getRandomValues:a=>webcrypto.getRandomValues(a)},null]){
    const ids=Array.from({length:100},()=>memoryUuid(cryptoApi));
    assert.equal(new Set(ids).size,100);
    for(const id of ids)assert.match(id,/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  }
});
test('Chinese scene fields and object maps retain names, clothing and mood',()=>{
  const scene=validateScene({幕后状态:{现场人物:{林澈:{动作:'等候',心情:'平静'}},衣着状态:[{姓名:'林澈',衣着:'黑色外套'}],时间地点:{地点:'咖啡馆'}}});
  assert.equal(scene.present[0].name,'林澈');assert.equal(scene.present[0].action,'等候');assert.equal(scene.present[0].mood,'平静');assert.equal(scene.clothing[0].outfit,'黑色外套');
  assert.equal(scene.timeline.location,'咖啡馆');
});
test('empty or nameless scene is rejected unless explicitly confirmed empty',()=>{
  assert.throws(()=>validateScene({backstage:{present:[]}}),/不能判定为无人/);
  assert.throws(()=>validateScene({backstage:{present:[{action:'等候'}]}}));
  assert.equal(validateScene({backstage:{present:[]},sceneEmpty:true}).sceneEmpty,true);
});
test('scene repair preserves long-term plots but removes offscreen duplicates',()=>{
  const old=normalizeBackstageState({promises:[{subject:'五点见'}],secrets:[{content:'未揭晓'}],offscreen:[{name:'林澈'}]});
  const next=mergeScene(old,validateScene({backstage:{present:[{name:'林澈'}]}}),4);
  assert.equal(next.promises.length,1);assert.equal(next.secrets.length,1);assert.equal(next.offscreen.length,0);assert.equal(next.sourceFloor,4);
  assert.equal(old.offscreen.length,1);
});
test('roster uses prose evidence, rejects fabricated people and preserves contextual groups',()=>{
  const source='林澈被朋友叫作阿澈。周宁与林澈同属项目组。';
  const roster=verifiedRoster({people:[{name:'林澈',aliases:['阿澈'],evidence:'林澈被朋友叫作阿澈。'},{name:'周宁',evidence:'周宁与林澈同属项目组。'},{name:'张三',evidence:'虚构'}],mainCharacter:'林澈',groups:[{name:'项目协作群',members:['阿澈','周宁','不存在'],evidence:'周宁与林澈同属项目组。',alreadyMember:true}]},source,'阿遥');
  let p=applyRoster(defaultPhoneState('权力世界-九爷'),roster,'阿遥','权力世界-九爷');
  assert.deepEqual(Object.values(p.contacts).filter(c=>!c.archived).map(c=>c.name).sort(),['周宁','林澈']);
  const g=Object.values(p.groups).find(g=>g.name==='项目协作群');assert.deepEqual(g.members,['林澈','周宁']);
  g.messages.push({id:'old',text:'旧群消息'});p=applyRoster(p,roster,'阿遥','权力世界-九爷');assert.equal(p.groups[g.id].messages[0].text,'旧群消息');
});
test('alias consolidation preserves threads, unread count and packet ownership',()=>{
  let p=mergeContacts(defaultPhoneState('林澈'),[{name:'阿澈'}]);const alias=Object.values(p.contacts).find(c=>c.name==='阿澈').id;
  p=appendMessage(p,'private','main',{sender:'林澈',text:'以前的对话',direction:'in'});
  p=appendMessage(p,'private',alias,{sender:'阿澈',text:'另一个称呼下的对话',direction:'in'});
  p=createPayment(p,{id:'gift',targetId:alias,amount:10,sender:'阿遥'});
  p=mergePeople(p,[{name:'林澈',aliases:['阿澈'],known:true,evidence:'林澈又叫阿澈'}],'阿遥');
  assert.equal(Object.values(p.contacts).length,1);assert.equal(p.threads.main.messages.length,3);assert.equal(p.world.packets[0].targetId,'main');assert.equal(p.wallet.wechat,510);
});
test('story card placeholder is not exposed as a person',()=>{
  const p=applyRoster(ensureWorld(defaultPhoneState('权力世界-九爷')),{people:[],groups:[],mainCharacter:''},'阿遥','权力世界-九爷');assert.equal(p.contacts.main.archived,true);assert.ok(p.threads.main);
});
test('separate person records are consolidated when a verified alias is supplied',()=>{
 let p=mergePeople(defaultPhoneState('林澈'),[{name:'林澈',known:true,evidence:'林澈'},{name:'阿澈',known:true,evidence:'阿澈'}],'阿遥');
 p=mergePeople(p,[{name:'林澈',aliases:['阿澈'],known:true,evidence:'林澈又名阿澈'}],'阿遥');assert.equal(p.world.people.length,1);
});
