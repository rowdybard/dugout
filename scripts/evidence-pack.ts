/**
 * Evidence packs: the file research hands the engine (docs/DECISION-ENGINE.md).
 *
 *   node --experimental-strip-types scripts/evidence-pack.ts export [out.json]   # bundled pack -> JSON (starting point for research edits)
 *   node --experimental-strip-types scripts/evidence-pack.ts validate pack.json   # schema check, SHA-256 to pin, changes vs bundled
 *   node --experimental-strip-types scripts/evidence-pack.ts add pack.json results.json <new-version>
 *       # merge a study's evidence row(s) into the pack (same id replaces), under a new version
 *
 * Publishing is done from the PC with research/datastore/lake.py put-pack (after validate).
 */
import {readFileSync,writeFileSync} from 'node:fs';
import {BUNDLED_PACK,parsePack} from '../lib/decision/pack.ts';
import {createEngine} from '../lib/decision/engine.ts';
import {sha256Hex} from '../lib/decision/sources.ts';

const [command,path,extra,newVersion]=process.argv.slice(2);

if(command==='export'){
  const text=`${JSON.stringify(BUNDLED_PACK,null,1)}\n`;
  if(path)writeFileSync(path,text);else process.stdout.write(text);
  if(path)console.error(`Wrote ${path} (${BUNDLED_PACK.evidence.length} rows, version ${BUNDLED_PACK.version}).`);
}else if(command==='validate'&&path){
  const text=readFileSync(path,'utf8');
  const parsed=parsePack(JSON.parse(text));
  if(!parsed.ok){console.error(`INVALID: ${parsed.error}`);process.exit(1);}
  const pack=parsed.pack,engine=createEngine({pack,trust:'pinned'});
  const before=new Map(BUNDLED_PACK.evidence.map(row=>[row.id,row]));
  const after=new Map(pack.evidence.map(row=>[row.id,row]));
  console.log(`Valid pack ${pack.version}: ${pack.evidence.length} evidence rows, ${pack.models?.length??0} models, ${engine.models.length} compiled.`);
  console.log(`SHA-256 (pin with DUGOUT_EVIDENCE_PACK_SHA256): ${await sha256Hex(text)}`);
  for(const [id,row] of after){
    const old=before.get(id);
    if(!old)console.log(`  + ${id} [${row.status}]`);
    else if(JSON.stringify(old)!==JSON.stringify(row))console.log(`  ~ ${id} [${old.status} -> ${row.status}]`);
  }
  for(const id of before.keys())if(!after.has(id))console.log(`  - ${id} (removed; losing rows should stay so the engine keeps refusing them)`);
  const proven=pack.evidence.filter(row=>row.status==='proven');
  if(proven.length)console.log(`  ! ${proven.length} proven row(s): ${proven.map(r=>r.id).join(', ')}. Real money uses them only when this exact file is pinned.`);
}else if(command==='add'&&path&&extra&&newVersion){
  const parsed=parsePack(JSON.parse(readFileSync(path,'utf8')));
  if(!parsed.ok){console.error(`INVALID pack: ${parsed.error}`);process.exit(1);}
  const input=JSON.parse(readFileSync(extra,'utf8'));
  // A study's results carry rows under `evidence` (drive_entry.py adds `evidenceHold` and `evidenceFade`).
  const rows=(Array.isArray(input)?input:input&&typeof input==='object'&&'evidence' in input&&!('status' in input)?[input.evidence,input.evidenceHold,input.evidenceFade]:[input]).filter(Boolean);
  if(!rows.length){console.error(`No evidence row in ${extra}${input?.note?`: ${input.note}`:''}.`);process.exit(1);}
  if(!/^[A-Za-z0-9._-]{1,80}$/.test(newVersion)||newVersion===parsed.pack.version){console.error('Give a new version (letters, digits, . _ -), different from the current one: a version always means the same rules.');process.exit(2);}
  const ids=new Set(rows.map((row:{id:string})=>row.id));
  const next=parsePack({...parsed.pack,version:newVersion,generatedAt:new Date().toISOString(),evidence:[...parsed.pack.evidence.filter(row=>!ids.has(row.id)),...rows]});
  if(!next.ok){console.error(`INVALID after adding: ${next.error}`);process.exit(1);}
  writeFileSync(path,`${JSON.stringify(next.pack,null,1)}\n`);
  for(const row of rows as {id:string;status:string}[])console.log(`  ${parsed.pack.evidence.some(old=>old.id===row.id)?'~':'+'} ${row.id} [${row.status}]`);
  console.log(`Wrote ${path} as ${newVersion}. Next: validate it, then publish with research/datastore/lake.py put-pack.`);
}else{
  console.error('Usage: evidence-pack.ts export [out.json] | validate <pack.json> | add <pack.json> <results.json> <new-version>');
  process.exit(2);
}
