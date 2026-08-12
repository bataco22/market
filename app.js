
// Markets v1.1 · monitor optimizado para límites de API · conserva datos v1.0
(function(){
  if(!("serviceWorker" in navigator)) return;
  let refreshing=false;
  navigator.serviceWorker.addEventListener("controllerchange",()=>{
    if(refreshing) return;
    refreshing=true;
    location.reload();
  });
  window.addEventListener("load", async ()=>{
    try{
      const regs=await navigator.serviceWorker.getRegistrations();
      for(const reg of regs){
        try{ await reg.update(); }catch(e){}
      }
    }catch(e){}
  });
})();


const TWELVE_BASE = "https://api.twelvedata.com";
const DEFAULT_ASSETS = ["SPY","QQQ","DIA","IWM","GLD","SLV","USO","UNG","DBA","AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","JPM","XOM","CAT","COST"];
const MARKET_UNIVERSE = [
  "SPY","QQQ","DIA","IWM",
  "GLD","SLV","COPX","USO","UNG","DBA",
  "AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","AVGO","AMD","NFLX",
  "JPM","BAC","GS","V","MA","XOM","CVX","CAT","DE","COST","WMT","KO","PEP","UNH","LLY","JNJ","PG","HD","BA","GE"
];
const TF_MAP={"15m":"15min","1h":"1h","4h":"4h","1d":"1day","1w":"1week"};
function getMarketApiKey(){ return localStorage.getItem("markets_quant_twelve_key") || ""; }
const DEFAULT_WEIGHTS = {trend:30,momentum:20,strength:15,volume:15,volatility:10,structure:10};
const state = {
  assets: JSON.parse(localStorage.getItem("markets_quant_assets") || "null") || DEFAULT_ASSETS,
  weights: JSON.parse(localStorage.getItem("markets_quant_weights") || "null") || DEFAULT_WEIGHTS,
  market: {},
  selected: null,
  analysis: null,
  paperTrades: JSON.parse(localStorage.getItem("markets_quant_paper_trades") || "[]"),
  pendingPaperSignal: null,
  homeInterval: localStorage.getItem("markets_quant_home_timeframe") || "1d",
  autoPaper: JSON.parse(localStorage.getItem("markets_quant_auto_paper") || "null") || {enabled:false,interval:"4h",threshold:85,stopPct:3,targetPct:9,riskPct:1,capital:20000,lastSignals:{},universe:"markets40"},
  scannerResults: []
};

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const fmt = (n,d=2) => Number(n).toLocaleString("es-MX",{maximumFractionDigits:d,minimumFractionDigits:n<1?Math.min(d,4):0});
const money = n => "$" + Number(n).toLocaleString("en-US",{maximumFractionDigits:n<1?6:2});
const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));

function showView(id){
  $$(".view").forEach(v=>v.classList.toggle("active",v.id===id));
  $$(".bottom-nav button").forEach(b=>b.classList.toggle("active",b.dataset.view===id));
  window.scrollTo({top:0,behavior:"smooth"});
  if(id==="homeView") renderHome();
  if(id==="backtestView") fillAssetSelects();
  if(id==="paperView"){ fillAssetSelects(); renderPaperTrades(); }
}
$$(".bottom-nav button").forEach(b=>b.addEventListener("click",()=>showView(b.dataset.view)));

const API_MIN_GAP_MS=9000; // protege planes con cuota baja
let apiLastStart=0;
let apiBackoffUntil=0;
let apiQueue=Promise.resolve();
const candleCache=new Map();
const CANDLE_TTL={"15m":4*60e3,"1h":15*60e3,"4h":60*60e3,"1d":4*60*60e3,"1w":12*60*60e3};
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
function queuedApi(task){
  const run=apiQueue.then(async()=>{
    const now=Date.now();
    if(apiBackoffUntil>now) await sleep(apiBackoffUntil-now);
    const wait=Math.max(0,API_MIN_GAP_MS-(Date.now()-apiLastStart));
    if(wait) await sleep(wait);
    apiLastStart=Date.now();
    return task();
  });
  apiQueue=run.catch(()=>{});
  return run;
}
async function api(path, params={}){
  const key=getMarketApiKey();
  if(!key) throw new Error("Falta API key de Twelve Data. Agrégala en Sistema.");
  const url=new URL(TWELVE_BASE+path);
  Object.entries({...params,apikey:key}).forEach(([k,v])=>url.searchParams.set(k,v));
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),15000);
  try{
    return await queuedApi(async()=>{
      const r=await fetch(url,{signal:controller.signal,cache:"no-store"});
      if(r.status===429){
        apiBackoffUntil=Date.now()+65000;
        throw new Error("API 429 · pausa automática de 65 s");
      }
      if(!r.ok) throw new Error("API "+r.status);
      const data=await r.json();
      if(data.status==="error"||data.code) throw new Error(data.message||"Error de mercado");
      return data;
    });
  } finally {clearTimeout(timeout);}
}

function ema(values, period){
  const k=2/(period+1), out=[];
  let prev=values[0];
  values.forEach((v,i)=>{prev=i===0?v:v*k+prev*(1-k);out.push(prev)});
  return out;
}
function sma(values,p){
  return values.map((_,i)=>i<p-1?null:values.slice(i-p+1,i+1).reduce((a,b)=>a+b,0)/p);
}
function rsi(values,p=14){
  const out=Array(values.length).fill(null); let gains=0,losses=0;
  for(let i=1;i<=p;i++){const d=values[i]-values[i-1];gains+=Math.max(d,0);losses+=Math.max(-d,0)}
  let ag=gains/p, al=losses/p; out[p]=al===0?100:100-100/(1+ag/al);
  for(let i=p+1;i<values.length;i++){const d=values[i]-values[i-1];ag=(ag*(p-1)+Math.max(d,0))/p;al=(al*(p-1)+Math.max(-d,0))/p;out[i]=al===0?100:100-100/(1+ag/al)}
  return out;
}
function atr(candles,p=14){
  const tr=candles.map((c,i)=>i===0?c.h-c.l:Math.max(c.h-c.l,Math.abs(c.h-candles[i-1].c),Math.abs(c.l-candles[i-1].c)));
  return ema(tr,p);
}
function adx(c,p=14){
  const trs=[],plus=[],minus=[];
  for(let i=0;i<c.length;i++){
    if(i===0){trs.push(c[i].h-c[i].l);plus.push(0);minus.push(0);continue}
    const up=c[i].h-c[i-1].h, dn=c[i-1].l-c[i].l;
    plus.push(up>dn&&up>0?up:0); minus.push(dn>up&&dn>0?dn:0);
    trs.push(Math.max(c[i].h-c[i].l,Math.abs(c[i].h-c[i-1].c),Math.abs(c[i].l-c[i-1].c)));
  }
  const atrE=ema(trs,p), pE=ema(plus,p), mE=ema(minus,p);
  const dx=c.map((_,i)=>{const pi=100*pE[i]/(atrE[i]||1),mi=100*mE[i]/(atrE[i]||1);return 100*Math.abs(pi-mi)/((pi+mi)||1)});
  return ema(dx,p);
}
function analyze(candles){
  const closes=candles.map(x=>x.c), vols=candles.map(x=>x.v);
  const e20=ema(closes,20),e50=ema(closes,50),e200=ema(closes,200),rs=rsi(closes),at=atr(candles),ax=adx(candles),v20=sma(vols,20);
  const i=Math.max(1,closes.length-2), price=closes.at(-1), signalPrice=closes[i], prev=closes[i-1], atrPct=at[i]/signalPrice*100;
  const closedCandles=candles.slice(0,-1), look=closedCandles.slice(-12), highs=look.map(x=>x.h), lows=look.map(x=>x.l);
  const longFactors={
    trend:(signalPrice>e20[i]?.35:0)+(e20[i]>e50[i]?.35:0)+(e50[i]>e200[i]?.30:0),
    momentum:rs[i]>=50&&rs[i]<=68?1:rs[i]>=45&&rs[i]<75?.65:rs[i]<35?.45:.2,
    strength:ax[i]>=25?1:ax[i]>=18?.65:.3,
    volume:v20[i]&&vols[i]>v20[i]?1:.45,
    volatility:atrPct>=1&&atrPct<=6?1:atrPct<9?.6:.25,
    structure:(highs.at(-1)>Math.max(...highs.slice(0,-1))?.55:0)+(lows.at(-1)>Math.min(...lows.slice(0,-1))?.45:0)
  };
  const shortFactors={
    trend:(signalPrice<e20[i]?.35:0)+(e20[i]<e50[i]?.35:0)+(e50[i]<e200[i]?.30:0),
    momentum:rs[i]>=32&&rs[i]<=50?1:rs[i]>25&&rs[i]<55?.65:rs[i]>70?.45:.2,
    strength:ax[i]>=25?1:ax[i]>=18?.65:.3,
    volume:v20[i]&&vols[i]>v20[i]?1:.45,
    volatility:atrPct>=1&&atrPct<=6?1:atrPct<9?.6:.25,
    structure:(lows.at(-1)<Math.min(...lows.slice(0,-1))?.55:0)+(highs.at(-1)<Math.max(...highs.slice(0,-1))?.45:0)
  };
  const calc=f=>Math.round(Object.entries(f).reduce((s,[k,v])=>s+v*(state.weights[k]||0),0));
  const longScore=calc(longFactors),shortScore=calc(shortFactors);
  const decision=s=>s>=85?"Favorable":s>=70?"Esperar / Vigilar":"Evitar";
  return {longScore,shortScore,longDecision:decision(longScore),shortDecision:decision(shortScore),
    trend:signalPrice>e20[i]&&e20[i]>e50[i]?"Alcista":signalPrice<e20[i]&&e20[i]<e50[i]?"Bajista":"Mixta",
    rsi:rs[i],adx:ax[i],atrPct,volumeRatio:v20[i]?vols[i]/v20[i]:1,
    support:Math.min(...closedCandles.slice(-20).map(x=>x.l)),resistance:Math.max(...closedCandles.slice(-20).map(x=>x.h)),
    price,change:(price/signalPrice-1)*100,e20,e50,e200,longFactors,shortFactors};
}
async function getCandles(symbol,interval="1d",limit=500,force=false){
  const cacheKey=`${symbol}:${interval}:${Math.min(limit,5000)}`;
  const cached=candleCache.get(cacheKey),ttl=CANDLE_TTL[interval]||15*60e3;
  if(!force&&cached&&(Date.now()-cached.at)<ttl) return cached.data;
  const raw=await api("/time_series",{symbol,interval:TF_MAP[interval]||interval,outputsize:Math.min(limit,5000),format:"JSON"});
  const values=(raw.values||[]).slice().reverse();
  if(values.length<30) throw new Error("Historial insuficiente para "+symbol);
  const data=values.map(x=>({t:new Date(x.datetime.replace(" ","T")).getTime(),o:+x.open,h:+x.high,l:+x.low,c:+x.close,v:+x.volume||0}));
  candleCache.set(cacheKey,{at:Date.now(),data});
  return data;
}
async function getTicker(symbol){
  const q=await api("/quote",{symbol});
  return {lastPrice:+q.close||+q.price||0,priceChangePercent:+q.percent_change||0};
}
async function getScannerUniverse(){
  return MARKET_UNIVERSE.slice();
}
async function mapWithConcurrency(items,limit,worker){
  const out=[];let next=0;
  async function run(){while(next<items.length){const i=next++;try{out[i]=await worker(items[i],i)}catch(e){out[i]=null}}}
  await Promise.all(Array.from({length:Math.min(limit,items.length)},run));return out;
}

// Señal principal: 1D define contexto/tendencia y 4H afina la entrada.
// Peso: 40% diario + 60% 4H. Si ambos marcos discrepan en el sesgo,
// el score combinado recibe una penalización para evitar falsas certezas.
function combineTimeframes(daily,entry4h,side){
  const dScore=activeScore(daily,side), hScore=activeScore(entry4h,side);
  const opposite=side==="long"?"short":"long";
  const dailyAligned=dScore>=activeScore(daily,opposite);
  const h4Aligned=hScore>=activeScore(entry4h,opposite);
  let score=Math.round(dScore*.40+hScore*.60);
  if(!dailyAligned) score-=12;
  if(!h4Aligned) score-=8;
  score=clamp(score,0,100);
  return {score,dailyScore:dScore,entryScore:hScore,dailyAligned,h4Aligned};
}
function combinedSideData(marketRow,side){
  if(!marketRow?.daily||!marketRow?.entry4h) return null;
  return combineTimeframes(marketRow.daily,marketRow.entry4h,side);
}

