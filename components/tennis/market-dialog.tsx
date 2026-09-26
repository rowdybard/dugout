'use client';
import {Dialog,DialogContent,DialogDescription,DialogTitle} from '@/components/ui/dialog';
import type {TennisMarket,TennisSession} from '@/lib/tennis/types';
import {TennisMatchChart} from './match-chart';
export function TennisMarketDialog({market,session,now,onClose}:{market:TennisMarket|null;session:TennisSession|null;now:number;onClose:()=>void}){
  if(!market)return null;
  return <Dialog open onOpenChange={open=>!open&&onClose()}><DialogContent className="tennis-market-dialog">
    <div className="tennis-dialog-meta"><span className="tennis-tour">{market.league}</span><span>{market.live&&market.active?'IN PLAY':market.ended?'ENDED':'WAITING FOR PLAY'}</span></div>
    <DialogTitle className="tennis-dialog-title">{market.yesName} <span>vs.</span> {market.noName}</DialogTitle>
    <DialogDescription className="tennis-dialog-description">{market.tournament||(market.league==='CFB'?'College football':market.league==='NFL'?'NFL':'Tennis')}{market.score?` · ${market.score}`:''}</DialogDescription>
    <TennisMatchChart market={market} session={session} now={now}/>
  </DialogContent></Dialog>;
}
