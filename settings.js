// ================================================================
// settings.js — S4K Terminal
// F8/F9 settings, user vars, keywords, debug
// ================================================================
'use strict';

async function loadUserSettings(){
  try{
    const [sd,kd]=await Promise.all([gasGet({action:'get_settings'}),gasGet({action:'get_keywords'})]);
    if(sd.ok){
      document.getElementById('us-last-refresh').textContent=sd.last_auto_refresh
        ?new Date(sd.last_auto_refresh).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})
        :'Never (run setupTriggers() in GAS)';
      document.getElementById('us-refresh-count').textContent=sd.auto_refresh_count||'0';
      document.getElementById('us-tracked-count').textContent=sd.tracked_count||Object.keys(tracked).length;
    }
    renderKeywords(kd.keywords||[]);
    renderAutoTrackedTerms();
    // Load saved user vars
    const savedVars=localStorage.getItem('s4k_user_vars');
    if(savedVars) document.getElementById('user-vars-input').value=savedVars;
    // Load saved custom theme CSS
    const savedThemeCSS=localStorage.getItem('s4k_custom_theme_css');
    if(savedThemeCSS) document.getElementById('theme-css-input').value=savedThemeCSS;
  }catch(e){toast(`Settings load failed: ${e.message}`,'err');}
}

// ── User Variables ────────────────────────────────────────────────

function saveUserVars(){
  const raw=document.getElementById('user-vars-input').value.trim();
  const status=document.getElementById('uv-status');
  if(!raw){ localStorage.removeItem('s4k_user_vars'); status.textContent='Cleared.'; return; }
  try{
    JSON.parse(raw); // validate
    localStorage.setItem('s4k_user_vars', raw);
    status.textContent='Saved ✓ — Claude will use this on next chat message';
    status.style.color='var(--green)';
    toast('CONTEXT SAVED');
  }catch(e){
    status.textContent='Invalid JSON — check syntax';
    status.style.color='var(--red)';
  }
}

function previewUserVars(){
  const raw=document.getElementById('user-vars-input').value.trim();
  try{
    JSON.parse(raw||'{}');
    showPanel('intel',document.getElementById('fkey-intel'));
    switchIntelTab('chat',document.getElementById('itab-chat'));
    document.getElementById('chat-input').value='What should I know about my current trading context and how does it affect my tracked events?';
    document.getElementById('chat-input').focus();
    toast('PREVIEW QUERY LOADED — PRESS SEND');
  }catch(e){ toast('Fix JSON syntax first','err'); }
}

function getUserVarsContext(){
  try{
    const raw=localStorage.getItem('s4k_user_vars');
    if(!raw) return '';
    const vars=JSON.parse(raw);
    return `\n\nUSER TRADING CONTEXT:\n${JSON.stringify(vars,null,2)}`;
  }catch(e){ return ''; }
}

// ── Custom Theme CSS ──────────────────────────────────────────────

function renderKeywords(keywords){
  const el=document.getElementById('kw-list');
  if(!keywords.length){el.innerHTML='<div style="color:var(--muted);font-size:10px;">No keywords yet — add one above.</div>';return;}
  el.innerHTML=keywords.map(kw=>`
    <div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--border);">
      <span style="color:var(--white);font-size:11px;flex:1;">${kw.keyword}</span>
      <span style="font-size:9px;padding:1px 6px;border:1px solid var(--border);color:var(--muted);">${kw.league||'all'}</span>
      <span style="font-size:9px;color:var(--muted);">${kw.match_count||0} matches</span>
      ${kw.last_matched?`<span style="font-size:9px;color:var(--muted);">${ago(kw.last_matched)}</span>`:''}
      <button onclick="removeKeyword('${kw.id}')" style="font-size:9px;padding:1px 6px;border:1px solid var(--red);color:var(--red);background:transparent;cursor:pointer;font-family:var(--font);">✕</button>
    </div>`).join('');
}

function renderAutoTrackedTerms(){
  const el=document.getElementById('auto-tracked-terms');
  if(!el)return;
  const terms=new Set();
  Object.values(tracked).forEach(ev=>{
    const name=(ev.name||ev.event_name||'').toLowerCase();
    name.split(/\s+(?:at|vs\.?|@)\s+/).forEach(t=>{
      t.split(/\s+/).filter(w=>w.length>3).forEach(w=>terms.add(w));
    });
    if(ev.performer&&ev.performer.length>3)terms.add(ev.performer.toLowerCase());
  });
  if(!terms.size){el.textContent='No tracked events yet.';return;}
  el.innerHTML=[...terms].map(t=>`<span style="display:inline-block;margin:2px;padding:1px 8px;border:1px solid var(--border);color:var(--cyan);font-size:10px;">${t}</span>`).join('');
}

