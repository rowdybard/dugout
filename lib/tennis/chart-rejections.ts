const CHART_WINDOW_MS = 6 * 60 * 60_000;
const INDEX_NAME = 'tennis_journal_order_rejections';
const CREATE_INDEX = `CREATE INDEX IF NOT EXISTS ${INDEX_NAME} ON tennis_journal(owner_id,created_at)
  WHERE kind='decision' AND json_extract(value,'$.code')='BOOK_ORDER'`;
const READ_REJECTIONS = `SELECT json_extract(value,'$.slug') AS slug,
    CASE WHEN json_type(value,'$.bookTime')='integer'
      AND json_extract(value,'$.bookTime') BETWEEN 1 AND 9007199254740991
      THEN json_extract(value,'$.bookTime') ELSE NULL END AS bookTime
  FROM tennis_journal INDEXED BY ${INDEX_NAME}
  WHERE owner_id=? AND created_at>=? AND created_at<=?
    AND kind='decision' AND json_extract(value,'$.code')='BOOK_ORDER'`;

/** Exclusions happen before LIMIT, so rejected books never displace good points. */
export const CHART_HISTORY_SQL = `SELECT time,
    json_extract(value,'$.book.bids[0].price') AS bid,
    json_extract(value,'$.book.asks[0].price') AS ask,
    json_extract(value,'$.market.score') AS score,
    json_extract(value,'$.market.period') AS period,
    json_extract(value,'$.market.contextUpdatedAt') AS scoreUpdatedAt
  FROM tennis_observations
  WHERE slug=? AND time>? AND time NOT IN (SELECT value FROM json_each(?))
  ORDER BY time DESC LIMIT 600`;

type RejectionRow = {slug:unknown;bookTime:unknown};
const indexTasks = new WeakMap<object,Promise<void>>();

async function ensureIndex(database:Pick<D1Database,'prepare'>):Promise<void> {
  const binding=database as object;
  let task=indexTasks.get(binding);
  if(!task){
    task=Promise.resolve().then(()=>database.prepare(CREATE_INDEX).run()).then(()=>{});
    indexTasks.set(binding,task);
  }
  try{await task;}
  catch(error){
    if(indexTasks.get(binding)===task)indexTasks.delete(binding);
    throw error;
  }
}

/** Keep rejected books in the journal; only exclude them from this owner's chart. */
export async function readChartRejections(database:Pick<D1Database,'prepare'>,ownerId:string,now:number):Promise<Record<string,number[]>> {
  if(!Number.isSafeInteger(now)||now<=0)throw new Error('Chart rejection time is invalid.');
  await ensureIndex(database);
  const cutoff=now-CHART_WINDOW_MS;
  const rows=await database.prepare(READ_REJECTIONS).bind(ownerId,cutoff,now).all<RejectionRow>();
  const grouped=new Map<string,Set<number>>();
  for(const {slug,bookTime} of rows.results){
    if(typeof slug!=='string'||!/^[-a-zA-Z0-9._:]{1,250}$/.test(slug)||
      typeof bookTime!=='number'||!Number.isSafeInteger(bookTime)||bookTime<=0||bookTime<cutoff||bookTime>now)continue;
    let times=grouped.get(slug);
    if(!times){times=new Set<number>();grouped.set(slug,times);}
    times.add(bookTime);
  }
  const result=Object.create(null) as Record<string,number[]>;
  for(const [slug,times] of grouped)result[slug]=[...times].sort((a,b)=>a-b);
  return result;
}
