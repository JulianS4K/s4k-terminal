// ================================================================
// portfolio.js — S4K Terminal
// Tracked events — load, history, sidebar, select, refresh
// ================================================================
'use strict';

async function loadTracked(){
  setSt('LOADING...');
  try{
    // ── Show cached data immediately if available ─────────────────
    // sessionStorage survives page refresh but not tab close.
    // Lets the sidebar render in ~0ms while fresh data loads in background.
    const CACHE_KEY = 's4k_tracked_cache';
    const cached = sessionStorage.getItem(CACHE_KEY);
    if(cached){
      try{
        const cachedEvents = JSON.parse(cached);
        tracked={};
        cachedEvents.forEach(ev=>{
          const key = ev.src==='TE'&&ev.event_id ? `TE::${ev.event_id}` : ev.key;
          tracked[key]={...ev, key, history:[]};
        });
        renderSidebar(); updateTotal(); setSt('UPDATING...');
      }catch(e){}
    }

    // ── Fetch fresh data from GAS ─────────────────────────────────
    const d=await gasGet({action:'tracked'});
    tracked={};
    (d.events||[]).forEach(ev=>{
      const canonicalKey = ev.src==='TE'&&ev.event_id ? `TE::${ev.event_id}` : ev.key;
      const alreadyHas = ev.src==='TE' && Object.values(tracked).some(t=>String(t.event_id)===String(ev.event_id));
      if(!alreadyHas) tracked[canonicalKey]={...ev, key:canonicalKey, history:[]};
    });

    // Cache the event list (without history) for next load
    try{
      sessionStorage.setItem(CACHE_KEY, JSON.stringify(
        Object.values(tracked).map(({history:_, ...ev})=>ev)
      ));
    }catch(e){}

    // Render sidebar immediately with event names — don't wait for price data
    renderSidebar(); updateTotal(); setSt('LOADING PRICES...');

    // Pre-fetch Firebase token once — avoids N simultaneous token requests
    try { await FS.getToken(); } catch(e) {}

    // Load all histories in parallel — each updates sidebar as it arrives
    loadAllHistories().then(() => {
      renderSidebar(); updateTotal(); setSt('READY');
      startRealtimeListener();
      // Auto-select first event so chart shows on open without needing a click
      if(!selKey) {
        const firstKey = Object.keys(tracked)[0];
        if(firstKey) selectEvent(firstKey);
      }
    }).catch(() => setSt('READY'));

  }catch(e){ setSt('ADD GAS URL IN F8'); }
}

// Load histories for all tracked events in parallel.
// Each event updates the sidebar incrementally as its data arrives.

async function loadAllHistories(){
  const keys = Object.keys(tracked);
  if(!keys.length) return;
  await Promise.allSettled(
    keys.map(async k => {
      await loadHistory(k);
      renderSidebar(); // update this event's card as soon as its data lands
    })
  );
}

async function loadHistory(key){
  const ev=tracked[key]; if(!ev) return;
  let loaded = false;

  // ── Try Firestore ─────────────────────────────────────────────
  // Requires composite index: tevo/ → event_id ASC, snapshot_ts DESC
  // If index missing: Firestore returns HTTP 400 → falls through to GAS.
  // Create index: Firebase Console → Firestore → Indexes → Composite
  //   Collection: tevo | event_id ASC | snapshot_ts DESC
  try {
    const snaps = await FS.getEventSnapshots(ev.event_id, 1000);
    if(snaps && snaps.length > 0){
      ev.history = snaps
        .map(s=>({
          ts:     s.snapshot_ts||'',
          floor:  Math.round(Number(s.floor||0)),
          avg:    Math.round(Number(s.avg||0)),
          median: Math.round(Number(s.median||0)),
          max:    Math.round(Number(s.max||0)),
          count:  Math.round(Number(s.count||0))
        }))
        .filter(s=>s.floor>0 && s.avg>0 && !isNaN(s.floor))
        .map(s=>({...s, max: s.max > s.floor*20 ? s.avg*3 : s.max}))
        .sort((a,b)=>a.ts.localeCompare(b.ts));
      loaded = true;
    }
  } catch(fsErr) {}

  // ── GAS fallback — reads all rows from Sheets ─────────────────
  if(!loaded){
    try {
      const d = await gasGet({action:'history', src:ev.src||'TE', event_id:ev.event_id});
      ev.history = (d.rows||[])
        .map(r=>({
          ts:     String(r.snapshot_ts||''),
          floor:  Math.round(Number(r.floor||0)),
          avg:    Math.round(Number(r.avg||0)),
          median: Math.round(Number(r.median||0)),
          max:    Math.round(Number(r.max||0)),
          count:  Math.round(Number(r.count||0))
        }))
        .filter(s=>s.floor>0 && s.avg>0 && !isNaN(s.floor))
        .map(s=>({...s, max: s.max > s.floor*20 ? s.avg*3 : s.max}))
        .sort((a,b)=>a.ts.localeCompare(b.ts));
    } catch(gasErr){ ev.history=[]; }
  }

  // Re-render chart immediately if this is the selected event
  if(selKey===key && (ev.history||[]).length>0) renderDetail(key);
}

