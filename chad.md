# Chad's guide to Dugout

Dugout lets you watch a bot practise trading sports markets with **fake money**. It does not place real bets or real-money orders. A paper gain is not money you can withdraw, and a successful demo would not prove that the bot can make money in real trading.

## Access status

Your private invitation has not been issued yet. The owner needs the email address you will sign in with. The source ZIP does not grant access to the hosted app or include anyone's credentials. Use your own invited login, never the owner's login.

The current background runner is configured for the owner's account. A separate signed-in visitor can have a separate paper account, but customer login and a complete paper run have not yet been verified end to end. Follow the runtime notice in the app: if it says checks run while the page is open, keep the tab open and visible. Do not assume the bot keeps working after you close it.

## The basic idea

The bot watches the buy and sell prices for both sides of the game you choose. It measures whether a drop is unusual for that market, whether buyer prices are recovering, and whether enough room remains after fees, the buy/sell gap and a movement allowance. A possible entry still has to pass the normal safety checks. These are local calculations; the bot is not watching the TV broadcast or using AI to predict who will win.

The bot often waits. An old quote, a large gap between buying and selling prices, an old game report, or a setup that has not formed can all prevent an entry. It explains that decision on the screen. A quiet bot is not proof of a fault, and it should not be pushed to trade just to produce activity.

## Your first session, once access is ready

1. Open the private Dugout link and use your invited login.
2. Check that the displayed paper balance is your own. A new account starts with $100 fake cash in the current code; an existing account keeps its saved balance.
3. Choose Football or Tennis, then select a live game to view its chart. The available list depends on the market provider.
4. Press **Focus bot on this game**. The named bot focus tells you which game it can enter; simply viewing a different chart does not change its focus.
5. Press **Start paper bot**. An older account first saves the current decision-engine policy without resetting cash or history. Watch the current decision, quotes, chart and any position that opens. Read the runtime notice about whether the tab must stay open.
6. Use **Pause** to prevent new entries while the bot continues managing an existing position. **Stop bot** also asks it to exit a held position; that exit still needs an executable quote and is not instant or guaranteed.

You do not need to edit the advanced rules for a first demonstration. This guide does not recommend changing them to chase a loss or force a trade.

**You choose the game, not the team.** The bot checks both teams and can buy either one if its setup qualifies. Switching the team shown on the chart only changes your view. Open **Compare both teams** to see the latest reason for each side. It can hold only one position at a time.

## What the screen means

| Screen item | Meaning |
| --- | --- |
| Paper balance | Simulated account value, with estimates for held positions; see the account details |
| Available cash | Fake cash currently available |
| Bot focus | The game allowed for future entries |
| Compare both teams | Each team's latest saved decision; your chart selection does not lock a team |
| Accepted bot quote | Age of the book the bot actually accepted; rejected arrivals cannot refresh it |
| Runner update | Age of a saved check/control update, not proof that the quote passed |
| Bot game report | Age of the saved football report, independent of prices |
| Buy / sell quote | Current prices to enter or exit; the gap matters |
| Book checked | Age of the market quote check, separate from the game report |
| Report age | Age of the provider's game information |
| Last checked | When the app last successfully checked that game feed; it can still return an old report |
| Blue field line | Reported ball position / line of scrimmage |
| Yellow field line | Reported first-down target when the required facts are available |
| Current decision | What the bot is doing or why it is waiting |
| Decision details | Optional measurements behind that decision, including costs and the age of its evidence |
| More details | Detailed history, diagnostics and the saved-history download |

The field is a drawing of provider reports, not live video. It can lag, and faded or missing markers indicate old or unverified information. Fresh market prices do not mean the field report is fresh.

## If it is not buying

Read the current decision before changing anything:

- **Paused / Ready / Stopped:** it is not starting new trades. Use Start when you want a paper run.
- **Collecting executable history:** both the quote count and elapsed history must qualify. For example, 35/20 quotes and 87/90 seconds still needs more usable history.
- **Drop is not distinct from volatility:** the move is too small compared with recent price noise. It is checking but has no qualifying setup.
- **Football report older than 45 seconds:** prices may be live, but game facts are too old for entry. The app cannot invent a newer play.
- **Older provider book:** a newly delivered response contains older prices than the bot already saw. It waits for a current book.
- **Between scrimmage plays:** the provider explicitly reports no active down, as can happen around scoring or kicks. The score stays visible, field lines are hidden, and entries wait for the next verified down. The feed does not identify every kick or touchdown, so the app does not invent a play label.

Do not reset the balance or loosen rules to make a trade appear. If **Runner update** stops advancing while running, use Reconnect and tell the owner the game, time and message. A different chart does not change the named **Bot game**.

## A few useful limits

- All trading in this product is simulated.
- One open position is allowed per paper account.
- A simulated purchase includes fees and can be delayed, partially filled or rejected.
- The current engine adjusts profit-taking to price movement and available buyers. It keeps the original loss threshold and time limit for each position; these are exit rules, not guaranteed prices or maximum losses.
- The current background experiment has not completed its full 60-minute live acceptance test. No profitability claim is supported.
- Claude, where enabled, is an optional adviser chat. It cannot place a trade or apply rule changes. It is not the automatic decision engine.

If something looks wrong, note the game, time, on-screen status and whether the tab was open. Avoid resetting the balance while investigating; history is useful evidence.

For full behavior and technical details, see [the bot manual](docs/BOT-MANUAL.md). For the current verification record, see [release status](docs/RELEASE-STATUS.md).
