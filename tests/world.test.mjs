import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPhoneState, mergeContacts, appendMessage, addCommitment, buildAnimaDigest } from '../core.mjs';
import { ensureWorld, extractPeople, createPayment, claimPayment, acceptRequest, addServiceOrder, applyWorldDelta } from '../world.mjs';
import { memoryRecords, localRecall, formatMemory } from '../memory.mjs';
test('worldbook triggers are not contacts; explicit profiles preserve names',()=>{
 const rows=extractPeople([{key:['成长环境','公司'],content:'姓名：周宁\n年龄：26\n性格：开朗\n职业：设计师'},{key:['工资'],comment:'公司',content:'职业：设计师\n年龄：26\n性别：女\n性格：开朗'}]);
 assert.deepEqual(rows.map(r=>r.name),['周宁']);
});
test('payment is delivered to selected thread and debited exactly once',()=>{
 let p=mergeContacts(defaultPhoneState('林澈'),[{name:'周宁'}]);const id=Object.values(p.contacts).find(c=>c.name==='周宁').id;
 p=createPayment(p,{id:'gift',targetId:id,amount:20,sender:'阿遥'});
 p=createPayment(p,{id:'gift',targetId:id,amount:20,sender:'阿遥'});
 assert.equal(p.wallet.wechat,500);assert.equal(p.threads.main.messages.length,0);assert.equal(p.threads[id].messages[0].packetId,'gift');
});
test('received red packet remains pending until claimed and credits once',()=>{
 let p=createPayment(defaultPhoneState('林澈'),{id:'incoming',targetId:'main',sender:'林澈',direction:'in',amount:36,kind:'红包'});
 assert.equal(p.wallet.wechat,520);p=claimPayment(p,'incoming','阿遥');p=claimPayment(p,'incoming','阿遥');assert.equal(p.wallet.wechat,556);
});
test('outgoing group packet NPC claims do not credit user and preserve total',()=>{
 let p=createPayment(defaultPhoneState('林澈'),{id:'groupgift',targetId:'story',channel:'group',sender:'阿遥',amount:10,kind:'红包',count:2});
 p=applyWorldDelta(p,{packetClaims:[{packetId:'groupgift',name:'林澈'}]},{signature:'one',userName:'阿遥',messageId:1});
 assert.equal(p.wallet.wechat,510);assert.equal(p.world.packets[0].remaining,500);
});
test('friend request does not create contact until accepted',()=>{
 let p=applyWorldDelta(defaultPhoneState('林澈'),{requests:[{id:'req',name:'周宁',type:'friend'}]},{signature:'1',userName:'阿遥'});
 assert.equal(Object.values(p.contacts).some(c=>c.name==='周宁'),false);
 p=acceptRequest(p,'req',true);assert.equal(Object.values(p.contacts).some(c=>c.name==='周宁'),true);
});
test('narrative order and wallet record linked to same order only charge once',()=>{
 let p=applyWorldDelta(defaultPhoneState(),{orders:[{id:'purchase',app:'jd',item:'游戏机',amount:100}],walletChanges:[{orderId:'purchase',amount:-100}]},{signature:'floor',userName:'阿遥'});
 p=applyWorldDelta(p,{orders:[{id:'purchase',app:'jd',item:'游戏机',amount:100}]},{signature:'floor',userName:'阿遥'});
 assert.equal(p.wallet.wechat,420);assert.equal(p.world.orders.length,1);
});
test('unknown order price is not invented, insufficient default account falls back',()=>{
 let p=addServiceOrder(defaultPhoneState(),{id:'unknown',app:'taobao',item:'电脑',amount:null});assert.equal(p.wallet.wechat,520);
 p=addServiceOrder(p,{id:'costly',app:'taobao',item:'衣服',amount:600});assert.equal(p.wallet.alipay,260);
});
test('wardrobe and diary history survive empty subsequent updates; no automatic user diary',()=>{
 let p=applyWorldDelta(defaultPhoneState(),{diaries:[{name:'林澈',content:'秘密计划'},{name:'阿遥',content:'不应自动生成'}],wardrobe:[{name:'林澈',item:'黑外套',wearing:true}]},{signature:'1',userName:'阿遥',messageId:1});
 p=applyWorldDelta(p,{diaries:[],wardrobe:[{name:'林澈',item:'白衬衫',wearing:true}]},{signature:'2',userName:'阿遥',messageId:2});
 assert.equal(p.world.diaries.length,1);assert.equal(p.world.wardrobe.length,2);assert.equal(p.world.wardrobe[0].wearing,false);
});
test('old phone conversation survives more than 200 messages and is retrievable',()=>{
 let p=defaultPhoneState('林澈');p=appendMessage(p,'private','main',{sender:'林澈',direction:'in',text:'五点在咖啡馆见'});
 for(let i=0;i<205;i++)p=appendMessage(p,'private','main',{sender:'阿遥',text:`今天的话题${i}`});
 p=addCommitment(p,{id:'appointment',person:'林澈',at:'17:00',subject:'咖啡馆见面'});
 const records=memoryRecords(ensureWorld(p),'阿遥');const recalled=localRecall(records,'五点咖啡馆见面');
 assert(recalled.some(r=>r.summary.includes('五点')));assert(formatMemory(recalled.find(r=>r.summary.includes('五点'))).includes('阿遥、林澈'));
 assert(buildAnimaDigest(p).未完成约定.appointment);
});
test('first narrative floor is idempotent and failed deltas never mutate original state',()=>{
 const original=ensureWorld(defaultPhoneState('林澈'));
 const payload={sms:[{sender:'银行',text:'你好'}]};
 const p=applyWorldDelta(original,payload,{signature:'zero',messageId:0,userName:'阿遥'});
 const again=applyWorldDelta(p,payload,{signature:'zero',messageId:0,userName:'阿遥'});
 assert.equal(again.world.sms.length,1);assert.equal(again.world.journal[0].floor,0);
 assert.throws(()=>applyWorldDelta(original,{orders:[{item:'电脑',amount:90000}]},{signature:'fail',messageId:1}),/余额不足/);
 assert.equal(original.world.orders.length,0);assert.equal(original.wallet.wechat,520);
});
test('private diary and conversations are filtered before a different NPC reply',async()=>{
 const {peerRecall}=await import('../memory.mjs');
 let p=applyWorldDelta(defaultPhoneState('林澈'),{diaries:[{name:'林澈',content:'秘密暗号是蓝莓'}]},{signature:'secret',messageId:1,userName:'阿遥'});
 p=appendMessage(p,'private','main',{sender:'林澈',direction:'in',text:'周五咖啡馆见'});
 assert.match(peerRecall(p,'阿遥',['林澈'],'蓝莓周五'),/蓝莓/);
 assert.doesNotMatch(peerRecall(p,'阿遥',['周宁'],'蓝莓周五'),/蓝莓|周五/);
});
