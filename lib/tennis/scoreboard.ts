import type {TennisScoreboardState} from './types';

type Raw=Record<string,unknown>;
const object=(value:unknown):Raw=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Raw:{};
const id=(value:unknown)=>typeof value==='string'||typeof value==='number'?/^[1-9]\d*$/.test(String(value))?String(value):null:null;
const integer=(value:unknown,min:number,max:number)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=max?value:null;

export function tennisPlayerIdentity(yesSide:unknown,noSide:unknown):{yesPlayerId:string;noPlayerId:string}|null{
  const yes=object(yesSide),no=object(noSide),a=id(yes.teamId),b=id(no.teamId);
  return a&&b&&a!==b&&id(object(yes.team).id)===a&&id(object(no.team).id)===b?{yesPlayerId:a,noPlayerId:b}:null;
}

/** Provider set scores identify players explicitly. Raw point order is used only
 * when every set pair in that same response uniquely confirms the ordering. */
export function tennisScoreboardState(rawState:unknown,yesSide:unknown,noSide:unknown):TennisScoreboardState|null{
  const state=object(rawState),identity=tennisPlayerIdentity(yesSide,noSide);
  if(!identity||state.type!=='tennis'||!Array.isArray(state.periodScores))return null;
  const sets:TennisScoreboardState['sets']=[],seen=new Set<number>();
  for(const value of state.periodScores){
    const set=object(value),number=integer(set.number,1,5);
    if(number===null||seen.has(number)||set.type!=='PERIOD_SCORE_TYPE_REGULATION'||set.label!==`S${number}`||!Array.isArray(set.scores)||set.scores.length!==2)return null;
    const scores=set.scores.map(object),yes=scores.filter(row=>id(row.competitorId)===identity.yesPlayerId),no=scores.filter(row=>id(row.competitorId)===identity.noPlayerId);
    if(yes.length!==1||no.length!==1)return null;
    const a=integer(yes[0].score,0,99),b=integer(no[0].score,0,99);
    if(a===null||b===null)return null;
    sets.push({number,yes:a,no:b});seen.add(number);
  }
  sets.sort((a,b)=>a.number-b.number);
  if(sets.some((set,index)=>set.number!==index+1))return null;
  const period=typeof state.period==='string'?state.period:'',current=/^(?:S|TB)([1-5])$/.exec(period);
  const currentSet=current?sets.find(set=>set.number===Number(current[1])):undefined;
  const games=currentSet?{yes:currentSet.yes,no:currentSet.no}:null;
  const setsWon=sets.length?{yes:0,no:0}:null;
  for(const set of sets){
    const high=Math.max(set.yes,set.no),low=Math.min(set.yes,set.no);
    const complete=high===6&&low<=4||high===7&&(low===5||low===6)||high>7&&high-low===2;
    if(complete&&setsWon)setsWon[set.yes>set.no?'yes':'no']++;
  }
  const server=id(object(state.tennisState).servingTeamId);
  const serving=server===identity.yesPlayerId?'YES':server===identity.noPlayerId?'NO':null;
  let points:TennisScoreboardState['points']=null;
  const raw=typeof state.score==='string'?state.score.trim():'';
  const match=/^(\d{1,2}\s*-\s*\d{1,2}(?:\s*,\s*\d{1,2}\s*-\s*\d{1,2})*)\s*:\s*(\d{1,2}|AD|A)\s*-\s*(\d{1,2}|AD|A)$/i.exec(raw);
  if(match&&currentSet&&sets.at(-1)?.number===currentSet.number){
    const pairs=match[1].split(',').map(pair=>pair.split('-').map(Number));
    const forward=pairs.length===sets.length&&pairs.every((pair,index)=>pair[0]===sets[index].yes&&pair[1]===sets[index].no);
    const reverse=pairs.length===sets.length&&pairs.every((pair,index)=>pair[0]===sets[index].no&&pair[1]===sets[index].yes);
    const values=match.slice(2).map(value=>value.toUpperCase()==='A'?'AD':value.toUpperCase());
    const validPoints=period.startsWith('TB')?values.every(value=>/^\d{1,2}$/.test(value)):values.every(value=>['0','15','30','40','AD'].includes(value));
    if(forward!==reverse&&validPoints)points={yes:values[forward?0:1],no:values[forward?1:0]};
  }
  return {sets,setsWon,games,points,serving};
}