function scoreClass(score){return score>=85?"good":score>=70?"warn":"bad"}
const HOME_TF_LABELS={"15m":"15M","1h":"1H","4h":"4H","1d":"1D","1w":"1W"};
function homeTfLabel(interval){return HOME_TF_LABELS[interval]||String(interval).toUpperCase()}
function homeTfData(marketRow){
  if(!marketRow)return null;
  const tf=state.homeInterval||"1d";
  return marketRow.timeframes?.[tf] || (tf==="1d"?marketRow.daily:tf==="4h"?marketRow.entry4h:null);
}
function homeBestOpportunity(){
  const rows=[];
  state.assets.forEach(symbol=>{
    const row=state.market[symbol], d=homeTfData(row); if(!row||!d)return;
    ["long","short"].forEach(side=>rows.push({symbol,side,score:activeScore(d,side),d,price:row.price,change:row.change}));
  });
  return rows.sort((a,b)=>b.score-a.score)[0]||null;
}
function homeReasonRows(best){
  if(!best)return [{tone:"neutral",icon:"•",text:"Esperando indicadores del mercado."}];
  const tf=homeTfLabel(state.homeInterval), sideName=best.side==="long"?"LONG":"SHORT";
  const details=scoreBreakdownData(best.d,best.side).sort((a,b)=>b.points-a.points).slice(0,4);
  return [
    {tone:scoreClass(best.score),icon:best.score>=70?"✓":"!",text:`Score ${tf} ${sideName}: ${best.score}/100.`},
    ...details.map(r=>({tone:r.tone,icon:r.tone==="good"?"✓":r.tone==="bad"?"×":"!",text:`${tf} · ${r.label}: aporta ${r.points.toFixed(1)} de ${r.weight} puntos.`}))
  ];
}
function renderHome(){
  const tf=state.homeInterval||"1d", tfLabel=homeTfLabel(tf);
  const selector=$("#homeTimeframeSelect");
  if(selector && selector.value!==tf) selector.value=tf;
  if($("#homeScoreLabel")) $("#homeScoreLabel").textContent=`Score ${tfLabel}`;
  const best=homeBestOpportunity();
  const data=Object.values(state.market).map(homeTfData).filter(Boolean);
  const analyzed=data.length;
  const maxScore=d=>Math.max(d.longScore||0,d.shortScore||0);
  const favorable=data.filter(d=>maxScore(d)>=85).length;
  const neutral=data.filter(d=>{const x=maxScore(d);return x>=70&&x<85}).length;
  const avoid=data.filter(d=>maxScore(d)<70).length;
  if($("#homeAnalyzed")){ $("#homeAnalyzed").textContent=analyzed; $("#homeFavorable").textContent=favorable; $("#homeNeutral").textContent=neutral; $("#homeAvoid").textContent=avoid; }
  if(!best){
    $("#homePair").textContent=`Analizando favoritos · ${tfLabel}…`; $("#homeScore").textContent="--"; $("#homeScore").parentElement.style.setProperty("--home-score",0);
    $("#homeReasons").innerHTML='<div class="reason-row neutral"><span>•</span><p>Cargando esta temporalidad.</p></div>';
    return;
  }
  const {symbol,side,score,d}=best, sideName=side==="long"?"LONG":"SHORT";
  const tone=scoreClass(score), confidence=score>=85?"Alta":score>=70?"Media":"Baja";
  const risk=d.atrPct<=3?"Bajo":d.atrPct<=6?"Medio":"Alto";
  const decision=score>=85?"FAVORABLE PARA EVALUAR":score>=70?"ESPERAR / VIGILAR":"EVITAR POR AHORA";
  const headline=score>=85?`${symbol} tiene una lectura de nivel alto en ${tfLabel}`:score>=70?`${symbol} merece vigilancia en ${tfLabel}, pero aún falta confirmación`:`No hay una entrada disciplinada en ${tfLabel} todavía`;
  $("#homePair").textContent=`${symbol} · ${sideName} · ${tfLabel}`; $("#homeScore").textContent=score; $("#homeScore").parentElement.style.setProperty("--home-score",score);
  $("#homeSide").textContent=`Sesgo ${sideName}`; $("#homeDecision").textContent=decision; $("#homeDecision").className=`home-decision ${tone}`;
  $("#homeHeadline").textContent=headline; $("#homeSummary").textContent=`Score ${tfLabel} ${score}/100 · Precio ${money(best.price)} · cambio 24h ${best.change>=0?"+":""}${fmt(best.change)}%.`;
  $("#homeConfidence").textContent=confidence; $("#homeRisk").textContent=risk; $("#homeUpdated").textContent=new Date().toLocaleTimeString("es-MX",{hour:"2-digit",minute:"2-digit"});
  $("#homeReasons").innerHTML=homeReasonRows(best).map(r=>`<div class="reason-row ${r.tone}"><span>${r.icon}</span><p>${r.text}</p></div>`).join("");
  $("#homeAnalyzeBtn").disabled=false; $("#homeAnalyzeBtn").dataset.symbol=symbol;
  $("#homePaperBtn").dataset.symbol=symbol;
  state.pendingPaperSignal={symbol,side,interval:tf,score,scoreType:"timeframe",snapshot:{longScore:d.longScore,shortScore:d.shortScore,rsi:d.rsi,adx:d.adx,atrPct:d.atrPct,volumeRatio:d.volumeRatio,trend:d.trend,ema20:d.e20.at(-1),ema50:d.e50.at(-1),ema200:d.e200.at(-1)},createdAt:Date.now()};
}
async function refreshHomeTimeframe(interval){
  state.homeInterval=interval;
  localStorage.setItem("markets_quant_home_timeframe",interval);
  renderHome();
  const missing=state.assets.filter(sym=>!state.market[sym]?.timeframes?.[interval]);
  if(!missing.length){renderHome();return;}
  const selector=$("#homeTimeframeSelect"); if(selector) selector.disabled=true;
  await Promise.all(missing.map(async sym=>{
    try{
      const candles=await getCandles(sym,interval,interval==="1w"?260:500);
      const a=analyze(candles);
      const row=state.market[sym]||(state.market[sym]={timeframes:{}});
      row.timeframes=row.timeframes||{}; row.timeframes[interval]=a;
      if(interval==="1d") row.daily=a; if(interval==="4h") row.entry4h=a;
      renderHome();
    }catch(e){console.warn("Home timeframe",sym,interval,e)}
  }));
  if(selector) selector.disabled=false;
  renderHome();
}
function activeScore(d,mode){return mode==="short"?d.shortScore:d.longScore}

function scoreAtIndex(c,i,pre=null){
  if(i<210)return null;
  const closes=pre?.closes||c.map(x=>x.c),vols=pre?.vols||c.map(x=>x.v);
  const e20=pre?.e20||ema(closes,20),e50=pre?.e50||ema(closes,50),e200=pre?.e200||ema(closes,200),rs=pre?.rs||rsi(closes),at=pre?.at||atr(c),ax=pre?.ax||adx(c),v20=pre?.v20||sma(vols,20);
  const price=closes[i],atrPct=(at[i]||0)/(price||1)*100;
  const look=c.slice(Math.max(0,i-11),i+1),highs=look.map(x=>x.h),lows=look.map(x=>x.l);
  const prevHigh=highs.length>1?Math.max(...highs.slice(0,-1)):highs[0],prevLow=lows.length>1?Math.min(...lows.slice(0,-1)):lows[0];
  const longFactors={trend:(price>e20[i]?.35:0)+(e20[i]>e50[i]?.35:0)+(e50[i]>e200[i]?.30:0),momentum:rs[i]>=50&&rs[i]<=68?1:rs[i]>=45&&rs[i]<75?.65:rs[i]<35?.45:.2,strength:ax[i]>=25?1:ax[i]>=18?.65:.3,volume:v20[i]&&vols[i]>v20[i]?1:.45,volatility:atrPct>=1&&atrPct<=6?1:atrPct<9?.6:.25,structure:(c[i].h>prevHigh?.55:0)+(c[i].l>prevLow?.45:0)};
  const shortFactors={trend:(price<e20[i]?.35:0)+(e20[i]<e50[i]?.35:0)+(e50[i]<e200[i]?.30:0),momentum:rs[i]>=32&&rs[i]<=50?1:rs[i]>25&&rs[i]<55?.65:rs[i]>70?.45:.2,strength:ax[i]>=25?1:ax[i]>=18?.65:.3,volume:v20[i]&&vols[i]>v20[i]?1:.45,volatility:atrPct>=1&&atrPct<=6?1:atrPct<9?.6:.25,structure:(c[i].l<prevLow?.55:0)+(c[i].h<prevHigh?.45:0)};
  const calc=f=>Math.round(Object.entries(f).reduce((sum,[k,v])=>sum+v*(state.weights[k]||0),0));
  return {longScore:calc(longFactors),shortScore:calc(shortFactors),rsi:rs[i],adx:ax[i],atrPct,volumeRatio:v20[i]?vols[i]/v20[i]:1,trend:price>e20[i]&&e20[i]>e50[i]?"Alcista":price<e20[i]&&e20[i]<e50[i]?"Bajista":"Mixta",ema20:e20[i],ema50:e50[i],ema200:e200[i]};
}
function saveAutoPaper(){localStorage.setItem("markets_quant_auto_paper",JSON.stringify(state.autoPaper))}
function syncAutoPaperControls(){
  const a=state.autoPaper;
  if($("#autoPaperEnabled")) $("#autoPaperEnabled").checked=!!a.enabled;
  if($("#autoPaperInterval")) $("#autoPaperInterval").value=a.interval;
  if($("#autoPaperThreshold")) $("#autoPaperThreshold").value=a.threshold;
  if($("#autoPaperStop")) $("#autoPaperStop").value=a.stopPct;
  if($("#autoPaperTarget")) $("#autoPaperTarget").value=a.targetPct;
  if($("#autoPaperRisk")) $("#autoPaperRisk").value=a.riskPct;
  if($("#autoPaperCapital")) $("#autoPaperCapital").value=a.capital;
  if($("#autoPaperStatus")) $("#autoPaperStatus").textContent=a.enabled?`Activo · ${a.interval} · score ≥ ${a.threshold}`:"Apagado";
}
function readAutoPaperControls(){
  state.autoPaper={...state.autoPaper,
    enabled:!!$("#autoPaperEnabled")?.checked,
    interval:$("#autoPaperInterval")?.value||"4h",
    threshold:+$("#autoPaperThreshold")?.value||85,
    stopPct:+$("#autoPaperStop")?.value||3,
    targetPct:+$("#autoPaperTarget")?.value||9,
    riskPct:+$("#autoPaperRisk")?.value||1,
    capital:+$("#autoPaperCapital")?.value||20000,
    universe:"markets40",
    lastSignals:state.autoPaper.lastSignals||{}
  };saveAutoPaper();syncAutoPaperControls();
}

function renderScannerResults(){
  const box=$("#scannerResults"), meta=$("#scannerResultsMeta"); if(!box)return;
  const rows=state.scannerResults||[];
  if(meta)meta.textContent=rows.length?`${rows.length} instrumentos revisados · ordenados por mejor Score`:"Aún no hay un barrido terminado.";
  if(!rows.length){box.innerHTML='<div class="scanner-empty">Activa el radar y toca <strong>Revisar señales ahora</strong> para ver aquí todos los instrumentos analizados.</div>';return;}
  box.innerHTML=rows.map((r,i)=>{
    const best=Math.max(r.longScore,r.shortScore),side=r.longScore>=r.shortScore?"LONG":"SHORT";
    const cls=best>=85?"scanner-good":best>=70?"scanner-watch":"scanner-low",status=best>=85?"SEÑAL":best>=70?"VIGILAR":"SIN SEÑAL";
    return `<div class="scanner-row ${cls}"><span class="scanner-rank">${i+1}</span><div class="scanner-coin"><strong>${r.symbol}</strong><small>${status} · mejor lado ${side}</small></div><div class="scanner-side"><span>Long</span><strong>${r.longScore}</strong></div><div class="scanner-side"><span>Short</span><strong>${r.shortScore}</strong></div><div class="scanner-best"><span>Mejor</span><strong>${best}</strong></div></div>`;
  }).join("");
}

