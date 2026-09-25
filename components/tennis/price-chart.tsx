'use client';

import {useId} from 'react';
import {Area,AreaChart,CartesianGrid,ResponsiveContainer,Tooltip,XAxis,YAxis} from 'recharts';

export type ChartPoint = {time:number;price:number};

export function TennisSparkline({points}:{points:ChartPoint[]}) {
  const id = `tennis-${useId().replaceAll(':','')}`;
  if (points.length < 2) return <div className="tennis-spark-empty"><span/>Collecting history</div>;
  const first=points[0],last=points[points.length-1];
  const low=Math.min(...points.map(point=>point.price)),high=Math.max(...points.map(point=>point.price));
  const range=Math.max(.02,high-low),duration=Math.max(1,last.time-first.time);
  const line=points.map(point=>`${((point.time-first.time)/duration*260).toFixed(1)},${(54-(point.price-low)/range*44).toFixed(1)}`).join(' ');
  const color=last.price<first.price?'#ef8790':last.price>first.price?'#c2f477':'#8fa18f';
  return <svg className="tennis-spark" viewBox="0 0 260 64" preserveAspectRatio="none" role="img" aria-label={`Observed price moved from ${(first.price*100).toFixed(1)} to ${(last.price*100).toFixed(1)} cents`}>
    <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity=".14"/><stop offset="100%" stopColor={color} stopOpacity="0"/></linearGradient></defs>
    <polygon points={`0,64 ${line} 260,64`} fill={`url(#${id})`}/>
    <polyline points={line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke"/>
  </svg>;
}

export function TennisPriceChart({points,currency=false}:{points:ChartPoint[];currency?:boolean}) {
  const id = `tennis-chart-${useId().replaceAll(':','')}`;
  if (points.length < 2) return <div className="tennis-chart-empty"><span className="tennis-chart-empty-line"/><strong>{currency?'Your run starts here.':'A real chart starts with real observations.'}</strong><p>{currency?'Your balance will be recorded as the session runs.':'Keep this page open while we collect price history.'}</p></div>;
  return <div className="tennis-chart"><ResponsiveContainer width="100%" height="100%"><AreaChart data={points} margin={{top:14,right:8,bottom:6,left:0}}>
    <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#c2f477" stopOpacity={.18}/><stop offset="100%" stopColor="#c2f477" stopOpacity={0}/></linearGradient></defs>
    <CartesianGrid vertical={false} stroke="#303930" strokeDasharray="3 6"/>
    <XAxis dataKey="time" type="number" domain={['dataMin','dataMax']} scale="time" tickFormatter={value=>new Date(value).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})} tick={{fill:'#91a08c',fontSize:11}} minTickGap={55} tickLine={false} axisLine={false}/>
    <YAxis domain={currency?['auto','auto']:[(low:number)=>Math.max(0,Math.floor((low-.03)*20)/20),(high:number)=>Math.min(1,Math.ceil((high+.03)*20)/20)]} tickFormatter={value=>currency?`$${value.toFixed(0)}`:`${Math.round(value*100)}¢`} tick={{fill:'#91a08c',fontSize:11}} width={43} tickLine={false} axisLine={false}/>
    <Tooltip contentStyle={{background:'#182119',border:'1px solid #4b5b43',borderRadius:8}} labelFormatter={value=>new Date(Number(value)).toLocaleTimeString()} formatter={value=>[currency?`$${Number(value).toFixed(2)}`:`${(Number(value)*100).toFixed(1)}¢`,currency?'Paper balance':'Observed midpoint']}/>
    <Area type="linear" dataKey="price" stroke="#c2f477" strokeWidth={2.4} fill={`url(#${id})`} isAnimationActive={false}/>
  </AreaChart></ResponsiveContainer></div>;
}