async function saveSnap(src,venue,perf,eid,name,date,stats,dataSource){
  const key = src==='TE' ? `TE::${eid}` : skey(src,venue,perf,eid);
  const ev=tracked[key]||{key,src,event_id:eid,name,venue,performer:perf,date,added_at:new Date().toISOString(),history:[]};
  const prev=ev.history.length?ev.history[ev.history.length-1]:null;
  const du=daysUntil(date);
  // Round all prices — never write decimals to snapshot
  const floor=Math.round(stats.floor||0), avg=Math.round(stats.avg||0),
        median=Math.round(stats.median||0), max=Math.round(stats.max||0),
        count=Math.round(stats.count||0);
  const snap={
    source:src, event_id:eid, event_name:name, venue, performer:perf,
    sport_type:'', event_date:date,
    days_until_event:String(Math.max(0,du)), day_of_week_event:dayOfWeek(date),
    floor, avg, median, max, count,
    floor_delta:prev?floor-Math.round(prev.floor||0):0,
    avg_delta:prev?avg-Math.round(prev.avg||0):0,
    median_delta:prev?median-Math.round(prev.median||0):0,
    count_delta:prev?count-Math.round(prev.count||0):0,
    days_until_delta:0, price_buckets:{},
    data_source:dataSource||'listings'
  };
  try{ await gasPost({action:'snapshot',src,snapshot:snap}); }
  catch(e){ toast('SHEETS WRITE FAILED','err'); }
  ev.history.push({ts:new Date().toISOString(),floor,avg,median,max,count});
  ev.lastUpdate=new Date().toISOString();
  tracked[key]=ev; renderSidebar(); updateTotal(); return key;
}

function renderSidebar(){
  const el=document.getElementById('sbl'); const keys=Object.keys(tracked);
  document.getElementById('tcount').textContent=keys.length;
  if(!keys.length){ el.innerHTML='<div style="padding:12px;color:var(--muted);font-size:10px;">NO EVENTS TRACKED<br><br>USE F3 OR CHAT TO ADD</div>'; return; }
  el.innerHTML=keys.map(k=>{
    const r=tracked[k]; 
    // Filter bad snapshots — floor must be > 0 and not NaN
    const h=(r.history||[]).filter(s=>s.floor>0&&!isNaN(s.floor)&&s.avg>0&&!isNaN(s.avg));
    if(!h.length) return`<div class="er src-${r.src.toLowerCase()}${k===selKey?' active':''}" onclick="selectEvent('${k}')"><div style="display:flex;justify-content:space-between;"><div class="er-name">${r.name}</div><span class="spill ${r.src.toLowerCase()}">${r.src}</span></div><div class="er-meta">${(r.venue||'').replace(/_/g,' ').substring(0,26)}</div><div class="er-r2"><span style="color:var(--muted);font-size:10px;">LOADING...</span></div></div>`;
    const lat=h[h.length-1],prev=h.length>1?h[h.length-2]:null,fd=prev?lat.floor-prev.floor:0;
    const nextUpd = getNextUpdateLabel(r.event_id||'');
    // News badge — how many feed items affect this event in last 24h
    const evNews  = (eventFeedMap[String(r.event_id||'')] || []);
    const recentNews = evNews.filter(i => (Date.now()-new Date(i.pubDate||0).getTime()) < 24*3600*1000);
    const highNews   = recentNews.filter(i => i.impact==='High');
    const newsBadge  = recentNews.length > 0
      ? `<span style="font-size:9px;padding:0 4px;border-radius:2px;margin-left:4px;background:${highNews.length?'rgba(255,23,68,0.2)':'rgba(251,188,4,0.15)'};color:${highNews.length?'var(--red)':'var(--amber)'};" title="${recentNews.length} news items">${highNews.length?'●':'○'} ${recentNews.length}</span>`
      : '';
    return`<div class="er src-${r.src.toLowerCase()}${k===selKey?' active':''}" onclick="selectEvent('${k}')"><div style="display:flex;justify-content:space-between;align-items:flex-start;"><div class="er-name" title="${r.name}">${r.name}</div><span class="spill ${r.src.toLowerCase()}">${r.src}</span></div><div class="er-meta">${(r.venue||'').replace(/_/g,' ').substring(0,26)}</div><div class="er-r2"><span class="er-floor">${fmt(lat.floor)}</span><span style="font-size:10px;">${dHtml(fd,false)}</span><span class="sct">${h.length}×</span><span class="elst"><span>${fmtC(lat.count)}</span> LST</span>${nextUpd}${newsBadge}</div></div>`;
  }).join('');
}

