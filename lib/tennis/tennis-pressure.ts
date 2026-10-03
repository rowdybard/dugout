import type {TennisMarket} from './types';

/**
 * Tennis pressure points: moments when one point can move the price a long way. New tennis buys (entries and Auto's
 * add-on) wait them out; held shares and exits are unaffected. A safety rule chosen on October 3, 2026, not measured:
 * each skip is recorded as a TENNIS_PRESSURE decision with the price, so a later study can compare it with trading.
 *   Tiebreak: the period reads TB<n>, or the set is 6-6.
 *   Break point: the receiver is one point from winning the server's game (40 against 0/15/30, or advantage).
 * Needs the provider's verified scoreboard (market.tennis); without it, nothing is blocked.
 */
export function tennisPressure(market:Pick<TennisMarket,'league'|'live'|'period'|'tennis'>):string|null {
  if((market.league!=='ATP'&&market.league!=='WTA')||!market.live)return null;
  const t=market.tennis;
  if(/^TB\d/i.test(market.period?.trim()??'')||(t?.games?.yes===6&&t.games.no===6))return 'Tiebreak: one point can swing the price, so new buys wait until it ends.';
  if(!t?.points||!t.serving)return null;
  const server=t.serving==='YES'?t.points.yes:t.points.no,receiver=t.serving==='YES'?t.points.no:t.points.yes;
  if(receiver==='AD'||(receiver==='40'&&['0','15','30'].includes(server)))return 'Break point: one point can swing the price, so new buys wait until the game is decided.';
  return null;
}