async function scanAutoPaper(manual=false){
  readAutoPaperControls(); const a=state.autoPaper;
  if(!a.enabled&&!manual){
    const status=$("#autoPaperStatus");if(status)status.textContent="Apagado";
    return;
  }
  const status=$("#autoPaperStatus");if(status)status.textContent="Preparando universo Markets…";
  let opened=0, universe=[];
  try{universe=await getScannerUniverse()}catch(e){console.warn("scanner universe",e);if(status)status.textContent="No se pudo cargar el universo de mercado";return}
  if(status)status.textContent=`Escaneando ${universe.length} instrumentos de Markets…`;
  const scanRows=await mapWithConcurrency(universe,2,async sym=>{
    try{
      const candles=await getCandles(sym,a.interval,a.interval==="1w"?260:500),analysis=analyze(candles),signalIndex=Math.max(1,candles.length-2),signalCandle=candles[signalIndex];
      const row={symbol:sym,longScore:analysis.longScore,shortScore:analysis.shortScore,price:analysis.price};
      const candidates=[{side:"long",score:analysis.longScore},{side:"short",score:analysis.shortScore}].filter(x=>x.score>=a.threshold).sort((x,y)=>y.score-x.score);
      if(!candidates.length)return row;
      if(manual&&!a.enabled)return row;
      const pick=candidates[0],key=`${sym}:${a.interval}:${pick.side}`,signalId=signalCandle.t;
      const alreadyOpen=state.paperTrades.some(t=>t.status==="open"&&t.symbol===sym&&t.interval===a.interval&&t.side===pick.side&&t.auto);
      if(alreadyOpen||a.lastSignals[key]===signalId)return row;
      const entry=signalCandle.c,lv=paperLevels(entry,pick.side,"percent",a.stopPct,"percent",a.targetPct),riskDist=Math.abs(entry-lv.stop),rewardDist=Math.abs(lv.target-entry),rr=riskDist?rewardDist/riskDist:0;
      if(rr<3)return row;
      const riskCash=a.capital*a.riskPct/100,qty=riskDist?riskCash/riskDist:0;
      state.paperTrades.unshift({id:Date.now()+Math.floor(Math.random()*1000000),symbol:sym,side:pick.side,interval:a.interval,entry,stop:lv.stop,target:lv.target,openedAt:signalCandle.t,status:"open",current:analysis.price,score:pick.score,capital:a.capital,riskPct:a.riskPct,riskCash,qty,potentialProfit:qty*rewardDist,rr,checklist:{trend:true,signal:true,risk:true,noImpulse:true},scoreType:"auto-score-markets",snapshot:{longScore:analysis.longScore,shortScore:analysis.shortScore,rsi:analysis.rsi,adx:analysis.adx,atrPct:analysis.atrPct,volumeRatio:analysis.volumeRatio,trend:analysis.trend,ema20:analysis.e20.at(-1),ema50:analysis.e50.at(-1),ema200:analysis.e200.at(-1)},notes:`AUTO MARKETS · Score ≥ ${a.threshold}`,auto:true,closedAt:null,exit:null,resultPct:null});
      a.lastSignals[key]=signalId;opened++; return row;
    }catch(e){console.warn("auto paper",sym,e);return null}
  });
  state.scannerResults=scanRows.filter(Boolean).sort((x,y)=>Math.max(y.longScore,y.shortScore)-Math.max(x.longScore,x.shortScore));
  renderScannerResults();
  saveAutoPaper();savePaperState();renderPaperTrades();
  if(status)status.textContent=`${a.enabled?"Activo":"Barrido manual"} · ${universe.length} instrumentos · ${a.interval} · score ≥ ${a.threshold}${opened?` · ${opened} nueva${opened===1?"":"s"}`:" · sin señales nuevas"}`;
}

function activeDecision(d,mode){return mode==="short"?d.shortDecision:d.longDecision}
function scoreBreakdownData(a,mode){
  const factors=mode==="short"?a.shortFactors:a.longFactors;
  const labels={trend:"Tendencia EMA",momentum:"Momentum RSI",strength:"Fuerza ADX",volume:"Volumen",volatility:"Volatilidad ATR",structure:"Estructura"};
  return Object.keys(labels).map(key=>{
    const quality=clamp(Number(factors?.[key]||0),0,1),weight=Number(state.weights[key]||0),points=quality*weight;
    const tone=quality>=.8?"good":quality>=.5?"warn":quality<.3?"bad":"neutral";
    const status=quality>=.8?"Fuerte":quality>=.5?"Parcial":quality<.3?"Débil":"Limitado";
    return {key,label:labels[key],quality,weight,points,tone,status};
  });
}
function trafficDecision(a,mode){
  const score=activeScore(a,mode), rows=scoreBreakdownData(a,mode);
  const bad=rows.filter(r=>r.quality<.3);
  const tone=score>=85&&bad.length===0?"green":score>=70?"yellow":"red";
  const title=tone==="green"?"🟢 OPERACIÓN PARA EVALUAR":tone==="yellow"?"🟡 ESPERAR CONFIRMACIÓN":"🔴 NO OPERAR";
  const message=tone==="green"?"La lectura técnica cumple el nivel alto del sistema. Confirma entrada, stop y R/B antes de ejecutar.":tone==="yellow"?"Hay elementos favorables, pero todavía faltan condiciones para una entrada disciplinada.":"La evidencia técnica es insuficiente. Preservar el capital es la decisión correcta.";
  const strongest=[...rows].sort((x,y)=>y.quality-x.quality).slice(0,2);
  const weakest=[...rows].sort((x,y)=>x.quality-y.quality).slice(0,3);
  const reasons=[...strongest.map(r=>({tone:"good",icon:"✓",text:`${r.label}: ${r.status.toLowerCase()} (${Math.round(r.quality*100)}%).`})),...weakest.filter(r=>!strongest.includes(r)).map(r=>({tone:r.quality<.3?"bad":"warn",icon:r.quality<.3?"×":"!",text:`${r.label}: ${r.status.toLowerCase()} (${Math.round(r.quality*100)}%).`}))];
  const targets={trend:.8,momentum:.8,strength:.8,volume:.8,volatility:.5,structure:.5};
  const needs=[];
  if(score<85) needs.push(`Subir el score de ${score} a 85 o más.`);
  rows.forEach(r=>{const target=targets[r.key]??.8;if(r.quality<target){
    const detail=r.key==="strength"?`Esperar ADX de 25 o más (actual ${fmt(a.adx,1)}).`:r.key==="volume"?`Esperar volumen de al menos 1.0x el promedio (actual ${fmt(a.volumeRatio,2)}x).`:r.key==="momentum"?`Esperar que el RSI entre en una zona más favorable para ${mode==="long"?"Long":"Short"} (actual ${fmt(a.rsi,1)}).`:r.key==="trend"?`Esperar alineación más clara de precio, EMA20, EMA50 y EMA200 para ${mode==="long"?"Long":"Short"}.`:r.key==="structure"?`Esperar una ruptura o estructura de máximos y mínimos más clara.`:`Esperar una volatilidad más operable; ATR actual ${fmt(a.atrPct,2)}%.`;
    needs.push(detail);
  }});
  if(!needs.length) needs.push("La lectura técnica ya está en verde. Solo falta validar entrada, stop y R/B mínimo 1:3 en el simulador.");
  return {score,tone,title,message,reasons:reasons.slice(0,4),needs:[...new Set(needs)].slice(0,6)};
}
function renderTrafficLight(a,mode){
  const card=$("#trafficCard");if(!card)return;
  const t=trafficDecision(a,mode), light=$("#trafficLight");
  $("#trafficTitle").textContent=t.title;$("#trafficMessage").textContent=t.message;
  light.className=`traffic-light ${t.tone}`;light.setAttribute("aria-label",t.title.replace(/[🟢🟡🔴]/g,"").trim());
  $("#trafficReasons").innerHTML=t.reasons.map(r=>`<div class="reason-row ${r.tone}"><span>${r.icon}</span><p>${r.text}</p></div>`).join("");
  $("#trafficNeeds").innerHTML=`<strong>Para llegar a verde:</strong><ul>${t.needs.map(n=>`<li>${n}</li>`).join("")}</ul>`;
}

