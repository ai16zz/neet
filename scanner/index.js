/**
 * NEET Smart Money Scanner — 24/7 GitHub Actions runner
 * Mirrors scoring & notification logic from neet-predict_2.html
 * Sends Telegram alerts when score >= 50 (or >= 35 for rockets)
 * Also monitors specific wallets for ANY buy activity
 * State persisted in scanner/state.json between runs
 *
 * UPDATED 2026-04-09:
 *   1. Removed stale hardcoded Telegram fallback token (it returned 401)
 *   2. sendTG now retries, logs loudly, and returns success/failure
 *   3. State is marked "notified" ONLY after a confirmed successful send
 *   4. Strict dedup: one alert per coin, ever (no more 4h cooldown re-alerts)
 *   5. Removed mc<=200K upper cap (was dropping tokens that pumped past it)
 *   6. fetchPairs() / checkWalletBuys() errors are now logged, not swallowed
 *   7. Watched-wallet signatures only marked seen after successful TG send
 *
 * UPDATED 2026-04-10:
 *   8. Added token-boosts/latest/v1 + pumpfun-grads.json as data sources
 *      so alerts fire as soon as tokens appear, not just when profiles update
 *   9. Age filter: skip pairs with pairCreatedAt > 48h ago
 *  10. Holder filter: skip if any single wallet holds > 8% of total supply
 *  11. MC upper cap restored: skip if MC >= $1M
 */
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const TG_TOKEN  = process.env.TG_TOKEN;   // REQUIRED — no fallback, fail loud
const TG_CHATID = process.env.TG_CHATID;  // REQUIRED
if (!TG_TOKEN || !TG_CHATID) {
  console.error('[FATAL] TG_TOKEN and TG_CHATID env vars are required.');
  console.error('        Set them as repo secrets: Settings → Secrets → Actions.');
  process.exit(1);
}

const STATE_FILE       = path.join(__dirname, 'state.json');
const SCORE_THRESHOLD  = 50;
const ROCKET_THRESHOLD = 35;
const SOLANA_RPC       = 'https://api.mainnet-beta.solana.com';
const WSOL             = 'So11111111111111111111111111111111111111112';

// Hard filters
const MC_MIN          = 5_000;
const MC_MAX          = 1_000_000;   // skip coins already over $1M
const VOL_MIN         = 0;
const LIQ_MIN         = 5_000;
const MAX_AGE_MS      = 48 * 3600 * 1000;  // 48 hours
const MAX_TOP_HOLDER  = 0.08;               // 8% max single holder

const SM_WALLETS = [
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
  {name:"Mitch",addr:"4Be9CvxqHW6BYiRAxW9Q3xu1ycTMWaL5z8NX4HR3ha7t",score:96},
  {name:"Hugo Martingale",addr:"Au1GUWfcadx7jMzhsg6gHGUgViYJrnPfL1vbdqnvLK4i",score:95},
];

// Wallets to monitor for ANY buy — instant Telegram alert regardless of score
const WATCHED_WALLETS = [
  {name:'Mitch',           addr:'4Be9CvxqHW6BYiRAxW9Q3xu1ycTMWaL5z8NX4HR3ha7t'},
  {name:'Hugo Martingale', addr:'Au1GUWfcadx7jMzhsg6gHGUgViYJrnPfL1vbdqnvLK4i'},
];

// ─── helpers ────────────────────────────────────────────────────────────────
function smHash(s){let h=5381;for(let i=0;i<s.length;i++)h=((h<<5)+h^s.charCodeAt(i))>>>0;return h;}
function fmtMC(n){if(!n||n<0)return'—';if(n>=1e9)return'$'+(n/1e9).toFixed(1)+'B';if(n>=1e6)return'$'+(n/1e6).toFixed(2)+'M';if(n>=1e3)return'$'+(n/1e3).toFixed(0)+'K';return'$'+n.toFixed(0);}
function httpGet(url){
  return new Promise((resolve,reject)=>{
    const mod=url.startsWith('https')?https:require('http');
    const req=mod.get(url,{headers:{'Accept':'application/json','User-Agent':'NEETScanner/1.2'}},res=>{
      let d='';res.on('data',c=>d+=c);
      res.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){reject(new Error('JSON parse: '+e.message));}});
    });
    req.on('error',reject);
    req.setTimeout(12000,()=>{req.destroy();reject(new Error('httpGet timeout: '+url));});
  });
}

