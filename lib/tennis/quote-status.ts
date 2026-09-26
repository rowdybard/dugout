/** Missing buyers and sellers block entries even when a book update is recent. */
export function quoteAvailabilityIssue(bid:number|null|undefined,ask:number|null|undefined):string|null {
  const valid=(price:number|null|undefined):price is number=>typeof price==='number'&&Number.isFinite(price)&&price>0&&price<1;
  if(!valid(bid)&&!valid(ask))return 'No usable buying or selling quotes are available for this player.';
  if(!valid(bid))return 'No usable buyers are quoted for this player, so the bot cannot plan an exit.';
  if(!valid(ask))return 'No usable sellers are quoted for this player, so the bot cannot enter.';
  if(bid>ask)return 'Buying and selling quotes disagree. Waiting for a consistent book.';
  return null;
}
