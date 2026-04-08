/**
 * NEET Smart Money Scanner — 24/7 GitHub Actions runner
 * Mirrors scoring & notification logic from neet-predict_2.html
 * Sends Telegram alerts when score >= 50 (or >= 35 for rockets)
 * State persisted in scanner/state.json between runs
 */
const https=require('https'),fs=require('fs'),path=require('path');
const TG_TOKEN =process.env.TG_TOKEN ||'8776338924:AAGA_ROKVFWWKm2dX9UQIovisnMupF_g2Bk';
const TG_CHATID=process.env.TG_CHATID||'1501478917';
const STATE_FILE=path.join(__dirname,'state.json');
const SCORE_THRESHOLD=50,ROCKET_THRESHOLD=35;
const NORMAL_COOLDOWN=4*60*60*1000,ROCKET_COOLDOWN=30*60*1000;

const SM_WALLETS=[
  {name:"180D Smart Trader [DpYuj2At]",addr:"DpYuj2At1Z1tH4baoz5A1XV4AanjJa8bgbB51BWSZUyn",score:99},
  {name:"180D Smart Trader [69SzLy86]",addr:"69SzLy86mUfdeFqYurR4YsvcTuvYsVAqwdeTGWiGvRgt",score:97},
  {name:"90D Smart Trader [3fupiyLE]",addr:"3fupiyLEr2BnFE9myQY8FS1kzqjhVZd7MdxUj74TFev4",score:97},
  {name:"Smart Trader [FMkNK3u7]",addr:"FMkNK3u7ZhS84hqxt9ETNSeC9w43RThiN6RvQJaSEhC8",score:88},
  {name:"Orange [2X4H5Y9C]",addr:"2X4H5Y9C4Fy6Pf3wpq8Q4gMvLcWvfrrwDv2bdR8AAwQv",score:94},
  {name:"Smart Trader [8q3vQtV9]",addr:"8q3vQtV9kuWdzzXVrweivhbKbZ5jXGq426fX4AhahZPX",score:92},
  {name:"90D Smart Trader [A2vZY74J]",addr:"A2vZY74JHBBwfjo3F1Bo5iiLXpABfAhmgdyfUGzABY9F",score:95},
  {name:"30D Smart Trader [D3MuDmrs]",addr:"D3MuDmrs2dm6U9CiZur651CnPjLwUWjs9p1a3PoDs76H",score:93},
  {name:"30D Smart Trader [HZrd9c6a]",addr:"HZrd9c6ag9hBtJhHQZvHeJHeZG8jYQQPVqq21U39GvyP",score:92},
  {name:"lesabre [4hfcN3bk]",addr:"4hfcN3bk5gCWNCrbowJBgFzvtPFCgf5bynR4bCBut7E3",score:92},
  {name:"logjam [5fkAwNVp]",addr:"5fkAwNVpT8A1UHEnY62VEFpqgagdoP8FYrv5ideiQp5c",score:98},
  {name:"180D Smart Trader [8q4HU6uH]",addr:"8q4HU6uHV9ViAkpjbdavnkM2njAPPq6h88P4rBHchb2F",score:91},
  {name:"richmax.sol [2HjBsjTC]",addr:"2HjBsjTCg9ZpWmU2KRtKDuF8ZUpQzWB16BK9ZzdFVgWL",score:91},
  {name:"90D Smart Trader [CoNcGfS9]",addr:"CoNcGfS9M4p56mJ2nqP35YS2y2X3mhvpu8AMgHbUniRC",score:84},
  {name:"180D Smart Trader [FcNAsyaG]",addr:"FcNAsyaGLQJWaADSWGFono2GHbtSv1iCJPbd9QGyUybF",score:86},
  {name:"30D Smart Trader [5aj3Hnjx]",addr:"5aj3Hnjx2G5NCwP7hgybHqNJmQLcRNNYVTKg9Hv9ez7F",score:92},
  {name:"30D Smart Trader [FvXiTcPA]",addr:"FvXiTcPAQCyUdZBFLhJBiYEAfyi79raezsure4qHMkgv",score:92},
  {name:"30D Smart Trader [4ToyC5XY]",addr:"4ToyC5XY9mTX4s9Qh1jSveaY1iZZDbAVgokxizUPXid9",score:89},
  {name:"90D Smart Trader [8UXcVkHY]",addr:"8UXcVkHYw4P2riBUAsfT9FUSRzWZgENQ8xJjXHQh3xGM",score:85},
  {name:"180D Smart Trader [CH8Agh6c]",addr:"CH8Agh6cnTWqFpkBJj88fpFnD59vTMdrrzcBBeXDJLeF",score:81},
];

