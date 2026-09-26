'use client';
import {useEffect,useState} from 'react';
import {Dialog,DialogContent,DialogDescription,DialogTitle} from '@/components/ui/dialog';
import {tennisCommandId} from './command-id';
type Chat={configured:boolean;messagesRemaining:number;reservedMicrodollars:number;allowanceMicrodollars:number;memory:string;messages:{role:'user'|'assistant';content:string}[];recentEstimatedMicrodollars:number;error?:string};
export function TennisAdvisor({onClose}:{onClose:()=>void}){
  const [chat,setChat]=useState<Chat|null>(null),[message,setMessage]=useState(''),[memory,setMemory]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const read=async()=>{const response=await fetch('/api/tennis/advisor',{cache:'no-store',signal:AbortSignal.timeout(12000)});const data=await response.json() as Chat;if(!response.ok)throw new Error(data.error);setChat(data);return data as Chat;};
  useEffect(()=>{let alive=true;fetch('/api/tennis/advisor',{cache:'no-store',signal:AbortSignal.timeout(12000)}).then(r=>r.json() as Promise<Chat>).then(data=>{if(alive){if(data.error)setError(data.error);else{setChat(data);setMemory(data.memory);}}}).catch(()=>{if(alive)setError('Saved chat is unavailable. Close and reopen to retry.');});return()=>{alive=false;};},[]);
  const submit=async(action:'send'|'memory')=>{setBusy(true);setError('');try{
    const response=await fetch('/api/tennis/advisor',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(action==='send'?{action,requestId:tennisCommandId(),message}:{action,memory}),signal:AbortSignal.timeout(55000)});
    const data=await response.json() as Chat;if(!response.ok)throw new Error(data.error||'The adviser is unavailable.');setChat(data);if(action==='send')setMessage('');if(data.error)setError(data.error);
  }catch(e){setError(e instanceof Error?e.message:'No reply received. No automatic retry was made.');try{await read();}catch{/* Preserve the original error. */}}finally{setBusy(false);}};
  return <Dialog open onOpenChange={open=>!open&&onClose()}><DialogContent className="tennis-market-dialog tennis-advisor-dialog">
    <DialogTitle className="tennis-dialog-title">A little help from Claude.</DialogTitle>
    <DialogDescription className="tennis-dialog-description">Ask why the bot waited, what a rule means, or how a run went. Advice only—Claude cannot trade or change your rules.</DialogDescription>
    <div className="tennis-advisor-status"><span>{chat?.configured?'Sonnet 5 · connected':'Not connected · no API calls'}</span><span>{chat?`${chat.messagesRemaining} messages left in the $1 allowance`:'Loading saved chat…'}</span></div>
    <div className="tennis-advisor-chat" role="log" aria-label="Saved adviser conversation">{chat?.messages.length?chat.messages.map((m,i)=><div className={`tennis-chat-message ${m.role==='user'?'is-user':''}`} key={i}><small>{m.role==='user'?'YOU':'CLAUDE ADVISER'}</small>{m.content}</div>):<p className="tennis-order-help">Your conversation stays saved here. Each message includes your notes, recent chat, and a small snapshot of the bot.</p>}</div>
    {!chat?.configured&&<p className="tennis-rule-summary">Connect with <b>ANTHROPIC_API_KEY</b> in the private site’s secret settings. Don’t paste a key into this chat. The bot works without Claude.</p>}
    <details><summary>What Claude remembers</summary><p>These notes and the last six chat messages accompany each question. Current bot rules and recent results are added automatically when you send.</p><textarea aria-label="Adviser memory" value={memory} maxLength={1200} rows={3} onChange={e=>setMemory(e.target.value)}/><button className="tennis-link" disabled={busy||!chat} onClick={()=>void submit('memory')}>Save notes · no AI call</button></details>
    <form onSubmit={event=>{event.preventDefault();if(!busy&&chat?.configured&&chat.messagesRemaining>0&&message.trim())void submit('send');}}>
      <textarea aria-label="Message Claude" placeholder="Why hasn’t the bot traded yet?" maxLength={1200} rows={3} value={message} onChange={e=>setMessage(e.target.value)} disabled={busy}/>
      <div className="tennis-reset-actions"><span className="tennis-order-help">Only Send calls Claude. No background calls or automatic retries.</span><button type="submit" className="tennis-primary" disabled={busy||!chat?.configured||chat.messagesRemaining<1||!message.trim()}>{busy?'Waiting for Claude…':'Send'}</button></div>
    </form>
    {error&&<p className="tennis-dialog-error" role="alert">{error}</p>}
    {chat&&<p className="tennis-order-help">${(chat.reservedMicrodollars/1e6).toFixed(2)} of $1 reserved · each Send reserves 5¢, including uncertain failures. Recent estimated API usage: ${(chat.recentEstimatedMicrodollars/1e6).toFixed(4)}. This does not show your Anthropic account balance.</p>}
  </DialogContent></Dialog>;
}
