'use client';

import type {TennisMarket} from '@/lib/tennis/types';
import type {ContextCheckState} from '@/lib/tennis/context-check';

type ScoreboardMarket=Pick<TennisMarket,'league'|'yesName'|'noName'|'tennis'|'score'|'period'|'tournament'|'live'|'ended'|'startTime'|'contextUpdatedAt'>;
const age=(time:number,now:number)=>now-time<10_000?'just now':now-time<60_000?`${Math.floor((now-time)/1000)}s ago`:`${Math.floor((now-time)/60_000)}m ago`;

/** Player assignment and serving come from the normalized feed, never the raw score's text order. */
export function TennisScoreboard({market,now,contextCheck}:{market:ScoreboardMarket;now:number;contextCheck?:ContextCheckState}){
  if(market.league!=='ATP'&&market.league!=='WTA')return null;
  const score=market.tennis;
  const sets=[...(score?.sets??[])].sort((a,b)=>a.number-b.number);
  const assigned=!!(sets.length||score?.setsWon||score?.games||score?.points);
  const failed=!!contextCheck?.error;
  const status=market.ended?'Final':market.live?'Live':'Upcoming';
  const period=market.period&&/^TB\d*$/i.test(market.period)?'Tie-break':market.period;
  const start=Date.parse(market.startTime);
  const reported=market.contextUpdatedAt;
  return <section className="tennis-live-scoreboard" aria-label="Tennis match scoreboard">
    <div className="tennis-live-scoreboard-head">
      <div><span className={`tennis-dot ${market.live&&!market.ended?'is-live':''}`}/><strong>{status}</strong><span>{market.league}{period?` · ${period}`:''}</span></div>
      {reported!==null&&Number.isFinite(reported)&&reported>=0&&reported<=now&&<small>{failed?'Last score':'Updated'} {age(reported,now)}</small>}
    </div>
    {market.tournament&&<p className="tennis-live-scoreboard-tour">{market.tournament}</p>}
    <div className="tennis-live-scoreboard-table">
      <table>
        <caption className="tennis-visually-hidden">Reported scores for both players</caption>
        <thead><tr><th scope="col">Player</th>{score?.setsWon&&<th scope="col">Sets</th>}{score?.games&&<th scope="col">Games</th>}{score?.points&&<th scope="col">Points</th>}{sets.map(set=><th scope="col" key={set.number}>Set {set.number}</th>)}</tr></thead>
        <tbody>{(['YES','NO'] as const).map(side=>{
          const key=side==='YES'?'yes':'no',name=side==='YES'?market.yesName:market.noName;
          return <tr key={side}><th scope="row"><span>{name}</span>{score?.serving===side&&<span className="tennis-serving-dot" role="img" aria-label="Serving" title="Serving"/>}</th>
            {score?.setsWon&&<td>{score.setsWon[key]}</td>}{score?.games&&<td>{score.games[key]}</td>}{score?.points&&<td className="tennis-live-point">{score.points[key]}</td>}{sets.map(set=><td key={set.number}>{set[key]}</td>)}
          </tr>;
        })}</tbody>
      </table>
    </div>
    {market.score&&!score?.points?<p className="tennis-live-scoreboard-fallback">Reported score <strong>{market.score}</strong></p>:!assigned&&!failed&&<p className="tennis-live-scoreboard-fallback" role="status">{market.live||market.ended?'Score not supplied yet.':Number.isFinite(start)?`Starts ${new Date(start).toLocaleString([],{weekday:'short',hour:'numeric',minute:'2-digit'})}.`:'Waiting for the match to start.'}</p>}
    {failed&&<p className="tennis-live-scoreboard-note" role="status" title={contextCheck!.error!}>Score update delayed. {assigned||market.score?'Showing the last known score.':'Retrying shortly.'}</p>}
    {score?.serving&&<p className="tennis-serving-key"><span className="tennis-serving-dot" aria-hidden="true"/> Serving</p>}
  </section>;
}
