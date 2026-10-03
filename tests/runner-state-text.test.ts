import test from 'node:test';
import assert from 'node:assert/strict';
import {runnerStateText} from '../lib/runner/sites-proxy.ts';
import type {RunnerBindings} from '../lib/runner/sites-proxy';

const env:RunnerBindings={DUGOUT_OWNER_ID:'u_owner',DUGOUT_RUNNER_URL:'https://runner.example.workers.dev',DUGOUT_RUNNER_SECRET:'synthetic-secret-at-least-thirty-two-characters'};
const runner={feedKey:false,mode:'service',backgroundConnected:true,epoch:'e',lastTickAt:5,lastEngineCheck:5,quoteAgeMs:null,contextAgeMs:null,source:{updatedAt:5,state:'rest',message:'Prices checked — every few seconds'},usage:{day:'2026-10-03',estimatedRowsWritten:1,alarmChecks:1,entryPauseAt:90000},paperOnly:true};
const body=JSON.stringify({session:{id:'s',decisions:[{reason:'x'.repeat(5000)}]},sweep:null,runner});

test('runner state passes through as text, with the status block read from the header (no re-parse of the session)',async()=>{
  const fetcher=(async()=>new Response(body,{headers:{'Content-Type':'application/json','x-dugout-runner':encodeURIComponent(JSON.stringify(runner))}})) as unknown as typeof fetch;
  const {text,runner:status}=await runnerStateText(env,'u_owner_account_1234','epoch-1234','/v1/state','GET',undefined,fetcher);
  assert.equal(text,body,'the session text is passed through untouched');
  assert.equal(status.source.message,'Prices checked — every few seconds','non-ASCII survives the header');
});

test('an older runner without the header still works, and runner errors keep their message',async()=>{
  const old=(async()=>new Response(body,{headers:{'Content-Type':'application/json'}})) as unknown as typeof fetch;
  const {text,runner:status}=await runnerStateText(env,'u_owner_account_1234','epoch-1234','/v1/state','GET',undefined,old);
  assert.deepEqual(JSON.parse(text),JSON.parse(body));assert.equal(status.lastEngineCheck,5);
  const failing=(async()=>Response.json({error:'Runner migration is not active.'},{status:409})) as unknown as typeof fetch;
  await assert.rejects(()=>runnerStateText(env,'u_owner_account_1234','epoch-1234','/v1/state','GET',undefined,failing),/not active/);
});