async function addKeyword(){
  const kw=document.getElementById('kw-input').value.trim();
  const league=document.getElementById('kw-league').value;
  if(!kw)return;
  try{
    const d=await gasPost({action:'add_keyword',keyword:kw,league});
    if(d.duplicate){toast('Keyword already tracked','err');return;}
    document.getElementById('kw-input').value='';
    toast(`TRACKING: "${kw}"`);
    loadUserSettings();
  }catch(e){toast(`Failed: ${e.message}`,'err');}
}

async function removeKeyword(id){
  try{
    await gasPost({action:'remove_keyword',id});
    loadUserSettings();
    toast('KEYWORD REMOVED');
  }catch(e){toast(`Failed: ${e.message}`,'err');}
}

// ================================================================
// F4 PORTFOLIO SNAPSHOT SECTION
// ================================================================

async function loadDebug(){
  const el=document.getElementById('debug-log');
  const btn=document.getElementById('btn-debug');
  el.textContent='Loading...'; btn.disabled=true;
  try{
    const d=await gasGet({action:'get_debug',limit:80});
    if(!d.rows||!d.rows.length){ el.textContent='No debug entries yet — trigger a GET PRICES to populate.'; btn.disabled=false; return; }
    el.innerHTML=d.rows.map(r=>{
      const ts=new Date(r.ts).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
      const lvlColor=r.level==='ERROR'?'var(--red)':r.level==='WARN'?'var(--amber)':'var(--green)';
      return `<div style="border-bottom:1px solid var(--border);padding:3px 0;">
        <span style="color:var(--muted);">${ts}</span>
        <span style="color:${lvlColor};margin:0 6px;font-weight:500;">${r.level}</span>
        <span style="color:var(--cyan);">[${r.source}]</span>
        <span style="color:var(--white);margin-left:6px;">${r.message}</span>
        ${r.detail?`<div style="color:var(--muted);padding-left:12px;word-break:break-all;">${r.detail}</div>`:''}
      </div>`;
    }).join('');
  }catch(e){ el.textContent=`FAILED: ${e.message}`; }
  btn.disabled=false;
}

async function clearDebugSheet(){
  if(!confirm('Clear debug log in Sheets?')) return;
  try{ await gasPost({action:'clear_debug'}); document.getElementById('debug-log').textContent='Cleared.'; }
  catch(e){ toast(`FAILED: ${e.message}`,'err'); }
}

// ================================================================
// BADGE SYSTEM
// ================================================================
const badgeCounts={feed:0,intel:0};

async function testListings(){
  const eid = document.getElementById('test-event-id').value.trim();
  const btn = document.getElementById('btn-test-listings');
  const el  = document.getElementById('test-listings-result');
  btn.disabled=true; btn.textContent='TESTING...';
  el.style.display='block'; el.textContent='Running 4 tests against TEvo /v9/listings...';
  try{
    const params = {action:'test_listings'};
    if(eid) params.event_id = eid;
    const d = await gasGet(params);
    if(d.error){ el.textContent=`ERROR: ${d.error}`; btn.disabled=false; btn.textContent='RUN TEST'; return; }
    const r = d.results||{};
    el.innerHTML = Object.entries(r).map(([test, res])=>{
      const ok = res.status===200;
      const col = ok?'var(--green)':res.status===401?'var(--red)':'var(--amber)';
      return `<div style="border-bottom:1px solid var(--border);padding:4px 0;">
        <span style="color:${col};font-weight:500;">${test}</span>
        <span style="color:var(--muted);margin-left:8px;">HTTP ${res.status||'ERR'}</span>
        ${res.error?`<div style="color:var(--red);padding-left:10px;">${res.error}</div>`:''}
        <div style="color:var(--muted);padding-left:10px;word-break:break-all;">${res.body||''}</div>
      </div>`;
    }).join('');
  }catch(e){ el.textContent=`FAILED: ${e.message}`; }
  btn.disabled=false; btn.textContent='RUN TEST';
}

// ================================================================
// F8 DEBUG LOG
// ================================================================
