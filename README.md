# Portly

A portfolio and dividend tracker that runs entirely in your browser. Drop in an
Interactive Brokers Activity Statement CSV and get holdings, income history and
a twelve-month forward projection.

**Your data never leaves your device.** Statements are parsed in the browser and
stored in IndexedDB. There is no server, no account and no upload.

## Why this exists

IBKR gives you the data but not the view. Snowball Analytics gives you the view
but wants a subscription and a broker connection. This is the view, from a file
you already have.

## What it does

| Tab | What's on it |
|---|---|
| **Overview** | Value, total profit ±%, passive income %, yield on cost, XIRR, allocation |
| **Income** | Dividends received by month/quarter/year, and a holdings × month payments matrix |
| **Forecast** | Next 12 months of expected income, split into declared and estimated |
| **Holdings** | Every position: shares, cost basis, value, weight, unrealised and realised P/L |
| **Data** | Import, reconciliation report, market-data controls, backup, settings |

Imports are **additive and idempotent**. Overlapping statements are the normal
case — import a monthly statement and then a full-year one and nothing is
double-counted.

## Correctness

The importer checks itself. After every import it compares what it derived
against IBKR's own stated totals — position values, cost bases, dividends,
withholding tax, deposits, accrual balances, and per-instrument trade
quantities, proceeds and commissions — and shows you the result. If a number
disagrees with the broker, you see it rather than trusting a silent total.

Things it gets right that are easy to get wrong:

- **Ticker renames.** IBKR reports one instrument under several tickers across
  sections of the same file. Identity resolves on conid, then ISIN, never on the
  ticker, so a renamed holding stays one position instead of becoming a phantom
  sale plus a phantom purchase.
- **Multi-currency cost basis** converted at the rate on each trade date, not
  today's. Converting at today's rate makes FX P/L vanish entirely.
- **Dividend currency ≠ trading currency.** An ETF can trade in EUR and pay in GBP.
- **Pence.** Some London lines quote in GBX, and the price feed does not say so.
  The unit is calibrated against the statement's own closing price.
- **Ex-date for yields, pay-date for cash-flow charts**, never crossed.
- **Fractional shares** are stored as decimals throughout.
- **Accrual netting.** `Po`/`Re` pairs are netted so declared-but-unpaid
  dividends reconcile to the broker's own accrual balance.

## Market data

Optional. With it off, the app values your portfolio at the closing prices
already inside the statement and works fully offline.

With it on, prices, dividend histories and FX rates are fetched **client-side**
from keyless, CORS-open endpoints — [stockanalysis.com](https://stockanalysis.com),
[extraETF](https://extraetf.com) and [Frankfurter](https://frankfurter.dev) (ECB
rates). Nothing is cached server-side and nothing is committed to this
repository, so the repo reveals nothing about what you hold. The only thing that
leaves your device is a ticker or ISIN.

Every figure carries its provenance and its age. A dead provider downgrades a
number to the statement's own price; it never blanks the screen.

The one thing the CSV cannot do alone is the forward projection: IBKR posts
accruals at ex-date minus one day, so declared data only reaches about four
weeks out, and annualising from a short history understates badly because UCITS
distributions are seasonal. That is what the dividend history is for.

## Running it

```sh
pnpm install
pnpm dev          # http://localhost:5173
pnpm test         # 412 tests
pnpm typecheck
pnpm build
```

Deployment is automatic: pushing to `main` runs typecheck, tests and build, then
publishes to GitHub Pages.

### Checking a real statement

`scripts/verify-statement.ts` runs a statement through the ingest pipeline and
prints the reconciliation report. It takes a path so you can point it at a file
outside the repo — never commit a brokerage export.

```sh
pnpm tsx scripts/verify-statement.ts ~/Downloads/statement.csv
```

## Architecture

```
src/
  domain/     the shared type contract
  ingest/     CSV reader, statement parser, entity derivation, dedupe
  db/         Dexie schema, import orchestration, encrypted backup
  metrics/    pure functions: cost basis, FX, returns, income, forecast
  providers/  market data, one seam, swappable implementations
  ui/         view model hook, component kit, five tabs
```

Two storage tiers with different lifetimes. `raw_files` and `raw_rows` hold every
line of every imported statement verbatim, forever. Everything else is derived
and disposable. A parser fix ships as a version bump plus a re-derive — no
re-import, no data loss, no asking you to find an export from eight months ago.

## Licence

MIT
