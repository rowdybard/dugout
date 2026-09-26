import test from 'node:test';
import assert from 'node:assert/strict';
import {advisorPayload,advisorContext,estimatedAdvisorMicrodollars,ADVISOR_ALLOWANCE,ADVISOR_RESERVATION} from '../lib/tennis/advisor.ts';
import {createTennisSession} from '../lib/tennis/engine.ts';
import {DatabaseSync} from 'node:sqlite';
import {reserveMessageSql,reserveAllowanceSql} from '../lib/tennis/advisor-storage.ts';
test('adviser context contains current rules and a bounded history without full books',()=>{
  const session=createTennisSession();const context=advisorContext(session,'Plain English');
  assert.equal(context.cash,100);assert.equal(context.preferences,'Plain English');assert.ok(!('histories' in context));
  const history=Array.from({length:20},(_,i)=>({role:(i%2?'assistant':'user') as 'user'|'assistant',content:`message ${i}`}));
  const body=advisorPayload(session,'Plain English',history,'Why wait?');
  assert.equal(body.messages.length,9);assert.equal(body.messages.at(-1)?.content,'Why wait?');
  assert.equal(body.messages[2].content,'message 14');assert.equal(body.thinking.type,'disabled');assert.equal(body.max_tokens,512);
  assert.ok(!('tools' in body));assert.ok(!('temperature' in body));
});
test('allowance reserves twenty sends and reported cost uses integer microdollars',()=>{
  assert.equal(ADVISOR_ALLOWANCE/ADVISOR_RESERVATION,20);
  assert.equal(estimatedAdvisorMicrodollars(18000,512),41120);
  assert.throws(()=>estimatedAdvisorMicrodollars(NaN,2));
});
test('oversized total context fails before any paid request can be built',()=>{
  assert.throws(()=>advisorPayload(createTennisSession(),'文'.repeat(1200),Array.from({length:6},()=>({role:'user' as const,content:'文'.repeat(1600)})),'hi'),/too long/);
});
test('actual reservation SQL prevents duplicate calls and caps allowance across reloads',()=>{
  const database=new DatabaseSync(':memory:');database.exec('CREATE TABLE cache(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated INTEGER NOT NULL)');
  database.prepare('INSERT INTO cache VALUES(?,?,?)').run('allowance','0',1);
  const reserve=(id:string,nonce:string)=>{
    database.exec('BEGIN');
    try{const inserted=database.prepare(reserveMessageSql).run(id,nonce,2,'allowance',950000).changes;
      database.prepare(reserveAllowanceSql).run(50000,2,'allowance',id,nonce);database.exec('COMMIT');return Number(inserted);
    }catch(e){database.exec('ROLLBACK');throw e;}
  };
  assert.equal(reserve('message-0','request-a'),1);assert.equal(reserve('message-0','request-b'),0);
  assert.equal(Number(database.prepare('SELECT value FROM cache WHERE key=?').get('allowance')?.value),50000);
  for(let i=1;i<20;i++)assert.equal(reserve(`message-${i}`,`nonce-${i}`),1);
  assert.equal(reserve('message-21','nonce-21'),0);
  assert.equal(Number(database.prepare('SELECT value FROM cache WHERE key=?').get('allowance')?.value),1000000);database.close();
});
