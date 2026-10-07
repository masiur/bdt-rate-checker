// One-file Cloudflare module Worker. No keys, bindings, or build step required.
const NSAVE = 'https://www.nsave.com';
let nsaveEndpoint;
const round = n => Math.round((n + Number.EPSILON) * 100) / 100;
function number(value, name, positive = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || (positive ? value <= 0 : value < 0)) throw new Error('Invalid ' + name + ' from provider');
  return value;
}
async function remote(url, headers = {}, asText = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'BDT-Rate-Checker/1.0', ...headers }, signal: controller.signal });
    if (!response.ok) throw new Error('Provider returned HTTP ' + response.status);
    return await (asText ? response.text() : response.json());
  } catch (e) {
    if (controller.signal.aborted) throw new Error('Provider timed out. Try again.');
    throw e;
  } finally { clearTimeout(timer); }
}
function endpoint(base, params) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url;
}
export function payouts(baseBDT, incentive, bankFee) {
  number(baseBDT, 'BDT payout', true);
  const base = round(baseBDT);
  const bonus = round(base * incentive / 100);
  const received = round(base + bonus);
  return { baseBDT: base, incentiveBDT: bonus, bankBDT: received, bkashBDT: received, bkashToBankBDT: round(received * (1 - bankFee / 100)) };
}
export function parseWiseGbp(json, amount) {
  const q = Array.isArray(json) && json.find(q => q.payInMethod === 'BALANCE' && q.payOutMethod === 'BALANCE');
  if (!q || q.sourceCcy !== 'USD' || q.targetCcy !== 'GBP' || q.sourceAmount !== amount) throw new Error('Wise balance conversion quote unavailable');
  return { receivedGBP: number(q.targetAmount, 'GBP payout', true), fee: number(q.total, 'Wise total fee'), rate: number(q.midRate, 'Wise rate', true) };
}
// Decode only the small Seroval value subset used by nsave's public calculator.
// Never evaluate provider JavaScript or use its hard-coded demonstration rates.
function decode(node, depth = 0) {
  if (!node || depth > 12) throw new Error('Unexpected nsave quote format');
  if (node.t === 0) return number(node.s, 'nsave number');
  if (node.t === 1) return String(node.s);
  if (node.t === 2 && node.s === 1) return undefined;
  if (node.t === 10 || node.t === 11) {
    if (!Array.isArray(node.p?.k) || !Array.isArray(node.p?.v) || node.p.k.length !== node.p.v.length) throw new Error('Unexpected nsave object');
    const obj = Object.create(null);
    node.p.k.forEach((k, i) => { obj[k] = decode(node.p.v[i], depth + 1); });
    return obj;
  }
  throw new Error('nsave could not return a live quote');
}
export function parseNsave(json, amount) {
  const value = decode(json);
  if (value.error || !value.result) throw new Error('nsave quote unavailable');
  const q = value.result;
  const fee = number(q.fee, 'nsave fee');
  if (fee >= amount) throw new Error('Amount is too small for nsave fees');
  return { receivedBDT: number(q.amount, 'nsave payout', true), rate: number(q.rate, 'nsave rate', true), fee };
}
function serializeInput(data) {
  return { t: { t: 10, i: 0, p: { k: ['data'], v: [{ t: 10, i: 1, p: { k: Object.keys(data), v: Object.values(data).map(s => ({ t: typeof s === 'number' ? 0 : 1, s })) } }] } }, f: 63, m: [] };
}
async function getNsaveEndpoint() {
  if (nsaveEndpoint && Date.now() < nsaveEndpoint.expires) return nsaveEndpoint.id;
  const html = await remote(NSAVE + '/send-money-home', { Accept: 'text/html' }, true);
  const asset = html.match(/(?:href|src)=["'](\/assets\/SendMoneyCalculatorPage-[\w-]+\.js)["']/)?.[1];
  if (!asset) throw new Error('nsave calculator changed; adapter update needed');
  const script = await remote(NSAVE + asset, { Accept: 'text/javascript' }, true);
  const id = script.match(/\.handler\(\w+\([`"']([a-f0-9]{64})[`"']\)\)/)?.[1];
  if (!id) throw new Error('nsave quote endpoint changed; adapter update needed');
  nsaveEndpoint = { id, expires: Date.now() + 3600000 };
  return id;
}
const providers = {
  async direct(amount) {
    const json = await remote(endpoint('https://wise.com/gateway/v4/comparisons', { sendAmount: amount, sourceCurrency: 'USD', targetCurrency: 'BDT', payInMethod: 'DIRECT_DEBIT', providers: 'wise' }));
    const q = json.providers?.find(p => p.alias === 'wise')?.quotes?.[0];
    if (!q || json.sourceCurrency !== 'USD' || json.targetCurrency !== 'BDT') throw new Error('Wise direct quote unavailable');
    return { rate: number(q.rate, 'Wise rate', true), fee: number(q.fee, 'Wise fee'), receivedBDT: number(q.receivedAmount, 'Wise payout', true) };
  },
  async wiseGbp(amount) {
    return parseWiseGbp(await remote(endpoint('https://wise.com/gateway/v1/price', { sourceAmount: amount, sourceCurrency: 'USD', targetCurrency: 'GBP', profileType: 'PERSONAL', profileCountry: 'GB', markers: 'FCF_PRICING' })), amount);
  },
  async ifast(currency) {
    const q = await remote(endpoint('https://www.ifastgb.com/api/fx/landing-scb-ezr-fx-rates', { baseCurrency: currency, termCurrency: 'BDT' }));
    if (q.sellCurrency !== currency || q.buyCurrency !== 'BDT') throw new Error('iFAST returned a different currency pair');
    return number(q.normalRate, 'iFAST rate', true);
  },
  async nsave(amount, plan) {
    const id = await getNsaveEndpoint();
    try {
      const url = endpoint(NSAVE + '/_serverFn/' + id, { payload: JSON.stringify(serializeInput({ sourceCurrency: 'USD', targetCurrency: 'BDT', amount, pricingTier: plan })) });
      return parseNsave(await remote(url, { 'x-tsr-serverFn': 'true', 'Sec-Fetch-Site': 'same-origin' }), amount);
    } catch (e) { nsaveEndpoint = undefined; throw e; }
  }
};
export async function calculate(input, api = providers) {
  const { amount, currency, incentive, bankFee, plan } = input;
  const tasks = [];
  function route(id, name, note, task) {
    tasks.push((async () => {
      try {
        const q = await task();
        return { id, name, ok: true, note, ...q, ...payouts(q.receivedBDT, incentive, bankFee) };
      } catch (e) { return { id, name, ok: false, error: e.message || 'Quote unavailable' }; }
    })());
  }
  if (currency === 'USD') {
    route('wise-direct', 'Wise → BDT', 'Original DIRECT_DEBIT comparison quote; bank and bKash projections use the same base quote.', () => api.direct(amount));
    route('wise-ifast', 'Wise → GBP → iFAST', 'Wise balance conversion + iFAST public GBP rate. No extra transfer fee assumed; bKash rate may differ.', async () => {
      const [wise, rate] = await Promise.all([api.wiseGbp(amount), api.ifast('GBP')]);
      return { receivedBDT: wise.receivedGBP * rate, rate, fee: wise.fee, receivedGBP: wise.receivedGBP, wiseRate: wise.rate };
    });
    route('nsave', 'nsave → BDT', 'Live ' + plan.toLowerCase() + ' plan quote; bank and bKash projections share this quote. Monthly plan cost excluded.', () => api.nsave(amount, plan));
  }
  route('ifast', 'iFAST ' + currency + ' → BDT', 'Public indicative rate; no transfer fee assumed. Bank and EzWallet/bKash quotes may differ in-app.', async () => {
    const rate = await api.ifast(currency);
    return { rate, fee: 0, receivedBDT: amount * rate };
  });
  const routes = await Promise.all(tasks);
  return { input, routes };
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'X-Content-Type-Options': 'nosniff' } });
}
function readInput(url) {
  const amount = Number(url.searchParams.get('usd') ?? url.searchParams.get('amount'));
  const currency = url.searchParams.has('usd') ? 'USD' : (url.searchParams.get('currency') || 'USD').toUpperCase();
  const incentive = Number(url.searchParams.get('incentive') ?? 2.5);
  const bankFee = Number(url.searchParams.get('bankFee') ?? 1.15);
  const plan = (url.searchParams.get('plan') || 'FREE').toUpperCase();
  if (!Number.isFinite(amount) || amount < .01 || amount > 1000000) throw new Error('Enter an amount between 0.01 and 1,000,000.');
  if (!['USD', 'GBP'].includes(currency)) throw new Error('Choose USD or GBP.');
  if (!['FREE', 'PRO'].includes(plan)) throw new Error('Choose the Free or Pro nsave plan.');
  if (!Number.isFinite(incentive) || incentive < 0 || incentive > 10 || !Number.isFinite(bankFee) || bankFee < 0 || bankFee > 10) throw new Error('Incentive and bank fee must be between 0% and 10%.');
  return { amount: round(amount), currency, incentive, bankFee, plan };
}
export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return json({ ok: true });
    if (request.method !== 'GET') return json({ ok: false, error: 'Use GET.' }, 405);
    const url = new URL(request.url);
    if (url.pathname === '/') return new Response(HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" } });
    if (url.pathname !== '/convert') return json({ ok: false, error: 'Not found.' }, 404);
    let input;
    try { input = readInput(url); } catch (e) { return json({ ok: false, error: e.message }, 400); }
    const result = await calculate(input);
    const ok = result.routes.some(r => r.ok);
    return json({ ok, fetchedAt: new Date().toISOString(), ...result }, ok ? 200 : 502);
  }
};

const HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#f7f7f8"><title>BDT / Rate checker</title>
<style>
:root{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#202124;background:#f7f7f8;font-synthesis:none}*{box-sizing:border-box}body{margin:0}main{max-width:1000px;margin:64px auto;padding:0 24px}header{display:flex;align-items:center;justify-content:space-between;margin-bottom:36px}.brand{font-size:14px;font-weight:700;letter-spacing:2px}.badge{font-size:12px;color:#53545a;background:#ededf0;border-radius:20px;padding:7px 12px}h1{font-size:clamp(30px,5vw,44px);font-weight:650;letter-spacing:-1.7px;margin:0 0 10px}p{color:#6b6c73;line-height:1.6;margin:0 0 24px}.panel{background:white;border:1px solid #e1e1e5;border-radius:18px;padding:24px}.entry{display:flex;gap:12px;align-items:end}.amount{flex:1}label{display:block;font-size:13px;font-weight:600;margin-bottom:8px}input,select,button{font:inherit;border-radius:10px}input,select{border:1px solid #d2d2d8;background:#fff;color:#202124;padding:13px 14px;min-width:0;width:100%}#amount{font-size:24px;font-weight:600;padding:9px 14px}button{border:0;background:#262629;color:#fff;padding:15px 24px;font-weight:600;cursor:pointer;white-space:nowrap}button:disabled{opacity:.65;cursor:wait}input:focus,select:focus,button:focus-visible,summary:focus-visible{outline:3px solid #a6a6b2;outline-offset:3px}.currency{width:105px}details.settings{margin-top:20px;border-top:1px solid #ebebee;padding-top:16px}summary{cursor:pointer;font-size:13px;color:#55565d}.fields{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:20px 0 12px}.hint{font-size:12px;line-height:1.6;color:#6b6c73}.toolbar{display:flex;justify-content:space-between;align-items:center;gap:16px;margin:32px 0 16px}.toolbar h2{font-size:16px;font-weight:600;margin:0}.toolbar select{width:auto;padding:9px 12px;font-size:13px}#status{font-size:12px;color:#6b6c73;margin:0 0 14px}#results{display:grid;grid-template-columns:1fr;gap:16px}.primary{padding:28px}.primary .value{font-size:42px}.route-label{font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:#6b6c73;margin-bottom:12px}.other-routes{border:1px solid #e1e1e5;border-radius:14px;background:#fff;padding:18px 22px}.other-routes>summary{font-size:14px;font-weight:600;color:#202124}.other-grid{display:grid;grid-template-columns:1fr;gap:12px;margin-top:18px}.other-grid .route{background:#fafafa}.other-grid .value{font-size:26px}.route{background:#fff;border:1px solid #e1e1e5;border-radius:14px;padding:22px;min-width:0}.route h3{font-size:15px;font-weight:600;margin:0 0 20px}.value{font-size:30px;letter-spacing:-1px;font-weight:650;font-variant-numeric:tabular-nums}.unit{font-size:13px;color:#6b6c73;margin-left:6px;font-weight:400;letter-spacing:0}.sub{font-size:12px;color:#6b6c73;margin:7px 0 16px}.route details{border-top:1px solid #ebebee;padding-top:12px}.row{display:flex;justify-content:space-between;gap:20px;font-size:12px;margin-top:12px;color:#62636b}.row span:last-child{text-align:right;font-variant-numeric:tabular-nums;color:#202124}.note{font-size:11px;line-height:1.6;color:#6b6c73;margin:15px 0 0}.error{color:#9d3e2d;font-size:13px;line-height:1.6}.empty{grid-column:1/-1;border:1px dashed #d6d6dc;border-radius:14px;text-align:center;padding:45px 20px;color:#6b6c73;font-size:14px}.comparison{margin-top:18px;font-size:13px;line-height:1.6;color:#484950}footer{font-size:12px;color:#6b6c73;line-height:1.8;margin:26px 0}footer a{color:inherit;text-underline-offset:3px}.loading{opacity:.6}@media(max-width:600px){main{margin:28px auto;padding:0 16px}header{margin-bottom:28px}.panel{padding:18px}.entry{flex-wrap:wrap}.entry button{width:100%}.fields{grid-template-columns:1fr}#results{grid-template-columns:1fr}.toolbar{align-items:start}.toolbar select{max-width:190px}.value{font-size:29px}.primary{padding:22px}.primary .value{font-size:34px}}
</style></head><body><main>
<header><div class="brand">BDT /</div><span class="badge">A little more makes it home.</span></header>
<h1>What arrives in taka?</h1><p>Compare Wise, nsave and iFAST. One amount, all your routes.</p>
<form id="form" class="panel"><div class="entry"><div class="amount"><label for="amount">You send</label><input id="amount" type="number" inputmode="decimal" min="0.01" max="1000000" step="0.01" value="1000" required></div><div class="currency"><label for="currency">Currency</label><select id="currency"><option>USD</option><option>GBP</option></select></div><button id="go" type="submit">Compare rates ↗</button></div>
<details class="settings"><summary>Calculation settings</summary><div class="fields"><div><label for="plan">nsave plan</label><select id="plan"><option value="FREE">Free</option><option value="PRO">Pro</option></select></div><div><label for="incentive">Incentive (%)</label><input id="incentive" type="number" min="0" max="10" step="0.01" value="2.5" required></div><div><label for="bankFee">bKash → bank deduction (%)</label><input id="bankFee" type="number" min="0" max="10" step="0.01" value="1.15" required></div></div><div class="hint">2.5% is an assumed eligible remittance incentive, added once to each quote. Set it to 0 if ineligible or already included. The 1.15% deduction preserves your previous calculation; adjust for your bank.</div></details></form>
<div class="toolbar"><h2>Your transfer</h2><select id="destination" aria-label="Compare recipient amounts"><option value="bankBDT">To bank · with incentive</option><option value="bkashBDT">To bKash · with incentive</option><option value="bkashToBankBDT">bKash → bank</option><option value="baseBDT">BDT · before incentive</option></select></div>
<div id="status" role="status" aria-live="polite">Ready when you are.</div><section id="results" aria-label="Route estimates"><div class="empty">Enter an amount and compare your routes.</div></section>
<footer>Estimates, not guaranteed payout quotes. Bank and bKash rates, limits and eligibility may differ. Confirm in the provider app.<br>Sources: <a href="https://wise.com/" target="_blank" rel="noopener">Wise</a> · <a href="https://www.nsave.com/send-money-home" target="_blank" rel="noopener">nsave</a> · <a href="https://www.ifastgb.com/en/transfer/ezwallet" target="_blank" rel="noopener">iFAST</a><br>Powered by <a href="https://masiursiddiki.com" target="_blank" rel="noopener">masiursiddiki.com</a> &lt;3</footer>
</main><script>
const $ = id => document.getElementById(id);
const fmt = (n, digits=2) => new Intl.NumberFormat(undefined,{minimumFractionDigits:digits,maximumFractionDigits:digits}).format(n);
let data, controller, generation = 0;
function element(tag, text, cls) { const e = document.createElement(tag); if(text !== undefined) e.textContent = text; if(cls) e.className = cls; return e; }
function row(parent, label, value) { const r = element('div',undefined,'row'); r.append(element('span',label),element('span',value)); parent.append(r); }
function render() {
  if (!data) return;
  const wasOpen = $('other-routes')?.open || false;
  $('results').replaceChildren();
  const primaryId = data.input.currency === 'USD' ? 'wise-ifast' : 'ifast';
  const otherRoutes = element('details', undefined, 'other-routes');
  otherRoutes.id = 'other-routes'; otherRoutes.open = wasOpen;
  otherRoutes.append(element('summary', 'Other routes (' + data.routes.filter(r => r.id !== primaryId).length + ')'));
  const otherGrid = element('div', undefined, 'other-grid'); otherRoutes.append(otherGrid);
  for (const r of data.routes) {
    const primary = r.id === primaryId;
    const target = primary ? $('results') : otherGrid;
    const card = element('article',undefined,primary ? 'route primary' : 'route');
    if (primary) card.append(element('div', 'Primary route', 'route-label'));
    card.append(element('h3',primary && data.input.currency === 'USD' ? 'Wise USD → GBP → iFAST → BDT' : r.name));
    if (!r.ok) { card.append(element('div','Currently unavailable','error'),element('p',r.error,'note')); target.append(card); continue; }
    const value = element('div',fmt(r[$('destination').value]),'value'); value.append(element('span','BDT','unit')); card.append(value);
    card.append(element('div',fmt(r[$('destination').value]/data.input.amount,4)+' BDT per '+data.input.currency+' · estimated','sub'));
    const details = element('details'); details.append(element('summary','Show calculation'));
    row(details,'Sending',fmt(data.input.amount)+' '+data.input.currency);
    row(details,'Provider fee',fmt(r.fee)+' '+data.input.currency);
    if (r.receivedGBP !== undefined) { row(details,'Wise rate',fmt(r.wiseRate,6)+' GBP / USD'); row(details,'Wise pays out',fmt(r.receivedGBP)+' GBP'); }
    row(details,'Rate',fmt(r.rate,6)+' BDT / '+(r.receivedGBP!==undefined?'GBP':data.input.currency));
    row(details,'Before incentive',fmt(r.baseBDT)+' BDT'); row(details,'Incentive ('+fmt(data.input.incentive)+'%)',fmt(r.incentiveBDT)+' BDT');
    row(details,'Bank / bKash estimate',fmt(r.bankBDT)+' BDT'); row(details,'bKash → bank (−'+fmt(data.input.bankFee)+'%)',fmt(r.bkashToBankBDT)+' BDT');
    details.append(element('p',r.note,'note')); card.append(details); target.append(card);
  }
  const wise = data.routes.find(r=>r.id==='wise-direct'&&r.ok), via = data.routes.find(r=>r.id==='wise-ifast'&&r.ok);
  const comparison = element('div', undefined, 'comparison');
  if(wise&&via) { const diff=via.bankBDT-wise.bkashToBankBDT; comparison.textContent='Your original comparison: Wise → GBP → iFAST → bank is '+fmt(Math.abs(diff))+' BDT '+(diff>=0?'more':'less')+' ('+fmt(Math.abs(diff)/wise.bkashToBankBDT*100)+'%) than Wise → bKash → bank.'; }
  if (otherGrid.childElementCount) { otherRoutes.append(comparison); $('results').append(otherRoutes); }
}
function invalidate() {
  generation++; if(controller) controller.abort(); data=null; $('go').disabled=false; $('go').textContent='Compare rates ↗'; $('results').classList.remove('loading'); $('results').removeAttribute('aria-busy'); $('results').replaceChildren(element('div','Settings changed. Compare again for updated amounts.','empty')); $('status').textContent='Ready to update.';
}
$('form').addEventListener('input',invalidate);
$('form').addEventListener('change',invalidate);
$('destination').addEventListener('change',render);
$('form').addEventListener('submit',async event=>{
  event.preventDefault(); if(!$('form').reportValidity()) return;
  if(controller) controller.abort(); controller=new AbortController(); const current=++generation;
  const params = new URLSearchParams(); for(const key of ['amount','currency','plan','incentive','bankFee']) params.set(key,$(key).value);
  data=null; $('results').replaceChildren(element('div','Checking live provider quotes…','empty')); $('results').setAttribute('aria-busy','true'); $('go').disabled=true; $('go').textContent='Checking…'; $('status').textContent='Fetching quotes…';
  try { const response=await fetch('/convert?'+params,{signal:controller.signal}); const result=await response.json(); if(current!==generation) return;
    if(!result.routes) throw new Error(result.error||'Could not fetch rates.'); data=result; render();
    const count=data.routes.filter(r=>r.ok).length; $('status').textContent=count+' of '+data.routes.length+' routes available · fetched '+new Date(data.fetchedAt).toLocaleTimeString();
  } catch(e) { if(current!==generation) return; $('results').replaceChildren(element('div','Could not load quotes. Please try again.','empty')); $('status').textContent=e.message; }
  finally { if(current===generation) { $('go').disabled=false; $('go').textContent='Compare rates ↗'; $('results').removeAttribute('aria-busy'); } }
});
</script></body></html>`;
