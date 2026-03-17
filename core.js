// ================================================================
// core.js — S4K Terminal
// State, constants, utilities, GAS transport, init
// ================================================================
'use strict';

// ================================================================
// STATE
// ================================================================
const CKEY='s4k_a20', TKEY='s4k_theme_v2'; // Alpha 2.0 — bump to clear old cached settings
const APP_VERSION='Alpha 2.0'; // single source of truth — update on every release
// Migrate GAS URL from any previous CKEY version so users don't lose settings on version bump
(function migrateCreds(){
  if(localStorage.getItem(CKEY)) return; // already on current version
  const prev=['s4k_v526','s4k_v5','s4k_v52','s4k_v53'].reverse(); // migrate old GAS URL forward
  for(const k of prev){
    const old=localStorage.getItem(k);
    if(old){ localStorage.setItem(CKEY,old); break; }
  }
})();
let tracked={}, selKey=null, chart=null, cmode='price';
let son={floor:false,med:true,avg:false,max:false};
let xFeedItems=[], espnFeedItems=[], feedItems=[], lfilt='all', ifilt=null, sfilt=null;
// eventFeedMap: eventId → [feed items that affect it] (including affected_event_ids)
// Built after every loadFeed() — used for sidebar badges, chart markers, event strip
let eventFeedMap = {}; // { "3082845": [{title, pubDate, impact, srcType, ...}] }
let intelItems=[], intelTypeFilter='all';
let chatHistory=[], chatWaiting=false;
let feedPollTimer=null;
const chatEventStore={}; // keyed by TEvo event ID, stores full event data for card actions

// ================================================================
// CORE UTILS
// ================================================================

function tick(){ document.getElementById('clock').textContent=new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}); }
setInterval(tick,1000); tick();

function toast(msg,type='ok'){ const el=document.getElementById('toast'); el.textContent=msg; el.className=`toast ${type}`; el.style.display='block'; clearTimeout(el._t); el._t=setTimeout(()=>el.style.display='none',3500); }

function setSt(msg){ document.getElementById('statusmsg').textContent=msg; }

function showPanel(id,el){
  document.querySelectorAll('.fkey').forEach(f=>f.classList.remove('active'));
  if(el&&el.classList&&el.classList.contains('fkey')) el.classList.add('active');
  document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
  document.getElementById('panel-'+id).classList.add('active');
  if(id==='feed'){ loadFeed(); startFeedPoll(); renderF4Portfolio(); if(selKey) updateEventFeedStrip(selKey); } else { stopFeedPoll(); }
  if(id==='feedsrc'){ loadRSSFeeds(); const u=document.getElementById('gas-url-display'); if(u) u.textContent=getCreds().gas||'(save GAS URL in F8 first)'; }
  if(id==='intel') loadIntelFeed();
  if(id==='usersettings') loadUserSettings();
}

// ================================================================
// CREDENTIALS
// ================================================================

function loadCreds(){ try{ const c=JSON.parse(localStorage.getItem(CKEY)||'{}'); document.getElementById('cred-gas').value=c.gas||''; updateSrcBar(c); return c; }catch(e){ return{}; } }

function getCreds(){ try{ return JSON.parse(localStorage.getItem(CKEY)||'{}'); }catch(e){ return{}; } }

function saveCreds(){ const c={gas:document.getElementById('cred-gas').value.trim()}; localStorage.setItem(CKEY,JSON.stringify(c)); updateSrcBar(c); toast('SETTINGS SAVED'); }

function updateSrcBar(c){
  const st=(id,cls,txt)=>{ const el=document.getElementById(id); if(!el)return; el.textContent=txt; el.className='stag '+cls; };
  st('tag-gas',  c.gas?'live':'cfg',     c.gas?'LIVE':'NEEDS URL');
  st('tag-sheets',c.gas?'live':'cfg',    c.gas?'LIVE':'PENDING');
  st('tag-sg',   c._sgOk?'live':'cfg',   c._sgOk?'LIVE':'NEEDS KEY');
  st('tag-te',   c._teOk?'live':'cfg',   c._teOk?'LIVE':'NEEDS KEY');
  st('tag-anth', c._anthOk?'live':'cfg', c._anthOk?'LIVE':'NEEDS KEY');
  if(c._rssCount>0) st('tag-rss','live',`${c._rssCount} FEED${c._rssCount!==1?'S':''}`);
  else if(c._rssOk) st('tag-rss','cfg','NO FEEDS YET');
  else              st('tag-rss','ntk','NEEDS KEY');
}

