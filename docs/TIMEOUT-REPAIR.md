# Paper bot timeout repair — September 23, 2026

Production logs showed `/api/feed` requests cancelled near the browser's 45-second timeout. The feed awaited up to 12 discovery requests plus two source reads for every card, behind a serialized public API queue. Starting the bot unnecessarily loaded that same feed.

## Changed behavior

- Start creates the isolated paper session without market, sports, or history requests. The development-replay gate remains server enforced.
- Initial saved-account loading is also independent of pricing or settling previous manual positions. Those optional updates run while the manual workspace/results are visible.
- Market discovery, saved chart enrichment, and bot execution are separate. History and per-card BBO fan-out no longer block home or the bot.
- Discovery returns partial coverage within 12 seconds. Cached pages allow later checks to continue coverage. Listing receipts retain their actual timestamps; rereading a cached listing does not create a fresh quote.
- A bot checks up to two entry candidates per cycle, or its held position first. Discovery, context, and quote work share a 22-second deadline. Sports entry checks have a smaller sub-budget to leave time for the book.
- Cancelled queued work is skipped before making a provider request. Timed-out work cannot return later and apply a fill. Cache misses coalesce within a Worker instance.
- A lost POST response triggers a read of saved bot state instead of repeating the command. Existing profile revision/CAS checks still protect the ledger.
- Pause/stop remain independent of data sources. A requested exit is still persisted before I/O and retried through partial fills or source outages. No entry gates or current-book checks were weakened.
- The Start button no longer depends on the market feed. NFL is labeled “Manual only,” with the reason in “How this runs.” Closed player-research panels no longer poll.

## Verification

The actual route was exercised with an isolated SQLite paper database, both in synthetic failure tests and against current public Polymarket US/MLB/ESPN APIs. No production account was changed and no real order API was called. The live source evidence is `docs/evidence/timeout-live-check.json`.

In the live check, Start returned in 8 ms. The cold scan hit its 22-second deadline safely; subsequent scans completed in approximately 7.7 and 5.9 seconds, observing four markets from a 22-market pregame universe. The engine correctly waited for an independently refreshed sports snapshot. Pause, resume and stop returned promptly. The paper balance stayed at $10; zero entries are not profitability evidence. These timings are local route measurements with real external I/O, not a production latency guarantee.

Browser QA verified the home, advanced-mode filler removal, MLB/NFL manual navigation, recorded-data gating, and the run-status explanation. The preview uses clearly labeled recorded development data; production retains live public reads.

Cloudflare hosting and authenticated streaming remain deferred at the user's request. The current browser runner requires the page to stay visible. NFL automatic entries still require an outcome model and reliable starting-QB evidence; the MLB model remains experimental and its dated ratings expire unless refreshed.
