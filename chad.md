# Chad's guide to Dugout

Updated October 3, 2026.

Dugout runs Football and Tennis bots that practise trading Polymarket games with **fake money**. They share one balance and trade history, with separate Start, Pause and game choices. It never places real bets. A paper profit isn't money you can withdraw, and a good weekend on paper doesn't prove the bot would make money for real.

## Getting in

- Open the Dugout link the owner sent you and **sign in with Google**. Your email has to be on the invite list; ask the owner if it isn't.
- You get **your own paper account**, starting at $100 of fake money. Nobody else can see or change it, and you can't see theirs.

## The screen, top to bottom

Choose **Football** or **Tennis** at the top. Tennis starts idle, and opening it does not reset or add money. Tennis uses **Auto**, **Recovery** (a price falls and recovers) or **Momentum** (a confirmed rise). These are paper experiments. Football's modes are described below. Either bot can run while you look at the other tab.

Tennis's new default bet is **$10 on a $100 starting balance**. Use the Small / Default / Large buttons on the bot card to change your saved bet size. An existing run keeps its saved size until you choose one; your balance and history stay intact.

New **Tennis Auto** can follow smaller confirmed moves and let gains continue. It looks at the result after fees and can sell when buyers confirm a reversal. It has no fixed 65¢ target or two-minute sell timer. The first purchase fixes its loss allowance: about $2.50 on a $10 purchase by default. One extra buy after a confirmed lower-price rebound can reduce average cost, but cannot increase that original dollar allowance. It can still sell the combined holding early. Average purchase price updates using the actual shares and prices of both buys; purchase fees are shown separately.

**Break points and tiebreaks:** the Tennis bot doesn't start a new bet or make its extra buy during a break point or a tiebreak, when a single point can move the price a long way. It waits until the game or tiebreak is over. Shares already held are managed as usual. The score it uses can be up to about 15 seconds old. This is a safety rule, not yet proven to help; each wait is logged ("TENNIS_PRESSURE") so it can be checked later.

If your saved run says it uses the original quick-trade Auto, tap **Auto** to apply the new rules to future trades. Shares already bought keep their original exit rules.

You can scroll through **Trades & balance** and **Bot activity** without the rows moving underneath you. The list pauses when you start reading; the bot keeps running. **Show newest** catches up. Open **Why** on a trade to see what triggered it, and check its after-fee result rather than just the change in price.

1. **Search box.** Type a team and pick a live or upcoming college game. That's the game the bot trades.
   - If it says the account is set to other sports, tap **Show college football games** once.
2. **Bot card:**
   - the game name, and **Steady** / **Bold** / **Auto** (see below);
   - your **balance**, and **Reset balance**;
   - the selected bot's main button: **Start bot**, **Pause**, **Resume** or **Acknowledge loss and resume**, and **End run** next to it while a run is going;
   - **status box:** what the bot is doing right now, in one or two sentences. Tap **Both sides** under it for a line about each team.
   - **Open orders & shares:** every offer the bot has waiting and every share it holds, with prices, cost and what it would get if it sold now. If a price isn't fresh it says so ("price 40 s old", "only 6 of 10 shares priced", "no price yet"); the balance at the top counts holdings the same way. After you change the rules or the mode, a line here says whether it changes anything for shares already held.
3. **Game tracker:** Football's score and clock come from Polymarket. For a verified game, ESPN can fill in missing drive details. During a gap after scoring, the last known scorer and play stay visible; if only the score changed, it shows the points without guessing what happened. Feed timing is tucked into **Feed details**. Tennis shows a scoreboard above its prices and chart: sets, games, points and who's serving when supplied. It checks every five seconds even while the Tennis bot is idle. A small update age shows how recent the reported score is.
4. **Trades & balance:** every fill, with price, fees and result, plus a balance chart.
5. **Settings & history** (closed by default): rules, background running, your own price key, diagnostics and downloads. You don't need any of it to get started.

## Steady, Bold or Auto

The bot mostly trades by leaving **buy offers** on both teams, slightly below the current price, and waiting for someone to sell into them. If both offers fill, you hold both sides of the game. That pays exactly $1 at the end whoever wins, and you paid a bit less than $1, so the difference is profit.

| | Steady | Bold |
|---|---|---|
| Offer size (on $100) | $5 | $12 (12% of the balance, at most $50) |
| Hold-to-final bets the research allows | No | Yes |
| Only one team's offer filled | Tries to complete the pair; **sells after 10 minutes** if it can't | **Take-profit:** sells (or completes the pair) once it's **5¢ up** on its average. **Buys once more** if the price drops 5¢, and **sells if it then drops another 10¢** below its average |
| Feel | Many small wins and losses | Bigger wins and bigger losses |

Bold doesn't make the bot smarter. It puts more money on each trade, so the bad days get bigger too.

