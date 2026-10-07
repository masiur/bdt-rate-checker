# BDT rate checker

One Cloudflare Worker serves the UI at `/` and JSON at `/convert`. No API key, database, separate Pages site, or build step.

## Deploy

1. In Cloudflare **Workers & Pages**, create a Worker (Hello World).
2. Open **Edit code**. Replace the starter code with the entire contents of `worker.mjs`.
3. Deploy and open its `workers.dev` address. The calculator is the homepage.
4. Test there before moving `usd.masiursiddiki.com`. To use that hostname, remove its existing Pages custom-domain association and conflicting DNS record, then add it under the Worker's **Settings → Domains & Routes → Add → Custom Domain**. Keep a copy of the old Page/Worker for rollback.

Alternatively, from this folder: `npx wrangler deploy`.

[Cloudflare dashboard instructions](https://developers.cloudflare.com/workers/get-started/dashboard/) · [Custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

## Routes

- USD: Wise → BDT; Wise balance → GBP → iFAST → BDT; nsave → BDT; iFAST USD → BDT.
- GBP: iFAST GBP → BDT.
- Display BDT before incentive, bank, bKash, or bKash → bank estimates.
- Wise USD → GBP → iFAST → BDT is primary. Other USD routes and the original Wise comparison are in a collapsed “Other routes” accordion. GBP mode shows iFAST GBP directly.
- nsave Free/Pro selection; adjustable incentive and bKash-to-bank deduction.

## Calculation boundaries

Provider payouts take precedence over reconstructing a quote from a rounded rate. Wise balance conversion uses `targetAmount` and `total`, strictly matching BALANCE/BALANCE. The original Wise direct route still uses DIRECT_DEBIT comparison pricing; it is not a new balance-funded or wallet-specific quote.

Incentive is added once, rounded to two decimals. Defaults preserve the supplied 2.5% incentive and 1.15% bKash-to-bank deduction. These are editable assumptions, not verified eligibility or bank-specific charges. Set incentive to zero if ineligible or already included in the provider quote.

Bank and bKash estimates share the provider's public quote. **Separate bank/bKash pricing and transfer limits are not available in these public responses.** iFAST uses its indicative public rate with zero additional transfer fee assumed. nsave's monthly subscription and incoming/funding fees are excluded. Always check the final in-app quote.

Public endpoints are undocumented and may change or block Worker traffic. Provider failures appear individually; the app never substitutes demo rates. nsave's current quote function is discovered from its public calculator bundle and cached in memory for one hour. If that website's structure or serialization changes, its adapter must be updated.

## API

`GET /convert?amount=1000&currency=USD&plan=FREE&incentive=2.5&bankFee=1.15`

`GET /convert?amount=1000&currency=GBP`

`usd=1000` remains an amount alias. Responses contain `ok`, `fetchedAt`, `input`, and `routes`; each route has `ok` and either amounts or an error. This version's JSON shape differs from the old standalone Worker, so use the included page together with it.

No rates are persisted. “Fetched” means retrieval time, not a provider guarantee of quote freshness.

## Local checks

- Tests: `node --test worker.test.mjs`
- Preview: `npx wrangler dev --port 0` (prints an available port; stop with **Ctrl+C**).

Verified on 2026-10-07: all 7 tests passed; Wrangler deployment dry run passed; live Wise, nsave, iFAST USD and iFAST GBP quotes worked in the local Cloudflare runtime. Browser checks covered USD/GBP, destination switching, stale-result clearing, and a 390px mobile layout without horizontal overflow. A deployed Cloudflare edge request remains to be checked after deployment.

## Sources

- [nsave calculator](https://www.nsave.com/send-money-home)
- [nsave incentive eligibility](https://intercom.help/nsave_help_center/en/articles/12753077-bangladesh-government-2-5-incentive)
- [iFAST EzWallet and supported wallets](https://www.ifastgb.com/en/transfer/ezwallet)
- Wise and iFAST public endpoints: see `providers` in `worker.mjs`.
