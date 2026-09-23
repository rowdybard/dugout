export const glossary:Record<string,string>={
 'Market belief':'A 43¢ YES price translates to roughly 43% implied probability. It reflects prices people offer, not a forecast guaranteed to be correct.',
 'Spread':'The gap between what buyers offer and sellers want. A smaller gap generally makes entering or exiting less costly.',
 'Activity':'Contracts traded during a period. We compare changes over time; a large lifetime total alone does not mean a market is suddenly busy.',
 'Liquidity':'How many contracts are available at different prices. A thin book means even a small purchase can move your execution price.',
 'Buying price':'The lowest price sellers currently offer. A larger purchase may need to pay more at the next price level.',
 'Selling price':'The highest price buyers currently offer. Selling immediately after buying usually costs you the spread, plus fees.',
 'Contract':'One YES contract pays $1 if YES wins and $0 if it loses. Some canceled or voided events can settle at another official value.',
 'Paper equity':'Unspent fake cash plus the estimated selling value of open positions. It can fall even before you close a trade.',
 'Order book':'A list of available buyer and seller offers. These are intentions, and they can disappear before you trade.',
 'Signal':'A description of unusual market behavior. It is not a recommendation or evidence of a profitable opportunity.',
 'Settlement':'The official value assigned after the market resolves. We use Polymarket US settlement data, never a guessed result.',
 'Slippage':'The difference between the first price you see and your average execution price when a purchase uses several price levels.',
 'Market order':'An instruction to trade at available prices. This paper simulator walks the current book, so it may fill at several prices.',
 'Limit order':'An instruction to buy or sell only at your specified price or better. V1 simulates immediate fills only.',
 'Position':'The contracts you currently hold. Its value changes with the market until you close it or it settles.',
 'Volume':'The number of contracts traded. It counts trading activity, not the number of people trading.'
};
