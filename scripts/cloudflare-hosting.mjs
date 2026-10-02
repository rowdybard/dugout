/**
 * Self-host Dugout on your own Cloudflare account behind Cloudflare Access (docs/CLOUDFLARE-HOSTING.md).
 *
 *   node scripts/cloudflare-hosting.mjs owner-id you@example.com   # your account id on the new site
 *   node scripts/cloudflare-hosting.mjs database                   # find or create the D1 database; prints its id
 *   node scripts/cloudflare-hosting.mjs deploy                     # build, apply database migrations, deploy the Worker
 *   node scripts/cloudflare-hosting.mjs secrets                    # copy optional server secrets from this shell to the Worker
 *   node scripts/cloudflare-hosting.mjs access                     # Google sign-in (+ email code backup), invite list,
 *                                                                  # remembered devices; prints ACCESS_TEAM_DOMAIN and ACCESS_AUD
 *   Access needs ACCESS_INVITES (comma-separated emails); Google needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (a Google
 *   OAuth "Web application" client whose redirect URI is https://<team>.cloudflareaccess.com/cdn-cgi/access/callback).
 *
 * Credentials: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment, or `wrangler login` on a PC.
 * Deploy needs DUGOUT_D1_DATABASE_ID, and ACCESS_TEAM_DOMAIN + ACCESS_AUD to let anyone in. Secret values are never printed.
 */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const WORKER_CONFIG='dist/server/wrangler.json';
const DATABASE=process.env.DUGOUT_D1_NAME||'dugout';
/** Optional server secrets (see .env.example). Only the ones set in this shell are copied. */
const SECRETS=['DUGOUT_OWNER_ID','DUGOUT_RUNNER_USERS','DUGOUT_RUNNER_URL','DUGOUT_RUNNER_SECRET','ANTHROPIC_API_KEY','POLYMARKET_KEY_ID','POLYMARKET_SECRET_KEY'];

/** Must match userIdForEmail in lib/server/cloudflare-access.ts (tests/cloudflare-access.test.ts checks it). */
export function ownerIdFor(email){
  return `u_${createHash('sha256').update(`dugout-user:${String(email).trim().toLowerCase()}`).digest('hex').slice(0,40)}`;
}

function run(command,args,{input,env,capture=false}={}){
  const result=spawnSync(command,args,{cwd:ROOT,env:{...process.env,...env},input,encoding:'utf8',stdio:[input===undefined?'inherit':'pipe',capture?'pipe':'inherit','inherit'],shell:false});
  if(result.status!==0)throw new Error(`${[command,...args].join(' ')} failed (exit ${result.status}).`);
  return result.stdout??'';
}
const wrangler=(args,options)=>run(process.execPath,['--import','./scripts/sites-env.mjs','./node_modules/wrangler/bin/wrangler.js',...args],options);

function need(names){
  const missing=names.filter(name=>!process.env[name]);
  if(missing.length)throw new Error(`Set ${missing.join(', ')} first (docs/CLOUDFLARE-HOSTING.md).`);
}

function findDatabase(){
  const list=JSON.parse(wrangler(['d1','list','--json'],{capture:true}));
  return list.find(item=>item.name===DATABASE)?.uuid??null;
}

