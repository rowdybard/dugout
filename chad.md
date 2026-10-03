# Chad's guide to Dugout

Updated October 3, 2026.

Dugout runs a bot that practises trading college football games on Polymarket with **fake money**. It never places real bets. A paper profit isn't money you can withdraw, and a good weekend on paper doesn't prove the bot would make money for real.

## Getting in

- Open the Dugout link the owner sent you and **sign in with Google**. Your email has to be on the invite list; ask the owner if it isn't.
- You get **your own paper account**, starting at $100 of fake money. Nobody else can see or change it, and you can't see theirs.

## The screen, top to bottom

1. **Search box.** Type a team and pick a live or upcoming college game. That's the game the bot trades.
   - If it says the account is set to other sports, tap **Show college football games** once.
2. **Bot card:**
   - the game name, and **Steady** / **Bold** (see below);
   - your **balance**, and **Reset balance**;
   - the main button: **Start bot**, **Pause**, **Resume** or **New run**, and **End run** next to it while a run is going;
   - **status box:** what the bot is doing right now, in one or two sentences. Tap **Both sides** under it for a line about each team.
   - **Open orders & shares:** every offer the bot has waiting and every share it holds, with prices, cost and what it would get if it sold now.
3. **Game tracker:** score, clock and a drawing of the field from Polymarket's game reports. It's not live video and can lag.
4. **Trades & balance:** every fill, with price, fees and result, plus a balance chart.
5. **Settings & history** (closed by default): rules, background running, your own price key, diagnostics and downloads. You don't need any of it to get started.

## Steady or Bold

The bot mostly trades by leaving **buy offers** on both teams, slightly below the current price, and waiting for someone to sell into them. If both offers fill, you hold both sides of the game. That pays exactly $1 at the end whoever wins, and you paid a bit less than $1, so the difference is profit.

| | Steady | Bold |
|---|---|---|
| Offer size (on $100) | $5 | $12 (12% of the balance, at most $50) |
| Hold-to-final bets the research allows | No | Yes |
| Only one team's offer filled | Tries to complete the pair; **sells after 10 minutes** if it can't | Tries to complete the pair; **buys once more** if the price drops 5¢; **sells if it then drops another 10¢** below its average |
| Feel | Many small wins and losses | Bigger wins and bigger losses |

Bold doesn't make the bot smarter. It puts more money on each trade, so the bad days get bigger too.

## Starting, pausing, ending

- **Start bot:** pick a game first, then press it.
- **Pause:** no new trades. Anything already held stays managed. **Resume** carries on.
- **End run:** sells what it holds and closes the run. **New run** then starts fresh.
- **Reset balance:** starts over at any amount from $5 to $10,000, any time. Open paper trades are dropped, which is fine because it's fake money.
- **Switching games:** search and pick another game any time. Shares held on the old game are still managed there, and new offers go to the new game.

## Leaving it running

- **Set up the background runner once:** with no open trades, open **Settings & history**, press **Set up background bot**, then **Finish background setup**. Your balance and history move over, and the bot stays paused until you press Start. After that it keeps trading with the tab closed, in your own private runner.
- **Until you do that:** the bot only runs while the Dugout tab is open. On a phone it may pause when the screen locks.

## Reading the status box

| It says | Meaning |
|---|---|
| **Buy offers posted** | Offers are waiting, e.g. "Offering to buy Liberty at 70¢ or Delaware at 29.5¢". Nothing happens until someone sells at that price. Most checks change nothing. |
| **Watching** | It's checking, but the research doesn't allow a trade right now. |
| **Bot is behind** | No check from the bot for 30–45 seconds. If it lasts more than a minute, reload the page. |
| **Paused / Ready / Stopped** | Not trading. Press Resume, Start or New run. |
| **Managing position** | It holds shares and is handling them (see Open orders & shares). |

## Why it isn't trading

These are all normal. It's the bot being careful, not broken:
- **After every play:** it pulls its offers for 30 seconds, because prices jump right after plays.
- **Old game report:** during a live game it only posts offers while Polymarket's game report is less than 45 seconds old. If the game tracker says the report is stale, it waits, and the tracker shows the reason the last check failed.
- **Thin or wide market:** if there are too few buyers and sellers, or the gap between buy and sell prices is wider than 5¢, it doesn't post offers.
- **Nobody selling:** offers only fill when someone sells at that price. Quiet games mean few fills.

Don't reset or change rules just to make it trade. If something looks wrong, note the game, the time and what the status box says, and tell the owner.

## Extras (optional)

- **Chaos mode** (experimental, Steady only): the same small offers on up to 6 extra games at once. Turn it on under Steady on the bot card.
- **Your own Polymarket key** (Settings & history → Live prices): gives your bot instant price updates instead of a check every few seconds. Make a separate read-only key for it; it's stored encrypted and never shown again.
- **Download Chaos log / saved history:** a full record of what the bot did, under Settings & history.

## Limits worth knowing

- Everything is simulated: the fills, the fees, the $1 payouts.
- Real fills on Polymarket can be worse, for example waiting in line behind other offers.
- No strategy here is proven yet; the bot is collecting the evidence. Expect quiet stretches and small results.
- Ask Claude, if you see it, is an optional chat for the owner. It can't place trades or change rules.

For the technical details, see [the bot manual](docs/BOT-MANUAL.md) and [the decision engine](docs/DECISION-ENGINE.md).
