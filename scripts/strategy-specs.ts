/**
 * Pre-registration lock for strategy specs (lib/decision/catalog.ts, docs/STRATEGY-ARCHITECTURE.md).
 *
 *   node --experimental-strip-types scripts/strategy-specs.ts check   # every spec version is locked and unchanged
 *   node --experimental-strip-types scripts/strategy-specs.ts lock    # add NEW id@version entries; never rewrites one
 *
 * Changing a locked version's rules fails `check` (and the test suite): make a new version instead.
 */
import {readFileSync,writeFileSync} from 'node:fs';
import {SPECS} from '../lib/decision/catalog.ts';
import {rulesHash,specKey} from '../lib/decision/spec.ts';

const PATH=new URL('../lib/decision/prereg.lock.json',import.meta.url);
const lock=JSON.parse(readFileSync(PATH,'utf8')) as Record<string,string>;
const command=process.argv[2];
const problems:string[]=[];let added=0;
for(const spec of SPECS){
  const key=specKey(spec),hash=await rulesHash(spec);
  if(!(key in lock)){
    if(command==='lock'){lock[key]=hash;added++;console.log(`+ ${key} ${hash}`);}
    else problems.push(`${key} is not locked. Run: node --experimental-strip-types scripts/strategy-specs.ts lock`);
  }else if(lock[key]!==hash)problems.push(`${key} changed after it was registered. Keep the old version and add ${spec.id}@${Number(spec.version)+1} instead.`);
}
if(command==='lock'&&added)writeFileSync(PATH,`${JSON.stringify(Object.fromEntries(Object.entries(lock).sort()),null,1)}\n`);
if(problems.length){for(const problem of problems)console.error(problem);process.exitCode=1;}
else console.log(`${SPECS.length} strategy versions registered and unchanged.`);
