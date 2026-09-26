> Historical record: this document describes an earlier release or research result. It is not the current operating guide. See [the bot manual](BOT-MANUAL.md) and [release status](RELEASE-STATUS.md). Earlier evidence is preserved below and has not all been rerun for the current release.

# Beginner-flow repair QA

Audit date: September 23, 2026. Source audit and deterministic accounting tests are separate from production observations.

## Baseline verified

- TypeScript compiled without errors before repairs.
- All seven existing paper/scanner tests passed before repairs.
- Five added regressions pass: a $10 YES round trip, a $10 opposite-outcome round trip, insufficient buyer depth on exit, explicit zero fees, and stale/missing-spread observations.
- Four partial-detail regressions pass against the repaired loader: optional section failures, unavailable execution book, an empty fresh book superseding stale summary offers, and a total section outage.
- Test books are explicitly synthetic accounting examples. They are not displayed as games, prices, or simulated real-game results.

## Source-confirmed findings

| Priority | Finding | Impact |
| --- | --- | --- |
| High | Market detail used one `Promise.all` for quote, book, history, and metadata. | One unavailable section discarded all successful sections. |
| High | Profile fetch errors were ignored. | Portfolio could say “Loading” forever; the practice button could stay disabled without explanation. |
| High | The home feed silently substituted unflagged games when the scanner found nothing, under “Something moved.” | Market information could be mistaken for picks or scanner recommendations. |
| Medium | The 60-second profile refresh reset editable scanner config. | An unsaved settings edit could disappear. |
| Medium | A card's watch indicator included game/team subscriptions, but its toggle changed only the individual market. | “Unwatch market” could instead add a separate market watch. |
| Medium | Missing historical NO price was coerced into a negative spread. | Incomplete history could create a false spread observation. |
| Low | The close route used `feeCoefficient || default`. | A valid zero fee would be replaced by the default, although observed captures all used 0.0695. |

Cold feed latency remains a risk to verify: discovery paginates both leagues, then enriches up to 48 markets with quote/history requests. The source audit alone does not establish a production outage.

## Accounting conclusions

The existing simulator buys from seller offers, sells to buyer bids, complements both sides correctly for NO, walks available depth, uses whole contracts, and charges estimated fees at entry and exit. An immediate cash-out at unchanged prices loses the spread and both fee estimates, which the UI needs to explain.

The fee formula is verified against the official US fee documentation captured in `docs/API-RESEARCH.md`. Calculations retain exact floating-point fee estimates; the exchange rounds to cents using banker's rounding and additional fill-level rules. Therefore the app must continue to call its amounts estimates rather than exchange-exact fills.

## Browser acceptance flow

1. Open the home screen. It should immediately identify the feed as market information and explain that a pick is saved only after a deliberate practice action.
2. Open a game explanation. This action must not change cash or create a position.
3. Read what changed, view the chart, and choose an outcome and a $5/$10/$25/custom budget. The action's disabled state must say why if a required quote, book, or profile is unavailable.
4. Save one practice pick. Verify the success state links to the portfolio, cash reflects the actual simulated fill plus estimated fees, and the exact outcome is visible.
5. Cash out with enough buyer depth. Verify cash increases by buyer proceeds minus estimated exit fees. Low depth must not create a fictitious full exit.
6. Switch chart ranges; expand and collapse the order book; close and reopen another game. No earlier game's prices, success notice, or failure should leak into the new game.
7. Save and remove a market watch. Separately watch a team/game; each control should describe the subscription it actually changes.
8. Edit scanner thresholds while a profile refresh occurs, then save. The draft should survive the refresh.
9. View an empty scanner result. It should say no condition was met, not imply that a price moved.
10. Repeat the primary information → explanation → practice flow at a 390px viewport and verify horizontal scrolling is unnecessary.

Browser testing in the local preview uses clearly labeled recorded API data. Production quotes must remain live and must not fall back to recordings.

## Integrated verification, September 23, 2026

- Final TypeScript check passed. All 21 accounting, scanner, partial-data, and captured-simulation tests passed.
- Desktop browser: opened a market without adding a position, inspected both outcome estimates, saved a $5 development-only pick, verified its explicit success state and direct portfolio link, then closed that pick at available buyer prices. The personal portfolio and separate $10 experiment were independently visible.
- At a 390px frame width: checked home hierarchy and chart/card width, opened the market sheet, and verified the top practice shortcut places the full calculator and save button inside the phone viewport.
- Simulation UI showed the five actual captured entries, $9.13 spent, $0.87 cash, all pending, and a preview-specific warning. Actual public API capture and separate settlement checks are documented in MLB-SIMULATION.md.
- Production logs before repair showed successful feed and profile GETs, including one 14-second cold feed. No production market-detail request failure was observed in those logs. Partial-source failures were reproduced deterministically in tests. Feed history and quote calls now overlap within the existing three-market concurrency limit.
- Browser activity used a clearly labeled development replay. No personal production positions were changed during QA; the new $10 experiment is separately captured real data.
