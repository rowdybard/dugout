'use client';

import {footballFieldView,type FootballFieldMarket} from '../../lib/tennis/football-field';
import type {FootballAssessment} from '@/lib/tennis/types';
import {contextCheckView,type ContextCheckState} from '@/lib/tennis/context-check';

const yardX=(yard:number)=>30+yard*6;
const muted='var(--dg-muted,#9ba6b4)';
const small='var(--fs-sm,14px)';

export function FootballField({market,now,assessment,contextCheck}:{market:FootballFieldMarket;now:number;assessment?:FootballAssessment;contextCheck?:ContextCheckState}){
  const field=footballFieldView(market,now,assessment);
  const check=contextCheckView(contextCheck,now,{freshness:field.freshness,live:market.live,ended:market.ended});
  if(!field.supported)return null;
  const fresh=field.freshness==='fresh';
  const reportLabel=fresh?'Fresh report':field.freshness==='transition'?'Between plays':field.freshness==='conflicting'?'Conflicting reports':field.freshness==='stale'?'Stale report':'Report unverified';
  const summary=`Reported football field. ${market.yesName} goal on the left; ${market.noName} goal on the right. ${field.positionLabel}. ${field.possessionLabel}. ${field.distanceLabel}. ${field.ageLabel}. ${reportLabel}.${field.issue?` ${field.issue}`:''}`;
  const markerOpacity=fresh?1:.55;
  return <section aria-label="Reported football field" style={{margin:'14px 0',padding:'16px',border:'1px solid var(--dg-line,#28323e)',borderRadius:12,background:'var(--dg-surface-2,#1a212b)',color:'var(--dg-text,#eef2f6)'}}>
    <div style={{display:'flex',flexWrap:'wrap',alignItems:'baseline',justifyContent:'space-between',gap:'6px 16px',marginBottom:6}}>
      <strong style={{fontSize:'var(--fs-md,16px)'}}>{field.direction===-1?'← ':''}{field.possessionLabel}{field.direction===1?' →':''}<span style={{fontWeight:400,color:muted}}> · {field.distanceLabel}</span></strong>
      <span style={{fontSize:small,fontWeight:600,color:fresh?'var(--dg-accent,#c2f477)':'var(--dg-warn,#f2c46d)'}} title={`Last checked ${check.checkedLabel}`}>{market.ended?'Game ended · ':!market.live?'Not in play · ':''}{reportLabel}{field.reportAgeMs!==null?` · ${field.ageLabel.replace(/^Reported /,'')}`:''}</span>
    </div>
    {check.failed&&<p role="status" style={{fontSize:small,color:'var(--dg-warn,#f2c46d)',lineHeight:1.5,margin:'0 0 8px'}}>{check.message}</p>}
    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16,fontSize:small,color:muted}}>
      <span style={{overflowWrap:'anywhere'}}>{market.yesName}</span>
      <span style={{textAlign:'right',overflowWrap:'anywhere'}}>{market.noName}</span>
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
        {yard>0&&yard<100&&yard%10===0&&<><text x={yardX(yard)} y="48" textAnchor="middle" fill="#e4ede6" fontSize="17" fontFamily="inherit" fontWeight="700">{yard<=50?yard:100-yard}</text><text x={yardX(yard)} y="182" textAnchor="middle" fill="#e4ede6" fontSize="17" fontFamily="inherit" fontWeight="700">{yard<=50?yard:100-yard}</text></>}
      </g>)}
      <g opacity={markerOpacity}>
        {field.firstDownLine!==null&&<line x1={yardX(field.firstDownLine)} x2={yardX(field.firstDownLine)} y1="19" y2="197" stroke="#ffdf57" strokeWidth="5" strokeDasharray={fresh?undefined:'8 5'}/>}
        {field.lineOfScrimmage!==null&&<>
          <line x1={yardX(field.lineOfScrimmage)} x2={yardX(field.lineOfScrimmage)} y1="19" y2="197" stroke="#77c5ff" strokeWidth="4" strokeDasharray={fresh?undefined:'8 5'}/>
          <ellipse cx={yardX(field.lineOfScrimmage)} cy="108" rx="11" ry="7" fill="#8d4e2e" stroke="#fff4de" strokeWidth="2"/>
          <line x1={yardX(field.lineOfScrimmage)-5} x2={yardX(field.lineOfScrimmage)+5} y1="108" y2="108" stroke="#fff4de" strokeWidth="2"/>
        </>}
      </g>
      <text x="30" y="218" textAnchor="middle" fill="#9ba6b4" fontSize="13" fontFamily="inherit">GOAL</text>
      <text x="630" y="218" textAnchor="middle" fill="#9ba6b4" fontSize="13" fontFamily="inherit">GOAL</text>
    </svg>
    <div style={{display:'flex',flexWrap:'wrap',gap:'4px 16px',fontSize:small,lineHeight:1.6,marginTop:4,color:muted}}>
      <span><span aria-hidden="true" style={{color:'#77c5ff'}}>━━ </span>Ball{field.lineOfScrimmage!==null?` · ${field.positionLabel}`:''}</span>
      <span><span aria-hidden="true" style={{color:'#ffdf57'}}>━━ </span>{field.goalToGo?'Goal':'First down'}{field.firstDownLine===null?' · unknown':''}</span>
      {(field.issue||!fresh)&&<span style={{color:'var(--dg-warn,#f2c46d)'}}>{field.issue??'Faded markers: last reported spot'}</span>}
    </div>
  </section>;
}