async function selectEvent(key){
  selKey = key;
  renderSidebar();
  showPanel('detail', document.querySelectorAll('.fkey')[0]);

  const ev = tracked[key];
  if (!ev) return;

  // If we already have history, render immediately — don't make user wait
  if (ev.history && ev.history.length > 0) {
    renderDetail(key);
  } else {
    // No history yet — show loading state on price cards
    setSt(`Loading ${ev.name}...`);
    ['m-f','m-a','m-m','m-x','m-c'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = '…';
    });
  }

  // Update event feed strip immediately (uses in-memory data, instant)
  updateEventFeedStrip(key);

  // Load history and markers in parallel — non-blocking
  const [_hist] = await Promise.allSettled([
    loadHistory(key),
    loadEventFeedMarkers(key)
  ]);

  // Render with full data once both complete
  if (selKey === key) {
    renderDetail(key);
    renderChart(tracked[key]);
    setSt('READY');
  }
}
// ── Feed markers per event ────────────────────────────────────────
// Loads matched feed items for a tracked event from Firestore.
// Sources: feed_items/ (X/Twitter via attribution) + espn_feed/ (ESPN RSS).
// Stored in ev.feedMarkers — used by renderChart for triangle overlays.
//
// X feed items:  query by matched_event_id (set by TeamLinking attribution)
// ESPN items:    query by feed_league + performer name in title/description
//                (attribution stored at write time when possible)
//
// Color coding:
//   Red    = High impact (injury, trade, star out)
//   Amber  = Medium impact (lineup change, questionable)
//   Green  = Low impact / informational
//   Cyan   = ESPN sourced

function updateTotal(){ const t=Object.values(tracked).reduce((a,r)=>a+(r.history||[]).length,0); document.getElementById('snaptotal').textContent=`${t} SNAPSHOT${t!==1?'S':''}`; }

async function refreshSelected(){
  if(!selKey) return;
  const r=tracked[selKey]; if(!r) return;
  if(r.src==='SG'){ toast('SeatGeek disabled — remove and re-add via TEvo','err'); return; }

  const btn = document.getElementById('btn-ref');
  btn.disabled = true; btn.textContent = 'REFRESHING...';
  setSt(`Refreshing ${r.name}...`);

  try {
    // 1. Fetch live data from TEvo → writes to Sheets + Firestore via GAS
    await fetchTE(r.event_id, r.name, r.venue, r.performer, r.date);

    // 2. Reload full history — gets ALL snapshots including the new one
    await loadHistory(selKey);

    // 3. Re-render chart and metric cards
    if(selKey) {
      renderDetail(selKey);
      renderChart(tracked[selKey]);
    }
    setSt('READY');
  } catch(e) {
    toast(`REFRESH FAILED: ${e.message}`, 'err');
    setSt('READY');
  } finally {
    btn.disabled = false; btn.textContent = 'REFRESH';
  }
}