function httpPost(url,body){
  return new Promise((resolve,reject)=>{
    const data=JSON.stringify(body);
    const u=new URL(url);
    const opts={hostname:u.hostname,port:443,path:u.pathname,method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}};
    const req=https.request(opts,res=>{
      let d='';res.on('data',c=>d+=c);
      res.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){resolve({ok:false,error_code:res.statusCode,description:'non-JSON response: '+d.slice(0,200)});}});
    });
    req.on('error',reject);
    req.setTimeout(10000,()=>{req.destroy();reject(new Error('httpPost timeout: '+url));});
    req.write(data);req.end();
  });
}

// ─── Telegram send (loud, returns true/false, retries once) ────────────────
async function sendTG(msg){
  const url='https://api.telegram.org/bot'+TG_TOKEN+'/sendMessage';
  const body={chat_id:TG_CHATID,text:msg,parse_mode:'Markdown',disable_web_page_preview:true};
  for(let attempt=1;attempt<=2;attempt++){
    try{
      const r=await httpPost(url,body);
      if(r && r.ok){
        console.log('[TG] sent ok (attempt '+attempt+')');
        return true;
      }
      console.error('[TG FAIL attempt '+attempt+']',
        'error_code=',r&&r.error_code,
        'description=',r&&r.description);
      if(r && r.error_code===429){
        const wait=(r.parameters&&r.parameters.retry_after?r.parameters.retry_after*1000:2000);
        console.error('[TG] rate-limited, waiting',wait,'ms');
        await new Promise(rs=>setTimeout(rs,wait));
        continue;
      }
      if(r && r.error_code===401){
        console.error('[TG FATAL] 401 Unauthorized — TG_TOKEN is invalid/revoked. Rotate it via @BotFather and update the repo secret.');
        return false;
      }
    }catch(e){
      console.error('[TG EXCEPTION attempt '+attempt+']',e.message);
    }
    await new Promise(rs=>setTimeout(rs,1500));
  }
  return false;
}

// ─── scoring ────────────────────────────────────────────────────────────────
function calcScore(t){let s=0;const mc=t.mc||0,vol=t.vol||0,liq=t.liq||0,p24=t.p24||0,p1=t.p1||0,sm=t.smCount||0;s+=Math.min(sm*15,45);if(mc>=15000&&mc<=100000)s+=15;else if(mc>100000&&mc<=500000)s+=10;else if(mc>500000&&mc<=2e6)s+=5;const vr=mc>0?vol/mc:0;if(vr>3)s+=12;else if(vr>1)s+=8;else if(vr>0.3)s+=4;if(liq>=8000&&liq<=80000)s+=8;else if(liq>=5000)s+=3;if(p24>100)s+=12;else if(p24>50)s+=9;else if(p24>20)s+=6;else if(p24>0)s+=2;if(p1>20)s+=8;else if(p1>5)s+=4;const lr=mc>0?liq/mc:0;if(liq<5000)s-=20;else if(liq<10000)s-=10;if(lr<0.03&&mc>20000)s-=35;else if(liq<15000&&p24<-30)s-=30;else if(liq<30000&&p24<-40)s-=20;if(p1<-50)s-=30;if(liq<15000&&(p24<-25||mc<25000))s-=40;else if(liq<30000&&p24<-35)s-=25;return Math.min(Math.max(Math.round(s),0),100);}
function classify(t){const sm=t.smCount||0,mc=t.mc||0,p24=t.p24||0,p1=t.p1||0;if(sm===0&&p24<-60)return'dead';if(mc<500000&&sm>=1&&p24>-20)return'early';if(sm>=2&&p1>=0)return'accumulating';if(p24>30||p1>8)return'hot';if(p24<-30&&sm<2)return'distributing';return'hot';}
function assignSM(score,addr){if(score<20)return[];addr=addr||'x';const h1=smHash(addr),h2=smHash(addr+'seed');if((h1%100)>=score)return[];const maxN=Math.min(4,Math.floor(score/20));const n=Math.max(1,(h2%maxN)+1);const ws=[...SM_WALLETS];for(let i=ws.length-1;i>0;i--){const j=smHash(addr+i)%(i+1);[ws[i],ws[j]]=[ws[j],ws[i]];}return ws.slice(0,n).map(w=>w.name);}

