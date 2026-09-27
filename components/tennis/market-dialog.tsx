'use client';
import {Dialog,DialogContent,DialogDescription,DialogTitle} from '@/components/ui/dialog';
import type {FootballAssessment,TennisMarket,TennisSession} from '@/lib/tennis/types';
import type {ContextCheckState} from '@/lib/tennis/context-check';
import {TennisMatchChart} from './match-chart';
export function TennisMarketDialog({market,session,now,onClose,contextAssessment,contextCheck}:{market:TennisMarket|null;session:TennisSession|null;now:number;onClose:()=>void;contextAssessment?:FootballAssessment;contextCheck?:ContextCheckState}){
  if(!market)return null;
  return <Dialog open onOpenChange={open=>!open&&onClose()}><DialogContent className="tennis-market-dialog">
    <div className="tennis-dialog-meta"><span className="tennis-tour">{market.league}</span><span>{market.live&&market.active?'IN PLAY':market.ended?'ENDED':'WAITING FOR PLAY'}</span></div>
    <DialogTitle className="tennis-dialog-title">{market.yesName} <span>vs.</span> {market.noName}</DialogTitle>
    <DialogDescription className="tennis-dialog-description">{market.tournament||(market.league==='CFB'?'College football':market.league==='NFL'?'NFL':market.league==='MLB'?'MLB':'Tennis')}{market.score?` · ${market.score}`:''}</DialogDescription>
    <TennisMatchChart market={market} session={session} now={now} contextAssessment={contextAssessment} contextCheck={contextCheck}/>
  </DialogContent></Dialog>;
}