function scoreQualityLabel(score,rr=0){
  if(score>=90&&rr>=3) return {grade:"A+",label:"Excelente"};
  if(score>=85&&rr>=3) return {grade:"A",label:"Alta calidad"};
  if(score>=70) return {grade:"B",label:"Vigilar"};
  return {grade:"C",label:"Evitar"};
}
function scoreWhySummary(a,mode){
  const rows=scoreBreakdownData(a,mode).sort((x,y)=>y.quality-x.quality);
  const good=rows.filter(r=>r.quality>=.8).slice(0,3).map(r=>`✓ ${r.label}: ${r.status.toLowerCase()}`);
  const weak=[...rows].sort((x,y)=>x.quality-y.quality).filter(r=>r.quality<.8).slice(0,2).map(r=>`${r.quality<.3?"✗":"!"} ${r.label}: ${r.status.toLowerCase()}`);
  return [...good,...weak];
}
function renderScoreBreakdown(a,mode){
  const box=$("#scoreBreakdown");if(!box)return;
  const rows=scoreBreakdownData(a,mode),total=Math.round(rows.reduce((s,r)=>s+r.points,0));
  $("#scoreWeightTotal").textContent=`Pesos: ${rows.reduce((s,r)=>s+r.weight,0)} · Score: ${total}`;
  const why=scoreWhySummary(a,mode);
  box.innerHTML=`<div class="score-why"><strong>¿Por qué este score?</strong>${why.map(x=>`<div>${x}</div>`).join("")}</div>`+rows.map(r=>`<div class="score-factor ${r.tone}"><div class="score-factor-top"><div><strong>${r.label}</strong><small>${r.status} · calidad ${Math.round(r.quality*100)}%</small></div><b>+${r.points.toFixed(1)} / ${r.weight}</b></div><div class="factor-track"><span style="width:${r.quality*100}%"></span></div></div>`).join("");
}
function renderRanking(){
  const mode=$("#marketModeSelect")?.value||"long";
  const rows=state.assets.filter(s=>state.market[s]).map(s=>({s,d:state.market[s]})).sort((a,b)=>activeScore(b.d,mode)-activeScore(a.d,mode));
  $("#marketRanking").innerHTML=rows.length?rows.map((x,i)=>`<button class="rank-row" data-rank="${x.s}">
    <span class="rank-num">${i+1}</span><span class="rank-main"><strong>${x.s}</strong><small>${mode==="long"?"Oportunidad de compra":"Oportunidad de caída"}</small></span>
    <span class="rank-score">${activeScore(x.d,mode)}/100</span><span class="rank-action">${activeDecision(x.d,mode)}</span></button>`).join(""):"<div class='notice'>Actualizando ranking…</div>";
  $$("[data-rank]").forEach(b=>b.onclick=()=>openAnalysis(b.dataset.rank));
}
function renderAssets(){
  const grid=$("#assetGrid"); grid.innerHTML="";
  state.assets.forEach(sym=>{
    const d=state.market[sym];
    const card=document.createElement("article");card.className="asset-card";
    card.innerHTML=d?`
      <div class="asset-top">
        <div class="symbol-wrap"><div class="coin-badge">${sym.slice(0,2)}</div><div><h3>${sym}</h3><span class="pair">${sym}</span></div></div>
        <div class="score-ring" style="--score:${Math.max(d.longScore,d.shortScore)}"><span>${Math.max(d.longScore,d.shortScore)}</span></div>
      </div>
      <div class="price">${money(d.price)}</div>
      <div class="change ${d.change>=0?"pos":"neg"}">${d.change>=0?"+":""}${fmt(d.change)}% · 24h</div>
      <div class="dual-scores"><div class="mini-score"><span>Long</span><strong>${d.longScore}/100</strong></div><div class="mini-score"><span>Short</span><strong>${d.shortScore}/100</strong></div></div>
      <div class="card-actions"><span class="tag">${d.longScore>=d.shortScore?"Sesgo Long":"Sesgo Short"}</span><button class="remove-btn" data-remove="${sym}" aria-label="Eliminar">×</button></div>
    `:`
      <div class="asset-top"><div class="symbol-wrap"><div class="coin-badge">${sym.slice(0,2)}</div><div><h3>${sym}</h3><span class="pair">${sym}</span></div></div></div>
      <div class="price">Cargando…</div>`;
    card.addEventListener("click",e=>{if(!e.target.dataset.remove) openAnalysis(sym)});
    grid.appendChild(card);
  });
  $$("[data-remove]").forEach(b=>b.addEventListener("click",e=>{e.stopPropagation();removeAsset(b.dataset.remove)}));
}
async function refreshAll(){
  $("#refreshAllBtn").classList.add("loading");
  renderAssets();
  let ok=0;
  for(const sym of state.assets){
    try{
      const [c1d,c4h]=await Promise.all([getCandles(sym,"1d",260),getCandles(sym,"4h",500)]);
      const t={lastPrice:c1d.at(-1).c,priceChangePercent:c1d.length>1?(c1d.at(-1).c/c1d.at(-2).c-1)*100:0};
      const daily=analyze(c1d),entry4h=analyze(c4h);
      state.market[sym]={daily,entry4h,timeframes:{"1d":daily,"4h":entry4h},price:+t.lastPrice,change:+t.priceChangePercent,
        longScore:daily.longScore,shortScore:daily.shortScore,longDecision:daily.longDecision,shortDecision:daily.shortDecision};
      ok++;
      renderAssets();renderRanking();renderHome();
    }catch(e){console.warn(sym,e)}
  }
  const mode=$("#marketModeSelect")?.value||"long";
  const scores=Object.values(state.market).map(x=>activeScore(x,mode));
  const avg=scores.length?Math.round(scores.reduce((a,b)=>a+b,0)/scores.length):0;
  $("#marketSummary").textContent=ok?`${ok} activos analizados · score ${mode==="long"?"Long":"Short"} medio ${avg}/100`:"No fue posible conectar con datos públicos";
  renderRanking();renderHome();
  $("#lastUpdate").textContent=new Date().toLocaleTimeString("es-MX",{hour:"2-digit",minute:"2-digit"});
  $("#refreshAllBtn").classList.remove("loading");
}
async function openAnalysis(sym){
  state.selected=sym;showView("analysisView");$("#analysisTitle").textContent=sym+"";await refreshAnalysis();
}
async function refreshAnalysis(){
  if(!state.selected)return;
  $("#analysisView").classList.add("loading");
  try{
    const interval=$("#timeframeSelect").value;
    const candles=await getCandles(state.selected,interval,500);
    const a=analyze(candles);state.analysis={candles,...a};
    const mode=$("#analysisModeSelect").value,score=activeScore(a,mode),decision=activeDecision(a,mode);
    $("#mainScore").textContent=score+"/100";
    $("#mainDecision").textContent=decision;$("#mainDecision").className="decision "+scoreClass(score);
    $("#analysisPrice").textContent=money(a.price);
    $("#analysisChange").textContent=`Última vela: ${a.change>=0?"+":""}${fmt(a.change)}%`;
    $("#chartCaption").textContent=`${state.selected} · ${interval} · ${candles.length} velas`;
    renderDiagnostic(a);renderTrafficLight(a,mode);renderScoreBreakdown(a,mode);drawPriceChart(candles,a);
  }catch(e){$("#plainExplanation").textContent="No se pudieron descargar los datos. Revisa la conexión e intenta de nuevo."}
  $("#analysisView").classList.remove("loading");
}
function metricInterpretation(type,a,mode){
  const long=mode==="long";
  if(type==="trend"){
    const status=a.trend==="Alcista"?"Alcista":a.trend==="Bajista"?"Bajista":"Mixta";
    const tone=(long&&a.trend==="Alcista")||(!long&&a.trend==="Bajista")?"good":a.trend==="Mixta"?"warn":"bad";
    return {status,tone,min:0,max:2,pos:a.trend==="Bajista"?0:a.trend==="Mixta"?1:2,labels:["Bajista","Mixta","Alcista"],
      meaning:"Resume la dirección usando el precio y las medias EMA20, EMA50 y EMA200.",
      current:long?`Para Long, una tendencia ${a.trend.toLowerCase()} ${a.trend==="Alcista"?"ayuda":"no ayuda"}.`:`Para Short, una tendencia ${a.trend.toLowerCase()} ${a.trend==="Bajista"?"ayuda":"no ayuda"}.`,
      guide:"Alcista: buscar compras. Mixta: esperar. Bajista: favorece shorts."};
  }
  if(type==="rsi"){
    const v=a.rsi; let status,tone;
    if(v<30){status="Sobreventa";tone=long?"warn":"bad"} else if(v<45){status="Impulso débil";tone=long?"warn":"good"} else if(v<=65){status="Zona equilibrada";tone="good"} else if(v<=70){status="Impulso alto";tone="warn"} else {status="Sobrecompra";tone=long?"bad":"warn"}
    return {status,tone,min:0,max:100,pos:v,labels:["0","30","50","70","100"],
      meaning:"Mide la velocidad del movimiento. No indica por sí solo que debas comprar o vender.",
      current:`RSI ${fmt(v,1)}: ${status.toLowerCase()}.`,
      guide:"0–30: sobreventa · 45–65: zona saludable · 70–100: sobrecompra."};
  }
  if(type==="adx"){
    const v=a.adx; const status=v<20?"Muy poca fuerza":v<25?"Fuerza naciente":v<40?"Tendencia fuerte":"Tendencia muy fuerte";
    const tone=v<20?"bad":v<25?"warn":"good";
    return {status,tone,min:0,max:60,pos:Math.min(v,60),labels:["0","20","25","40","60+"],
      meaning:"Mide la fuerza de la tendencia, no si va hacia arriba o hacia abajo.",
      current:`ADX ${fmt(v,1)}: ${status.toLowerCase()}.`,
      guide:"Menos de 20: lateral · 20–25: empieza · 25–40: fuerte · más de 40: muy fuerte."};
  }
  if(type==="atr"){
    const v=a.atrPct; const status=v<1?"Movimiento bajo":v<=3?"Movimiento moderado":v<=6?"Movimiento alto":"Movimiento extremo";
    const tone=v<=3?"good":v<=6?"warn":"bad";
    return {status,tone,min:0,max:10,pos:Math.min(v,10),labels:["0%","1%","3%","6%","10%+"],
      meaning:"Es como el medidor de movimiento del mercado: estima cuánto recorre una vela en promedio.",
      current:`ATR ${fmt(v,2)}%: una vela suele recorrer cerca de ese porcentaje.`,
      guide:"Sirve para no colocar un stop más pequeño que el movimiento normal del activo."};
  }
  if(type==="volume"){
    const v=a.volumeRatio; const status=v<.5?"Muy bajo":v<.9?"Bajo":v<1.2?"Normal":v<2?"Alto":"Extraordinario";
    const tone=v<.5?"bad":v<.9?"warn":v<2?"good":"warn";
    return {status,tone,min:0,max:3,pos:Math.min(v,3),labels:["0x","0.5x","1x","2x","3x+"],
      meaning:"Compara el volumen de la última vela cerrada contra el promedio de las últimas 20.",
      current:`Volumen ${fmt(v,2)}x: ${status.toLowerCase()}.`,
      guide:"1x es normal · 2x es el doble de actividad · menos de 0.5x muestra poco interés."};
  }
  if(type==="support") return {status:"Zona inferior",tone:"neutral",meaning:"Es el precio más bajo observado en las últimas 20 velas cerradas.",current:`Soporte aproximado: ${money(a.support)}.`,guide:"No es una pared exacta; es una zona donde antes apareció demanda."};
  return {status:"Zona superior",tone:"neutral",meaning:"Es el precio más alto observado en las últimas 20 velas cerradas.",current:`Resistencia aproximada: ${money(a.resistance)}.`,guide:"No es una pared exacta; es una zona donde antes apareció oferta."};
}
function metricCard(type,label,value,a,mode){
  const x=metricInterpretation(type,a,mode);
  const gauge=x.pos!==undefined?`<div class="meter"><div class="meter-fill ${x.tone}" style="width:${clamp((x.pos-x.min)/(x.max-x.min)*100,0,100)}%"></div><span class="meter-marker" style="left:${clamp((x.pos-x.min)/(x.max-x.min)*100,0,100)}%"></span></div><div class="meter-labels">${x.labels.map(l=>`<span>${l}</span>`).join("")}</div>`:"";
  return `<button class="diag metric-help" type="button" aria-expanded="false">
    <span class="metric-title">${label}<b class="help-symbol">?</b></span><strong>${value}</strong><em class="metric-status ${x.tone}">${x.status}</em>
    <div class="metric-detail">${gauge}<p><b>Qué mide:</b> ${x.meaning}</p><p><b>Tu lectura:</b> ${x.current}</p><p><b>Guía rápida:</b> ${x.guide}</p></div>
  </button>`;
}
function renderDiagnostic(a){
  const mode=$("#analysisModeSelect").value;
  const metrics=[
    ["trend","Tendencia",a.trend],["rsi","RSI 14",fmt(a.rsi,1)],["adx","ADX 14",fmt(a.adx,1)],
    ["atr","ATR / precio",fmt(a.atrPct,2)+"%"],["volume","Volumen / promedio",fmt(a.volumeRatio,2)+"x"],
    ["support","Soporte 20 velas",money(a.support)],["resistance","Resistencia 20 velas",money(a.resistance)]
  ];
  $("#diagnosticGrid").innerHTML=metrics.map(m=>metricCard(...m,a,mode)).join("");
  $$(".metric-help").forEach(card=>card.addEventListener("click",()=>{
    const open=card.classList.toggle("open");card.setAttribute("aria-expanded",open?"true":"false");
  }));
  let txt;
  if(mode==="long"){
    txt=`Lectura Long: tendencia ${a.trend.toLowerCase()}, ADX ${fmt(a.adx,1)} y RSI ${fmt(a.rsi,1)}. `;
    txt+=a.rsi>70?"Está sobrecomprado; no conviene perseguirlo. ":a.rsi>=50?"El momentum acompaña la compra. ":"El momentum comprador es débil. ";
    txt+=a.volumeRatio>1?"El volumen confirma mejor. ":"El volumen aún no confirma. ";
    txt+=`Resultado: ${a.longDecision.toLowerCase()}.`;
  }else{
    txt=`Lectura Short: busca debilidad bajista, no una compra barata. Tendencia ${a.trend.toLowerCase()}, ADX ${fmt(a.adx,1)} y RSI ${fmt(a.rsi,1)}. `;
    txt+=a.rsi<30?"Ya está sobrevendido; abrir short tarde aumenta el riesgo de rebote. ":a.rsi<50?"El momentum favorece presión bajista. ":"El momentum todavía no confirma caída. ";
    txt+=a.volumeRatio>1?"El volumen confirma mejor. ":"El volumen aún no confirma. ";
    txt+=`Resultado: ${a.shortDecision.toLowerCase()}.`;
  }
  $("#plainExplanation").textContent=txt;
}
function drawLineChart(canvas, series, labels=[]){
  const ctx=canvas.getContext("2d"),W=canvas.width,H=canvas.height,p={l:54,r:18,t:20,b:36};
  ctx.clearRect(0,0,W,H);ctx.fillStyle="#0b1726";ctx.fillRect(0,0,W,H);
  const vals=series.flatMap(s=>s.values.filter(Number.isFinite)),min=Math.min(...vals),max=Math.max(...vals),range=max-min||1;
  ctx.strokeStyle="#1f3148";ctx.lineWidth=1;
  for(let j=0;j<5;j++){const y=p.t+j*(H-p.t-p.b)/4;ctx.beginPath();ctx.moveTo(p.l,y);ctx.lineTo(W-p.r,y);ctx.stroke();
    ctx.fillStyle="#7186a0";ctx.font="12px system-ui";ctx.fillText(fmt(max-j*range/4,2),5,y+4)}
  const cols=["#edf4ff","#5ee1b7","#73a7ff","#f6c86b"];
  series.forEach((s,si)=>{ctx.strokeStyle=cols[si%cols.length];ctx.lineWidth=si===0?2.4:1.6;ctx.beginPath();
    s.values.forEach((v,i)=>{if(!Number.isFinite(v))return;const x=p.l+i*(W-p.l-p.r)/(s.values.length-1),y=p.t+(max-v)/range*(H-p.t-p.b);i===0?ctx.moveTo(x,y):ctx.lineTo(x,y)});ctx.stroke()});
}
function drawPriceChart(c,a){
  const n=Math.min(120,c.length),slice=c.slice(-n);
  drawLineChart($("#priceChart"),[
    {values:slice.map(x=>x.c)},{values:a.e20.slice(-n)},{values:a.e50.slice(-n)}
  ]);
}
function removeAsset(sym){
  if(state.assets.length<=1)return alert("Debe quedar al menos un activo.");
  state.assets=state.assets.filter(x=>x!==sym);delete state.market[sym];
  localStorage.setItem("markets_quant_assets",JSON.stringify(state.assets));renderAssets();fillAssetSelects();
}
function fillAssetSelects(){
  const opts=state.assets.map(s=>`<option value="${s}">${s}</option>`).join("");
  $("#btSymbol").innerHTML=opts;
  if($("#paperSymbol")) $("#paperSymbol").innerHTML=opts;
}
$("#addAssetBtn").onclick=()=>{$("#newAssetInput").value="";$("#assetDialogError").textContent="";$("#assetDialog").showModal()};
$("#confirmAddAsset").onclick=async e=>{
  e.preventDefault();const sym=$("#newAssetInput").value.trim().toUpperCase();
  if(!/^[A-Z0-9]{2,10}$/.test(sym)){return $("#assetDialogError").textContent="Símbolo no válido."}
  if(state.assets.includes(sym)){return $("#assetDialogError").textContent="Ya está en favoritos."}
  try{await getTicker(sym);state.assets.push(sym);localStorage.setItem("markets_quant_assets",JSON.stringify(state.assets));$("#assetDialog").close();refreshAll()}
  catch{$("#assetDialogError").textContent="No encontré datos para ese símbolo en Twelve Data."}
};

