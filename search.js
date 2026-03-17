// ================================================================
// search.js — S4K Terminal
// F3 TEvo/SeatGeek search and event lookup
// ================================================================
'use strict';

async function fetchSG(){ toast('SeatGeek disabled — use F3 or chat','err'); }

// ================================================================
// F3 — TICKET EVOLUTION
// ================================================================

async function searchTE(){
  const c=getCreds(); if(!c.gas){toast('ADD GAS URL — F8','err');return;}
  const q=document.getElementById('te-q').value.trim(); if(!q){toast('ENTER QUERY','err');return;}
  const st=document.getElementById('te-st'),dd=document.getElementById('te-dd');
  st.textContent='SEARCHING...'; st.style.color='var(--amber)'; dd.style.display='none';
  try{
    const d=await gasGet({action:'search_te',q});
    if(d.error){st.textContent=`ERROR: ${d.error}`;st.style.color='var(--red)';return;}
    if(!d.events?.length){st.textContent='NO EVENTS FOUND';st.style.color='var(--red)';return;}
    st.textContent=`${d.events.length} RESULTS — SELECT ONE`; st.style.color='var(--green)';
    dd.style.display='block';
    dd.innerHTML=d.events.map(ev=>`<div class="ddi" onclick="fetchTE('${ev.id}','${(ev.name||'').replace(/['"]/g,'')}','${(ev.venue?.name||'UNKNOWN').replace(/['"]/g,'')}','${(ev.performances?.[0]?.performer?.name||'UNKNOWN').replace(/['"]/g,'')}','${ev.occurs_at||''}')"><div class="ddn2">${ev.name||'UNNAMED'}</div><div class="ddm">${ev.venue?.name||''} · ${ev.occurs_at?safeDate(ev.occurs_at,{month:'short',day:'numeric',year:'numeric'}):''}</div></div>`).join('');
  }catch(e){st.textContent=`FAILED: ${e.message}`;st.style.color='var(--red)';}
}

async function fetchTE(eid,name,venue,perf,date){
  document.getElementById('te-dd').style.display='none';
  const c=getCreds(); if(!c.gas){toast('ADD GAS URL — F8','err');return;}
  const st=document.getElementById('te-st'); st.textContent=`FETCHING ${name}...`; st.style.color='var(--amber)'; setSt('FETCHING TEVO...');
  try{
    const d=await gasGet({action:'fetch_te',event_id:eid,name:encodeURIComponent(name),venue:encodeURIComponent(venue),performer:encodeURIComponent(perf),date});
    if(d.error){st.textContent=`ERROR: ${d.error}`;st.style.color='var(--red)';return;}
    const key=await saveSnap('TE',venue,perf,eid,name,date,d.stats);
    st.textContent=`TRACKED · ${fmtC(d.stats.count)} LISTINGS · SAVED`; st.style.color='var(--green)';
    toast('TRACKED + SAVED'); setSt(`ADDED: ${name}`); selectEvent(key); document.getElementById('te-q').value='';
  }catch(e){st.textContent=`FAILED: ${e.message}`;st.style.color='var(--red)';}
}

// ================================================================
// F4 — DEMAND FEED (rss.app webhook-powered)
// ================================================================
