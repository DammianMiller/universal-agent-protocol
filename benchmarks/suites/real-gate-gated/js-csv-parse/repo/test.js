// In-repo gate: `node test.js`
const p = require('./csv.js');
const eq = (a,b)=>JSON.stringify(a)===JSON.stringify(b);
let ok=true;
if(!eq(p('a,b,c'),[['a','b','c']])){console.error('basic');ok=false;}
if(!eq(p('a,"b,c",d'),[['a','b,c','d']])){console.error('quoted comma');ok=false;}
if(!eq(p('x,y\nz,w'),[['x','y'],['z','w']])){console.error('two rows');ok=false;}
if(!ok){process.exit(1)} console.log('ok');