In Bold (and Auto when it's in Bold), the bot also tries one **comeback re-entry**, on paper, to measure it: when a team trails by 3 to 24 points and drives inside the opponent's 30 (1st to 3rd down, **at least 5 minutes left**), it buys that team and sells when the drive ends. It does not open that trade with fewer than 5 minutes left, when a trailing team is usually a 1–2¢ longshot. The research so far leans against it (the move after such drives is smaller than the cost of buying and selling), so treat its results as a test, not a strategy that wins back losses.

**Auto** lets the bot pick Steady or Bold on every check:
- **Bold** while the research allows a hold-to-final or comeback bet on your game;
- **Steady** when it doesn't (after 5 minutes without one, and only when nothing is held), and **always Steady while the run is down 10% or more**, so it never chases losses with bigger bets.

The line under the buttons says which one it's in and why. Switching never changes shares already held: they keep the plan they were bought under, except that dropping to Steady on a 10% loss also brings back Steady's "sell unpaired shares after 10 minutes".

## Starting, pausing, ending

- **Start bot:** pick a game first, then press it.
- **Pause:** no new trades. Anything already held stays managed. **Resume** carries on.
- **End run:** sells that bot's holdings and stops it. **Start bot** can start it again with the same balance and history.
- **Acknowledge loss and resume:** appears after the bot hits its loss limit and finishes selling. Keeps the same run, balance and history. Each acknowledgement allows the original dollar amount again: with a $100 start and a 20% limit, a stop at $79.94 can resume with another $20 allowance, reaching the next limit at $59.94. It never resumes a loss stop automatically.
- **Sell everything now:** the big button that appears while the bot holds shares. It's green when they're up and red when down, and shows the amount. It sells everything at the best price on the next price check (a few seconds) and pauses the bot. Press Resume to carry on.
- **Reset balance:** explicitly starts the whole shared wallet over at any amount from $5 to $10,000. It resets both bots and drops open paper trades.
- **Switching games:** search and pick another game any time. Shares held on the old game are still managed there, and new offers go to the new game. The Engine line under Settings & history waits for the new game's first check instead of showing the old game's plan.
- **Changing rules or mode mid-game is fine.** Every change is saved with the time and what it was before and after, and every purchase records the mode and rules it was made under, so results can be compared later.

## Leaving it running

- **Set up the background runner once:** with no open trades, open **Settings & history**, press **Set up background bot**, then **Finish background setup**. Your balance and history move over, and the bot stays paused until you press Start. After that it keeps trading with the tab closed, in your own private runner.
- **Until you do that:** the bot only runs while the Dugout tab is open. On a phone it may pause when the screen locks.

## Reading the status box

| It says | Meaning |
|---|---|
| **Buy offers posted** | Offers are waiting, e.g. "Offering to buy Liberty at 70¢ or Delaware at 29.5¢". Nothing happens until someone sells at that price. Most checks change nothing. |
| **Watching** | It's checking, but the research doesn't allow a trade right now. |
| **Bot is behind** | No check from the bot for 30–45 seconds. If it lasts more than a minute, reload the page. |
| **Paused / Ready / Stopped** | This bot is not trading. Press Resume or Start; a loss stop needs acknowledgement first. |
| **Loss limit hit** | Trading stopped at the loss limit. After exits finish, acknowledge the loss to continue the same run. |
| **Managing position** | It holds shares and is handling them (see Open orders & shares). |

## Why it isn't trading

These are all normal. It's the bot being careful, not broken:
- **After every play:** it pulls its offers for 30 seconds, because prices jump right after plays.
- **Old game report:** prices can keep moving while a drive report is delayed. Polymarket's report must stay within 45 seconds, and an ESPN drive report within 90 seconds, with matching score and quarter. A newer clock does not freshen an older drive. During gaps the tracker keeps the last known details and explains what is missing. Existing exits continue.
- **Thin or wide market:** if there are too few buyers and sellers, or the gap between buy and sell prices is wider than 5¢, it doesn't post offers.
- **Nobody selling:** offers only fill when someone sells at that price. Quiet games mean few fills.
- **Market closed or its status is out of date:** offers and Bold's extra dip buy don't fill on a market that's closed or suspended, or whose status is over 45 seconds old. Selling still works.
- **Spending limit:** shares held, a queued purchase and every waiting offer (main game and Octopus) together stay within half the balance, so offers shrink or stop as the bot holds more.
- **Loss limit:** Bold's dip buy is limited to what's left of the run's loss allowance, and skipped when none is left.

Don't reset or change rules just to make it trade. If something looks wrong, note the game, the time and what the status box says, and tell the owner.

## Extras (optional)

- **The Octopus** (red **Experimental** label, on the bot card): the bot works up to 6 extra games ("arms") at once, with the same offers and rules as your main game, at your Steady or Bold size.
  - **Auto-pick on:** it chooses calm, liquid college games itself and re-checks every 5 minutes.
  - **Your own picks:** use the search box to pin games. × removes a pinned game, or skips an auto one so it won't be picked again.
  - **Spending limit:** both bots' holdings, queued purchases and offers together use at most half the available account limit. They cannot each spend a separate half of the same wallet.
- **Your own Polymarket key** (Settings & history → Live prices): gives your bot instant price updates instead of a check every few seconds. Make a separate read-only key for it; it's stored encrypted and never shown again.
- **Download Octopus log / saved history:** a full record of what the bot did, under Settings & history.

## Limits worth knowing

- Everything is simulated: the fills, the fees, the $1 payouts.
- **How fills are simulated:** an offer fills in full as soon as the best sell price reaches it. Real fills would be fewer, because other buyers at the same price are ahead in line. Downloads and the scorecard state this.
- **Scorecard:** a strategy is only called proven with enough trades **and** enough different games. Resting-offer results are listed by mode (Steady, Bold, Auto), main game or Octopus, and rules version.
- No strategy here is proven yet; the bot is collecting the evidence. Expect quiet stretches and small results.
- Ask Claude, if you see it, is an optional chat for the owner. It can't place trades or change rules.

For the technical details, see [the bot manual](docs/BOT-MANUAL.md) and [the decision engine](docs/DECISION-ENGINE.md).
