> Historical record: this document describes an earlier release or research result. It is not the current operating guide. See [the bot manual](BOT-MANUAL.md) and [release status](RELEASE-STATUS.md). Earlier evidence is preserved below and has not all been rerun for the current release.

# Trading workspace QA and simulation evidence

This record separates synthetic engineering scenarios from observed MLB results. Synthetic books and prices in the test suite are accounting and failure cases only. They are never presented as current games, executions, returns, or evidence that a strategy is profitable.

## Baseline

Before this revision, the existing 21 tests passed. They cover the paper calculator, complementary YES/NO prices, market-detail section failures, and the immutable September 23 MLB experiment. The captured $10 experiment remains unchanged in `data/mlb-simulation-2026-09-23.json`.

That dated experiment follows recent movement and holds to official settlement. It does not test fast dip-entry/rebound-exit trading. Its minute-resolution history cannot reconstruct the quotes, available size, latency, or queue state needed to validate those trades.

## Validation completed

On September 23, 2026, these commands passed:

```sh
node --experimental-strip-types --test tests/*.test.ts services/trading/service.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

The combined suite has **78 passing tests**, including 29 independent integration scenarios in `tests/trading-integration.test.ts`. The remainder includes the existing baseline, arithmetic and strategy tests, guarded live-adapter transport tests, and service tests. The live-adapter tests use injected synthetic transports; they do not submit exchange orders.

The immutable September 23 capture is unchanged, with SHA-256:

```text
fa9a14940c15324fcb24aa2de4499511b999bcc4f0f34a3e774f04dd7346b562
```

## Focused acceptance scenarios verified

| Scenario | Required behavior |
| --- | --- |
| A small rebound follows entry | Net results include the entry ask, exit bid, and both fees; rising price alone cannot imply profit. |
| Price worsens during decision latency | A bounded order cannot fill past its price limit or borrow an earlier favorable quote. |
| Partial entry or exit | Fill only displayed executable quantity, preserve the remainder, and account for fees and cost basis on the filled quantity. |
| Opposite outcome selected | NO asks derive from YES bids; NO bids derive from YES asks. |
| Old, missing, or replay-only quote | Block actions that require current authoritative data; never relabel a capture as live. |
| Duplicate or uncertain command | Repeated commands cannot spend twice; an ambiguous submission remains unresolved until reconciled. |
| Manual exit while automation is active | Manual takeover pauses re-entry for the market, including when the attempted exit cannot fully fill. |
| Replay sees later observations | Decisions use only data available at decision time; future observations cannot improve earlier decisions. |

The full synthetic dip scenario first arms on a decline, waits for later recovery observations, buys through the same execution engine, declines to call a small rebound profitable after fees, partially exits at its net target, retains the remaining position, and enters cooldown only after the remaining quantity sells. This proves deterministic behavior for that designed input sequence, not that such a sequence will occur or can be profitably predicted.

SQLite tests load the real migrations and execute the exact SQL used by `commitOrder`. They verify a stale profile version cannot create an orphan journal fill, repeated command IDs cannot spend twice, and failure of the ledger write rolls back the preceding journal insert. These are local transaction tests, not a hosted Cloudflare D1 outage or contention test.

## Findings corrected during this review

| Finding | Correction and evidence |
| --- | --- |
| A relative near-100% threshold could close a lot with an unsold remainder. | Completion now compares quantities at the supported fixed precision. A regression retains one unsold micro-contract. |
| Book receipt time was stamped after metadata also finished loading. | Receipt is now captured when the book request resolves; slow metadata cannot make an older book appear newly received. |
| Old private events could overwrite a newer account view or resurrect a terminal order. | Private events require reconciliation, use timestamp guards and execution-ID deduplication, and retain terminal-order protection. Service tests cover stale order and balance events. |
| Untimed private snapshots could be mistaken for a complete current account. | REST reconciliation owns authoritative replacement; a private event racing that request prevents the older result from being marked ready. |

Quiet streams are tested separately from quote changes: heartbeats preserve transport health without changing the last-price-change or book-receipt timestamp. Disconnects and protocol gaps invalidate existing books; reconnecting or receiving only a heartbeat cannot make those books certain again. Provider timestamps allow at most a two-second lead for clock skew, while the server receipt timestamp remains independent.

## Evidence limits

Authenticated exchange connection, actual order acceptance, exchange rounding, cancellation races, and account reconciliation require real contract verification. Passing synthetic scenarios does not prove those external contracts and does not establish trading profitability. Browser and deployment checks are performed separately by the coordinating agent.

The current paper order path fetches an authoritative REST book for execution and blocks development replay. Its strategy runner is tied to the open workspace and pauses after an interruption; this is not evidence of a continuously deployed strategy service. A stream-driven execution path must explicitly preserve maintained-book certainty or fetch a new snapshot before acting. A heartbeat must never be substituted for the receipt time of a newly fetched book.

Price history alone is insufficient for a live-trading profitability backtest. Future evidence needs point-in-time bid/ask/depth data, execution latency and missed/partial-fill treatment, fee estimates with their limitations, declared strategy versions, and later unseen evaluation periods. The existing five-game test is a preserved baseline, not an endorsement of dip trading or recent-movement selection.

No real-money order is part of this QA work.

## Browser review

The coordinating agent verified the actual app at desktop width and inside a 390px development iframe (375px content viewport with scrollbar). There was no page-level horizontal overflow at that phone width. This was responsive browser QA, not a physical-device test.

- Beginner OFF removes the teaching cards, glossary, promotional paper panel, guided walkthrough and legacy detail sheet; switching back restores the guided flow.
- Empty scanner results still show an available MLB chart immediately.
- Switching YES/NO changes chart direction, executable bid/ask and held position together.
- An edited $12 preset survived a reload. Amount initialization now follows stored presets.
- A 50% exit selection showed six contracts for a twelve-contract position; fractional sizing used market rules.
- Mobile quick entry/exit controls remain fixed at the bottom and share the same protected commands and presets.
- Recorded capture is labeled with its actual recording time and disables current-order submission. No fabricated fills were inserted for browser screenshots.
- Initial stream null-state crash was fixed. The final preview rendered without that error.

The screenshot in advanced-workspace.jpg is a development preview with the recorded-data banner visible, not a claim of production prices or live account results.