function entrySignal(preset,i,c,ind){
  if(i<210)return false;
  const price=c[i].c,prev=c[i-1].c;
  if(preset==="trend") return ind.e20[i]>ind.e50[i]&&ind.e50[i]>ind.e200[i]&&ind.rs[i]>=50&&ind.rs[i]<=68;
  if(preset==="pullback") return price>ind.e200[i]&&prev<ind.e20[i-1]&&price>ind.e20[i];
  if(preset==="breakout"){
    const max20=Math.max(...c.slice(i-20,i).map(x=>x.h)),vavg=ind.v20[i];
    return price>max20&&vavg&&c[i].v>vavg*1.2;
  }
  return false;
}
async function runBacktest(){
  const btn=$("#runBacktestBtn");btn.classList.add("loading");btn.textContent="Calculando…";
  try{
    const sym=$("#btSymbol").value,int=$("#btInterval").value,mode=$("#btPreset").value;
    const stop=+$("#btStop").value/100,target=+$("#btTarget").value/100,fee=+$("#btFee").value/100,risk=+$("#btRisk").value/100;
    const initial=+$("#btCapital").value,threshold=+$("#btScoreThreshold")?.value||85,direction=$("#btDirection")?.value||"auto";
    const c=await getCandles(sym,int,1000),cl=c.map(x=>x.c);
    const vols=c.map(x=>x.v),ind={closes:cl,vols,e20:ema(cl,20),e50:ema(cl,50),e200:ema(cl,200),rs:rsi(cl),v20:sma(vols,20),at:atr(c),ax:adx(c)};
    let equity=initial,peak=initial,maxDD=0,wins=0,losses=0,trades=[],curve=[initial],inPos=false,entry=0,size=0,entryI=0,side="long",entryScore=0;
    for(let i=210;i<c.length-1;i++){
      if(!inPos){
        let signal=false;
        if(mode==="score"){
          const sc=scoreAtIndex(c,i,ind); if(!sc)continue;
          const options=[];
          if(direction!=="short"&&sc.longScore>=threshold)options.push({side:"long",score:sc.longScore});
          if(direction!=="long"&&sc.shortScore>=threshold)options.push({side:"short",score:sc.shortScore});
          options.sort((a,b)=>b.score-a.score);
          if(options.length){side=options[0].side;entryScore=options[0].score;signal=true;}
        }else{
          signal=entrySignal(mode,i,c,ind);side="long";entryScore=0;
        }
        if(signal){entry=c[i].c;const riskCash=equity*risk;size=riskCash/(entry*stop);inPos=true;entryI=i;}
      }else{
        const stopP=side==="long"?entry*(1-stop):entry*(1+stop),targetP=side==="long"?entry*(1+target):entry*(1-target);let exit=null,reason="";
        const stopHit=side==="long"?c[i].l<=stopP:c[i].h>=stopP,targetHit=side==="long"?c[i].h>=targetP:c[i].l<=targetP;
        if(stopHit){exit=stopP;reason="stop"}else if(targetHit){exit=targetP;reason="target"}else if(i-entryI>=40){exit=c[i].c;reason="time"}
        if(exit){
          const gross=(side==="long"?(exit-entry):(entry-exit))*size,fees=(entry+exit)*size*fee,pnl=gross-fees;
          equity+=pnl;pnl>0?wins++:losses++;trades.push({pnl,reason,side,score:entryScore});curve.push(equity);peak=Math.max(peak,equity);maxDD=Math.max(maxDD,(peak-equity)/peak);inPos=false;
        }
      }
    }
    const n=trades.length,winRate=n?wins/n*100:0,total=(equity/initial-1)*100,avg=n?trades.reduce((sum,t)=>sum+t.pnl,0)/n:0;
    const grossWin=trades.filter(t=>t.pnl>0).reduce((sum,t)=>sum+t.pnl,0),grossLoss=Math.abs(trades.filter(t=>t.pnl<0).reduce((sum,t)=>sum+t.pnl,0)),pf=grossLoss?grossWin/grossLoss:(grossWin>0?99:0);
    const avgScore=n?trades.reduce((sum,t)=>sum+(t.score||0),0)/n:0,longs=trades.filter(t=>t.side==="long").length,shorts=trades.filter(t=>t.side==="short").length;
    const vals=[["Operaciones",n],["Ganadoras",fmt(winRate,1)+"%"],["Resultado",(total>=0?"+":"")+fmt(total,2)+"%"],["Capital final",money(equity)],["Profit factor",fmt(pf,2)],["Drawdown máximo",fmt(maxDD*100,2)+"%"],["Long / Short",`${longs} / ${shorts}`],["Score promedio",mode==="score"?fmt(avgScore,1):"—"]];
    $("#btResults").innerHTML=vals.map(([k,v])=>`<div class="result-card"><span>${k}</span><strong>${v}</strong></div>`).join("");
    $("#btResults").classList.remove("hidden");$("#btEquityWrap").classList.remove("hidden");drawLineChart($("#equityChart"),[{values:curve}]);
    const note=$("#btAutoSummary");if(note)note.innerHTML=n?`<strong>${sym} ${int}</strong> · ${mode==="score"?`motor Score ≥ ${threshold}`:"regla clásica"} · ${n} operaciones simuladas sobre el historial disponible de Twelve Data. ${total>0?"La combinación fue rentable en esta muestra.":"La combinación no fue rentable en esta muestra."}`:`No apareció ninguna entrada con estas reglas en el historial descargado.`;
  }catch(e){alert("No fue posible completar el backtest: "+e.message)}
  btn.classList.remove("loading");btn.textContent="Ejecutar simulaciones automáticas";
}
$("#runBacktestBtn").onclick=runBacktest;

$("#calcPositionBtn").onclick=()=>{
  const capital=+$("#posCapital").value,riskPct=+$("#posRisk").value/100,entry=+$("#posEntry").value,stop=+$("#posStop").value,target=+$("#posTarget").value;
  if(!(capital>0&&riskPct>0&&entry>0&&stop>0&&target>0)||stop>=entry||target<=entry)return alert("Revisa los datos: stop menor que entrada y objetivo mayor que entrada.");
  const riskCash=capital*riskPct,unitRisk=entry-stop,qty=riskCash/unitRisk,position=qty*entry,potential=(target-entry)*qty,rr=(target-entry)/(entry-stop);
  const vals=[["Riesgo máximo",money(riskCash)],["Cantidad de monedas",fmt(qty,8)],["Tamaño de posición",money(position)],["Pérdida en stop",money(riskCash)],["Ganancia potencial",money(potential)],["Riesgo / beneficio","1 : "+fmt(rr,2)]];
  $("#positionResults").innerHTML=vals.map(([k,v])=>`<div class="result-card"><span>${k}</span><strong>${v}</strong></div>`).join("");$("#positionResults").classList.remove("hidden");
};


