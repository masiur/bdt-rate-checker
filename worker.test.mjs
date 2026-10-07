import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { payouts, parseWiseGbp, parseNsave, calculate } from './worker.mjs';

test('incentive applies once; bank deduction follows incentive', () => {
  assert.deepEqual(payouts(10000, 2.5, 1.15), { baseBDT: 10000, incentiveBDT: 250, bankBDT: 10250, bkashBDT: 10250, bkashToBankBDT: 10132.13 });
  assert.equal(payouts(10000, 0, 0).bankBDT, 10000);
});
test('Wise uses quoted target and total fee; never substitutes another payment method', () => {
  const q = { payInMethod: 'BALANCE', payOutMethod: 'BALANCE', sourceCcy: 'USD', targetCcy: 'GBP', sourceAmount: 100, targetAmount: 73.12, midRate: .75, total: 2.5, variableFee: 1 };
  assert.equal(parseWiseGbp([q], 100).receivedGBP, 73.12);
  assert.equal(parseWiseGbp([q], 100).fee, 2.5);
  assert.throws(() => parseWiseGbp([{ ...q, payInMethod: 'SWIFT' }], 100));
  assert.throws(() => parseWiseGbp([{ ...q, targetAmount: null }], 100));
});
test('nsave preserves quoted payout instead of multiplying the rounded rate', () => {
  const n = { t: 10, p: { k: ['result'], v: [{ t: 10, p: { k: ['rate','fee','amount'], v: [{t:0,s:122.65},{t:0,s:0},{t:0,s:122653.86}] } }] } };
  assert.equal(parseNsave(n, 1000).receivedBDT, 122653.86);
  assert.throws(() => parseNsave({t:25}, 1000));
});
test('invalid inputs and methods never reach providers', async () => {
  for (const value of ['Infinity', 'NaN', '-1', '0', '', '1000001']) {
    assert.equal((await worker.fetch(new Request('https://example.com/convert?usd=' + value))).status, 400);
  }
  assert.equal((await worker.fetch(new Request('https://example.com/convert?usd=100', {method:'POST'}))).status, 405);
});
test('one failed provider does not hide other routes; GBP only uses iFAST', async () => {
  const providers = {
    direct: async () => { throw new Error('Unavailable'); },
    wiseGbp: async () => ({ receivedGBP: 75, fee: 1, rate: .76 }),
    ifast: async () => 160,
    nsave: async () => ({ receivedBDT: 12300, rate: 123, fee: 0 })
  };
  const r = await calculate({ amount: 100, currency: 'USD', incentive: 2.5, bankFee: 1.15, plan: 'FREE' }, providers);
  assert.equal(r.routes.length, 4);
  assert.equal(r.routes.filter(x => x.ok).length, 3);
  assert.equal(r.routes.find(x => x.id === 'wise-ifast').bankBDT, 12300);
  const gbp = await calculate({ amount: 100, currency: 'GBP', incentive: 0, bankFee: 0, plan:'FREE' }, providers);
  assert.equal(gbp.routes.length, 1);
  assert.equal(gbp.routes[0].baseBDT, 16000);
});

test('all providers failing returns explicit unavailable routes, not fabricated rates', async () => {
  const fail = async () => { throw new Error('offline'); };
  const r = await calculate({ amount: 100, currency: 'USD', incentive: 2.5, bankFee: 1.15, plan: 'PRO' }, { direct: fail, wiseGbp: fail, ifast: fail, nsave: fail });
  assert.equal(r.routes.length, 4);
  assert.ok(r.routes.every(x => !x.ok && x.bankBDT === undefined));
});

test('reject unsupported currencies, plans and nonfinite settings', async () => {
  for (const query of ['amount=100&currency=EUR', 'usd=100&plan=OTHER', 'usd=100&incentive=Infinity', 'usd=100&bankFee=-1']) {
    assert.equal((await worker.fetch(new Request('https://example.com/convert?' + query))).status, 400);
  }
});