// ─── holder concentration check ─────────────────────────────────────────────
async function passesHolderFilter(mint){
  try{
    const [supplyResp,largestResp]=await Promise.all([
      httpPost(SOLANA_RPC,{jsonrpc:'2.0',id:1,method:'getTokenSupply',params:[mint]}),
      httpPost(SOLANA_RPC,{jsonrpc:'2.0',id:2,method:'getTokenLargestAccounts',params:[mint]})
    ]);
    const totalAmt=supplyResp.result&&supplyResp.result.value&&parseFloat(supplyResp.result.value.uiAmount||0);
    if(!totalAmt||totalAmt===0)return true; // can't verify, allow
    const accounts=(largestResp.result&&largestResp.result.value)||[];
    if(!accounts.length)return true;
    const topAmt=parseFloat(accounts[0].uiAmount||0);
    const pct=topAmt/totalAmt;
    console.log('[HOLDER]',mint.slice(0,8),'top holder:',+(pct*100).toFixed(1)+'%');
    return pct<=MAX_TOP_HOLDER;
  }catch(e){
    console.error('[HOLDER] check failed for',mint.slice(0,8),':',e.message);
    return true; // on RPC error, don't block the alert
  }
}

// ─── DexScreener fetch — 3 sources merged ──────────────────────────────────
async function fetchPairs(){
  const seen=new Set();
  let pairs=[];

  async function addTokenBatch(addrs){
    const chunks=[];
    for(let i=0;i<addrs.length;i+=30)chunks.push(addrs.slice(i,i+30));
    for(const c of chunks){
      try{
        const d=await httpGet('https://api.dexscreener.com/latest/dex/tokens/'+c.join(','));
        for(const p of (d.pairs||[])){
          if(p.chainId==='solana'&&!seen.has(p.pairAddress)){
            pairs.push(p);seen.add(p.pairAddress);
          }
        }
      }catch(e){console.error('[FETCH] batch error:',e.message);}
      await new Promise(r=>setTimeout(r,300));
    }
  }

  // Source 1: token-boosts/latest — updates whenever someone buys a boost (most real-time)
  try{
    const b=await httpGet('https://api.dexscreener.com/token-boosts/latest/v1');
    const arr=Array.isArray(b)?b:(b.pairs||[]);
    const addrs=arr.filter(x=>(x.chainId||x.chain)==='solana').map(x=>x.tokenAddress).filter(Boolean);
    console.log('[FETCH] boosts latest:',addrs.length,'tokens');
    if(addrs.length)await addTokenBatch(addrs);
  }catch(e){console.error('[FETCH] token-boosts error:',e.message);}

  // Source 2: token-profiles/latest — updates when profiles are activated
  try{
    const p=await httpGet('https://api.dexscreener.com/token-profiles/latest/v1');
    const arr=Array.isArray(p)?p:(p.pairs||[]);
    const addrs=arr.filter(x=>(x.chainId||x.chain)==='solana').map(x=>x.tokenAddress).filter(Boolean);
    console.log('[FETCH] profiles latest:',addrs.length,'tokens');
    if(addrs.length)await addTokenBatch(addrs);
  }catch(e){console.error('[FETCH] token-profiles error:',e.message);}

  // Source 3a: pump.fun grads file (updated every 15 min, used as a warm cache)
  try{
    const gradsFile=path.join(__dirname,'../pumpfun-grads.json');
    if(fs.existsSync(gradsFile)){
      const grads=JSON.parse(fs.readFileSync(gradsFile,'utf8'));
      const addrs=(grads.data||[]).map(g=>g.mint).filter(Boolean);
      console.log('[FETCH] pumpfun grads (file):',addrs.length,'tokens');
      if(addrs.length)await addTokenBatch(addrs);
    }
  }catch(e){console.error('[FETCH] pumpfun-grads file error:',e.message);}

  // Source 3b: pump.fun graduation API direct — fetches live graduates every scan
  // This catches coins that graduated AFTER the last pumpfun-grads.json file update
  try{
    const PF='https://frontend-api-v3.pump.fun';
    const PF_UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const liveAddrs=[];
    for(const offset of [0,50]){
      try{
        const d=await httpGet(`${PF}/coins?offset=${offset}&limit=50&sort=last_trade_timestamp&order=DESC&includeNsfw=false&complete=true`);
        const coins=Array.isArray(d)?d:(d.coins||d.data||[]);
        for(const c of coins){if(c.mint)liveAddrs.push(c.mint);}
      }catch(e){console.error('[FETCH] pumpfun live offset',offset,'error:',e.message);}
      await new Promise(r=>setTimeout(r,400));
    }
    const unique=[...new Set(liveAddrs)];
    console.log('[FETCH] pumpfun grads (live API):',unique.length,'tokens');
    if(unique.length)await addTokenBatch(unique);
  }catch(e){console.error('[FETCH] pumpfun-live error:',e.message);}

  // Source 4: DexScreener active boosts (different set from latest)
  try{
    const b=await httpGet('https://api.dexscreener.com/token-boosts/active/v1');
    const arr=Array.isArray(b)?b:(b.pairs||[]);
    const addrs=arr.filter(x=>(x.chainId||x.chain)==='solana').map(x=>x.tokenAddress).filter(Boolean);
    console.log('[FETCH] boosts active:',addrs.length,'tokens');
    if(addrs.length)await addTokenBatch(addrs);
  }catch(e){console.error('[FETCH] boosts-active error:',e.message);}

  console.log('[FETCH] total unique pairs:',pairs.length);
  return pairs;
}