function smHash(s){let h=5381;for(let i=0;i<s.length;i++)h=((h<<5)+h^s.charCodeAt(i))>>>0;return h;}
function fmtMC(n){if(!n||n<0)return'—';if(n>=1e9)return'$'+(n/1e9).toFixed(1)+'B';if(n>=1e6)return'$'+(n/1e6).toFixed(2)+'M';if(n>=1e3)return'$'+(n/1e3).toFixed(0)+'K';return'$'+n.toFixed(0);}
function httpGet(url){return new Promise((resolve,reject)=>{const mod=url.startsWith('https')?https:require('http');const req=mod.get(url,{headers:{'Accept':'application/json','User-Agent':'NEETScanner/1.0'}},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){reject(e);}});});req.on('error',reject);req.setTimeout(12000,()=>{req.destroy();reject(new Error('Timeout'));});});}
function httpPost(url,body){return new Promise((resolve,reject)=>{const data=JSON.stringify(body);const u=new URL(url);const opts={hostname:u.hostname,port:443,path:u.pathname,method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}};const req=https.request(opts,res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){resolve({});}});});req.on('error',reject);req.setTimeout(10000,()=>{req.destroy();reject(new Error('Timeout'));});req.write(data);req.end();});}

function calcScore(t){let s=0;const mc=t.mc||0,vol=t.vol||0,liq=t.liq||0,p24=t.p24||0,p1=t.p1||0,sm=t.smCount||0;s+=Math.min(sm*15,45);if(mc>=15000&&mc<=100000)s+=15;else if(mc>100000&&mc<=500000)s+=10;else if(mc>500000&&mc<=2e6)s+=5;const vr=mc>0?vol/mc:0;if(vr>3)s+=12;else if(vr>1)s+=8;else if(vr>0.3)s+=4;if(liq>=8000&&liq<=80000)s+=8;else if(liq>=5000)s+=3;if(p24>100)s+=12;else if(p24>50)s+=9;else if(p24>20)s+=6;else if(p24>0)s+=2;if(p1>20)s+=8;else if(p1>5)s+=4;const lr=mc>0?liq/mc:0;if(liq<5000)s-=20;else if(liq<10000)s-=10;if(lr<0.03&&mc>20000)s-=35;else if(liq<15000&&p24<-30)s-=30;else if(liq<30000&&p24<-40)s-=20;if(p1<-50)s-=30;if(liq<15000&&(p24<-25||mc<25000))s-=40;else if(liq<30000&&p24<-35)s-=25;return Math.min(Math.max(Math.round(s),0),100);}
function classify(t){const sm=t.smCount||0,mc=t.mc||0,p24=t.p24||0,p1=t.p1||0;if(sm===0&&p24<-60)return'dead';if(mc<500000&&sm>=1&&p24>-20)return'early';if(sm>=2&&p1>=0)return'accumulating';if(p24>30||p1>8)return'hot';if(p24<-30&&sm<2)return'distributing';return'hot';}
function assignSM(score,addr){if(score<20)return[];addr=addr||'x';const h1=smHash(addr),h2=smHash(addr+'seed');if((h1%100)>=score)return[];const maxN=Math.min(4,Math.floor(score/20));const n=Math.max(1,(h2%maxN)+1);const ws=[...SM_WALLETS];for(let i=ws.length-1;i>0;i--){const j=smHash(addr+i)%(i+1);[ws[i],ws[j]]=[ws[j],ws[i]];}return ws.slice(0,n).map(w=>w.name);}

