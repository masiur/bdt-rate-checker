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
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#202024;background:#f6f6f7;font-synthesis:none;--muted:#71717a;--line:#e7e7eb;--ink:#222226}
*{box-sizing:border-box}body{margin:0}button,input{font:inherit}main{max-width:860px;margin:40px auto;padding:0 24px}header{display:flex;align-items:center;justify-content:space-between;margin-bottom:44px}.brand{display:flex;align-items:center;gap:10px;font-size:14px;font-weight:750;letter-spacing:-.3px}.brand-mark{display:grid;place-items:center;background:var(--ink);color:white;border-radius:10px;width:32px;height:32px;font-size:22px}.badge{font-size:11px;color:var(--muted);letter-spacing:1px}h1{font-size:clamp(30px,5vw,40px);font-weight:650;letter-spacing:-1.6px;margin:0 0 10px}p{color:var(--muted);line-height:1.6;margin:0 0 26px;font-size:14px}.panel{background:white;border:1px solid var(--line);border-radius:18px;padding:24px;box-shadow:0 3px 12px #00000003}.entry{display:flex;gap:16px;align-items:end}.amount{flex:1;min-width:0}label,legend{display:block;font-size:12px;font-weight:600;margin-bottom:9px;color:#57575f}fieldset{border:0;padding:0;margin:0;min-width:0}legend{padding:0}input[type=number]{border:1px solid #dedee4;border-radius:9px;background:#fff;color:var(--ink);padding:11px 12px;min-width:0;width:100%;font-variant-numeric:tabular-nums}#amount{font-size:26px;font-weight:600;letter-spacing:-.7px;height:52px;padding:8px 14px}button{border:0;border-radius:10px;background:var(--ink);color:#fff;padding:0 20px;height:52px;font-weight:600;font-size:13px;cursor:pointer;white-space:nowrap;transition:background .15s,transform .15s}button:hover{background:#3c3c43}button:active{transform:translateY(1px)}button:disabled{opacity:.65;cursor:wait}input:focus-visible,button:focus-visible,summary:focus-visible{outline:3px solid #b5b5c5;outline-offset:3px}
.segments{display:flex;gap:3px;background:#f2f2f5;border:1px solid #ededf1;border-radius:10px;padding:4px}.choice{position:relative;flex:1;display:block;margin:0;cursor:pointer;min-width:0}.choice input{position:absolute;opacity:0;width:1px;height:1px;margin:0}.choice span{display:flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap;border-radius:7px;min-height:34px;padding:0 14px;font-size:12px;font-weight:550;color:#74747d;transition:background .15s,color .15s,box-shadow .15s}.choice input:checked+span{background:#fff;color:#242429;box-shadow:0 1px 4px #00000012;font-weight:650}.choice input:focus-visible+span{outline:3px solid #a6a6b2;outline-offset:2px}.choice:hover span{color:#242429}.currency .segments{height:52px;align-items:stretch}.currency .choice span{height:100%;font-size:13px;padding:0 15px}.currency .symbol{font-size:14px;color:#909099;margin-right:2px}
summary{cursor:pointer;list-style:none;display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px;color:#65656f;user-select:none}summary::-webkit-details-marker{display:none}summary::after{content:"";width:6px;height:6px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(45deg);margin:0 4px 4px 8px;flex-shrink:0;transition:transform .15s}details[open]>summary::after{transform:rotate(225deg);margin-bottom:-2px}details.settings{margin-top:20px;border-top:1px solid var(--line);padding-top:16px}.fields{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:20px 0 12px}.hint{font-size:11px;line-height:1.7;color:var(--muted)}.toolbar{display:flex;justify-content:space-between;align-items:center;gap:16px;margin:30px 0 14px}.toolbar h2{font-size:14px;font-weight:650;margin:0}.destination{min-width:0}.destination .choice{flex:0 0 auto}.destination .choice span{padding:0 12px}.destination-note{font-size:11px;color:var(--muted);margin:0 0 14px}#status{font-size:11px;color:var(--muted);margin:0 0 12px;min-height:16px}#results{display:grid;grid-template-columns:1fr;gap:12px}.route{background:#fff;border:1px solid var(--line);border-radius:14px;padding:22px;min-width:0}.primary{padding:28px;border-color:#d8d8df;box-shadow:0 3px 12px #00000003}.route-label{font-size:10px;text-transform:uppercase;letter-spacing:1.4px;color:var(--muted);margin-bottom:14px}.route h3{font-size:14px;font-weight:600;margin:0 0 22px}.value{font-size:28px;letter-spacing:-1px;font-weight:650;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.primary .value{font-size:46px;letter-spacing:-1.8px}.unit{font-size:12px;color:var(--muted);margin-left:8px;font-weight:450;letter-spacing:0}.sub{font-size:11px;color:var(--muted);margin:7px 0 22px}.route details{border-top:1px solid var(--line);padding-top:14px}.row{display:flex;justify-content:space-between;gap:20px;font-size:12px;margin-top:12px;color:#62626b}.row span:last-child{text-align:right;font-variant-numeric:tabular-nums;color:var(--ink)}.note{font-size:11px;line-height:1.7;color:var(--muted);margin:15px 0 0}.other-routes{border:1px solid var(--line);border-radius:12px;background:#fff;padding:18px 22px}.other-routes>summary{font-size:13px;font-weight:600;color:#51515b}.other-grid{display:grid;gap:12px;margin-top:18px}.other-grid .route{background:#fafafa}.other-grid .value{font-size:26px}.error{color:#a23d38;font-size:13px;line-height:1.6}.empty{border:1px dashed #d9d9e0;border-radius:14px;padding:30px;text-align:center;color:var(--muted);font-size:13px;line-height:1.8}.empty-title{display:block;color:#45454f;font-size:14px;font-weight:600;margin-bottom:5px}.comparison{margin-top:18px;font-size:12px;line-height:1.7;color:#555560}footer{font-size:11px;color:var(--muted);line-height:1.8;margin:24px 0}footer a{color:inherit;text-decoration:none}footer a:hover{text-decoration:underline;text-underline-offset:3px}.footer-bottom{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:18px;padding-top:16px;border-top:1px solid var(--line)}.powered a{color:#45454f;font-weight:550}.heart{font-family:"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif;margin-left:4px}.loading{opacity:.6}@media(max-width:640px){main{margin:24px auto;padding:0 18px}header{margin-bottom:32px}.badge{font-size:10px}.panel{padding:18px}.entry{flex-wrap:wrap;gap:14px}.entry button{width:100%;height:46px}.currency .choice span{padding:0 10px}.fields{grid-template-columns:1fr}.toolbar{display:block;margin-top:26px}.toolbar h2{margin-bottom:12px}.destination .segments{display:grid;grid-template-columns:repeat(2,1fr)}.destination .choice span{font-size:11px;padding:0 4px;min-height:36px}.primary{padding:22px}.primary .value{font-size:38px}.footer-bottom{flex-direction:column;align-items:flex-start;gap:8px}.empty{padding:26px 18px}.route h3{font-size:13px}}@media(prefers-reduced-motion:reduce){*{transition:none!important}}
</style></head><body><main>
<header><div class="brand"><span class="brand-mark" aria-hidden="true">৳</span> BDT /</div><span class="badge">USD / GBP → BDT</span></header>
<h1>What arrives in taka?</h1><p>Your Wise → iFAST transfer, with the alternatives a click away.</p>
<form id="form" class="panel"><div class="entry"><div class="amount"><label for="amount">You send</label><input id="amount" type="number" inputmode="decimal" min="0.01" max="1000000" step="0.01" value="1000" required></div><fieldset class="currency"><legend>Currency</legend><div class="segments"><label class="choice"><input type="radio" name="currency" value="USD" checked><span>$ USD</span></label><label class="choice"><input type="radio" name="currency" value="GBP"><span>£ GBP</span></label></div></fieldset><button id="go" type="submit">Compare rates ↗</button></div>
<details class="settings"><summary>Calculation settings</summary><div class="fields"><fieldset><legend>nsave plan</legend><div class="segments"><label class="choice"><input type="radio" name="plan" value="FREE" checked><span>Free</span></label><label class="choice"><input type="radio" name="plan" value="PRO"><span>Pro</span></label></div></fieldset><div><label for="incentive">Incentive (%)</label><input id="incentive" type="number" min="0" max="10" step="0.01" value="2.5" required></div><div><label for="bankFee">bKash → bank deduction (%)</label><input id="bankFee" type="number" min="0" max="10" step="0.01" value="1.15" required></div></div><div class="hint">2.5% is an assumed eligible remittance incentive, added once to each quote. Set it to 0 if ineligible or already included. The 1.15% deduction preserves your previous calculation; adjust for your bank.</div></details></form>
<div class="toolbar"><h2>Recipient gets</h2><fieldset class="destination" aria-label="Compare recipient amounts"><div class="segments"><label class="choice"><input type="radio" name="destination" value="bankBDT" checked><span>Bank</span></label><label class="choice"><input type="radio" name="destination" value="bkashBDT"><span>bKash</span></label><label class="choice"><input type="radio" name="destination" value="bkashToBankBDT"><span>bKash → bank</span></label><label class="choice"><input type="radio" name="destination" value="baseBDT"><span>Before bonus</span></label></div></fieldset></div>
<div class="destination-note" id="destination-note">Bank estimate, including the incentive in your settings.</div>
<div id="status" role="status" aria-live="polite">Ready when you are.</div><section id="results" aria-label="Route estimates"><div class="empty"><span class="empty-title">One transfer. A clearer picture.</span>Enter your amount above to see what arrives.</div></section>
<footer>Estimates only. Bank and bKash rates, limits and incentive eligibility may differ. Confirm your final quote in the provider app.<div class="footer-bottom"><div>Rate sources &nbsp; <a href="https://wise.com/" target="_blank" rel="noopener">Wise</a> · <a href="https://www.nsave.com/send-money-home" target="_blank" rel="noopener">nsave</a> · <a href="https://www.ifastgb.com/en/transfer/ezwallet" target="_blank" rel="noopener">iFAST</a></div><div class="powered">Powered by <a href="https://masiursiddiki.com" target="_blank" rel="noopener">masiursiddiki.com</a> <span class="heart" role="img" aria-label="love">❤️</span></div></div></footer>
</main><script>
const $ = id => document.getElementById(id);
const selected = name => document.querySelector('input[name="'+name+'"]:checked').value;
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
    const value = element('div',fmt(r[selected('destination')]),'value'); value.append(element('span','BDT','unit')); card.append(value);
    card.append(element('div',fmt(r[selected('destination')]/data.input.amount,4)+' BDT per '+data.input.currency+' · estimated','sub'));
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
document.querySelector('.destination').addEventListener('change',()=>{
  const labels = { bankBDT:'Bank estimate, including the incentive in your settings.', bkashBDT:'bKash estimate, including the incentive in your settings.', bkashToBankBDT:'After the incentive and bKash-to-bank deduction in your settings.', baseBDT:'Provider payout before any added incentive.' };
  $('destination-note').textContent = labels[selected('destination')];
  render();
});
$('form').addEventListener('submit',async event=>{
  event.preventDefault(); if(!$('form').reportValidity()) return;
  if(controller) controller.abort(); controller=new AbortController(); const current=++generation;
  const params = new URLSearchParams(); for(const key of ['amount','currency','plan','incentive','bankFee']) params.set(key,['currency','plan'].includes(key)?selected(key):$(key).value);
  data=null; $('results').replaceChildren(element('div','Checking live provider quotes…','empty')); $('results').setAttribute('aria-busy','true'); $('go').disabled=true; $('go').textContent='Checking…'; $('status').textContent='Fetching quotes…';
  try { const response=await fetch('/convert?'+params,{signal:controller.signal}); const result=await response.json(); if(current!==generation) return;
    if(!result.routes) throw new Error(result.error||'Could not fetch rates.'); data=result; render();
    const count=data.routes.filter(r=>r.ok).length; $('status').textContent=count+' of '+data.routes.length+' routes available · fetched '+new Date(data.fetchedAt).toLocaleTimeString();
  } catch(e) { if(current!==generation) return; $('results').replaceChildren(element('div','Could not load quotes. Please try again.','empty')); $('status').textContent=e.message; }
  finally { if(current===generation) { $('go').disabled=false; $('go').textContent='Compare rates ↗'; $('results').removeAttribute('aria-busy'); } }
});
</script></body></html>`;
