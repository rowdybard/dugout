'use client';
import {useEffect,useState} from 'react';
import {ChevronDown} from 'lucide-react';
type Research={version:string;ratingsThrough:string;holdout:{games:number;brier:number;baseline:number;interval:number[]};later:{games:number;brier:number;baseline:number};purpose:string;limitations:string[]};
export function BotModelResearch(){
  const [research,setResearch]=useState<Research|null>(null);
  useEffect(()=>{let active=true;fetch('/api/bot/model').then(r=>r.ok?r.json():null).then(r=>{if(active)setResearch(r as Research|null);}).catch(()=>{});return()=>{active=false;};},[]);
  if(!research)return null;
  return <details className="auto-experiment auto-model"><summary><span>MLB outcome model <small>Experimental</small></span><span>{research.holdout.games.toLocaleString()}-game holdout <ChevronDown size={15}/></span></summary><div>
    <p>{research.purpose}</p>
    <div className="auto-model-table"><table><caption>Forecast error · lower is better <span title="Brier score compares predicted probabilities with actual results. These scores measure game predictions, not trading profit." aria-label="About forecast error">ⓘ</span></caption><thead><tr><th>Evaluation</th><th>Games</th><th>Team model</th><th>Simple home baseline</th></tr></thead><tbody><tr><th>Later 2025</th><td>{research.holdout.games.toLocaleString()}</td><td>{research.holdout.brier.toFixed(4)}</td><td>{research.holdout.baseline.toFixed(4)}</td></tr><tr><th>2026 to Sep 22</th><td>{research.later.games.toLocaleString()}</td><td>{research.later.brier.toFixed(4)}</td><td>{research.later.baseline.toFixed(4)}</td></tr></tbody></table></div>
    <ul>{research.limitations.map(s=><li key={s}>{s}</li>)}</ul><p>Ratings through {research.ratingsThrough}. New paper entries require the selected side’s estimate to exceed the fee-inclusive entry price by at least 3 percentage points, plus all other entry checks.</p>
  </div></details>;
}