function savePaperState(){localStorage.setItem("markets_quant_paper_trades",JSON.stringify(state.paperTrades))}
function paperLevels(entry,side,stopMode,stopValue,targetMode,targetValue){
  const stop=stopMode==="percent"?(side==="long"?entry*(1-stopValue/100):entry*(1+stopValue/100)):stopValue;
  const target=targetMode==="percent"?(side==="long"?entry*(1+targetValue/100):entry*(1-targetValue/100)):targetValue;
  return {stop,target};
}
async function previewPaper(){
  const sym=$("#paperSymbol").value,side=$("#paperSide").value,int=$("#paperInterval").value;
  try{
    const candles=await getCandles(sym,int,500),a=analyze(candles),entry=+$("#paperEntry").value||a.price;
    if(!$("#paperEntry").value) $("#paperEntry").value=entry;
    const lv=paperLevels(entry,side,$("#paperStopMode").value,+$("#paperStop").value,$("#paperTargetMode").value,+$("#paperTarget").value);
    const pending=state.pendingPaperSignal;
    const usePending=pending&&pending.symbol===sym&&pending.side===side&&pending.interval===int;
    const score=usePending?pending.score:(side==="long"?a.longScore:a.shortScore);
    const riskDist=Math.abs(entry-lv.stop),rewardDist=Math.abs(lv.target-entry),rr=riskDist?rewardDist/riskDist:0;
    const capital=+$("#paperCapital").value||0,riskPct=+$("#paperRiskPct").value||0,riskCash=capital*riskPct/100,qty=riskDist?riskCash/riskDist:0,potential=qty*rewardDist;
    const warning=rr<3?`<div class="trade-warning">⛔ Relación 1:${fmt(rr,2)}. No se puede guardar: tu mínimo es 1:3.</div>`:`<div class="trade-ok">✓ Relación 1:${fmt(rr,2)} cumple tu regla mínima.</div>`;
    const quality=scoreQualityLabel(score,rr);
    $("#paperPreview").innerHTML=`<div class="trade-quality ${score>=85&&rr>=3?"quality-good":score>=70?"quality-warn":"quality-bad"}"><span>CALIDAD</span><strong>${quality.grade}</strong><small>${quality.label}</small></div><div class="preview-main">Entrada <strong>${money(entry)}</strong> · Stop <strong>${money(lv.stop)}</strong> · Objetivo <strong>${money(lv.target)}</strong> · Score ${side.toUpperCase()} <strong>${score}/100</strong></div><div class="preview-metrics"><span>Riesgo: <strong>${money(riskCash)}</strong></span><span>Cantidad: <strong>${fmt(qty,8)}</strong></span><span>Ganancia potencial: <strong>${money(potential)}</strong></span></div>${warning}`;
  }catch(e){$("#paperPreview").textContent="No se pudo preparar la prueba. Revisa la conexión."}
}
async function createPaperTrade(){
  const sym=$("#paperSymbol").value,side=$("#paperSide").value,int=$("#paperInterval").value;
  const candles=await getCandles(sym,int,500),a=analyze(candles),entry=+$("#paperEntry").value||a.price;
  const sv=+$("#paperStop").value,tv=+$("#paperTarget").value;
  if(!(entry>0&&sv>0&&tv>0)) return alert("Revisa entrada, stop y objetivo.");
  const lv=paperLevels(entry,side,$("#paperStopMode").value,sv,$("#paperTargetMode").value,tv);
  if(side==="long"&&!(lv.stop<entry&&lv.target>entry)) return alert("En Long, el stop debe quedar debajo y el objetivo arriba de la entrada.");
  if(side==="short"&&!(lv.stop>entry&&lv.target<entry)) return alert("En Short, el stop debe quedar arriba y el objetivo debajo de la entrada.");
  const now=Date.now(),pending=state.pendingPaperSignal;
  const usePending=pending&&pending.symbol===sym&&pending.side===side&&pending.interval===int;
  const score=usePending?pending.score:(side==="long"?a.longScore:a.shortScore);
  const riskDist=Math.abs(entry-lv.stop),rewardDist=Math.abs(lv.target-entry),rr=riskDist?rewardDist/riskDist:0;
  const capital=+$("#paperCapital").value||0,riskPct=+$("#paperRiskPct").value||0,riskCash=capital*riskPct/100,qty=riskDist?riskCash/riskDist:0,potentialProfit=qty*rewardDist;
  if(rr<3) return alert(`Esta operación tiene R/B 1:${fmt(rr,2)}. Tu regla mínima es 1:3; ajusta el stop o el objetivo antes de guardarla.`);
  const checklist={trend:$("#checkTrend").checked,signal:$("#checkSignal").checked,risk:$("#checkRisk").checked,noImpulse:$("#checkNoImpulse").checked};
  const completed=Object.values(checklist).filter(Boolean).length;
  if(completed<3&&!confirm(`Solo completaste ${completed} de 4 controles. ¿Guardar de todos modos?`)) return;
  state.paperTrades.unshift({id:now,symbol:sym,side,interval:int,entry,stop:lv.stop,target:lv.target,openedAt:now,status:"open",current:entry,score,capital,riskPct,riskCash,qty,potentialProfit,rr,checklist,
    scoreType:usePending&&pending.combo?"1D+4H":"timeframe",scoreDaily:usePending&&pending.combo?pending.combo.dailyScore:null,score4h:usePending&&pending.combo?pending.combo.entryScore:null,
    snapshot:usePending?pending.snapshot:{longScore:a.longScore,shortScore:a.shortScore,rsi:a.rsi,adx:a.adx,atrPct:a.atrPct,volumeRatio:a.volumeRatio,trend:a.trend,ema20:a.e20.at(-1),ema50:a.e50.at(-1),ema200:a.e200.at(-1)},
    notes:$("#paperNotes").value.trim(),closedAt:null,exit:null,resultPct:null});
  savePaperState();state.pendingPaperSignal=null;$("#paperNotes").value="";["checkTrend","checkSignal","checkRisk","checkNoImpulse"].forEach(id=>$("#"+id).checked=false);renderPaperTrades();alert("Prueba guardada. La app seguirá su resultado.");
}
function favorableRFromPrice(t,price){
  const risk=Math.abs(t.entry-t.stop); if(!(risk>0&&price>0)) return 0;
  const move=t.side==="long"?price-t.entry:t.entry-price;
  return Math.max(0,move/risk);
}
function updateTradeMFE(t,candle){
  const favorablePrice=t.side==="long"?candle.h:candle.l;
  const r=favorableRFromPrice(t,favorablePrice);
  if(r>(t.mfeR||0)){t.mfeR=r;t.mfePrice=favorablePrice;t.mfeAt=candle.t;}
}
async function backfillPaperMFE(){
  const missing=state.paperTrades.filter(t=>t.status!=="open"&&t.closedAt&&!(t.mfeR>=0));
  for(const t of missing){
    try{
      const all=await getCandles(t.symbol,t.interval,800);
      const candles=all.filter(c=>c.t>=t.openedAt&&c.t<=t.closedAt);
      t.mfeR=0;t.mfePrice=t.entry;
      for(const c of candles){
        // En la vela del stop no conocemos el orden intravela. No contamos su extremo favorable
        // si el stop fue tocado, para no inflar artificialmente el MFE histórico.
        const stopHit=t.side==="long"?c.l<=t.stop:c.h>=t.stop;
        if(stopHit && t.status==="loss") break;
        updateTradeMFE(t,c);
        if(c.t>=t.closedAt) break;
      }
    }catch(e){console.warn("mfe backfill",t.symbol,e)}
  }
  if(missing.length) savePaperState();
}
let paperTradeUpdateRunning=false;
const PAPER_TRADE_CONCURRENCY=2;
const paperMonitor={lastRun:null,lastDuration:0,checked:0,closed:0,errors:0,totalOpen:0,lastError:"",nextRun:null};

function renderPaperMonitor(){
  const box=$("#paperMonitor"); if(!box) return;
  const active=state.paperTrades.some(t=>t.status==="open");
  const now=Date.now();
  const next=paperMonitor.nextRun?Math.max(0,Math.ceil((paperMonitor.nextRun-now)/1000)):null;
  const stamp=paperMonitor.lastRun?new Date(paperMonitor.lastRun).toLocaleTimeString("es-MX",{hour:"2-digit",minute:"2-digit",second:"2-digit"}):"Aún no revisa";
  let stateClass="ok", stateLabel=paperTradeUpdateRunning?"Revisando…":active?"Seguimiento automático activo":"Sin posiciones abiertas";
  if(paperMonitor.errors>0){stateClass="warn";stateLabel="Seguimiento con errores"}
  box.className=`paper-monitor ${stateClass}`;
  box.innerHTML=`<div class="paper-monitor-head"><div><span class="monitor-dot"></span><strong>${stateLabel}</strong></div><button id="paperCheckNowBtn" class="secondary compact-btn" ${paperTradeUpdateRunning?"disabled":""}>Revisar ahora</button></div>
  <div class="paper-monitor-grid"><span>Última revisión<strong>${stamp}</strong></span><span>Abiertas al iniciar<strong>${paperMonitor.totalOpen}</strong></span><span>Revisadas<strong>${paperMonitor.checked}</strong></span><span>Cerradas<strong>${paperMonitor.closed}</strong></span><span>Errores<strong>${paperMonitor.errors}</strong></span><span>Próxima revisión<strong>${active?(paperTradeUpdateRunning?"al terminar":next===null?"según temporalidad":`~${next} s`):"—"}</strong></span></div>
  ${paperMonitor.lastError?`<div class="paper-monitor-error">Último error: ${String(paperMonitor.lastError).replace(/</g,"&lt;")}</div>`:""}`;
  const btn=$("#paperCheckNowBtn"); if(btn) btn.onclick=()=>updatePaperTrades(true);
}

async function checkOnePaperTrade(t){
  const before=t.status;
  try{
    const all=await getCandles(t.symbol,t.interval,800);
    const candles=all.filter(c=>c.t>=t.openedAt);
    if(!candles.length) return {ok:false,closed:false,error:"Sin velas devueltas"};
    t.current=candles.at(-1).c;
    for(const c of candles){
      const stopHit=t.side==="long"?c.l<=t.stop:c.h>=t.stop;
      const targetHit=t.side==="long"?c.h>=t.target:c.l<=t.target;
      if(!stopHit) updateTradeMFE(t,c);
      // Si stop y objetivo aparecen en la misma vela no conocemos el orden intravela:
      // mantenemos el criterio conservador de la versión anterior y contamos stop.
      if(stopHit&&targetHit){t.status="loss";t.exit=t.stop;t.closedAt=c.t;break}
      if(stopHit){t.status="loss";t.exit=t.stop;t.closedAt=c.t;break}
      if(targetHit){updateTradeMFE(t,c);t.status="win";t.exit=t.target;t.closedAt=c.t;break}
    }
    if(t.status!=="open") t.resultPct=(t.side==="long"?(t.exit/t.entry-1):(t.entry/t.exit-1))*100;
    t.lastCheckedAt=Date.now();
    return {ok:true,closed:before==="open"&&t.status!=="open"};
  }catch(e){
    console.warn("paper",t.symbol,e);
    return {ok:false,closed:false,error:`${t.symbol}: ${e?.message||e}`};
  }
}

async function updatePaperTrades(manual=false){
  // Evita dos rondas simultáneas. El finally garantiza liberar el bloqueo aun si algo falla.
  if(paperTradeUpdateRunning){renderPaperMonitor();return}
  paperTradeUpdateRunning=true;
  const started=Date.now();
  paperMonitor.lastError="";
  renderPaperMonitor();
  try{
    const allOpen=state.paperTrades.filter(t=>t.status==="open");
    const due=manual?allOpen:allOpen.filter(t=>Date.now()-(t.lastCheckedAt||0)>=paperCadenceMs(t.interval));
    const open=due;
    paperMonitor.totalOpen=allOpen.length; paperMonitor.checked=0; paperMonitor.closed=0; paperMonitor.errors=0;
    // Procesa hasta 6 posiciones a la vez para que una operación lenta no retrase a todas.
    for(let i=0;i<open.length;i+=PAPER_TRADE_CONCURRENCY){
      const batch=open.slice(i,i+PAPER_TRADE_CONCURRENCY);
      const results=await Promise.all(batch.map(checkOnePaperTrade));
      for(const r of results){
        if(r?.ok) paperMonitor.checked++;
        else {paperMonitor.errors++; if(r?.error) paperMonitor.lastError=r.error}
        if(r?.closed) paperMonitor.closed++;
      }
      renderPaperMonitor();
    }
    savePaperState();
    renderPaperTrades();
  }catch(e){
    console.warn("paper update round",e);
    paperMonitor.errors++; paperMonitor.lastError=e?.message||String(e);
  }finally{
    paperMonitor.lastRun=Date.now(); paperMonitor.lastDuration=paperMonitor.lastRun-started;
    paperMonitor.nextRun=paperMonitor.lastRun+PAPER_TRADE_CHECK_MS;
    paperTradeUpdateRunning=false;
    renderPaperMonitor();
  }
}

