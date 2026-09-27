# Forward tests

Live, out-of-sample checks of research leads, with paper picks only. See [docs/DECISION-ENGINE.md](../../docs/DECISION-ENGINE.md#forward-test-cfb-pregame-favourites).

The scheduled workflow writes the ledger (`cfb-favourite-pregame.json`) and `summary.md` to the **`forward-test-data`** branch, not to `main`. A local run of `scripts/forward-test.ts run` writes them here, and they are git-ignored on `main`.
