import type {CancelAllOrdersResponse,CreateOrderParams,CreateOrderResponse,GetAccountBalancesResponse,GetOpenOrdersResponse,GetOrderResponse,GetUserPositionsResponse,PreviewOrderResponse} from 'polymarket-us';
import {usRequestHeaders} from '../trading/us-signature.ts';

/**
 * Workers-native authenticated Polymarket US client: the official SDK's endpoints and signing
 * (polymarket-us 0.1.1), without its node-fetch dependency. It never retries: a timeout on order
 * creation has an UNKNOWN outcome, and only reconciliation may resolve it.
 */

export type LiveCredentials={keyId:string;secretKey:string};
export type Fetcher=(url:string,init:RequestInit)=>Promise<Response>;

export class LiveApiError extends Error {
  readonly status:number;
  /** True when the request may have reached the exchange (timeouts, network loss, 5xx). */
  readonly outcomeUnknown:boolean;
  constructor(status:number,message:string,outcomeUnknown:boolean){super(message);this.name='LiveApiError';this.status=status;this.outcomeUnknown=outcomeUnknown;}
}

const MAX_RESPONSE_BYTES=2_000_000;

export class PolymarketUSClient {
  private readonly credentials:LiveCredentials;
  private readonly fetcher:Fetcher;
  private readonly now:()=>number;
  private readonly baseUrl:string;
  private readonly timeoutMs:number;

  constructor(credentials:LiveCredentials,options:{fetcher?:Fetcher;now?:()=>number;baseUrl?:string;timeoutMs?:number}={}){
    if(!credentials.keyId||!credentials.secretKey)throw new Error('Polymarket US trading credentials are required.');
    this.credentials=credentials;this.fetcher=options.fetcher??((url,init)=>fetch(url,init));this.now=options.now??Date.now;
    this.baseUrl=options.baseUrl??'https://api.polymarket.us';this.timeoutMs=options.timeoutMs??8000;
  }

  async request<T>(method:'GET'|'POST',path:string,options:{query?:Record<string,string|number|string[]|undefined>;body?:unknown}={}):Promise<T> {
    const url=new URL(path,this.baseUrl);
    for(const [key,value] of Object.entries(options.query??{})){
      if(value===undefined)continue;
      if(Array.isArray(value))for(const item of value)url.searchParams.append(key,item);else url.searchParams.set(key,String(value));
    }
    const headers={'Content-Type':'application/json',...await usRequestHeaders(this.credentials.keyId,this.credentials.secretKey,method,url.pathname,this.now())};
    let response:Response;
    try{
      response=await this.fetcher(url.toString(),{method,headers,body:options.body===undefined?undefined:JSON.stringify(options.body),signal:AbortSignal.timeout(this.timeoutMs)});
    }catch(error){
      throw new LiveApiError(0,`Polymarket US request failed: ${(error as Error).message}`,true);
    }
    const text=await response.text();
    if(text.length>MAX_RESPONSE_BYTES)throw new LiveApiError(response.status,'Polymarket US response exceeded the size limit.',!response.ok);
    if(!response.ok){
      let message=response.statusText||`HTTP ${response.status}`;
      try{const data=JSON.parse(text) as {message?:string;error?:string};message=data.message??data.error??message;}catch{if(text)message=text.slice(0,300);}
      // 4xx other than timeouts are definite rejections; 408/5xx may have been applied.
      throw new LiveApiError(response.status,`Polymarket US ${response.status}: ${message}`,response.status===408||response.status>=500);
    }
    if(!text)return {} as T;
    try{return JSON.parse(text) as T;}catch{throw new LiveApiError(response.status,'Polymarket US returned malformed JSON.',true);}
  }

  balances(){return this.request<GetAccountBalancesResponse>('GET','/v1/account/balances');}
  openOrders(slugs?:string[]){return this.request<GetOpenOrdersResponse>('GET','/v1/orders/open',{query:{slugs}});}
  order(orderId:string){return this.request<GetOrderResponse>('GET',`/v1/order/${encodeURIComponent(orderId)}`);}
  createOrder(params:CreateOrderParams){return this.request<CreateOrderResponse>('POST','/v1/orders',{body:params});}
  cancelOrder(orderId:string,marketSlug:string){return this.request<Record<string,never>>('POST',`/v1/order/${encodeURIComponent(orderId)}/cancel`,{body:{marketSlug}});}
  cancelAll(slugs?:string[]){return this.request<CancelAllOrdersResponse>('POST','/v1/orders/open/cancel',{body:slugs?{slugs}:{}});}
  previewOrder(request:CreateOrderParams){return this.request<PreviewOrderResponse>('POST','/v1/order/preview',{body:{request}});}
  positions(market?:string){return this.request<GetUserPositionsResponse>('GET','/v1/portfolio/positions',{query:{market,limit:100}});}
}

/** The subset the executor uses, so tests can run it against an in-memory exchange. */
export type LiveExchange=Pick<PolymarketUSClient,'balances'|'openOrders'|'order'|'createOrder'|'cancelOrder'|'cancelAll'|'previewOrder'|'positions'>;
