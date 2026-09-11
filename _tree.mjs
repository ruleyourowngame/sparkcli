import { load } from "./src/fetch.ts";
import { parse } from "./src/parse.ts";
const url = process.argv[2];
const threadMatch = process.argv[3] || "Server Thread - ES";
const minPct = parseFloat(process.argv[4] || "2");
const src = await load(url);
const rep = await parse(src.origin, src.bytes);
const th = rep.threads.find(t => t.name.includes(threadMatch));
if(!th){ console.error("threads:", rep.threads.map(t=>t.name).slice(0,20)); process.exit(1); }
const nodes = th.nodes;
const sum = a => (a||[]).reduce((x,y)=>x+y,0);
const T = sum(th.times) || th.childrenRefs.reduce((s,r)=>s+sum(nodes[r].times),0);
const incl = n => sum(n.times);
const name = n => `${n.className}.${n.methodName}`;
const pct = x => (100*x/T).toFixed(1)+"%";
function walk(ref, indent, depthLeft){
  const n=nodes[ref];
  const kids=[...n.childrenRefs].sort((a,b)=>incl(nodes[b])-incl(nodes[a]));
  for(const r of kids){ const k=nodes[r];
    if(100*incl(k)/T<minPct) continue;
    console.log("  ".repeat(indent)+pct(incl(k)).padStart(6)+"  "+name(k));
    if(depthLeft>0) walk(r,indent+1,depthLeft-1);
  }
}
console.log("THREAD:",th.name," T=",T,"samples (~"+(T*4/1000).toFixed(1)+"s CPU)");
walk(-0+([...th.childrenRefs])[0]!==undefined?th.childrenRefs[0]:0,0,0); // noop
// start from synthetic root: iterate root children
{ const fake={childrenRefs:th.childrenRefs}; (function w(refs,indent,d){const kids=[...refs].sort((a,b)=>incl(nodes[b])-incl(nodes[a]));for(const r of kids){const k=nodes[r]; if(100*incl(k)/T<minPct)continue; console.log("  ".repeat(indent)+pct(incl(k)).padStart(6)+"  "+name(k)); if(d>0) w(k.childrenRefs,indent+1,d-1);}})(fake.childrenRefs,0,40); }