// ─── process pairs into scored candidates ───────────────────────────────────
function processPairs(pairs){
  const now=Date.now();
  return pairs.map(p=>{
    const mc=parseFloat(p.fdv||p.marketCap||0);
    const vol=parseFloat((p.volume||{}).h24||0);
    const liq=parseFloat((p.liquidity||{}).usd||0);
    const p24=parseFloat((p.priceChange||{}).h24||0);
    const p1 =parseFloat((p.priceChange||{}).h1 ||0);
    const bt=p.baseToken||{};
    const pairCreatedAt=p.pairCreatedAt?parseInt(p.pairCreatedAt):0;
    const t={name:bt.name||'Unknown',sym:bt.symbol||'?',pair:p.pairAddress||'',addr:bt.address||'',mc,vol,liq,p24,p1,pairCreatedAt};
    t.smNames=assignSM(calcScore({...t,smCount:0}),t.addr||t.pair||'');
    t.smCount=t.smNames.length;
    t.score=calcScore(t);
    t.cls=classify(t);
    return t;
  }).filter(t=>{
    if(t.mc<MC_MIN||t.mc>=MC_MAX)return false;         // $5K–$1M only
    if(t.vol<=VOL_MIN||t.liq<LIQ_MIN)return false;     // needs volume + liquidity
    if(t.pairCreatedAt&&(now-t.pairCreatedAt)>MAX_AGE_MS)return false; // skip old pairs
    return true;
  });
}

function buildMsg(t){
  const sym='$'+(t.sym||'???');
  const badge='🆕 NEW';
  const ci={early:'⚡',hot:'🔥',accumulating:'▲',distributing:'▼',dead:'☠'}[t.cls]||'';
  const rocket=t._rocket?' 🚀+'+Math.round((t._mcVel||0)*100)+'% MC/scan':'';
  const sm=(t.smNames||[]).slice(0,3).join(', ')||'—';
  const url=t.pair?'https://dexscreener.com/solana/'+t.pair:'#';
  return badge+' *'+sym+'*\nMC: '+fmtMC(t.mc)+' | Score: '+t.score+' '+ci+rocket+
         '\nLiq: '+fmtMC(t.liq)+' | Vol: '+fmtMC(t.vol)+'\nSM: '+sm+'\n'+url;
}

// ─── state ───────────────────────────────────────────────────────────────
function loadState(){
  try{
    const s=JSON.parse(fs.readFileSync(STATE_FILE,'utf8'));
    s.notifiedAt = s.notifiedAt || {};
    s.mcPrev    = s.mcPrev    || {};
    s.seenKeys  = s.seenKeys  || [];
    s.seenSigs  = s.seenSigs  || {};
    return s;
  }catch(e){
    return {notifiedAt:{},mcPrev:{},seenKeys:[],seenSigs:{}};
  }
}
function saveState(s){
  const mcKeys=Object.keys(s.mcPrev);
  if(mcKeys.length>3000){
    const keep=mcKeys.slice(-1500);
    const newMC={};for(const k of keep)newMC[k]=s.mcPrev[k];
    s.mcPrev=newMC;
  }
  if(s.seenKeys.length>20000)s.seenKeys=s.seenKeys.slice(-15000);
  fs.writeFileSync(STATE_FILE,JSON.stringify(s,null,2));
}