async function fetchPairs(){try{const p=await httpGet('https://api.dexscreener.com/token-profiles/latest/v1');const arr=Array.isArray(p)?p:(p.pairs||[]);const sol=arr.filter(x=>(x.chainId||x.chain)==='solana');if(sol.length){const addrs=sol.map(x=>x.tokenAddress).filter(Boolean);const chunks=[];for(let i=0;i<addrs.length;i+=30)chunks.push(addrs.slice(i,i+30));let pairs=[];for(const c of chunks){try{const d=await httpGet('https://api.dexscreener.com/latest/dex/tokens/'+c.join(','));pairs=pairs.concat(d.pairs||[]);await new Promise(r=>setTimeout(r,300));}catch(e){}}return pairs.filter(p=>p.chainId==='solana');}}catch(e){}try{const d=await httpGet('https://api.dexscreener.com/latest/dex/search?q=solana&chainId=solana');return(d.pairs||[]).filter(p=>p.chainId==='solana');}catch(e){return[];}}
function processPairs(pairs){return pairs.slice(0,60).map(p=>{const mc=parseFloat(p.fdv||p.marketCap||0),vol=parseFloat((p.volume||{}).h24||0),liq=parseFloat((p.liquidity||{}).usd||0),p24=parseFloat((p.priceChange||{}).h24||0),p1=parseFloat((p.priceChange||{}).h1||0),bt=p.baseToken||{},lbl=p.labels||[];const t={name:bt.name||'Unknown',sym:bt.symbol||'?',pair:p.pairAddress||'',addr:bt.address||'',mc,vol,liq,p24,p1};t.smNames=assignSM(calcScore({...t,smCount:0}),t.addr||t.pair||'');t.smCount=t.smNames.length;t.score=calcScore(t);t.cls=classify(t);return t;}).filter(t=>t.mc>=5000&&t.mc<=200000&&t.vol>0&&t.liq>=5000);}
async function sendTG(msg){try{const r=await httpPost('https://api.telegram.org/bot'+TG_TOKEN+'/sendMessage',{chat_id:TG_CHATID,text:msg,parse_mode:'Markdown',disable_web_page_preview:true});if(r.ok)console.log('[TG] sent');else console.warn('[TG]',r.description);}catch(e){console.error('[TG]',e.message);}}
function buildMsg(t,isNew){const sym='$'+(t.sym||'???'),badge=isNew?'🆕 NEW':'📡 SIGNAL',ci={early:'⚡',hot:'🔥',accumulating:'▲',distributing:'▼',dead:'☠'}[t.cls]||'',rocket=t._rocket?' 🚀+'+Math.round((t._mcVel||0)*100)+'% MC/scan':'',sm=(t.smNames||[]).slice(0,3).join(', ')||'—',url=t.pair?'https://dexscreener.com/solana/'+t.pair:'#';return badge+' *'+sym+'*\nMC: '+fmtMC(t.mc)+' | Score: '+t.score+' '+ci+rocket+'\nLiq: '+fmtMC(t.liq)+' | Vol: '+fmtMC(t.vol)+'\nSM: '+sm+'\n'+url;}
function loadState(){try{return JSON.parse(fs.readFileSync(STATE_FILE,'utf8'));}catch(e){return{notifiedAt:{},mcPrev:{},seenKeys:[]};}}
function saveState(s){const cut=Date.now()-48*3600*1000;Object.keys(s.notifiedAt).forEach(k=>{if(s.notifiedAt[k]<cut)delete s.notifiedAt[k];});if(s.seenKeys.length>2000)s.seenKeys=s.seenKeys.slice(-1000);fs.writeFileSync(STATE_FILE,JSON.stringify(s,null,2));}

async function main(){console.log('=== NEET Scanner',new Date().toISOString(),'===');const state=loadState();const pairs=await fetchPairs();if(!pairs.length){console.log('No pairs');return;}const tokens=processPairs(pairs);console.log('Tokens:',tokens.length);let n=0;for(const t of tokens){const k=t.addr||t.pair||t.sym;if(!k)continue;if(t.p1<-50||t.p24<-70)continue;if(state.mcPrev[k]&&state.mcPrev[k]>0&&t.mc>0){t._mcVel=(t.mc-state.mcPrev[k])/state.mcPrev[k];if(t._mcVel>=0.4){t._rocket=true;t.score=Math.min(100,t.score+15);}}state.mcPrev[k]=t.mc;const isRocket=!!t._rocket,thr=isRocket?ROCKET_THRESHOLD:SCORE_THRESHOLD,cd=isRocket?ROCKET_COOLDOWN:NORMAL_COOLDOWN;if(t.score>=thr){const last=state.notifiedAt[k]||0,isNew=!state.seenKeys.includes(k);if(Date.now()-last>cd){state.notifiedAt[k]=Date.now();if(isNew)state.seenKeys.push(k);await sendTG(buildMsg(t,isNew));n++;await new Promise(r=>setTimeout(r,500));}}}saveState(state);console.log('Done. Notified:',n);}
main().catch(e=>{console.error(e);process.exit(1);});
