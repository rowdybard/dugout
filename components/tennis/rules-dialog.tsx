'use client';
import {useState} from 'react';
import {Dialog,DialogContent,DialogDescription,DialogTitle} from '@/components/ui/dialog';
import {defaultTennisConfig,describeTennisRules,normalizeTennisConfig,validateTennisConfig} from '@/lib/tennis/rules';
import type {TennisAction,TennisConfig,TennisSession} from '@/lib/tennis/types';
import {tennisCommandId} from './command-id';
type NumberKey={ [K in keyof TennisConfig]:TennisConfig[K] extends number?K:never }[keyof TennisConfig];
export function TennisRulesDialog({session,busy,error,onClose,onAction}:{session:TennisSession;busy:boolean;error:string|null;onClose:()=>void;onAction:(action:TennisAction)=>Promise<boolean>}) {
  const [draft,setDraft]=useState(()=>normalizeTennisConfig(session.config));
  const [revision]=useState(session.rulesRevision??0),[more,setMore]=useState(false);
  const field=(key:NumberKey,label:string,unit:string,min:number,max:number,scale=1,step=1)=>
    <label className="tennis-rule-field" key={key}><span>{label}<small>{unit}</small></span><input type="number" aria-label={label} min={min} max={max} step={step} value={Number.isFinite(draft[key])?+(draft[key]/scale).toFixed(6):''} onChange={e=>setDraft({...draft,[key]:e.target.value===''?NaN:Number(e.target.value)*scale})}/></label>;
  const issue=validateTennisConfig(draft);
  const apply=async()=>{const rules={...draft} as Partial<TennisConfig>;delete rules.startingCash;delete rules.version;if(await onAction({action:'update-rules',rules,expectedRulesRevision:revision,sessionId:session.id,commandId:tennisCommandId()}))onClose();};
  return <Dialog open onOpenChange={open=>!open&&onClose()}><DialogContent className="tennis-market-dialog tennis-rules-dialog">
    <DialogTitle className="tennis-dialog-title">Set limits. Let the bot decide.</DialogTitle>
    <DialogDescription className="tennis-dialog-description">Auto compares both entry patterns on every live match. Set your budget and limits once; changes keep your balance and history.</DialogDescription>
    <div className="tennis-strategy-choices" role="group" aria-label="Bot strategy">{(['auto','recovery','momentum'] as const).map(strategy=><button className={strategy==='auto'?'is-auto':''} key={strategy} aria-pressed={draft.strategy===strategy} onClick={()=>setDraft({...draft,strategy})}><b>{strategy==='auto'?'Auto — choose the setup for me':strategy==='recovery'?'Fixed: wait for a recovery':'Fixed: follow a rise'}</b><span>{strategy==='auto'?'Compare a bounce and a sustained rise. Adapt to quote movement while keeping your money and risk limits fixed.':strategy==='recovery'?'Watch a dip, then wait for buyers to return.':'Wait for a sustained rise in price and buyers.'}</span></button>)}</div>
    <div className="tennis-tour-choice" role="group" aria-label="Tours the bot can watch">{(['ATP','WTA'] as const).map(league=><button key={league} aria-pressed={draft.leagues.includes(league)} onClick={()=>setDraft({...draft,leagues:draft.leagues.includes(league)?draft.leagues.filter(l=>l!==league):[...draft.leagues,league]})}>{league==='ATP'?'Men · ATP':'Women · WTA'}</button>)}</div>
    <div className="tennis-rules-grid">
      {field('entryBudget','Dollars per trade','Maximum spend, including fees',.01,Math.min(100,draft.startingCash*.2),1,.01)}
      {field('targetReturn','Take profit at','Percent after fees',.01,100,.01,.1)}
      {field('stopReturn','Try to exit a loss at','Percent after fees; exit needs buyers',.01,50,.01,.1)}
      {field('maxHoldMs','Hold for at most','Minutes before trying to exit',.1,60,60000,.1)}
      {field('maxSpreadPoints','Largest price gap','Cents between buying and selling',.1,10,1,.1)}
      {draft.strategy!=='auto'&&<>{draft.strategy==='recovery'?<>{field('declinePoints','Wait for a drop of','Cents below the recent baseline',.1,40,1,.1)}{field('recoveryPoints','Then a recovery of','Cents above the low',.1,40,1,.1)}</>:field('momentumPoints','Wait for a rise of','Cents above the recent baseline',.1,40,1,.1)}{field(draft.strategy==='recovery'?'recoveryConfirmations':'momentumConfirmations','Confirm the move','Independent fresh quotes',2,20)}</>}
    </div>
    <button className="tennis-link" aria-expanded={more} onClick={()=>setMore(!more)}>{more?'Hide timing controls':'More controls'}</button>
    {more&&<div className="tennis-rules-grid">
      {field('baselineWindowMs','History window','Seconds used to find the baseline',1,3600,1000)}
      {field('minimumHistoryMs','Warm-up time','Seconds of history before any entry',1,3600,1000)}
      {field('minSamples','Minimum quotes','Fresh observations needed',3,200)}
      {field('cooldownMs','Rest between trades','Seconds for this match',0,3600,1000)}
      {field('executionDelayMs','Simulated delay','Seconds plus a later fresh quote',1,30,1000)}
      {field('maxBookAgeMs','Oldest allowed quote','Seconds',.1,30,1000,.1)}
      {field('maxSessionLossFraction','Stop the session at','Percent lost from the starting balance',.1,50,.01,.1)}
    </div>}
    <p className="tennis-rule-summary">{issue||describeTennisRules(draft)}</p>
    <p className="tennis-order-help">Always paper money, live matches, and one position at a time. Each entry is limited to 20% of the starting balance. These strategies are unproven.</p>
    {error&&<p className="tennis-dialog-error" role="alert">{error}</p>}
    <div className="tennis-reset-actions"><button className="tennis-link" onClick={()=>setDraft({...defaultTennisConfig(session.config.startingCash),strategy:'auto'})}>Restore defaults</button><button className="tennis-primary" disabled={busy||!!issue} onClick={()=>void apply()}>{busy?'Saving…':'Apply rules'}</button></div>
  </DialogContent></Dialog>;
}
