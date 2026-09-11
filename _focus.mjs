import { load } from "./src/fetch.ts";
import { parse } from "./src/parse.ts";
const url = process.argv[2];
const focus = process.argv[3];          // substring of a frame to root the subtree at
const minPct = parseFloat(process.argv[4] || "0.8");
const src = await load(url);
const rep = await parse(src.origin, src.bytes);
const th = rep.threads.find(t => t.name.includes("Server Thread - ES"));
const nodes = th.nodes;
const sum = a => (a||[]).reduce((x,y)=>x+y,0);
const T = sum(th.times) || th.childrenRefs.reduce((s,r)=>s+sum(nodes[r].times),0);
const incl = n => sum(n.times);
const name = n => `${n.className}.${n.methodName}`;
const pct = x => (100*x/T).toFixed(2)+"%";
function printTree(ref, indent, depthLeft){
  const n = nodes[ref];
  const kids = n.childrenRefs.map(r=>nodes[r]).sort((a,b)=>incl(b)-incl(a));
  for(const k of kids){
    if(100*incl(k)/T < minPct) continue;
    console.log("  ".repeat(indent) + pct(incl(k)).padStart(7) + "  " + name(k));
    if(depthLeft>0) printTree(n.childrenRefs[nodes.indexOf? n.childrenRefs.find(r=>nodes[r]===k):0]||0, 0, 0); // placeholder
  }
}
// simpler: recursive by ref
function walk(ref, indent, depthLeft){
  const n = nodes[ref];
  const kids = [...n.childrenRefs].sort((a,b)=>incl(nodes[b])-incl(nodes[a]));
  for(const r of kids){
    const k = nodes[r];
    if(100*incl(k)/T < minPct) continue;
    console.log("  ".repeat(indent) + pct(incl(k)).padStart(7) + "  " + name(k));
    if(depthLeft>0) walk(r, indent+1, depthLeft-1);
  }
}
// find topmost nodes whose name matches focus
const hits=[];
function find(ref){ const n=nodes[ref]; if(name(n).includes(focus)){hits.push(ref); return;} for(const r of n.childrenRefs) find(r); }
for(const r of th.childrenRefs) find(r);
console.log(`FOCUS "${focus}"  (min ${minPct}%, T=${T} samples)`);
for(const r of hits){
  console.log(pct(incl(nodes[r])).padStart(7)+"  "+name(nodes[r])+"   <-- root");
  walk(r, 1, 30);
}
