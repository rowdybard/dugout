import type {CreateOrderParams,Order} from 'polymarket-us';
import {LiveApiError,type LiveExchange} from '../../lib/live/client.ts';

/**
 * In-memory Polymarket US for executor tests. Wire rules follow docs.polymarket.us: prices are YES prices for
 * every intent; post-only (participateDontInitiate) orders that would cross are rejected; resting buys fill when
 * the book trades through them. Positions are long YES (+) / long NO (-) in contracts.
 */
export class FakeExchange implements LiveExchange {
  cash=1000;yesBid=.60;yesAsk=.61;
  orders=new Map<string,Order>();
  position={net:0,cost:0};
  calls:string[]=[];
  created:CreateOrderParams[]=[];
  failNextCreate:'timeout'|'reject'|null=null;
  failBalances=0;
  previewPrice:string|null=null;
  /** Called at createOrder time, to prove the journal was written first. */
  beforeCreate:(()=>void)|null=null;
  private seq=0;

  async balances(){
    this.calls.push('balances');
    if(this.failBalances>0){this.failBalances--;throw new LiveApiError(503,'Polymarket US 503: unavailable',true);}
    return {balances:[{currentBalance:this.cash,currency:'USD',buyingPower:this.cash}]};
  }
  async positions(market?:string){
    this.calls.push('positions');
    const mark=this.position.net>=0?this.position.net*this.yesBid:-this.position.net*(1-this.yesAsk);
    return {positions:this.position.net===0?{}:{[market!]:{netPosition:String(this.position.net),qtyBought:'0',qtySold:'0',cost:{value:String(this.position.cost),currency:'USD' as const},
      realized:{value:'0',currency:'USD' as const},bodPosition:'0',expired:false,cashValue:{value:String(mark),currency:'USD' as const},marketMetadata:{slug:market!}}}};
  }
  async openOrders(slugs?:string[]){
    this.calls.push('openOrders');
    return {orders:[...this.orders.values()].filter(order=>order.leavesQuantity>0&&!['ORDER_STATE_FILLED','ORDER_STATE_CANCELED'].includes(order.state)&&(!slugs||slugs.includes(order.marketSlug)))};
  }
  async order(id:string){this.calls.push('order');const order=this.orders.get(id);if(!order)throw new LiveApiError(404,'Polymarket US 404: not found',false);return {order};}
  async createOrder(params:CreateOrderParams){
    this.calls.push('create');this.beforeCreate?.();
    this.created.push(params);
    if(this.failNextCreate==='timeout'){this.failNextCreate=null;this.insert(params);throw new LiveApiError(0,'Polymarket US request failed: timeout',true);}
    if(this.failNextCreate==='reject'){this.failNextCreate=null;throw new LiveApiError(400,'Polymarket US 400: insufficient buying power',false);}
    if(params.manualOrderIndicator!=='MANUAL_ORDER_INDICATOR_AUTOMATIC')throw new LiveApiError(400,'automated orders must be flagged',false);
    const yes=Number(params.price!.value);
    const crosses=params.intent==='ORDER_INTENT_BUY_LONG'?yes>=this.yesAsk:yes<=this.yesBid;
    if(params.participateDontInitiate&&crosses)throw new LiveApiError(400,'Polymarket US 400: post-only order would cross',false);
    return {id:this.insert(params).id};
  }
  private insert(params:CreateOrderParams):Order{
    const id=`order-${++this.seq}`;
    const order:Order={id,marketSlug:params.marketSlug,side:'ORDER_SIDE_BUY',type:'ORDER_TYPE_LIMIT',price:params.price!,quantity:params.quantity!,cumQuantity:0,
      leavesQuantity:params.quantity!,tif:params.tif!,intent:params.intent,state:'ORDER_STATE_NEW'};
    this.orders.set(id,order);return order;
  }
  async cancelOrder(id:string){this.calls.push('cancel');const order=this.orders.get(id);if(order&&order.leavesQuantity>0){order.state='ORDER_STATE_CANCELED';order.leavesQuantity=0;}return {};}
  async cancelAll(slugs?:string[]){
    this.calls.push('cancelAll');const ids:string[]=[];
    for(const order of this.orders.values())if(order.leavesQuantity>0&&(!slugs||slugs.includes(order.marketSlug))){order.state='ORDER_STATE_CANCELED';order.leavesQuantity=0;ids.push(order.id);}
    return {canceledOrderIds:ids};
  }
  async previewOrder(params:CreateOrderParams){
    this.calls.push('preview');
    return {order:{id:'preview',marketSlug:params.marketSlug,side:'ORDER_SIDE_BUY' as const,type:'ORDER_TYPE_LIMIT' as const,price:{value:this.previewPrice??params.price!.value,currency:'USD' as const},
      quantity:params.quantity!,cumQuantity:0,leavesQuantity:params.quantity!,tif:params.tif!,intent:params.intent,state:'ORDER_STATE_NEW' as const}};
  }
  /** Move the book; resting buys that the new book trades through are filled at their price. */
  move(yesBid:number,yesAsk:number){
    this.yesBid=yesBid;this.yesAsk=yesAsk;
    for(const order of this.orders.values()){
      if(order.leavesQuantity<=0)continue;
      const yes=Number(order.price.value),long=order.intent==='ORDER_INTENT_BUY_LONG';
      if(long?yesAsk<=yes:yesBid>=yes){
        const qty=order.leavesQuantity,paid=long?yes:1-yes;
        this.cash-=qty*paid;this.position.net+=long?qty:-qty;this.position.cost+=qty*paid;
        order.cumQuantity+=qty;order.leavesQuantity=0;order.state='ORDER_STATE_FILLED';
      }
    }
  }
  /** An order placed by hand on the same market. */
  manualOrder(slug:string){this.insert({marketSlug:slug,intent:'ORDER_INTENT_BUY_LONG',type:'ORDER_TYPE_LIMIT',price:{value:'0.1',currency:'USD'},quantity:1,tif:'TIME_IN_FORCE_GOOD_TILL_CANCEL'});}
}
