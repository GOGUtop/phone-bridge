import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANIMA_PROMPT_RULE_MARKER,
  ANIMA_PROMPT_RULE_TITLE,
  addCommitment,
  applyAnimaDigest,
  applyNarrativeUpdate,
  appendMessage,
  buildAnimaDigest,
  defaultPhoneState,
  mergeContacts,
  mergeAnimaPromptRule,
  normalizeBackstageState,
  placeOrder,
  recordTransaction,
} from '../core.mjs';

test('private chat persists both directions and creates bridge events', () => {
  let phone = defaultPhoneState('林澈');
  phone = appendMessage(phone, 'private', 'main', { sender: '我', direction: 'out', text: '五点见' });
  phone = appendMessage(phone, 'private', 'main', { sender: '林澈', direction: 'in', text: '好，我会准时到。' });
  assert.equal(phone.threads.main.messages.length, 2);
  assert.equal(phone.threads.main.unread, 1);
  assert.equal(phone.eventLedger.length, 2);
});

test('commitments survive in the compact Anima digest', () => {
  let phone = defaultPhoneState('林澈');
  phone = addCommitment(phone, { id: 'meet-1', person: '林澈', at: '今日 17:00', place: '咖啡馆', subject: '见面' });
  const digest = buildAnimaDigest(phone);
  assert.deepEqual(digest.未完成约定['meet-1'], {
    对象: '林澈', 时间: '今日 17:00', 地点: '咖啡馆', 事项: '见面', 状态: '未完成',
  });
});

test('wallet rejects overspending and records valid income', () => {
  let phone = defaultPhoneState();
  assert.throws(() => recordTransaction(phone, { account: 'wechat', amount: -9999 }), /余额不足/);
  phone = recordTransaction(phone, { account: 'bank', amount: 5000, kind: '工资', counterparty: '公司' });
  assert.equal(phone.wallet.bank, 11800);
  assert.equal(phone.wallet.transactions.at(-1).kind, '工资');
});

test('placing an order deducts balance and exposes current order', () => {
  let phone = defaultPhoneState();
  const before = phone.wallet.wechat;
  phone = placeOrder(phone, 'r1', '番茄牛腩饭', 'wechat');
  assert.equal(phone.wallet.wechat, before - 28);
  assert.equal(phone.delivery.orders.at(-1).status, '商家已接单');
  assert.equal(buildAnimaDigest(phone).当前订单.内容, '番茄牛腩饭');
});

test('Anima digest updates the matching local order', () => {
  let phone = placeOrder(defaultPhoneState(), 'r1', '番茄牛腩饭', 'wechat');
  const order = phone.delivery.orders.at(-1);
  phone = applyAnimaDigest(phone, { 当前订单: { 订单ID: order.id, 状态: '已送达', 最新通知: '已放在门口' } });
  assert.equal(phone.delivery.orders.at(-1).status, '已送达');
  assert.equal(phone.delivery.orders.at(-1).lastMessage, '已放在门口');
});

test('narrative reconciliation is idempotent for messages and wallet changes', () => {
  const payload = {
    contacts: [{ name: '周宁' }],
    incomingMessages: [{ channel: 'private', targetName: '周宁', sender: '周宁', text: '我到了' }],
    walletChanges: [{ account: 'bank', amount: 100, kind: '退款', counterparty: '平台' }],
  };
  let phone = applyNarrativeUpdate(defaultPhoneState('林澈'), payload, { signature: 'floor-9', messageId: 9 });
  phone = applyNarrativeUpdate(phone, payload, { signature: 'floor-9', messageId: 9 });
  const contact = Object.values(phone.contacts).find(row => row.name === '周宁');
  assert.equal(phone.threads[contact.id].messages.length, 1);
  assert.equal(phone.wallet.transactions.length, 1);
  assert.equal(phone.wallet.bank, 6900);
});

test('contact aliases merge without creating duplicate threads', () => {
  let phone = mergeContacts(defaultPhoneState('林澈'), [{ name: '周宁', aliases: ['小宁'] }]);
  phone = mergeContacts(phone, [{ name: '小宁', aliases: ['周宁'] }]);
  assert.equal(Object.values(phone.contacts).filter(row => row.name === '周宁' || row.name === '小宁').length, 1);
  assert.equal(Object.keys(phone.threads).length, 2);
});

test('backstage normalization always keeps all seven sections', () => {
  const backstage = normalizeBackstageState({ timeline: { time: '17:00' }, present: [{ name: '林澈', action: '等候' }] });
  assert.equal(backstage.timeline.time, '17:00');
  assert.deepEqual(backstage.present, [{ name: '林澈', action: '等候' }]);
  for (const key of ['clothing', 'promises', 'secrets', 'offscreen', 'world']) assert.deepEqual(backstage[key], []);
});

test('Anima card adaptation preserves existing rules and appends a final guard', () => {
  const existing = [
    { role: 'system', title: '原有规则', content: '必须保留' },
    { role: 'user', title: '增量剧情', content: '{{chat_context}}' },
  ];
  const result = mergeAnimaPromptRule(existing, `${ANIMA_PROMPT_RULE_MARKER}\n规则正文`);
  assert.equal(result.ready, true);
  assert.equal(result.changed, true);
  assert.equal(result.rules[0].content, '必须保留');
  assert.equal(result.rules[1].content, '{{chat_context}}');
  assert.equal(result.rules[2].title, ANIMA_PROMPT_RULE_TITLE);
});

test('Anima card adaptation updates its own rule without duplication', () => {
  const existing = [
    { role: 'system', title: '原有规则', content: '保留' },
    { role: 'system', title: ANIMA_PROMPT_RULE_TITLE, content: `${ANIMA_PROMPT_RULE_MARKER}\n旧版` },
  ];
  const updated = mergeAnimaPromptRule(existing, `${ANIMA_PROMPT_RULE_MARKER}\n新版`);
  const repeated = mergeAnimaPromptRule(updated.rules, `${ANIMA_PROMPT_RULE_MARKER}\n新版`);
  assert.equal(updated.rules.length, 2);
  assert.equal(updated.rules[0].content, '保留');
  assert.match(updated.rules[1].content, /新版/);
  assert.equal(repeated.changed, false);
});

test('Anima card adaptation waits instead of writing an incomplete prompt list', () => {
  assert.deepEqual(mergeAnimaPromptRule([], `${ANIMA_PROMPT_RULE_MARKER}\n规则`), { changed: false, ready: false, rules: [] });
});