// ---- Cloudflare Access through the API (token: Access Apps and Policies: Edit; Organizations, Identity Providers and Groups: Edit) ----
const API='https://api.cloudflare.com/client/v4';
async function cf(method,path,body){
  const response=await fetch(`${API}/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}${path}`,{method,headers:{Authorization:`Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const json=await response.json().catch(()=>({}));
  if(!response.ok||json.success===false)throw new Error(`${method} ${path} failed (${response.status}): ${(json.errors??[]).map(e=>e.message).join('; ')||'no detail'}`);
  return json.result;
}
/** The longest Access session (remembered devices) Cloudflare offers for an application. */
const SESSION='730h';

async function access(){
  need(['CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','ACCESS_INVITES']);
  const invites=process.env.ACCESS_INVITES.split(',').map(e=>e.trim().toLowerCase()).filter(e=>e.includes('@'));
  if(!invites.length)throw new Error('ACCESS_INVITES has no email addresses.');
  const org=await cf('GET','/access/organizations').catch(()=>null);
  if(!org?.auth_domain)throw new Error('Zero Trust is not set up yet: open Cloudflare dashboard → Zero Trust once and choose a team name, then run this again.');
  const providers=await cf('GET','/access/identity_providers');
  const ensure=async(type,name,config)=>providers.find(p=>p.type===type)?.id??(await cf('POST','/access/identity_providers',{name,type,config})).id;
  const idps=[await ensure('onetimepin','Email code',{})];
  if(process.env.GOOGLE_CLIENT_ID&&process.env.GOOGLE_CLIENT_SECRET){
    const existing=providers.find(p=>p.type==='google');
    const google={name:'Google',type:'google',config:{client_id:process.env.GOOGLE_CLIENT_ID,client_secret:process.env.GOOGLE_CLIENT_SECRET}};
    idps.unshift(existing?(await cf('PUT',`/access/identity_providers/${existing.id}`,google)).id:(await cf('POST','/access/identity_providers',google)).id);
  }else console.warn('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set: sign-in is by emailed code only.');
  const sub=await cf('GET','/workers/subdomain');
  const domain=process.env.ACCESS_SITE_DOMAIN||`dugout.${sub.subdomain}.workers.dev`;
  const policy={name:'Dugout invite list',decision:'allow',include:invites.map(email=>({email:{email}})),precedence:1};
  const apps=await cf('GET','/access/apps');
  const app={name:'Dugout',domain,type:'self_hosted',session_duration:SESSION,allowed_idps:idps,auto_redirect_to_identity:false,app_launcher_visible:false,policies:[policy]};
  const found=apps.find(a=>a.domain===domain);
  const saved=found?await cf('PUT',`/access/apps/${found.id}`,app):await cf('POST','/access/apps',app);
  console.log(`Access protects https://${domain} for: ${invites.join(', ')}`);
  console.log(`Sign-in: ${idps.length>1?'Google, or an emailed code':'an emailed code'} · devices stay signed in for ${SESSION}`);
  console.log(`ACCESS_TEAM_DOMAIN=${org.auth_domain}`);
  console.log(`ACCESS_AUD=${saved.aud}`);
  if(!process.env.GOOGLE_CLIENT_ID)console.log(`For Google: redirect URI https://${org.auth_domain}/cdn-cgi/access/callback`);
}

async function main([command,...args]){
  if(command==='owner-id'){
    if(!args[0]?.includes('@'))throw new Error('Usage: owner-id you@example.com');
    console.log(ownerIdFor(args[0]));
  }else if(command==='database'){
    let id=findDatabase();
    if(!id){wrangler(['d1','create',DATABASE]);id=findDatabase();}
    if(!id)throw new Error(`Could not find the ${DATABASE} database after creating it.`);
    console.log(`DUGOUT_D1_DATABASE_ID=${id}`);
  }else if(command==='deploy'){
    need(['DUGOUT_D1_DATABASE_ID']);
    // The first deploy can precede Access (workers.dev Access is switched on for an existing Worker). The site
    // refuses everyone until both values are set and it is deployed again.
    if(!process.env.ACCESS_TEAM_DOMAIN||!process.env.ACCESS_AUD)console.warn('ACCESS_TEAM_DOMAIN or ACCESS_AUD is not set: the site will refuse every visitor until you set both and deploy again.');
    run(process.execPath,['scripts/run-framework.mjs','build'],{env:{DUGOUT_HOSTING:'cloudflare'}});
    wrangler(['d1','migrations','apply',DATABASE,'--remote','--config',WORKER_CONFIG]);
    wrangler(['deploy','--config',WORKER_CONFIG]);
  }else if(command==='secrets'){
    const present=SECRETS.filter(name=>process.env[name]);
    if(!present.length)console.log(`None of ${SECRETS.join(', ')} are set in this shell; nothing to copy.`);
    for(const name of present){wrangler(['secret','put',name,'--config',WORKER_CONFIG],{input:process.env[name]});console.log(`${name} set.`);}
  }else if(command==='access'){
    await access();
  }else{
    console.error('Usage: cloudflare-hosting.mjs owner-id <email> | database | deploy | secrets | access');
    process.exitCode=2;
  }
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
