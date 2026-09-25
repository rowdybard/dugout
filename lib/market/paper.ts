import type {Book} from './types';
export const DEFAULT_FEE=.0695;
export const feeFor=(qty:number,p:number,theta=DEFAULT_FEE)=>qty*theta*p*(1-p);
// Whole-contract paper simulation is deliberately conservative. Walk every available level.
export function simulateBuy(book:Book,budget:number,theta=DEFAULT_FEE){
 let remaining=budget,contracts=0,cost=0,fees=0;
 for(const l of [...book.asks].sort((a,b)=>a.price-b.price)){
  if(l.price<=0||l.price>=1)continue;
  const unit=l.price+feeFor(1,l.price,theta);const q=Math.min(Math.floor(l.quantity),Math.floor((remaining+1e-9)/unit));
  contracts+=q;cost+=q*l.price;fees+=feeFor(q,l.price,theta);remaining-=q*unit;
 }
 return {contracts,cost,fees,total:cost+fees,average:contracts?cost/contracts:0,unused:remaining};
}
export function simulateSell(book:Book,qty:number,theta=DEFAULT_FEE){let remaining=qty,gross=0,fees=0;for(const l of [...book.bids].sort((a,b)=>b.price-a.price)){const q=Math.min(remaining,Math.floor(l.quantity));gross+=q*l.price;fees+=feeFor(q,l.price,theta);remaining-=q;if(!remaining)break;}return {complete:remaining===0,net:gross-fees,average:qty?gross/qty:0,fees};}
export function sideBook(book:Book,side:'YES'|'NO'):Book{if(side==='YES')return book;return {...book,bids:book.asks.map(l=>({...l,price:1-l.price})).sort((a,b)=>b.price-a.price),asks:book.bids.map(l=>({...l,price:1-l.price})).sort((a,b)=>a.price-b.price)};}
