import {db,readCached} from './storage';
import {usableStreamBook,type StoredStreamBook,type StoredStreamConnection} from '../trading/stream-book';
import type {StreamQuote} from '../trading/stream-types';

export async function saveStreamBooks(connection:StoredStreamConnection,quotes:StreamQuote[]){
  const statements=[db().prepare("INSERT INTO cache(key,value,updated) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated WHERE excluded.updated>=cache.updated AND json_extract(cache.value,'$.active')=1")
    .bind(`stream:connection:${connection.id}`,JSON.stringify(connection),connection.updatedAt)];
  for(const quote of quotes)statements.push(db().prepare('INSERT INTO cache(key,value,updated) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated=excluded.updated WHERE excluded.updated>=cache.updated')
    .bind(`stream:book:${quote.slug}`,JSON.stringify({connectionId:connection.id,quote}),quote.receivedAt));
  await db().batch(statements);
}
export async function currentStreamBook(slug:string){
  const stored=await readCached<StoredStreamBook>(`stream:book:${slug}`);
  if(!stored)return null;
  const connection=await readCached<StoredStreamConnection>(`stream:connection:${stored.value.connectionId}`);
  return usableStreamBook(stored.value,connection?.value??null,Date.now());
}
