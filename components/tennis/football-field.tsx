'use client';

import {footballFieldView,type FootballFieldMarket} from '../../lib/tennis/football-field';
import type {FootballAssessment} from '@/lib/tennis/types';
import {contextCheckView,type ContextCheckState} from '@/lib/tennis/context-check';

const yardX=(yard:number)=>30+yard*6;
const muted='#b7c8bb';

export function FootballField({market,now,assessment,contextCheck}:{market:FootballFieldMarket;now:number;assessment?:FootballAssessment;contextCheck?:ContextCheckState}){
  const field=footballFieldView(market,now,assessment);
  const check=contextCheckView(contextCheck,now,{freshness:field.freshness,live:market.live,ended:market.ended});
  if(!field.supported)return null;
  const fresh=field.freshness==='fresh';
  const reportLabel=fresh?'Fresh report':field.freshness==='conflicting'?'Conflicting reports':field.freshness==='stale'?'Stale report':'Report unverified';
  const summary=`Reported football field. ${market.yesName} goal on the left; ${market.noName} goal on the right. ${field.positionLabel}. ${field.possessionLabel}. ${field.distanceLabel}. ${field.ageLabel}. ${reportLabel}.${field.issue?` ${field.issue}`:''}`;
  const markerOpacity=fresh?1:.55;
  return <section aria-label="Reported football field" style={{margin:'14px 0',padding:'14px',border:'1px solid #344d3d',borderRadius:14,background:'#12281e',color:'#edf6ee'}}>
    <div style={{display:'flex',flexWrap:'wrap',alignItems:'center',justifyContent:'space-between',gap:'8px 16px',marginBottom:8}}>
      <strong style={{fontSize:14}}>Reported field</strong>
      <span style={{fontSize:12,fontWeight:700,color:fresh?'#c2f477':'#f2ba75'}}>{market.ended?'Game ended · ':!market.live?'Not in play · ':''}{reportLabel}</span>
    </div>
    <div style={{display:'flex',flexWrap:'wrap',gap:'4px 18px',fontSize:12,lineHeight:1.6,marginBottom:8,color:muted}}>
      <span>Report age: {field.reportAgeMs===null?'Unverified':field.ageLabel.replace(/^Reported /,'')}</span>
      <span title="Last successful read from the game-data provider. A new check does not make an unchanged play report fresh.">Last checked: {check.checkedLabel}</span>
    </div>
    <p role={check.failed?'status':undefined} style={{fontSize:12,color:check.failed?'#f2ba75':muted,lineHeight:1.5,margin:'0 0 10px'}}>{check.message}</p>
    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16,fontSize:12,color:muted}}>
      <span style={{overflowWrap:'anywhere'}}>{market.yesName}<small style={{display:'block'}}>Own goal line</small></span>
      <span style={{textAlign:'right',overflowWrap:'anywhere'}}>{market.noName}<small style={{display:'block'}}>Own goal line</small></span>
    </div>
    <svg viewBox="0 0 660 224" role="img" aria-label={summary} style={{display:'block',width:'100%',height:'auto',margin:'4px 0'}}>
      <title>Reported football field</title>
      <desc>{summary}</desc>
      <rect x="10" y="18" width="640" height="180" rx="5" fill="#174b30" stroke="#b1c9b6"/>
      <rect x="10" y="18" width="20" height="180" fill="#103a28"/>
      <rect x="630" y="18" width="20" height="180" fill="#103a28"/>
      {[0,20,40,60,80].map(yard=><rect key={yard} x={yardX(yard)} y="19" width="60" height="178" fill="#215b3c"/>)}
      {Array.from({length:21},(_,i)=>i*5).map(yard=><g key={yard}>
        <line x1={yardX(yard)} x2={yardX(yard)} y1="19" y2="197" stroke="#d2e3d7" strokeOpacity={yard%10===0?.65:.25} strokeWidth={yard===0||yard===100?2:1}/>
        {yard>0&&yard<100&&<><line x1={yardX(yard)-3} x2={yardX(yard)+3} y1="86" y2="86" stroke="#c0d4c6"/><line x1={yardX(yard)-3} x2={yardX(yard)+3} y1="130" y2="130" stroke="#c0d4c6"/></>}
        {yard>0&&yard<100&&yard%10===0&&<><text x={yardX(yard)} y="48" textAnchor="middle" fill="#e4ede6" fontSize="17" fontFamily="sans-serif" fontWeight="700">{yard<=50?yard:100-yard}</text><text x={yardX(yard)} y="182" textAnchor="middle" fill="#e4ede6" fontSize="17" fontFamily="sans-serif" fontWeight="700">{yard<=50?yard:100-yard}</text></>}
      </g>)}
      <g opacity={markerOpacity}>
        {field.firstDownLine!==null&&<line x1={yardX(field.firstDownLine)} x2={yardX(field.firstDownLine)} y1="19" y2="197" stroke="#ffdf57" strokeWidth="5" strokeDasharray={fresh?undefined:'8 5'}/>}
        {field.lineOfScrimmage!==null&&<>
          <line x1={yardX(field.lineOfScrimmage)} x2={yardX(field.lineOfScrimmage)} y1="19" y2="197" stroke="#77c5ff" strokeWidth="4" strokeDasharray={fresh?undefined:'8 5'}/>
          <ellipse cx={yardX(field.lineOfScrimmage)} cy="108" rx="11" ry="7" fill="#8d4e2e" stroke="#fff4de" strokeWidth="2"/>
          <line x1={yardX(field.lineOfScrimmage)-5} x2={yardX(field.lineOfScrimmage)+5} y1="108" y2="108" stroke="#fff4de" strokeWidth="2"/>
        </>}
      </g>
      <text x="30" y="218" textAnchor="middle" fill={muted} fontSize="12" fontFamily="sans-serif">GOAL</text>
      <text x="630" y="218" textAnchor="middle" fill={muted} fontSize="12" fontFamily="sans-serif">GOAL</text>
    </svg>
    <div style={{display:'flex',flexWrap:'wrap',gap:'6px 18px',alignItems:'center',fontSize:13,lineHeight:1.5}}>
      <strong>{field.direction===-1?'← ':''}{field.possessionLabel}{field.direction===1?' →':''}</strong>
      <span>{field.distanceLabel}</span>
    </div>
    <div style={{display:'flex',flexWrap:'wrap',gap:'4px 16px',fontSize:12,lineHeight:1.6,marginTop:5}}>
      <span><span aria-hidden="true" style={{color:'#77c5ff'}}>━━ </span>Blue = ball / line of scrimmage{field.lineOfScrimmage!==null?` · ${field.positionLabel}`:''}</span>
      <span><span aria-hidden="true" style={{color:'#ffdf57'}}>━━ </span>Yellow = {field.goalToGo?'goal to reach':'first down'}{field.firstDownLine===null?' · unavailable':''}</span>
    </div>
    <p style={{fontSize:12,color:fresh?muted:'#f2ba75',lineHeight:1.5,margin:'7px 0 0'}}>
      {field.issue?`${field.issue} `:''}{!fresh?'Faded, dashed markers show the last reported location; they are not a current play. ':''}Markers update with game reports, independently of market quotes.
    </p>
  </section>;
}