// Markets v1.1: cada operación se revisa según su temporalidad.
// Al regresar a la app se reconstruye lo ocurrido con las velas desde openedAt.
function paperCadenceMs(interval){
  return ({"15m":5*60e3,"1h":15*60e3,"4h":60*60e3,"1d":4*60*60e3,"1w":12*60*60e3})[interval]||15*60e3;
}
const PAPER_TRADE_CHECK_MS=60*1000; // sólo despierta el monitor; consulta únicamente trades vencidos
paperMonitor.nextRun=Date.now()+PAPER_TRADE_CHECK_MS;
setInterval(renderPaperMonitor,1000);
setInterval(()=>{
  if(document.visibilityState==="visible" && state.paperTrades.some(t=>t.status==="open")){
    updatePaperTrades();
  }
},PAPER_TRADE_CHECK_MS);
document.addEventListener("visibilitychange",()=>{
  if(document.visibilityState==="visible" && state.paperTrades.some(t=>t.status==="open")) updatePaperTrades();
});
window.addEventListener("focus",()=>{
  if(state.paperTrades.some(t=>t.status==="open")) updatePaperTrades();
});
function closePaperManual(id){
  const t=state.paperTrades.find(x=>x.id===id);if(!t)return;
  const value=prompt("Precio de cierre manual",t.current||t.entry);if(value===null)return;
  const exit=+value;if(!(exit>0))return alert("Precio inválido.");
  t.status="manual";t.exit=exit;t.closedAt=Date.now();t.resultPct=(t.side==="long"?(exit/t.entry-1):(t.entry/exit-1))*100;savePaperState();renderPaperTrades();
}
function deletePaper(id){if(confirm("¿Eliminar esta prueba del diario?")){state.paperTrades=state.paperTrades.filter(x=>x.id!==id);savePaperState();renderPaperTrades()}}
function tradeCard(t){
  const status={open:"Abierta",win:"Ganada",loss:"Perdida",manual:"Cierre manual"}[t.status];
  const cls={open:"status-open",win:"status-win",loss:"status-loss",manual:"status-manual"}[t.status];
  const current=t.status==="open"?(t.current||t.entry):t.exit;
  const running=(t.side==="long"?(current/t.entry-1):(t.entry/current-1))*100;
  const pnlCash=(t.side==="long"?(current-t.entry):(t.entry-current))*(t.qty||0);
  const checklistDone=t.checklist?Object.values(t.checklist).filter(Boolean).length:0;
  return `<article class="paper-trade"><div class="paper-head"><div><h3>${t.symbol} · ${t.side.toUpperCase()}</h3><div class="paper-meta">${t.interval} · ${new Date(t.openedAt).toLocaleString("es-MX")}</div></div><strong class="${cls}">${status}</strong></div>
  <div class="paper-levels"><div class="paper-level"><span>Entrada</span><strong>${money(t.entry)}</strong></div><div class="paper-level"><span>Stop</span><strong>${money(t.stop)}</strong></div><div class="paper-level"><span>Objetivo</span><strong>${money(t.target)}</strong></div><div class="paper-level"><span>${t.status==="open"?"Precio actual":"Salida"}</span><strong>${money(current)}</strong></div><div class="paper-level"><span>Resultado</span><strong class="${running>=0?"status-win":"status-loss"}">${running>=0?"+":""}${fmt(running,2)}%</strong></div><div class="paper-level"><span>Resultado $</span><strong class="${pnlCash>=0?"status-win":"status-loss"}">${pnlCash>=0?"+":""}${money(pnlCash)}</strong></div><div class="paper-level"><span>R/B inicial</span><strong>1 : ${fmt(t.rr||Math.abs(t.target-t.entry)/Math.abs(t.entry-t.stop),2)}</strong></div><div class="paper-level"><span>Máx. avance (MFE)</span><strong>${t.mfeR>=0?"+"+fmt(t.mfeR,2)+"R":"Calculando…"}</strong></div><div class="paper-level"><span>Riesgo planeado</span><strong>${money(t.riskCash||0)} (${fmt(t.riskPct||0,1)}%)</strong></div><div class="paper-level"><span>Ganancia potencial</span><strong>${money(t.potentialProfit||0)}</strong></div><div class="paper-level"><span>Score inicial</span><strong>${t.score}/100${t.scoreType==="1D+4H"?` · combinado (1D ${t.scoreDaily} / 4H ${t.score4h})`:""}</strong></div></div>
  <div class="paper-snapshot"><span class="tag">Control ${checklistDone}/4</span><span class="tag">RSI ${fmt(t.snapshot.rsi,1)}</span><span class="tag">ADX ${fmt(t.snapshot.adx,1)}</span><span class="tag">ATR ${fmt(t.snapshot.atrPct,2)}%</span><span class="tag">Vol ${fmt(t.snapshot.volumeRatio,2)}x</span><span class="tag">${t.snapshot.trend}</span></div>
  ${t.notes?`<p class="paper-note">${t.notes.replace(/</g,"&lt;")}</p>`:""}<div class="paper-actions">${t.status==="open"?`<button class="ghost" data-close-paper="${t.id}">Cerrar manual</button>`:"<span></span>"}<button class="danger" data-delete-paper="${t.id}">Eliminar</button></div></article>`;
}


function renderPaperTrades(){
  const openCountEl=$("#paperOpenCount");
  const openList=$("#paperOpenList"), closedList=$("#paperClosedList");
  if(!openList||!closedList)return;

  const open=state.paperTrades.filter(t=>t.status==="open");
  const closed=state.paperTrades.filter(t=>t.status!=="open");
  if(openCountEl) openCountEl.textContent=open.length;

  const frames=["15m","1h","4h","1d","1w"];
  const frameLabel={"15m":"15 min","1h":"1 hora","4h":"4 horas","1d":"1 día","1w":"1 semana"};

  const sideGroup=(rows,side)=>{
    const filtered=rows.filter(t=>(t.side||"").toLowerCase()===side);
    const label=side==="long"?"LONG":"SHORT";
    return `<details class="paper-side-group" ${filtered.length ? "open" : ""}>
      <summary>
        <span class="paper-side-title ${side}">${label}</span>
        <span class="paper-side-count">${filtered.length} ${filtered.length===1?"operación":"operaciones"}</span>
      </summary>
      <div class="paper-side-body">
        ${filtered.length ? filtered.map(tradeCard).join("") : `<div class="notice compact-notice">No hay operaciones ${label}.</div>`}
      </div>
    </details>`;
  };

  const timeframeGroup=(tf)=>{
    const rows=open.filter(t=>(t.interval||"4h").toLowerCase()===tf);
    return `<details class="paper-tf-group">
      <summary class="paper-tf-summary">
        <span class="paper-tf-title">${frameLabel[tf]}</span>
        <span class="paper-tf-count">${rows.length} ${rows.length===1?"operación":"operaciones"}</span>
      </summary>
      <div class="paper-tf-body">
        ${sideGroup(rows,"long")}
        ${sideGroup(rows,"short")}
      </div>
    </details>`;
  };

  const standard=frames.map(timeframeGroup).join("");
  const otherRows=open.filter(t=>!frames.includes((t.interval||"").toLowerCase()));
  const other=otherRows.length?`<details class="paper-tf-group">
    <summary class="paper-tf-summary">
      <span class="paper-tf-title">Otras temporalidades</span>
      <span class="paper-tf-count">${otherRows.length} operaciones</span>
    </summary>
    <div class="paper-tf-body">${sideGroup(otherRows,"long")}${sideGroup(otherRows,"short")}</div>
  </details>`:"";

  openList.innerHTML=standard+other;

  const filter=$("#paperFilter")?.value||"all";
  const visible=closed.filter(t=>filter==="all"||(filter==="wins"&&(t.resultPct||0)>0)||(filter==="losses"&&(t.resultPct||0)<0)||filter===t.side);

  const won=visible.filter(t=>t.status==="win"||(t.resultPct||0)>0);
  const lost=visible.filter(t=>t.status==="loss"||(t.resultPct||0)<0);
  const neutral=visible.filter(t=>!won.includes(t)&&!lost.includes(t));

  const closedGroup=(label,rows,kind)=>`<details class="paper-closed-group">
    <summary>
      <span class="paper-closed-title ${kind}">${label}</span>
      <span class="paper-closed-count">${rows.length} ${rows.length===1?"operación":"operaciones"}</span>
    </summary>
    <div class="paper-closed-body">
      ${rows.length?rows.slice().reverse().map(tradeCard).join(""):`<div class="notice compact-notice">No hay operaciones ${label.toLowerCase()}.</div>`}
    </div>
  </details>`;

  closedList.innerHTML=visible.length
    ? closedGroup("GANADAS",won,"won")+closedGroup("PERDIDAS",lost,"lost")+(neutral.length?closedGroup("OTRAS",neutral,"other"):"")
    : '<div class="notice">No hay operaciones que coincidan con este filtro.</div>';

  const wins=closed.filter(t=>t.status==="win"||t.resultPct>0).length;
  const losses=closed.filter(t=>t.status==="loss"||t.resultPct<0).length;
  const rate=closed.length?wins/closed.length*100:0;
  const avg=closed.length?closed.reduce((sum,t)=>sum+(t.resultPct||0),0)/closed.length:0;
  const totalPct=closed.reduce((sum,t)=>sum+(t.resultPct||0),0);
  const avgRR=closed.length?closed.reduce((sum,t)=>sum+(t.rr||Math.abs(t.target-t.entry)/Math.abs(t.entry-t.stop)||0),0)/closed.length:0;
  const totalCash=closed.reduce((sum,t)=>sum+((t.side==="long"?((t.exit||t.entry)-t.entry):(t.entry-(t.exit||t.entry)))*(t.qty||0)),0);

  $("#paperStats").innerHTML=[
    ["Pruebas cerradas",closed.length],["Ganadoras",wins],["Perdedoras",losses],
    ["Acierto",fmt(rate,1)+"%"],["Resultado acumulado",(totalPct>=0?"+":"")+fmt(totalPct,2)+"%"],
    ["Resultado en dinero",(totalCash>=0?"+":"")+money(totalCash)],
    ["Resultado promedio",(avg>=0?"+":"")+fmt(avg,2)+"%"],["R/B promedio","1 : "+fmt(avgRR,2)]
  ].map(([k,v])=>`<div class="result-card"><span>${k}</span><strong>${v}</strong></div>`).join("");

  const mfeKnown=closed.filter(t=>t.mfeR>=0);
  const rLevels=[1,1.5,2,2.5,3];
  const objectiveCards=rLevels.map(r=>{
    const hits=mfeKnown.filter(t=>t.mfeR>=r).length;
    const pct=mfeKnown.length?hits/mfeKnown.length*100:0;
    return `<div class="result-card mfe-card"><span>Habrían llegado a 1:${r}</span><strong>${hits}/${mfeKnown.length} · ${fmt(pct,1)}%</strong></div>`;
  }).join("");
  const mfeBox=$("#paperMfeStats");
  if(mfeBox) mfeBox.innerHTML=objectiveCards+(mfeKnown.length<closed.length?`<p class="mfe-note">Calculando recorrido de ${closed.length-mfeKnown.length} operaciones anteriores…</p>`:``);

  renderPaperInsights(closed);
  $$('[data-close-paper]').forEach(b=>b.onclick=()=>closePaperManual(+b.dataset.closePaper));
  $$('[data-delete-paper]').forEach(b=>b.onclick=()=>deletePaper(+b.dataset.deletePaper));
}

function renderPaperInsights(closed){
  const box=$("#paperInsights");if(!box)return;
  if(closed.length<5){box.innerHTML=`<h3>🧠 Qué está aprendiendo el Centro Quant</h3><p>Necesita al menos 5 operaciones cerradas. Llevas ${closed.length}. Con 20 o más, las conclusiones serán mucho más útiles.</p>`;return}
  const insights=[];
  const groups=[
    ["RSI menor de 45",t=>t.snapshot?.rsi<45],["RSI entre 45 y 55",t=>t.snapshot?.rsi>=45&&t.snapshot?.rsi<=55],["RSI mayor de 55",t=>t.snapshot?.rsi>55],
    ["ADX menor de 20",t=>t.snapshot?.adx<20],["ADX de 20 o más",t=>t.snapshot?.adx>=20],
    ["volumen por encima del promedio",t=>t.snapshot?.volumeRatio>=1],["volumen bajo",t=>t.snapshot?.volumeRatio<1],
    ["score de 85 o más",t=>t.score>=85],["score de 70 a 84",t=>t.score>=70&&t.score<85],["score menor de 70",t=>t.score<70]
  ];
  const ranked=groups.map(([name,test])=>{const a=closed.filter(test);return {name,n:a.length,avg:a.length?a.reduce((s,t)=>s+(t.resultPct||0),0)/a.length:-999,win:a.length?a.filter(t=>(t.resultPct||0)>0).length/a.length*100:0}}).filter(x=>x.n>=3).sort((a,b)=>b.avg-a.avg);
  if(ranked.length){const best=ranked[0],worst=ranked.at(-1);insights.push(`Tus mejores resultados aparecen con <strong>${best.name}</strong>: ${fmt(best.win,0)}% de acierto y ${best.avg>=0?"+":""}${fmt(best.avg,2)}% promedio (${best.n} operaciones).`);if(worst.name!==best.name)insights.push(`La condición más débil hasta ahora es <strong>${worst.name}</strong>: ${fmt(worst.win,0)}% de acierto y ${worst.avg>=0?"+":""}${fmt(worst.avg,2)}% promedio.`)}
  const longs=closed.filter(t=>t.side==="long"),shorts=closed.filter(t=>t.side==="short");
  if(longs.length>=3&&shorts.length>=3){const la=longs.reduce((s,t)=>s+(t.resultPct||0),0)/longs.length,sa=shorts.reduce((s,t)=>s+(t.resultPct||0),0)/shorts.length;insights.push(`${la>=sa?"Long":"Short"} ha sido tu dirección más rentable hasta ahora (${fmt(Math.max(la,sa),2)}% promedio).`)}
  const goodRR=closed.filter(t=>(t.rr||0)>=3),lowRR=closed.filter(t=>(t.rr||0)<3);
  if(goodRR.length>=3&&lowRR.length>=3){const ga=goodRR.reduce((s,t)=>s+(t.resultPct||0),0)/goodRR.length,ba=lowRR.reduce((s,t)=>s+(t.resultPct||0),0)/lowRR.length;insights.push(`Las operaciones con R/B mínimo 1:3 promedian ${ga>=0?"+":""}${fmt(ga,2)}%, frente a ${ba>=0?"+":""}${fmt(ba,2)}% en las menores a 1:3.`)}
  box.innerHTML=`<h3>🧠 Qué está aprendiendo el Centro Quant</h3>${insights.length?`<ul>${insights.map(x=>`<li>${x}</li>`).join("")}</ul>`:`<p>Aún faltan operaciones repetidas bajo condiciones comparables para detectar un patrón confiable.</p>`}<small>Estas observaciones describen tu diario; no garantizan resultados futuros.</small>`;
}

