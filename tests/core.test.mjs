import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addCommitment,
  appendMessage,
  buildAnimaDigest,
  defaultPhoneState,
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
