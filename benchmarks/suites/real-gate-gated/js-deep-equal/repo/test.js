// In-repo gate: `node test.js`
const eq = require('./equal.js');
let ok=true;
const chk=(c,m)=>{if(!c){console.error('FAIL',m);ok=false;}};
chk(eq({x:1,y:2},{y:2,x:1})===true,'key order');
chk(eq([1,[2,3]],[1,[2,3]])===true,'nested arr');
chk(eq(NaN,NaN)===true,'NaN');
chk(eq({a:1},{a:1,b:2})===false,'extra key');
if(!ok)process.exit(1); console.log('ok');