function exportPaperCSV(){
  const rows=state.paperTrades.map(t=>({
    fecha:new Date(t.openedAt).toISOString(),activo:t.symbol,direccion:t.side,temporalidad:t.interval,
    entrada:t.entry,stop:t.stop,objetivo:t.target,salida:t.exit||"",estado:t.status,
    resultado_pct:t.resultPct??"",cantidad:t.qty||"",riesgo_dinero:t.riskCash||"",score:t.score,
    rsi:t.snapshot?.rsi??"",adx:t.snapshot?.adx??"",volumen:t.snapshot?.volumeRatio??"",
    notas:(t.notes||"").replace(/\n/g," ")
  }));
  if(!rows.length)return alert("No hay operaciones para exportar.");
  const headers=Object.keys(rows[0]);
  const csv=[headers.join(","),...rows.map(r=>headers.map(h=>`"${String(r[h]).replace(/"/g,'""')}"`).join(","))].join("\n");
  const blob=new Blob(["\ufeff"+csv],{type:"text/csv;charset=utf-8"}),url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download=`centro-quant-diario-${new Date().toISOString().slice(0,10)}.csv`;a.click();URL.revokeObjectURL(url);
}

function downloadJSON(data,filename){
  const blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json;charset=utf-8"});
  const url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);
}

function createFullBackup(){
  const data={};
  for(let i=0;i<localStorage.length;i++){
    const key=localStorage.key(i);
    if(key&&key.startsWith("markets_quant_")&&key!=="markets_quant_twelve_key") data[key]=localStorage.getItem(key);
  }
  const backup={
    app:"Centro Quant Markets",
    version:"6.6.0",
    format:1,
    createdAt:new Date().toISOString(),
    data
  };
  downloadJSON(backup,`centro-quant-respaldo-${new Date().toISOString().slice(0,10)}.json`);
}

async function restoreFullBackup(file){
  let parsed;
  try{parsed=JSON.parse(await file.text())}catch(e){throw new Error("El archivo no es un JSON válido.")}
  if(!parsed||parsed.app!=="Centro Quant Markets"||parsed.format!==1||!parsed.data||typeof parsed.data!=="object"){
    throw new Error("Este archivo no parece ser un respaldo válido de Centro Quant Markets.");
  }
  const entries=Object.entries(parsed.data).filter(([k,v])=>k.startsWith("markets_quant_")&&(typeof v==="string"||v===null));
  if(!entries.length) throw new Error("El respaldo no contiene datos de Centro Quant Markets.");
  // Valida JSON de las claves estructuradas antes de tocar los datos actuales.
  for(const [k,v] of entries){
    if(v===null) continue;
    if(["markets_quant_assets","markets_quant_weights","markets_quant_paper_trades","markets_quant_auto_paper"].includes(k)) JSON.parse(v);
  }
  if(!confirm(`Se reemplazarán los datos actuales por el respaldo del ${parsed.createdAt?new Date(parsed.createdAt).toLocaleString("es-MX"):"archivo seleccionado"}. ¿Continuar?`)) return;
  const oldKeys=[];
  for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(k&&k.startsWith("markets_quant_")&&k!=="markets_quant_twelve_key")oldKeys.push(k)}
  oldKeys.forEach(k=>localStorage.removeItem(k));
  entries.forEach(([k,v])=>{if(v!==null)localStorage.setItem(k,v)});
  alert("Respaldo cargado correctamente. La aplicación se reiniciará para aplicar los datos.");
  location.reload();
}

function updateWeightsTotal(){
  const total=$$("[data-weight]").reduce((s,i)=>s+Number(i.value||0),0),el=$("#weightsTotal");
  if(el){el.textContent=`${total} / 100`;el.className=total===100?"weight-total-ok":"weight-total-bad";}
}
function renderWeights(){
  const names={trend:"Tendencia EMA",momentum:"Momentum RSI",strength:"Fuerza ADX",volume:"Volumen",volatility:"Volatilidad ATR",structure:"Estructura"};
  $("#weightsForm").innerHTML=Object.entries(names).map(([k,n])=>`<div class="weight-row"><label><strong>${n}</strong><small>Peso máximo dentro del score</small></label><div class="weight-control"><input data-weight-range="${k}" type="range" min="0" max="50" step="1" value="${state.weights[k]}"><input data-weight="${k}" type="number" min="0" max="100" value="${state.weights[k]}"><span>pts</span></div></div>`).join("");
  $$('[data-weight]').forEach(i=>i.addEventListener('input',()=>{const r=$(`[data-weight-range="${i.dataset.weight}"]`);if(r)r.value=i.value;updateWeightsTotal()}));
  $$('[data-weight-range]').forEach(r=>r.addEventListener('input',()=>{const i=$(`[data-weight="${r.dataset.weightRange}"]`);if(i)i.value=r.value;updateWeightsTotal()}));
  updateWeightsTotal();
}
function applyWeightPreset(name){
  const presets={balanced:{trend:30,momentum:20,strength:15,volume:15,volatility:10,structure:10},trend:{trend:40,momentum:15,strength:20,volume:10,volatility:5,structure:10},momentum:{trend:20,momentum:30,strength:15,volume:20,volatility:5,structure:10}};
  const p=presets[name];if(!p)return;state.weights={...p};renderWeights();
}

$("#saveWeightsBtn").onclick=()=>{
  let total=0,next={};$$("[data-weight]").forEach(i=>{next[i.dataset.weight]=+i.value;total+=+i.value});
  if(total!==100)return alert("Los pesos deben sumar exactamente 100. Ahora suman "+total+".");
  state.weights=next;localStorage.setItem("markets_quant_weights",JSON.stringify(next));alert("Pesos guardados.");refreshAll();
};
$("#backupDataBtn").onclick=createFullBackup;
$("#restoreDataBtn").onclick=()=>$("#restoreDataInput").click();
$("#restoreDataInput").onchange=async e=>{const file=e.target.files?.[0];if(!file)return;try{await restoreFullBackup(file)}catch(err){alert("No se pudo cargar el respaldo: "+err.message)}finally{e.target.value=""}};
$("#resetDataBtn").onclick=()=>{if(confirm("¿Borrar favoritos, pesos, operaciones y configuración local?")){localStorage.clear();location.reload()}};
$$(`[data-weight-preset]`).forEach(b=>b.onclick=()=>applyWeightPreset(b.dataset.weightPreset));
$("#backToDashboard").onclick=()=>showView("dashboardView");
$("#refreshAnalysisBtn").onclick=refreshAnalysis;
$("#timeframeSelect").onchange=refreshAnalysis;
$("#analysisModeSelect").onchange=refreshAnalysis;
$("#marketModeSelect").onchange=()=>{renderRanking();refreshAll()};
$("#refreshAllBtn").onclick=refreshAll;
$("#homeTimeframeSelect").onchange=e=>refreshHomeTimeframe(e.target.value);
$("#homeAnalyzeBtn").onclick=()=>{const sym=$("#homeAnalyzeBtn").dataset.symbol;if($("#timeframeSelect"))$("#timeframeSelect").value=state.homeInterval;if(sym)openAnalysis(sym);};
$("#homePaperBtn").onclick=()=>{const sym=$("#homePaperBtn").dataset.symbol;showView("paperView");fillAssetSelects();if(sym)$("#paperSymbol").value=sym;if(state.pendingPaperSignal){$("#paperSide").value=state.pendingPaperSignal.side;$("#paperInterval").value=state.pendingPaperSignal.interval||"1d";}previewPaper();};
$("#homeMarketBtn").onclick=()=>showView("dashboardView");
$("#homeBacktestBtn").onclick=()=>showView("backtestView");
$("#savePaperBtn").onclick=()=>createPaperTrade().catch(e=>alert("No se pudo guardar la prueba: "+e.message));
["paperSymbol","paperSide","paperInterval","paperEntry","paperStopMode","paperStop","paperTargetMode","paperTarget","paperCapital","paperRiskPct"].forEach(id=>{
  $("#"+id)?.addEventListener("change",previewPaper);
  $("#"+id)?.addEventListener("input",previewPaper);
});
$("#refreshPaperBtn").onclick=async()=>{await updatePaperTrades();await backfillPaperMFE();renderPaperTrades();await scanAutoPaper();};
["autoPaperEnabled","autoPaperInterval","autoPaperThreshold","autoPaperStop","autoPaperTarget","autoPaperRisk","autoPaperCapital"].forEach(id=>$("#"+id)?.addEventListener("change",()=>{readAutoPaperControls();if(state.autoPaper.enabled)scanAutoPaper();}));
$("#scanAutoPaperBtn")?.addEventListener("click",()=>scanAutoPaper(true));
$("#trafficNeedsBtn").onclick=()=>{const box=$("#trafficNeeds"),btn=$("#trafficNeedsBtn");const open=box.hidden;box.hidden=!open;btn.setAttribute("aria-expanded",open?"true":"false");btn.textContent=open?"Ocultar condiciones":"¿Qué tendría que pasar para ponerse en verde?";};
$("#paperFilter").onchange=renderPaperTrades;
$("#exportPaperBtn").onclick=exportPaperCSV;

renderWeights();fillAssetSelects();renderAssets();renderRanking();renderPaperTrades();renderPaperMonitor();renderScannerResults();syncAutoPaperControls();if($("#homeTimeframeSelect"))$("#homeTimeframeSelect").value=state.homeInterval;renderHome();
(async()=>{
  // Primero protegemos/actualizamos las operaciones heredadas de v1.0.
  await updatePaperTrades();
  renderPaperTrades();
  // La carga general queda bajo petición para no consumir la cuota al abrir la PWA.
  const status=$("#autoPaperStatus");
  if(status&&state.autoPaper.enabled) status.textContent=`Activo · ${state.autoPaper.interval} · score ≥ ${state.autoPaper.threshold} · barrido manual para ahorrar API`;
})();

function syncMarketApiKeyUI(){
  const key=getMarketApiKey(), input=$("#marketApiKey"), status=$("#marketApiStatus");
  if(input) input.value=key;
  if(status) status.textContent=key?"Configurada":"Sin clave";
}
if($("#saveMarketApiKey")) $("#saveMarketApiKey").onclick=()=>{
  const key=$("#marketApiKey")?.value.trim()||"";
  if(key) localStorage.setItem("markets_quant_twelve_key",key); else localStorage.removeItem("markets_quant_twelve_key");
  syncMarketApiKeyUI();
  alert(key?"Clave guardada. Ya puedes actualizar Markets.":"Clave eliminada.");
  if(key) refreshAll();
};
syncMarketApiKeyUI();

if("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(console.warn);