async function gasGet(p){ const c=getCreds(); if(!c.gas) throw new Error('GAS URL not set'); const r=await fetch(`${c.gas}?${new URLSearchParams(p)}`); if(!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }

async function gasPost(b){
  const c=getCreds(); if(!c.gas) throw new Error('GAS URL not set');
  // text/plain avoids CORS preflight — GAS still receives body via e.postData.contents
  const r=await fetch(c.gas,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify(b)});
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ================================================================
// FirestoreReader — direct terminal → Firestore reads
// ================================================================
// Writes always go through GAS (keeps TEvo/Anthropic auth centralized).
// Reads go direct: Terminal → Firestore REST API (sub-second, no GAS hop).
//
// Token lifecycle:
//   First call → fetch token from GAS get_firebase_token
//   Subsequent calls → use cached token
//   Token expires → auto-refresh (55min cache, 60min actual)
//
// Usage:
//   const snaps = await FS.getEventSnapshots('3082845', 50);
//   const items = await FS.getFeedItems({league:'NBA', limit:100});
//   const doc   = await FS.getDoc('event_index', '3082845');
// ================================================================
const FS = (() => {
  let _token      = null;
  let _projectId  = null;
  let _expiresAt  = 0;

  // ── Token management ───────────────────────────────────────────
  async function getToken() {
    if (_token && Date.now() < _expiresAt - 60000) return _token;
    const d = await gasGet({action:'get_firebase_token'});
    if (!d.ok) throw new Error(`Firebase token error: ${d.error}`);
    _token     = d.token;
    _projectId = d.project_id;
    _expiresAt = new Date(d.expires_at).getTime();
    return _token;
  }

  function baseUrl() {
    return `https://firestore.googleapis.com/v1/projects/${_projectId}/databases/(default)/documents`;
  }

  // ── Raw Firestore value decoder ────────────────────────────────
  function decodeValue(v) {
    if (!v) return null;
    if (v.stringValue  !== undefined) return v.stringValue;
    if (v.integerValue !== undefined) return Number(v.integerValue);
    if (v.doubleValue  !== undefined) return Number(v.doubleValue);
    if (v.booleanValue !== undefined) return v.booleanValue;
    if (v.nullValue    !== undefined) return null;
    if (v.timestampValue !== undefined) return v.timestampValue;
    if (v.arrayValue)  return (v.arrayValue.values||[]).map(decodeValue);
    if (v.mapValue)    return decodeFields(v.mapValue.fields||{});
    return null;
  }

  function decodeFields(fields) {
    const out = {};
    Object.entries(fields||{}).forEach(([k,v]) => { out[k] = decodeValue(v); });
    return out;
  }

  function decodeDoc(raw) {
    if (!raw || !raw.fields) return null;
    const doc = decodeFields(raw.fields);
    // Add Firestore doc ID as _id
    if (raw.name) doc._id = raw.name.split('/').pop();
    return doc;
  }

  // ── GET single document ────────────────────────────────────────
  async function getDoc(collection, docId) {
    const token = await getToken();
    const url   = `${baseUrl()}/${collection}/${encodeURIComponent(docId)}`;
    const r = await fetch(url, {headers:{Authorization:`Bearer ${token}`}});
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Firestore GET ${collection}/${docId}: HTTP ${r.status}`);
    return decodeDoc(await r.json());
  }

  // ── Structured query (POST :runQuery) ──────────────────────────
  // filters: [{field, op, value}]  op = EQUAL | GREATER_THAN | LESS_THAN | etc.
  // orderBy: [{field, dir}]        dir = ASCENDING | DESCENDING
  async function query(collection, filters=[], orderBy=[], limit=100) {
    const token = await getToken();
    const url   = `${baseUrl()}:runQuery`;

    const where = filters.length === 1
      ? buildFilter(filters[0])
      : {compositeFilter:{op:'AND', filters: filters.map(buildFilter)}};

    const structuredQuery = {
      from:  [{collectionId: collection}],
      limit: {value: limit},
    };
    if (filters.length) structuredQuery.where  = where;
    if (orderBy.length) structuredQuery.orderBy = orderBy.map(o=>({
      field:{fieldPath:o.field}, direction:o.dir||'DESCENDING'
    }));

    const r = await fetch(url, {
      method:  'POST',
      headers: {Authorization:`Bearer ${token}`, 'Content-Type':'application/json'},
      body:    JSON.stringify({structuredQuery})
    });
    if (!r.ok) throw new Error(`Firestore query ${collection}: HTTP ${r.status}`);
    const results = await r.json();
    return (Array.isArray(results) ? results : [results])
      .filter(row => row.document)
      .map(row => decodeDoc(row.document));
  }

  function buildFilter({field, op, value}) {
    let fv;
    if      (typeof value === 'string')  fv = {stringValue:  value};
    else if (typeof value === 'number')  fv = {doubleValue:  value};
    else if (typeof value === 'boolean') fv = {booleanValue: value};
    else                                 fv = {nullValue:    'NULL_VALUE'};
    return {fieldFilter:{field:{fieldPath:field}, op, value:fv}};
  }

  // ── Convenience methods ────────────────────────────────────────

  // Latest N price snapshots for an event from tevo/ collection
  async function getEventSnapshots(eventId, limit=100) {
    return query('tevo',
      [{field:'event_id', op:'EQUAL', value:String(eventId)}],
      [{field:'snapshot_ts', dir:'DESCENDING'}],
      limit
    );
  }

  // Feed items from feed_items/ — filter by league, matched, or event
  async function getFeedItems({league, matched, eventId, limit=150} = {}) {
    const filters = [];
    if (eventId) filters.push({field:'matched_event_id', op:'EQUAL', value:String(eventId)});
    else if (matched) filters.push({field:'matched', op:'EQUAL', value:true});
    else if (league && league !== 'all') filters.push({field:'league', op:'EQUAL', value:league});
    return query('feed_items', filters, [{field:'received_ts', dir:'DESCENDING'}], limit);
  }

  // Event index doc — latest prices across all sources for one event
  async function getEventIndex(eventId) {
    return getDoc('event_index', String(eventId));
  }

  // ESPN feed items — filter by league, matched, or directly by event
  async function getEspnItems({league, eventId, limit=100} = {}) {
    const filters = [];
    if (eventId) {
      // Direct event match (populated by EspnPoller.gs performer matching)
      filters.push({field:'matched_event_id', op:'EQUAL', value:String(eventId)});
    } else if (league && league !== 'all') {
      filters.push({field:'feed_league', op:'EQUAL', value:league});
      filters.push({field:'matched', op:'EQUAL', value:true});
    } else {
      filters.push({field:'matched', op:'EQUAL', value:true});
    }
    return query('espn_feed', filters, [{field:'received_ts', dir:'DESCENDING'}], limit);
  }

  // Connection test — reads the ping doc
  async function testConnection() {
    try {
      const doc = await getDoc('_connection_test', 'ping');
      return {ok: !!doc, doc};
    } catch(e) {
      return {ok: false, error: e.message};
    }
  }

  return {getDoc, query, getEventSnapshots, getFeedItems,
          getEventIndex, getEspnItems, testConnection, getToken,
          getProjectId: async () => { await getToken(); return _projectId; },
          _decodeFields: decodeFields};
})();

async function testConn(){
  const box=document.getElementById('conn-box'); box.style.display='block'; box.className='connbox'; box.textContent='TESTING...';
  try{
    const url=document.getElementById('cred-gas').value.trim();
    if(!url){ box.textContent='ENTER URL FIRST'; box.className='connbox err'; return; }
    const d=await(await fetch(`${url}?action=ping`)).json();
    if(d.ok){
      box.textContent=`CONNECTED · SG:${d.sg?'OK':'NO KEY'} · TE:${d.te?'OK':'NO KEY'} · AI:${d.anthropic?'OK':'NO KEY'} · RSS:${d.rss?'OK':'NO KEY'}`;
      box.className='connbox ok';
      const c=getCreds(); c._sgOk=d.sg; c._teOk=d.te; c._anthOk=d.anthropic; c._rssOk=d.rss;
      localStorage.setItem(CKEY,JSON.stringify(c)); updateSrcBar(c);
    } else { box.textContent=`ERROR: ${d.error}`; box.className='connbox err'; }
  }catch(e){ box.textContent=`FAILED: ${e.message}`; box.className='connbox err'; }
}

async function testFirestore(){
  const box=document.getElementById('fs-test-box');
  box.style.display='block'; box.className='connbox'; box.textContent='TESTING FIRESTORE CONNECTION...';
  try {
    const result = await FS.testConnection();
    if(result.ok) {
      // Also count a few collections
      const snaps = await FS.query('tevo',[],[{field:'snapshot_ts',dir:'DESCENDING'}],5);
      const feeds = await FS.query('feed_items',[],[{field:'received_ts',dir:'DESCENDING'}],5);
      box.textContent = `FIRESTORE CONNECTED ✓ · tevo/ (${snaps.length} recent) · feed_items/ (${feeds.length} recent)`;
      box.className='connbox ok';
    } else {
      box.textContent = `FIRESTORE FAILED: ${result.error}`;
      box.className='connbox err';
    }
  } catch(e) {
    box.textContent = `FIRESTORE ERROR: ${e.message}`;
    box.className='connbox err';
  }
}

// ================================================================
// HELPERS
// ================================================================

function calcStats(p){ if(!p.length)return{floor:0,max:0,avg:0,median:0,count:0};const s=[...p].sort((a,b)=>a-b);const sum=s.reduce((a,b)=>a+b,0);const mid=Math.floor(s.length/2);return{floor:s[0],max:s[s.length-1],avg:Math.round(sum/s.length),median:s.length%2===0?Math.round((s[mid-1]+s[mid])/2):s[mid],count:s.length}; }

function daysUntil(d){ if(!d)return null; const dt=new Date(d); if(isNaN(dt))return null; return Math.max(0,Math.round((dt-new Date())/864e5)); }

// Safe date formatter — handles ISO strings, GAS Date serializations,
// spreadsheet serial numbers, and anything else without throwing

function safeDate(d, opts){
  if(!d || d==='' || d==='0' || d===false) return 'TBD';
  let dt;
  // Try direct ISO parse first (most TEvo dates: "2026-03-25T20:00:00Z")
  dt = new Date(d);
  if(!isNaN(dt.getTime()) && dt.getFullYear() > 2000)
    return dt.toLocaleDateString('en-US', opts||{weekday:'short',month:'short',day:'numeric',year:'numeric'});
  // Sheets serial number (days since Dec 30 1899) — 2026 dates ≈ 46000
  const n = Number(d);
  if(!isNaN(n) && n > 40000 && n < 70000) {
    dt = new Date(Date.UTC(1899,11,30) + n*86400000);
    if(!isNaN(dt.getTime()))
      return dt.toLocaleDateString('en-US', opts||{weekday:'short',month:'short',day:'numeric',year:'numeric'});
  }
  // Strip GAS timezone suffix e.g. "Mon Mar 25 2026 ... (Coordinated Universal Time)"
  dt = new Date(String(d).replace(/\s*\(.*\)$/, '').trim());
  if(!isNaN(dt.getTime()) && dt.getFullYear() > 2000)
    return dt.toLocaleDateString('en-US', opts||{weekday:'short',month:'short',day:'numeric',year:'numeric'});
  return 'TBD';
}

function safeDateFull(d){
  return safeDate(d, {weekday:'short',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
}

function dayOfWeek(d){ if(!d)return''; return['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(d).getDay()]; }

function fmt(n){ return n>=1000?'$'+Number(n).toLocaleString():'$'+n; }

function fmtC(n){ return Number(n).toLocaleString(); }

function dHtml(n,isC){ if(!n||n===0)return'<span style="color:var(--muted)">—</span>'; const a=Math.abs(n),s=isC?a.toLocaleString():'$'+a.toLocaleString(); return n>0?`<span class="dup">▲ ${s}</span>`:`<span class="ddn">▼ ${s}</span>`; }

function skey(src,v,p,eid){
  // TEvo events: key by event_id only — guaranteed unique, prevents venue/performer string variance duplicates
  if(src==='TE'&&eid) return `TE::${eid}`;
  // SeatGeek: keep venue+performer+id composite key
  return`${src}::${(v||'').replace(/[^\w]/g,'_').substring(0,30)}::${(p||'').replace(/[^\w]/g,'_').substring(0,30)}::${eid||''}`.replace(/::$/,'');
}

function ago(ds){ const d=new Date(ds),m=Math.round((Date.now()-d)/60000); if(m<1)return'just now'; if(m<60)return`${m}m ago`; if(m<1440)return`${Math.round(m/60)}h ago`; return`${Math.round(m/1440)}d ago`; }

// Next-update timers — loaded from GAS get_settings
let _nextUpdateMap = {}; // event_id → {mins_until_update, window_mins, next_update_ts}

function bumpBadge(id,n=1){
  const key=id.replace('-badge','');
  const panelMap={'feed-badge':'panel-feed','intel-badge':'panel-intel'};
  const panel=document.getElementById(panelMap[id]);
  if(panel&&panel.style.display!=='none')return;
  badgeCounts[key]=(badgeCounts[key]||0)+n;
  updateBadge(id,badgeCounts[key]);
}

// ================================================================
// USER SETTINGS PANEL (F9)
// ================================================================

function clearBadge(id){
  const key=id.replace('-badge','');
  badgeCounts[key]=0; updateBadge(id,0);
}

function updateBadge(id,count){
  const el=document.getElementById(id);
  if(!el)return;
  if(count>0){el.textContent=count>99?'99+':count;el.style.display='inline';}
  else{el.style.display='none';}
}

async function init(){
  loadCreds();
  loadTheme();

  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }

  const c = getCreds();
  if(!c.gas){
    showPanel('creds', document.querySelector('.fkey[onclick*="creds"]'));
    setSt('ADD GAS URL IN F8 TO CONNECT');
    return;
  }

  // ── Parallel warmup — kick off everything simultaneously ──────
  // GAS cold start takes 3-8s; warming it and the Firestore token
  // in parallel before we need them cuts perceived load by ~50%.
  setSt('CONNECTING...');

  // Fire GAS ping + Firestore token warmup simultaneously
  // Neither blocks the sidebar from rendering
  const warmup = Promise.allSettled([
    gasGet({action:'ping'}).catch(()=>{}),
    FS.getToken().catch(()=>{})
  ]);

  // Load session-cached events instantly (0ms render)
  await loadTracked();

  // Background: settings + next-update timers (non-blocking)
  warmup.then(() => {
    gasGet({action:'get_settings'}).then(d=>{
      if(d.ok && d.last_auto_refresh) lastSnapshotTs = d.last_auto_refresh;
      if(d.ok && d.event_next_update){ _nextUpdateMap = d.event_next_update; renderSidebar(); }
    }).catch(()=>{});
    loadNextUpdateTimes();
  }).catch(()=>{});

  // Default panel + tutorial
  showPanel('intel', document.getElementById('fkey-intel'));
  switchIntelTab('chat', document.getElementById('itab-chat'));
  setTimeout(showTutorial, 150);
}

function showTutorial(){
  // Only show once per session
  if(sessionStorage.getItem('s4k_tutorial_shown')) return;
  sessionStorage.setItem('s4k_tutorial_shown','1');

  const el=document.getElementById('chat-messages');
  // Clear any existing content (placeholder or old messages)
  if(el.children.length===0 || (el.children.length===1 && el.firstElementChild.classList.contains('chat-placeholder'))){
    el.innerHTML='';
  } else if(el.children.length > 0){
    // Chat already has messages — don't overwrite
    return;
  }

  const lines=[
    `**Welcome to S4K Intelligence** — your ticket market analyst.`,
    ``,
    `Here's what you can do right now:`,
    ``,
    `**Find events + pricing**`,
    `· _"Knicks games this week"_ — search TEvo, see listing counts + weather`,
    `· _"Lakers tonight"_ — pulls market data, feed signals, and weather in one shot`,
    `· _"Get prices for Indiana Pacers at MSG"_ — floor, median, avg, wholesale`,
    ``,
    `**Portfolio**`,
    `· Click **TRACK** on any event card to add it to your portfolio`,
    `· Tracked events auto-refresh every hour and push price alerts to F4 + F6`,
    `· Ask _"what's moving in my portfolio?"_ for a delta summary`,
    ``,
    `**Feed intelligence**`,
    `· F4 shows your live demand feed — rss.app keyword feeds push here`,
    `· Click **ASK AI ↗** on any feed item to analyze it here`,
    `· Add keywords in **F9 Settings** to auto-flag relevant news`,
    ``,
    `**Auto-refresh**`,
    `· Run \`setupTriggers()\` in GAS editor once to enable hourly auto-refresh`,
    `· The **↺ REFRESH** button in the topbar triggers a full portfolio refresh now`,
    ``,
    `_Type anything below to get started, or click an example above._`
  ];

  const div=document.createElement('div');
  div.className='cmsg ai';
  div.innerHTML=`<div class="cmsg-label">S4K INTELLIGENCE</div><div class="cbubble">${renderMarkdown(lines.join('\n'))}</div>`;
  el.appendChild(div);

  // Quick-action chips
  const chips=[
    'lakers tonight','knicks this week','show me my portfolio','search rangers playoffs'
  ];
  const chipWrap=document.createElement('div');
  chipWrap.style.cssText='display:flex;gap:6px;flex-wrap:wrap;padding:4px 0 8px 0;';
  chips.forEach(chip=>{
    const btn=document.createElement('button');
    btn.textContent=chip;
    btn.style.cssText='font-size:10px;padding:3px 10px;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer;font-family:var(--font);border-radius:2px;';
    btn.onmouseenter=()=>btn.style.color='var(--white)';
    btn.onmouseleave=()=>btn.style.color='var(--muted)';
    btn.onclick=()=>{
      document.getElementById('chat-input').value=chip;
      sendChat();
    };
    chipWrap.appendChild(btn);
  });
  el.appendChild(chipWrap);
  el.scrollTop=el.scrollHeight;
}
init();
