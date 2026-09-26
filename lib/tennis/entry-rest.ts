import type {TennisSession} from './types.ts';

/** A rest on one game does not mean an unfocused bot cannot scan another game. */
export function focusedEntryRest(session:TennisSession|null,now:number):number|null {
  if(!session||session.status!=='running'||!session.config.focusSlug||session.pending||
    session.positions.some(position=>position.status==='open')||!Number.isFinite(now)||
    session.lastTickAt>now||now-session.lastTickAt>20000)return null;
  const slug=session.config.focusSlug;
  const tracks=session.config.strategy==='auto'
    ?(['YES','NO'] as const).flatMap(side=>(['recovery','momentum'] as const).map(strategy=>session.autoSignals?.[`${slug}:${side}:${strategy}`]))
    :(['YES','NO'] as const).map(side=>session.signals[`${slug}:${side}`]);
  const deadlines=tracks.map(track=>track?.cooldownUntil);
  if(!deadlines.every((deadline):deadline is number=>deadline!==undefined&&Number.isFinite(deadline)&&deadline>now))return null;
  return Math.ceil((Math.min(...deadlines)-now)/1000);
}