async function removeSelected(){
  if(!selKey)return; try{await gasPost({action:'untrack',key:selKey});}catch(e){}
  delete tracked[selKey]; selKey=null; renderSidebar(); updateTotal();
  ['det-title','det-meta'].forEach((id,i)=>{document.getElementById(id).textContent=i?'—':'SELECT AN EVENT';});
  ['lst-pill','lst-delta'].forEach(id=>document.getElementById(id).style.display='none');
  document.getElementById('btn-ref').disabled=true; document.getElementById('btn-rem').disabled=true;
  document.getElementById('empty-ch').style.display='flex'; document.getElementById('main-ch').style.display='none';
  document.getElementById('snapinfo').style.display='none';
  ['m-f','m-a','m-m','m-x','m-c'].forEach(id=>{document.getElementById(id).textContent='—';document.getElementById(id+'d').textContent='—';});
  if(chart){chart.destroy();chart=null;} toast('REMOVED'); setSt('READY');
}
// Manual refresh rate limit — 5 minutes between manual triggers
const MANUAL_REFRESH_LIMIT_MS = 5 * 60 * 1000;
let _lastManualRefresh = 0;

async function refreshAll(el){
  const keys=Object.keys(tracked); if(!keys.length){toast('NOTHING TO REFRESH','err');return;}

  // Rate limit check
  const now = Date.now();
  const msSinceLast = now - _lastManualRefresh;
  if(_lastManualRefresh > 0 && msSinceLast < MANUAL_REFRESH_LIMIT_MS){
    const secsLeft = Math.ceil((MANUAL_REFRESH_LIMIT_MS - msSinceLast) / 1000);
    const minsLeft = Math.ceil(secsLeft / 60);
    toast(`SLOW DOWN — next refresh in ${minsLeft}m ${secsLeft%60}s`,'err');
    return;
  }
  _lastManualRefresh = now;

  if(el){ el.textContent='REFRESHING...'; el.style.pointerEvents='none'; }
  setSt('REFRESHING ALL Tracked Events...');
  try{
    const d=await gasPost({action:'refresh_all'});
    if(d.ok){
      await loadTracked();
      renderSidebar(); renderF4Portfolio();
      await loadIntelFeed();
      toast(`REFRESHED: ${d.count||keys.length} events`);
      setSt(`REFRESHED ${new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})}`);
      // Update next-update timers after refresh
      loadNextUpdateTimes();
    } else {
      for(const k of keys){selKey=k;await refreshSelected();}
      if(keys.length) selectEvent(keys[keys.length-1]);
      toast(`${keys.length} REFRESHED`); setSt('REFRESH COMPLETE');
    }
  }catch(e){
    for(const k of keys){selKey=k;await refreshSelected();}
    toast(`${keys.length} REFRESHED`); setSt('REFRESH COMPLETE');
  }
  if(el){ el.textContent='↺ REFRESH'; el.style.pointerEvents='auto'; }
}

// ================================================================
// F2 — SEATGEEK (disabled)
// ================================================================

async function loadNextUpdateTimes(){
  try {
    // Try Firestore event_index first — has last snapshot ts per event
    const keys = Object.keys(tracked);
    if (!keys.length) return;
    for (const key of keys) {
      const ev = tracked[key];
      if (!ev || !ev.event_id) continue;
      try {
        const idx = await FS.getEventIndex(ev.event_id);
        if (idx && idx.tevo_ts) {
          const daysUntilN = ev.date
            ? Math.max(0, (new Date(ev.date)-new Date())/864e5) : 999;
          const windowMins = daysUntilN<=2 ? 15 : daysUntilN<=7 ? 30 : 240;
          const nextTs     = new Date(new Date(idx.tevo_ts).getTime() + windowMins*60*1000);
          const minsUntil  = Math.max(0, Math.round((nextTs-new Date())/60000));
          _nextUpdateMap[String(ev.event_id)] = {
            next_update_ts:    nextTs.toISOString(),
            mins_until_update: minsUntil,
            window_mins:       windowMins,
            last_snapshot_ts:  idx.tevo_ts
          };
        }
      } catch(e) {} // per-event failure is non-fatal
    }
    renderSidebar();
  } catch(e) {
    // Fall back to GAS get_settings
    try {
      const d = await gasGet({action:'get_settings'});
      if(d.ok && d.event_next_update) {
        _nextUpdateMap = d.event_next_update;
        renderSidebar();
      }
    } catch(e2) {}
  }
}

function getNextUpdateLabel(eventId){
  const info = _nextUpdateMap[String(eventId)];
  if(!info) return '';
  const mins = info.mins_until_update;
  if(mins<=0)  return '<span style="color:var(--green);font-size:9px;">UPDATE DUE</span>';
  if(mins< 60) return `<span style="color:var(--muted);font-size:9px;">↻ ${mins}m</span>`;
  return `<span style="color:var(--muted);font-size:9px;">↻ ${Math.round(mins/60)}h</span>`;
}
