import { SERVICE_NAMES, ensureWorld, createPayment, claimPayment, acceptRequest, addServiceOrder, logWorld, clean } from './world.mjs';
import { makeId, recordTransaction } from './core.mjs';
import { peerRecall } from './memory.mjs';
export const EXTRA_APPS = { sms: '短信', calls: '电话', alipay: '支付宝', bank: '银行', taobao: '淘宝', jd: '京东', taxi: '打车', flight: '航班', hotel: '酒店', orders: '订单' };
export const EXTRA_ICONS = { sms: 'comment-sms', calls: 'phone', alipay: 'wallet', bank: 'building-columns', taobao: 'bag-shopping', jd: 'cart-shopping', taxi: 'taxi', flight: 'plane', hotel: 'bed', orders: 'receipt' };
export function createWorldUI(host) {
  const { runtime, escapeHtml: e, money, appHeader: header, render, savePhone, bridgeToAnima, context, serverRequest, parseAgentJson } = host;
  const phone = () => ensureWorld(runtime.phone);
  const user = () => context()?.name1 || '我';
  const world = () => phone().world;
  const catalog = () => (world().catalog ||= {});
  const audio = new Audio();
  const stopAudio = () => {audio.pause();audio.removeAttribute('src');audio.load();};
  const eventTypes=context()?.event_types||{};
  context()?.eventSource?.on(eventTypes.CHAT_CHANGED||'chat_id_changed',stopAudio);
  const done = async reason => { savePhone(); render(); host.renderBackstage(); await bridgeToAnima(reason); };
  const field = (name, placeholder, type='text', extra='') => `<input name="${name}" type="${type}" placeholder="${placeholder}" ${extra}>`;
  function modal(title, html) {
    document.getElementById('apb-action-dialog')?.remove();
    const dialog = document.createElement('dialog'); dialog.id='apb-action-dialog'; dialog.className='apb-action-dialog';
    dialog.innerHTML=`<header><strong>${e(title)}</strong><button type="button" data-w-close title="关闭"><i class="fa-solid fa-xmark"></i></button></header>${html}`;
    document.body.append(dialog); dialog.showModal();
    dialog.addEventListener('click',event=>{ if(event.target.closest('[data-w-close]')) dialog.close(); else click(event).catch(host.error); });
    dialog.addEventListener('submit',event=>{ event.preventDefault(); submit(event.target).catch(host.error); });
    dialog.addEventListener('close',()=>dialog.remove(),{once:true});
  }
  const close = () => document.getElementById('apb-action-dialog')?.close();
  function requests() { return world().requests.filter(r=>r.status==='待处理').map(r=>`<article class="apb-request"><strong>${e(r.name)} · ${r.type==='group'?'群邀请':'好友申请'}</strong><p>${e(r.text || r.source || '')}</p><button data-w-request="${e(r.id)}" data-accept="yes">接受</button><button data-w-request="${e(r.id)}" data-accept="no">拒绝</button></article>`).join(''); }
  function packet(row) {
    const p = world().packets.find(p=>p.id===row.packetId);
    if(!p)return e(row.text);
    return `<button class="apb-packet" data-w-claim="${e(p.id)}"><i class="fa-solid fa-gift"></i><strong>${e(p.kind)} ${money(p.amount)}</strong><small>${e(p.status)} · ${e(p.note || '心意已送达')}</small></button>`;
  }
  function payments(id,group) {
    return `<div class="apb-chat-tools"><button type="button" data-w-payment="${e(id)}" data-group="${group}" title="转账或红包"><i class="fa-solid fa-gift"></i></button><button type="button" data-w-call="${e((group ? phone().groups : phone().threads)[id]?.name)}" title="拨打电话"><i class="fa-solid fa-phone"></i></button><button type="button" data-apb-open="wallet" title="微信支付"><i class="fa-solid fa-wallet"></i></button></div>`;
  }
  function account(app) {
    const key=app==='wallet'?'wechat':app;
    const title=app==='wallet'?'微信支付':EXTRA_APPS[app];
    return `${header(title,true)}<main class="apb-app-body"><div class="apb-account-total"><small>余额</small><strong>${money(phone().wallet[key])}</strong></div>
    ${app==='wallet'?'<button data-apb-open="wechat">返回微信会话</button>':`<form class="apb-stack-form" data-w-account="${key}">${field('counterparty','收款人','text','required')}${field('amount','金额','number','min="0.01" step="0.01" required')}${field('note','备注')}<button>转账</button></form>`}
    ${app==='bank'?`<h3>银行入账</h3><form class="apb-stack-form" data-apb-income>${field('source','工资 / 奖金来源','text','required')}${field('amount','到账金额','number','min="0.01" step="0.01" required')}<button>记录入账</button></form>`:''}
    <h3>账单</h3>${phone().wallet.transactions.filter(t=>t.account===key).slice().reverse().map(t=>`<div class="apb-order"><span>${e(t.kind)}<small>${e(t.counterparty)} · ${e(t.note)}</small></span><b>${t.amount>0?'+':''}${money(t.amount)}</b></div>`).join('') || '<p class="apb-empty">暂无账单</p>'}</main>`;
  }
  function sms() {
    const peer=runtime.route.id;
    if(peer) {
      for(const m of world().sms)if(m.sender===peer)m.read=true;
      return `${header(peer,true)}<main class="apb-chat-body">${world().sms.filter(m=>m.sender===peer||m.peer===peer).map(m=>`<div class="apb-message ${m.direction==='out'?'is-out':'is-in'}"><p>${e(m.text)}</p></div>`).join('')}</main><form class="apb-compose" data-w-sms="${e(peer)}">${field('text','短信内容','text','required')}<button ${runtime.busy?'disabled':''}>发送</button></form>`;
    }
    const peers=[...new Set(world().sms.slice().reverse().map(m=>m.peer||m.sender))];
    return `${header('短信',true)}<main class="apb-app-body"><button data-w-new-sms title="新短信"><i class="fa-solid fa-pen-to-square"></i></button>${peers.map(p=>`<button class="apb-thread-row" data-w-sms-peer="${e(p)}"><span class="apb-avatar">${e(p.slice(0,1))}</span><span><strong>${e(p)}</strong><small>${e(world().sms.filter(m=>(m.peer||m.sender)===p).at(-1)?.text)}</small></span></button>`).join('') || '<p class="apb-empty">暂无短信</p>'}</main>`;
  }
  function calls() {
    return `${header('电话',true)}<main class="apb-app-body"><form class="apb-inline-form" data-w-dial>${field('name','联系人或号码','text','required')}<button title="拨号"><i class="fa-solid fa-phone"></i></button></form>${world().calls.slice().reverse().map(c=>`<div class="apb-order"><span><strong>${e(c.name)}</strong><small>${e(c.status)} · ${new Date(c.time).toLocaleString()}</small></span><button data-w-call-view="${e(c.id)}" title="查看通话"><i class="fa-solid fa-phone"></i></button></div>`).join('')}</main>`;
  }
  function callView(id) {
    const c=world().calls.find(c=>c.id===id); if(!c)return;
    const active=c.status==='通话中';
    modal(c.name,`<div class="apb-call-avatar"><i class="fa-solid fa-user"></i></div><p>${e(c.status)}</p><div class="apb-call-log">${(c.messages||[]).map(m=>`<p><b>${e(m.sender)}：</b>${e(m.text)}</p>`).join('')}</div>${c.status==='来电中'?`<button data-w-call-status="${id}" data-status="通话中">接听</button><button data-w-call-status="${id}" data-status="已拒接">拒绝</button>`:active?`<form class="apb-compose" data-w-call-message="${id}">${field('text','说点什么','text','required')}<button ${runtime.busy?'disabled':''}>说话</button></form><button data-w-call-status="${id}" data-status="已结束">挂断</button>`:''}`);
  }
  async function reply(mode,peer,input,history=[]) {
    const known=world().knowledge.filter(k=>(k.knownBy||[]).includes(peer));
    const person=world().people.find(p=>p.name===peer);
    const messages=[{role:'system',content:`你是故事中的${peer}，通过${mode}与${user()}交互。只返回JSON {"text":"回复"}。保持人物性格、现实服务职责及知情边界。系统短信/验证码不进行闲聊回复。你仅知道自己参与的通讯与以下已知事实：${JSON.stringify(known)}。人物资料：${JSON.stringify(person||{})}。当前时间地点：${JSON.stringify(phone().backstage.timeline)}。不要凭空声称已经完成支付、订单或挂断等动作。`},...history.slice(-16).map(m=>({role:m.sender===user()?'user':'assistant',content:m.text})),{role:'user',content:input}];
    messages.splice(1,0,{role:'system',content:`该人物的相关历史：${peerRecall(phone(),user(),[peer],input)}`});
    const result=await serverRequest('/json',{method:'POST',body:JSON.stringify({messages})});
    return clean(parseAgentJson(result.content).text,3000);
  }
  function services(app) {
    const labels={taxi:'出发地 → 目的地',flight:'出发地 / 目的地 / 日期',hotel:'城市 / 酒店 / 入住日期',taobao:'搜索商品',jd:'搜索商品'};
    const offers=(catalog()[app]||[]).map((o,i)=>`<article class="apb-order"><span><strong>${e(o.item)}</strong><small>${e(o.merchant)} · ${money(o.amount)}</small><small>${e(o.detail)}</small></span><button data-w-offer="${i}" data-app="${app}" title="下单"><i class="fa-solid fa-cart-plus"></i></button></article>`).join('');
    return `${header(EXTRA_APPS[app],true)}<main class="apb-app-body"><form class="apb-inline-form" data-w-search="${app}">${field('query',labels[app]||'商品或服务','text','required')}<button ${runtime.busy?'disabled':''} title="搜索"><i class="fa-solid fa-magnifying-glass"></i></button></form>${offers}<details><summary>自定义订单</summary><form class="apb-stack-form" data-w-service="${app}">${field('item','商品或行程','text','required')}${field('merchant','商家 / 平台 / 司机（可选）')}${field('amount','订单金额','number','step="0.01" min="0.01" required')}<select name="account"><option value="">自动选择余额</option><option value="wechat">微信支付</option><option value="alipay">支付宝</option><option value="bank">银行卡</option></select><button>确认下单</button></form></details><button data-apb-open="orders">查看订单</button>${orderRows(app)}</main>`;
  }
  function orderRows(app='') {
    const rows=[...phone().delivery.orders.map(o=>({...o,app:o.app||'eleme',merchant:o.restaurant})),...world().orders].filter(o=>!app||o.app===app).sort((a,b)=>(b.time||b.placedAt)-(a.time||a.placedAt));
    return rows.map(o=>`<article class="apb-order"><span><strong>${e(o.item)}</strong><small>${e(SERVICE_NAMES[o.app]||o.app)} · ${e(o.merchant)} · ${o.amount===null?'金额待确认':money(o.amount)}</small><small>${e(o.status)} ${e(o.lastMessage||'')}</small></span><button data-w-order-chat="${e(o.id)}" title="联系商家"><i class="fa-solid fa-comment"></i></button></article>`).join('') || '<p class="apb-empty">暂无订单</p>';
  }
  function screen(app) {
    if(app==='music')return `${header('网易云音乐',true)}<main class="apb-app-body apb-music"><div class="apb-music-hero"><div class="apb-record ${phone().music.playing?'is-playing':''}"><i class="fa-solid fa-music"></i></div><strong>${e(phone().music.playing?.title||'我的歌单')}</strong><span>${e(phone().music.playing?.artist||'')}</span></div><div data-w-audio></div>${phone().music.playlist.map(s=>`<button class="apb-song" data-w-song="${e(s.id)}"><i class="fa-solid fa-music"></i><span><strong>${e(s.title)}</strong><small>${e(s.artist)}${s.url?'':' · 未关联音源'}</small></span></button>`).join('')}<details><summary>添加歌曲</summary><form class="apb-stack-form" data-w-song-form>${field('title','歌名','text','required')}${field('artist','歌手')}${field('url','可播放音频链接（可选）','url')}<button>加入歌单</button></form></details></main>`;
    if(['wallet','alipay','bank'].includes(app))return account(app);
    if(app==='sms')return sms();
    if(app==='calls')return calls();
    if(['taobao','jd','taxi','flight','hotel'].includes(app))return services(app);
    if(app==='orders')return `${header('全部订单',true)}<main class="apb-app-body">${orderRows()}</main>`;
    return null;
  }
  function orderView(id){const o=[...world().orders,...phone().delivery.orders].find(o=>o.id===id);if(o)modal(o.merchant||o.restaurant,`<p>${e(o.item)} · ${e(o.status)}</p>${(o.messages||[]).map(m=>`<p>${e(m.sender)}：${e(m.text)}</p>`).join('')}<form class="apb-stack-form" data-w-order-message="${e(o.id)}">${field('text','向商家或司机发送消息','text','required')}<button>发送</button></form>`);}
  async function submit(form) {
    const data=Object.fromEntries(new FormData(form));
    const scope=runtime.currentChatKey;
    const stillHere=()=>runtime.currentChatKey===scope;
    if(form.hasAttribute('data-w-song-form')){if(data.url&&!/^https?:\/\//i.test(data.url))throw new Error('音源须为 HTTP 或 HTTPS 音频链接');phone().music.playlist.push({id:makeId('song'),title:clean(data.title,120),artist:clean(data.artist,120),url:data.url});await done('playlist');return true;}
    if(form.hasAttribute('data-w-search')) {
      if(runtime.busy)return true;
      const app=form.dataset.wSearch;runtime.busy=true;form.querySelector('button').disabled=true;
      try {
        const result=await serverRequest('/json',{method:'POST',body:JSON.stringify({messages:[{role:'system',content:`你是虚构故事的${SERVICE_NAMES[app]}服务目录。按场景和搜索词提供4个可选商品/酒店/行程，合理报价，不能声称查询真实商业服务，不执行购买。当前时间地点：${JSON.stringify(phone().backstage.timeline)}。只返回JSON {"offers":[{"item":"商品或行程","merchant":"商家","amount":10,"detail":"规格或时间"}]}`},{role:'user',content:data.query}]})});
        if(stillHere()){const rows=parseAgentJson(result.content).offers;if(!Array.isArray(rows))throw new Error('目录返回格式无效');catalog()[app]=rows.filter(o=>o.item&&Number.isFinite(Number(o.amount))&&Number(o.amount)>0).map(o=>({...o,amount:Number(o.amount)}));savePhone();}
      }finally{runtime.busy=false;if(stillHere())render();}
      return true;
    }
    if(form.hasAttribute('data-w-payment-form')) {
      runtime.phone=createPayment(phone(),{...data,channel:form.dataset.channel,targetId:form.dataset.target,sender:user()});close();await done('payment');return true;
    }
    if(form.hasAttribute('data-w-account')) {
      const account=form.dataset.wAccount;
      if(!Number.isFinite(Number(data.amount))||Number(data.amount)<=0)throw new Error('转账金额必须大于零');
      runtime.phone=recordTransaction(phone(),{account,amount:-Number(data.amount),counterparty:data.counterparty,kind:'转账',note:data.note}); await done('account_transfer');return true;
    }
    if(form.hasAttribute('data-w-service')) {runtime.phone=addServiceOrder(phone(),{...data,app:form.dataset.wService},user());close();await done('service_order');return true;}
    if(form.hasAttribute('data-w-dial')) { await startCall(data.name);return true; }
    if(form.hasAttribute('data-w-sms')||form.hasAttribute('data-w-call-message')||form.hasAttribute('data-w-order-message')) {
      if(runtime.busy)return true;
      const call=world().calls.find(c=>c.id===form.dataset.wCallMessage);
      if(call&&call.status!=='通话中')throw new Error('通话已结束');
      const order=[...world().orders,...phone().delivery.orders].find(o=>o.id===form.dataset.wOrderMessage);
      const peer=call?.name || order?.merchant || order?.restaurant || form.dataset.wSms;
      const row={id:makeId('message'),sender:user(),peer,text:clean(data.text),direction:'out',time:Date.now()};
      const messages=call?(call.messages||=[]):order?(order.messages||=[]):world().sms;
      messages.push(row);logWorld(phone(),call?'call':order?'merchant':'sms',`${user()}对${peer}说：${row.text}`,[user(),peer],row.id);
      savePhone(); runtime.busy=true; form.querySelector('button').disabled=true;
      try {
        const text=await reply(call?'电话':order?'订单会话':'短信',peer,row.text,messages.filter(m=>m!==row&&(!m.peer||m.peer===peer)));
        if(!stillHere())return true;
        if(call&&world().calls.find(c=>c.id===call.id)?.status!=='通话中')return true;
        if(text){const response={id:makeId('reply'),sender:peer,peer,text,direction:'in',time:Date.now()};messages.push(response);logWorld(phone(),'communication',`${peer}：${text}`,[user(),peer],response.id);}
        // Host normalization may have replaced the object during persistence.
        const merge=current=>[...new Map([...(current||[]),...messages].map(m=>[m.id,m])).values()].sort((a,b)=>a.time-b.time);
        if(call){const current=world().calls.find(c=>c.id===call.id);current.messages=merge(current.messages);}
        else if(order){const current=[...world().orders,...phone().delivery.orders].find(o=>o.id===order.id);current.messages=merge(current.messages);}
        else world().sms=merge(world().sms);
      } finally {runtime.busy=false;if(stillHere()){await done('communication');if(call&&world().calls.find(c=>c.id===call.id)?.status==='通话中')callView(call.id);else if(order&&document.querySelector('[data-w-order-message]')?.dataset.wOrderMessage===order.id)orderView(order.id);}}
      return true;
    }
    if(form.hasAttribute('data-w-comment')) {
      const m=phone().moments.find(m=>m.id===form.dataset.wComment);if(!m)return true;
      m.comments||=[];m.comments.push({id:makeId('comment'),author:user(),text:clean(data.text),time:Date.now()});
      logWorld(phone(),'moment_comment',`${user()}评论${m.author}：${data.text}`,[user(),m.author]);close();await done('moment_comment');return true;
    }
    return false;
  }
  async function startCall(name) {
    const row={id:makeId('call'),name:clean(name,80),status:'通话中',direction:'out',messages:[],time:Date.now()};
    world().calls.push(row);logWorld(phone(),'call',`${user()}拨打${row.name}的电话`,[user(),row.name],row.id);await done('outgoing_call');callView(row.id);
  }
  async function click(event) {
    const b=event.target.closest('button');if(!b)return false;
    if(b.dataset.wSong){const song=phone().music.playlist.find(s=>s.id===b.dataset.wSong);if(!song)return true;
      if(phone().music.playing?.id===song.id){stopAudio();phone().music.playing=null;}else{phone().music.playing=song;if(song.url){audio.src=song.url;try{await audio.play();}catch(err){host.error(new Error('音源不可播放：'+err.message));}}else stopAudio();}
      logWorld(phone(),'music',`${user()}${phone().music.playing?'选择收听《'+song.title+'》':'停止音乐'}`,[user()]);await done('music');return true;}
    if(b.hasAttribute('data-w-offer')){const offer=catalog()[b.dataset.app]?.[Number(b.dataset.wOffer)];if(offer)modal('确认订单',`<p>${e(offer.item)} · ${money(offer.amount)}</p><form class="apb-stack-form" data-w-service="${e(b.dataset.app)}"><input type="hidden" name="item" value="${e(offer.item)}"><input type="hidden" name="merchant" value="${e(offer.merchant)}"><input type="hidden" name="amount" value="${offer.amount}"><select name="account"><option value="">自动选择余额</option><option value="wechat">微信支付</option><option value="alipay">支付宝</option><option value="bank">银行卡</option></select><button>确认支付</button></form>`);return true;}
    if(b.hasAttribute('data-w-payment')) {const group=b.dataset.group==='true';const target=(group?phone().groups:phone().threads)[b.dataset.wPayment];modal(target.name,`<form class="apb-stack-form" data-w-payment-form data-channel="${group?'group':'private'}" data-target="${e(target.id)}"><select name="kind">${group?'':'<option>转账</option>'}<option>红包</option></select>${field('amount','金额','number','min="0.01" step="0.01" required')}${group?field('count','红包份数','number','min="1" max="100" value="1" required'):''}${field('note','备注')}<button>确认发送</button></form>`);return true;}
    if(b.dataset.wClaim){runtime.phone=claimPayment(phone(),b.dataset.wClaim,user());await done('claim');return true;}
    if(b.dataset.wRequest){runtime.phone=acceptRequest(phone(),b.dataset.wRequest,b.dataset.accept==='yes');await done('request');return true;}
    if(b.dataset.wSmsPeer){runtime.route={app:'sms',id:b.dataset.wSmsPeer};render();return true;}
    if(b.hasAttribute('data-w-new-sms')){const peer=prompt('短信接收人或号码');if(peer){runtime.route={app:'sms',id:peer};render();}return true;}
    if(b.dataset.wCall){await startCall(b.dataset.wCall);return true;}
    if(b.dataset.wCallView){callView(b.dataset.wCallView);return true;}
    if(b.dataset.wCallStatus){const c=world().calls.find(c=>c.id===b.dataset.wCallStatus);if(c){c.status=b.dataset.status;logWorld(phone(),'call',`${user()}与${c.name}的电话：${c.status}`,[user(),c.name]);await done('call');if(c.status==='通话中')callView(c.id);else close();}return true;}
    if(b.dataset.wOrderChat){orderView(b.dataset.wOrderChat);return true;}
    if(b.dataset.wLike){const m=phone().moments.find(m=>m.id===b.dataset.wLike);if(m){m.likes||=[];m.likes=m.likes.includes(user())?m.likes.filter(n=>n!==user()):[...m.likes,user()];logWorld(phone(),'moment_like',`${user()}${m.likes.includes(user())?'点赞':'取消点赞'}${m.author}的朋友圈`,[user(),m.author]);await done('moment_like');}return true;}
    if(b.dataset.wComment){modal('朋友圈评论',`<form class="apb-stack-form" data-w-comment="${e(b.dataset.wComment)}">${field('text','评论内容','text','required')}<button>发送</button></form>`);return true;}
    return false;
  }
  function incomingCall() {const c=world().calls.find(c=>c.status==='来电中');if(c&&!document.getElementById('apb-action-dialog'))callView(c.id);}
  function afterRender(){const slot=document.querySelector('[data-w-audio]');if(slot&&audio.getAttribute('src')){audio.controls=true;audio.style.width='100%';slot.append(audio);}}
  return { screen, click, submit, requests, packet, payments, incomingCall, afterRender };
}