// ─── watched-wallet buys ────────────────────────────────────────────────────
async function checkWalletBuys(state){
  for(const wallet of WATCHED_WALLETS){
    try{
      const sigResp=await httpPost(SOLANA_RPC,{jsonrpc:'2.0',id:1,method:'getSignaturesForAddress',params:[wallet.addr,{limit:6,commitment:'confirmed'}]});
      if(!sigResp.result||!sigResp.result.length){continue;}
      if(!state.seenSigs[wallet.addr])state.seenSigs[wallet.addr]=[];
      for(const s of sigResp.result){
        if(s.err)continue;
        if(state.seenSigs[wallet.addr].includes(s.signature))continue;
        const txResp=await httpPost(SOLANA_RPC,{jsonrpc:'2.0',id:1,method:'getTransaction',params:[s.signature,{encoding:'jsonParsed',commitment:'confirmed',maxSupportedTransactionVersion:0}]});
        if(!txResp.result||!txResp.result.meta){
          state.seenSigs[wallet.addr].push(s.signature);
          continue;
        }
        const pre=txResp.result.meta.preTokenBalances||[];
        const post=txResp.result.meta.postTokenBalances||[];
        let buyDetected=false;
        for(const pb of post){
          if(pb.owner!==wallet.addr)continue;
          if(pb.mint===WSOL)continue;
          const preEntry=pre.find(p=>p.mint===pb.mint&&p.owner===wallet.addr);
          const preAmt=preEntry?parseFloat((preEntry.uiTokenAmount&&preEntry.uiTokenAmount.uiAmount)||0):0;
          const postAmt=parseFloat((pb.uiTokenAmount&&pb.uiTokenAmount.uiAmount)||0);
          if(postAmt>preAmt){
            const gained=postAmt-preAmt;
            const token=pb.mint;
            const msg='🚨 *'+wallet.name+'* just bought!\n\nToken: `'+token+'`\nAmount: '+gained.toLocaleString(undefined,{maximumFractionDigits:2})+' tokens\n[View on DexScreener](https://dexscreener.com/solana/'+token+')';
            console.log('[WALLET BUY]',wallet.name,'->',token);
            const sent=await sendTG(msg);
            if(sent){
              state.seenSigs[wallet.addr].push(s.signature);
            }else{
              console.error('[WALLET BUY] TG send FAILED for',wallet.name,token,'— will retry next scan');
            }
            buyDetected=true;
            break;
          }
        }
        if(!buyDetected){
          state.seenSigs[wallet.addr].push(s.signature);
        }
        await new Promise(r=>setTimeout(r,300));
      }
      state.seenSigs[wallet.addr]=state.seenSigs[wallet.addr].slice(-200);
    }catch(e){
      console.error('[WALLET_BUY]',wallet.name,'error:',e.message);
    }
  }
}

// ─── main ──────────────────────────────────────────────────────────────────
async function main(){
  console.log('=== NEET Scanner',new Date().toISOString(),'===');
  const state=loadState();
  console.log('[STATE] seenKeys size:',state.seenKeys.length);

  await checkWalletBuys(state);

  const pairs=await fetchPairs();
  if(!pairs.length){
    console.warn('[MAIN] 0 pairs returned — upstream outage?');
    saveState(state);
    return;
  }
  const tokens=processPairs(pairs);
  console.log('[MAIN] candidate tokens after filter:',tokens.length);

  const seenSet=new Set(state.seenKeys);
  let sent=0, alreadySeen=0, belowThr=0, crashFilter=0, holderFiltered=0, ageFiltered=0;

  for(const t of tokens){
    const k=t.addr||t.pair||t.sym;
    if(!k)continue;

    // crash filter
    if(t.p1<-50||t.p24<-70){crashFilter++;continue;}

    // rocket detection via MC velocity
    if(state.mcPrev[k]&&state.mcPrev[k]>0&&t.mc>0){
      t._mcVel=(t.mc-state.mcPrev[k])/state.mcPrev[k];
      if(t._mcVel>=0.4){t._rocket=true;t.score=Math.min(100,t.score+15);}
    }
    state.mcPrev[k]=t.mc;

    const thr=t._rocket?ROCKET_THRESHOLD:SCORE_THRESHOLD;
    if(t.score<thr){belowThr++;continue;}

    // ══ STRICT DEDUP: one alert per coin, ever ══
    if(seenSet.has(k)){alreadySeen++;continue;}

    // holder concentration check (only runs for coins that passed score filter)
    const holderOk=await passesHolderFilter(t.addr||'');
    if(!holderOk){
      console.log('[HOLDER] skip',t.sym,'— top holder >8%');
      holderFiltered++;
      // mark seen so we don't re-check every scan
      seenSet.add(k);
      state.seenKeys.push(k);
      continue;
    }

    // attempt send — only mark seen on success
    const ok=await sendTG(buildMsg(t));
    if(ok){
      seenSet.add(k);
      state.seenKeys.push(k);
      state.notifiedAt[k]=Date.now();
      sent++;
      await new Promise(r=>setTimeout(r,500));
    }else{
      console.error('[MAIN] send failed for',t.sym,'('+k+') — will retry next scan');
    }
  }

  saveState(state);
  console.log('[MAIN] done. sent:',sent,'| seen:',alreadySeen,'| below-thr:',belowThr,'| crash:',crashFilter,'| holder-filtered:',holderFiltered);
}

main().catch(e=>{console.error('[FATAL]',e);process.exit(1);});
