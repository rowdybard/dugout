import type {StreamQuote} from './stream-types.ts';
import {streamBookForDisplay} from './stream-types.ts';

export type StoredStreamBook={connectionId:string;quote:StreamQuote};
export type StoredStreamConnection={id:string;active:boolean;updatedAt:number};
/** Heartbeats prove transport health, never a new book observation. */
export function usableStreamBook(stored:StoredStreamBook|null,connection:StoredStreamConnection|null,now:number){
  if(!stored||!connection||!connection.active||connection.id!==stored.connectionId
    ||!Number.isFinite(now)||!Number.isFinite(connection.updatedAt)||connection.updatedAt>now||now-connection.updatedAt>15000)return null;
  const q=stored.quote;
  if(!q.valid||!q.book||!Number.isFinite(q.receivedAt)||q.receivedAt>now||now-q.receivedAt>12000||q.source!=='polymarket_us_websocket')return null;
  const book=streamBookForDisplay(q);
  if(!book||book.bids.length>1000||book.asks.length>1000)return null;
  if([...book.bids,...book.asks].some(l=>!Number.isFinite(l.price)||l.price<0||l.price>1||!Number.isFinite(l.quantity)||l.quantity<0))return null;
  if(book.bids.some((l,i)=>i>0&&l.price>book.bids[i-1].price)||book.asks.some((l,i)=>i>0&&l.price<book.asks[i-1].price))return null;
  if(book.bids[0]&&book.asks[0]&&book.bids[0].price>book.asks[0].price)return null;
  return {book,receivedAt:q.receivedAt,source:'WEBSOCKET' as const};
}
