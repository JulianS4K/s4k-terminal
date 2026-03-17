// ================================================================
// intelligence.js — S4K Terminal
// F6 intel feed, AI chat, tool results
// ================================================================
'use strict';

function switchIntelTab(tab,el){ document.querySelectorAll('.itab').forEach(t=>t.classList.remove('active'));el.classList.add('active');document.querySelectorAll('.intel-panel').forEach(p=>p.classList.remove('active'));document.getElementById(`intel-${tab}`).classList.add('active');if(tab==='feed')loadIntelFeed(); }

async function loadIntelFeed(){
  setSt('LOADING INTELLIGENCE FEED...');
  try{
    const d=await gasGet({action:'get_feed',limit:100});
    const prevUnread=intelItems.filter(i=>!i.read||i.read==='false'||i.read===false).length;
    intelItems=d.items||[];
    const unread=intelItems.filter(i=>!i.read||i.read==='false'||i.read===false).length;
    const badge=document.getElementById('unread-badge'); if(unread>0){badge.textContent=unread;badge.style.display='inline-block';}else badge.style.display='none';
    // Bump nav badge if new unread items arrived
    if(unread>prevUnread) bumpBadge('intel-badge',unread-prevUnread);
    renderIntelFeed(); setSt('INTELLIGENCE READY');
  }catch(e){setSt('INTELLIGENCE FEED ERROR');}
}

function setIntelType(type,el){ intelTypeFilter=type; document.querySelectorAll('.intel-toolbar .fpill').forEach(p=>p.classList.remove('active'));el.classList.add('active'); renderIntelFeed(); }

function renderIntelFeed(){
  const el=document.getElementById('intel-feed-list');
  let items=[...intelItems]; if(intelTypeFilter!=='all')items=items.filter(i=>i.type===intelTypeFilter);
  document.getElementById('intel-count').textContent=`${items.length} item${items.length!==1?'s':''}`;
  if(!items.length){el.innerHTML=`<div class="empty" style="height:200px;"><span style="color:var(--muted);font-size:11px;">NO ${intelTypeFilter.toUpperCase()} ITEMS YET</span></div>`;return;}
  el.innerHTML=items.map(item=>{
    const isRead=item.read===true||item.read==='true',isSaved=item.saved===true||item.saved==='true';
    return`<div class="icard type-${item.type}" onclick="expandCard('body-${item.id}')" style="opacity:${isRead?'0.6':'1'}">
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;"><span class="icard-type ${item.type}">${(item.type||'').toUpperCase()}</span>${item.severity&&item.severity!=='info'?`<span class="isev ${item.severity}">${item.severity.toUpperCase()}</span>`:''} ${item.event_name&&item.event_name!=='ALL EVENTS'?`<span style="font-size:10px;color:var(--muted);">${item.event_name}</span>`:''}<span class="icard-time">${ago(item.ts)}</span></div>
      <div class="icard-title">${item.title||'Untitled'}</div>
      <div class="icard-body" id="body-${item.id}">${(item.body||'').replace(/\n/g,'<br>')}</div>
      <div class="icard-actions" onclick="event.stopPropagation()"><button class="iact" onclick="markRead('${item.id}')">MARK READ</button><button class="iact ${isSaved?'saved':''}" onclick="saveItem('${item.id}')">${isSaved?'SAVED ★':'SAVE'}</button><button class="iact" onclick="askAboutItem('${item.id}')">ASK AI ↗</button></div>
    </div>`;
  }).join('');
}

function expandCard(bodyId){ const el=document.getElementById(bodyId);if(el)el.classList.toggle('open'); }

async function markRead(id){ try{await gasPost({action:'mark_read',id});}catch(e){} const item=intelItems.find(i=>i.id===id);if(item)item.read=true; renderIntelFeed(); }

async function saveItem(id){ try{await gasPost({action:'save_item',id});}catch(e){} const item=intelItems.find(i=>i.id===id);if(item)item.saved=true; renderIntelFeed();toast('ITEM SAVED'); }

function askAboutItem(id){ const item=intelItems.find(i=>i.id===id);if(!item)return; switchIntelTab('chat',document.getElementById('itab-chat')); document.getElementById('chat-input').value=`Tell me more about: ${item.title}`; document.getElementById('chat-input').focus(); }

async function generateStory(){ if(!selKey){toast('SELECT AN EVENT IN F1 FIRST','err');return;} setSt('GENERATING STORY...'); try{const d=await gasPost({action:'generate_story',event_key:selKey});if(d.error){toast(`FAILED: ${d.error}`,'err');return;}toast('STORY GENERATED');await loadIntelFeed();switchIntelTab('feed',document.getElementById('itab-feed'));setSt('STORY READY');}catch(e){toast(`FAILED: ${e.message}`,'err');} }

async function generateBrief(){ setSt('GENERATING BRIEF...'); try{const d=await gasPost({action:'generate_brief'});if(d.error){toast(`FAILED: ${d.error}`,'err');return;}toast('BRIEF GENERATED');await loadIntelFeed();switchIntelTab('feed',document.getElementById('itab-feed'));setSt('BRIEF READY');}catch(e){toast(`FAILED: ${e.message}`,'err');} }

async function generateDigest(){ setSt('GENERATING DIGEST...'); try{const d=await gasPost({action:'generate_digest'});if(d.error){toast(`FAILED: ${d.error}`,'err');return;}toast('DIGEST GENERATED');await loadIntelFeed();switchIntelTab('feed',document.getElementById('itab-feed'));setSt('DIGEST READY');}catch(e){toast(`FAILED: ${e.message}`,'err');} }

// ── Chat with TEvo tool use ───────────────────────────────────────

async function sendChat(){
  if(chatWaiting)return;
  const input=document.getElementById('chat-input');
  const msg=input.value.trim(); if(!msg)return;
  input.value=''; chatWaiting=true;
  const sendBtn=document.getElementById('chat-send-btn'); sendBtn.disabled=true; sendBtn.textContent='...';
  appendChatMsg('user',msg);
  chatHistory.push({role:'user',content:msg});
  const thinkId='think-'+Date.now();
  appendChatMsg('ai','<span class="blink">▋</span>',thinkId);
  try{
    const d=await gasPost({action:'chat',message:msg+getUserVarsContext(),history:chatHistory.slice(-6)});
    document.getElementById(thinkId)?.remove();
    if(d.error){ appendChatMsg('ai',`ERROR: ${d.error}`); chatHistory.pop(); }
    else{
      if(d.tools_used?.length){
        const hints=d.tools_used.map(t=>{
          if(t.tool==='search_te_events') return`searched TEvo for "${t.input.query}"`;
          if(t.tool==='fetch_te_listings') return`fetched listings for ${t.input.event_name}`;
          if(t.tool==='get_tracked_events') return'pulled tracked events';
          return t.tool;
        });
        appendToolHint(hints.join(' · '));
      }
      if(d.reply) appendChatMsg('ai',d.reply);
      if(d.events_found?.length) appendEventCards(d.events_found,d.listings_found||[]);
      chatHistory.push({role:'assistant',content:d.reply||''});
    }
  }catch(e){ document.getElementById(thinkId)?.remove(); appendChatMsg('ai',`FAILED: ${e.message}`); chatHistory.pop(); }
  chatWaiting=false; sendBtn.disabled=false; sendBtn.textContent='SEND';
}

// ── Markdown renderer for chat messages ──────────────────────────
// Converts Claude's markdown output to clean HTML.
// Handles: bold, italic, inline code, code blocks, tables, lists, headers.

function renderMarkdown(text) {
  if (!text) return '';
  let html = text;

  // Code blocks (``` ... ```) — preserve before other processing
  const codeBlocks = [];
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre style="background:rgba(0,0,0,0.3);border:1px solid var(--border);border-radius:3px;padding:8px 12px;overflow-x:auto;font-size:11px;line-height:1.5;margin:6px 0;"><code style="font-family:var(--font);color:#A5D6A7;">${code.replace(/</g,'&lt;').replace(/>/g,'&gt;').trim()}</code></pre>`);
    return `\x00CODE${idx}\x00`;
  });

  // Tables — | col | col | rows
  html = html.replace(/(\|.+\|\n)+/g, tableBlock => {
    const rows = tableBlock.trim().split('\n').filter(r => r.trim());
    const isSep = r => /^[\|\s\-:]+$/.test(r);
    let out = '<table style="width:100%;border-collapse:collapse;font-size:11px;margin:6px 0;">';
    let inHead = true;
    rows.forEach(row => {
      if (isSep(row)) { inHead = false; return; }
      const cells = row.split('|').map(c=>c.trim()).filter((_,i,a)=>i>0&&i<a.length-1);
      const tag = inHead ? 'th' : 'td';
      const style = inHead
        ? 'padding:4px 8px;border-bottom:1px solid var(--border);color:var(--amber);text-align:left;'
        : 'padding:4px 8px;border-bottom:1px solid var(--bg3);color:var(--white);';
      out += `<tr>${cells.map(c=>`<${tag} style="${style}">${c}</${tag}>`).join('')}</tr>`;
    });
    out += '</table>';
    return out;
  });

  // Headers
  html = html.replace(/^### (.+)$/gm, '<div style="font-size:12px;color:var(--amber);font-weight:600;margin:8px 0 4px;">$1</div>');
  html = html.replace(/^## (.+)$/gm,  '<div style="font-size:13px;color:var(--white);font-weight:600;margin:10px 0 4px;">$1</div>');
  html = html.replace(/^# (.+)$/gm,   '<div style="font-size:14px;color:var(--white);font-weight:700;margin:10px 0 6px;">$1</div>');

  // Bullet lists
  html = html.replace(/((?:^[ \t]*[-*+] .+\n?)+)/gm, block => {
    const items = block.trim().split('\n').map(l => l.replace(/^[ \t]*[-*+] /, '').trim());
    return '<ul style="margin:4px 0 4px 16px;padding:0;list-style:disc;">' +
           items.map(i=>`<li style="margin:2px 0;color:var(--white);font-size:11px;">${i}</li>`).join('') +
           '</ul>';
  });

  // Numbered lists
  html = html.replace(/((?:^[ \t]*\d+\. .+\n?)+)/gm, block => {
    const items = block.trim().split('\n').map(l => l.replace(/^[ \t]*\d+\. /, '').trim());
    return '<ol style="margin:4px 0 4px 16px;padding:0;">' +
           items.map(i=>`<li style="margin:2px 0;color:var(--white);font-size:11px;">${i}</li>`).join('') +
           '</ol>';
  });

  // Inline formatting
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong style="color:var(--white);">$1</strong>');
  html = html.replace(/__(.+?)__/g,     '<strong style="color:var(--white);">$1</strong>');
  html = html.replace(/\*(.+?)\*/g,     '<em style="color:var(--muted);">$1</em>');
  html = html.replace(/_([^_]+)_/g,     '<em style="color:var(--muted);">$1</em>');
  html = html.replace(/`([^`]+)`/g,     '<code style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:3px;font-size:10px;font-family:var(--font);">$1</code>');

  // Dollar amounts — highlight in cyan
  html = html.replace(/\$(\d[\d,.]+)/g, '<span style="color:var(--cyan);">$$$1</span>');

  // Horizontal rule
  html = html.replace(/^---+$/gm, '<hr style="border:none;border-top:1px solid var(--border);margin:8px 0;">');

  // Line breaks
  html = html.replace(/\n\n+/g, '<br><br>');
  html = html.replace(/\n/g,    '<br>');

  // Restore code blocks
  codeBlocks.forEach((block, i) => {
    html = html.replace(`\x00CODE${i}\x00`, block);
  });

  return html;
}

function appendChatMsg(role, content, id){
  const el  = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = `cmsg ${role}`;
  if(id) div.id = id;
  const rendered = role === 'assistant'
    ? renderMarkdown(content)
    : content.replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
  div.innerHTML = `<div class="cmsg-label">${role==='user'?'YOU':'S4K INTELLIGENCE'}</div><div class="cbubble">${rendered}</div>`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
  return div;
}

function appendToolHint(text){
  const el=document.getElementById('chat-messages');
  const div=document.createElement('div'); div.className='chat-tool-hint';
  div.textContent=`⚙ ${text}`; el.appendChild(div); el.scrollTop=el.scrollHeight;
}

function appendEventCards(events, listingsFound){
  const el=document.getElementById('chat-messages');
  const wrap=document.createElement('div'); wrap.style.cssText='padding:0 0 8px 0;';
  const listingsMap={};
  (listingsFound||[]).forEach(l=>{if(l.event_id)listingsMap[String(l.event_id)]=l;});
  const trackedIds=new Set(Object.values(tracked).map(t=>String(t.event_id)));

  // Pull feed items once for all cards
  const allFeedItems=[...feedItems]; // already loaded from F4 poll

  events.forEach(ev=>{
    chatEventStore[String(ev.id)] = ev;

    const card=document.createElement('div'); card.className='te-event-card';
    const dateStr=(ev.date_local||ev.date)?safeDate(ev.date_local||ev.date,{month:'short',day:'numeric',year:'numeric',weekday:'short'}):'TBD';
    const isTracked=trackedIds.has(String(ev.id));
    const lst=listingsMap[String(ev.id)];
    const avail=ev.available_count||0;
    const availColor=avail>200?'var(--green)':avail>50?'var(--amber)':avail>0?'var(--rss)':'var(--muted)';

    // KPI movement from tracked history — guard against bad snapshot values
    let kpiHtml='';
    if(isTracked){
      const tKey=Object.keys(tracked).find(k=>String(tracked[k].event_id)===String(ev.id));
      const tev=tKey?tracked[tKey]:null;
      if(tev&&tev.history&&tev.history.length){
        // Find most recent snapshot with valid floor > 0
        const validSnaps=tev.history.filter(s=>s.floor>0&&s.avg>0);
        if(validSnaps.length){
          const lat=validSnaps[validSnaps.length-1];
          const prev=validSnaps.length>1?validSnaps[validSnaps.length-2]:null;
          const fd=prev?lat.floor-prev.floor:null;
          const cd=prev?lat.count-prev.count:null;
          kpiHtml=`<div style="display:flex;gap:10px;padding:5px 0;border-top:1px solid var(--border);margin-top:4px;flex-wrap:wrap;">
            <span style="font-size:10px;"><span style="color:var(--muted);">FLOOR </span><span style="color:var(--cyan);">$${lat.floor}</span>${fd!==null?` <span style="${fd>0?'color:var(--red)':'color:var(--green)'}">${fd>0?'▲':'▼'}$${Math.abs(fd)}</span>`:''}</span>
            <span style="font-size:10px;"><span style="color:var(--muted);">AVG </span><span style="color:var(--amber);">$${lat.avg}</span></span>
            <span style="font-size:10px;"><span style="color:var(--muted);">LST </span><span style="color:#A5D6A7;">${(lat.count||0).toLocaleString()}</span>${cd!==null?` <span style="${cd<0?'color:var(--red)':'color:var(--green)'}">${cd>0?'+':''}${cd}</span>`:''}</span>
            <span style="font-size:9px;color:var(--muted);margin-left:auto;">${validSnaps.length} snaps</span>
          </div>`;
        }
      }
    }

    // F4 feed matches — search rss_live for this specific event's teams/venue
    const feedTerms=[ev.name, ev.performer, ev.venue]
      .flatMap(s=>(s||'').toLowerCase().split(/\s+at\s+|\s+vs\.?\s+|\s+@\s+/))
      .map(s=>s.replace(/[^\w\s]/g,'').trim())
      .filter(s=>s.length>=3);
    const feedMatches=allFeedItems.filter(item=>{
      const t=(item.title||item.item_title||'').trim();
      if(t.length<=5||/^pic\.?$|^image$|^photo$/i.test(t)) return false;
      const text=[
        item.title||item.item_title||'',
        item.desc||item.item_description||'',
        item.source||item.feed_title||''
      ].join(' ').toLowerCase();
      return feedTerms.some(t=>text.includes(t));
    }).slice(0,3);

    let feedHtml='';
    if(feedMatches.length){
      feedHtml=`<div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,107,53,0.3);">
        <div style="font-size:9px;color:var(--rss);letter-spacing:.08em;margin-bottom:4px;">F4 FEED · ${feedMatches.length} RELATED</div>`+
        feedMatches.map(item=>`
          <div style="padding:3px 0;font-size:10px;line-height:1.4;">
            <span style="color:var(--white);">${(item.title||item.item_title||'').substring(0,80)}${(item.title||item.item_title||'').length>80?'...':''}</span>
            ${item.impact?`<span style="margin-left:6px;font-size:9px;padding:0 4px;border:1px solid;border-radius:2px;color:${item.impact==='High'?'var(--red)':item.impact==='Medium'?'var(--amber)':'var(--green)'};border-color:${item.impact==='High'?'var(--red)':item.impact==='Medium'?'var(--amber)':'var(--green)'};">${item.impact}</span>`:''}
            <div style="color:var(--muted);font-size:9px;">${item.source||item.feed_title||''} · ${ago(item.pubDate||item.item_published||item.received_ts||'')}</div>
            ${item.reason?`<div style="color:var(--amber);font-size:9px;">${item.reason}</div>`:''}
          </div>`).join('')+
        `</div>`;
    }

    card.innerHTML=`
      <div class="te-event-name">${ev.name}</div>
      <div class="te-event-meta">
        <span>${ev.venue}${ev.venue_city?', '+ev.venue_city:''}</span>
        <span>${dateStr}</span>
        <span style="margin-left:auto;display:flex;gap:8px;align-items:center;">
          <span style="font-size:10px;color:${availColor};">${avail>0?avail+' lstg':'no listings'}</span>
          ${ev.popularity?`<span style="font-size:10px;color:var(--muted);">${(ev.popularity*100).toFixed(0)}% pop</span>`:''}
        </span>
      </div>
      ${lst?`<div class="te-event-stats">
        <span class="te-stat"><span>FLOOR</span><span style="color:var(--cyan);">$${lst.stats.floor}</span></span>
        <span class="te-stat"><span>MEDIAN</span><span style="color:var(--purple);">$${lst.stats.median}</span></span>
        <span class="te-stat"><span>AVG</span><span style="color:var(--amber);">$${lst.stats.avg}</span></span>
        <span class="te-stat"><span>LST</span><span style="color:#A5D6A7;">${lst.stats.count}</span></span>
      </div>`:''}
      ${kpiHtml}
      ${feedHtml}
      <div id="weather-${ev.id}" style="font-size:10px;color:var(--muted);padding:3px 0;display:none;border-top:1px solid var(--border);margin-top:4px;"></div>
      <div class="te-card-btns">
        <button id="tc-${ev.id}" class="te-btn track ${isTracked?'done':''}" data-evid="${ev.id}" ${isTracked?'disabled':''}>${isTracked?'TRACKED ✓':'TRACK'}</button>
        <button id="gp-${ev.id}" class="te-btn prices" data-evid="${ev.id}">GET PRICES</button>
      </div>`;

    const trackBtn=card.querySelector(`#tc-${ev.id}`);
    const pricesBtn=card.querySelector(`#gp-${ev.id}`);
    if(!isTracked&&trackBtn) trackBtn.addEventListener('click',()=>trackFromChat(String(ev.id)));
    if(pricesBtn){
      if(lst){ pricesBtn.textContent='PRICES SHOWN'; pricesBtn.disabled=true; pricesBtn.style.opacity='0.4'; }
      else { pricesBtn.addEventListener('click',()=>fetchChatListings(String(ev.id))); }
    }

    // Auto-fetch weather inline if within 15 days
    if(ev.venue_city&&(ev.date||ev.date_local)){
      const daysOut=Math.round((new Date(ev.date||ev.date_local)-new Date())/864e5);
      if(daysOut>=0&&daysOut<=15){
        const wEl=card.querySelector(`#weather-${ev.id}`);
        gasGet({action:'get_weather',city:encodeURIComponent(ev.venue_city),date:new Date(ev.date||ev.date_local).toISOString().split('T')[0]})
          .then(w=>{
            if(w.ok&&wEl){
              wEl.style.display='block';
              const precipColor=w.precip_pct>30?'var(--rss)':'var(--muted)';
              wEl.innerHTML=`${w.weather_label} · ${w.high_f}°/${w.low_f}°F · <span style="color:${precipColor};">${w.precip_pct}% precip</span> · ${w.wind_mph}mph wind`;
            }
          }).catch(()=>{});
      }
    }

    wrap.appendChild(card);
  });
  el.appendChild(wrap); el.scrollTop=el.scrollHeight;
}

// Track without requiring listings — registers event, fetches stats + weather + feed in ONE reply

async function trackFromChat(eid){
  const ev = chatEventStore[eid];
  if(!ev) return;
  const btn=document.getElementById(`tc-${eid}`); if(!btn||btn.disabled)return;
  btn.textContent='TRACKING...'; btn.style.opacity='0.5';
  try{
    const venueId     = ev.venue     ? 'v_'+ev.venue.replace(/[^\w]/g,'_').substring(0,30).toLowerCase() : '';
    const performerId = ev.performer ? 'p_'+ev.performer.replace(/[^\w]/g,'_').substring(0,30).toLowerCase() : '';
    const evRecord = {
      key: `TE::${String(ev.id)}`,  // canonical TEvo key — event_id only
      src:'TE', event_id:String(ev.id), name:ev.name||'',
      venue_id:venueId, venue:ev.venue||'', venue_city:ev.venue_city||'',
      performer_id:performerId, performer:ev.performer||'',
      date:ev.date||ev.date_local||'', added_at:new Date().toISOString(), history:[]
    };

    await gasPost({action:'track', event:evRecord});
    tracked[evRecord.key] = evRecord;
    renderSidebar(); updateTotal();
    btn.textContent='TRACKED ✓'; btn.classList.add('done'); btn.disabled=true; btn.style.opacity='1';
    toast(`TRACKING: ${ev.name}`);
    appendToolHint(`${ev.name} added · loading market data...`);

    // Fetch stats + weather in parallel
    const statsPromise = gasGet({
      action:'fetch_te_stats', event_id:String(ev.id),
      name:encodeURIComponent(ev.name||''), venue:encodeURIComponent(ev.venue||''),
      performer:encodeURIComponent(ev.performer||''), date:ev.date||ev.date_local||''
    });

    const weatherPromise = (ev.venue_city && (ev.date||ev.date_local)) ? (() => {
      const daysOut = Math.round((new Date(ev.date||ev.date_local)-new Date())/864e5);
      return daysOut>=0&&daysOut<=15
        ? gasGet({action:'get_weather', city:ev.venue_city, date:new Date(ev.date||ev.date_local).toISOString().split('T')[0]})
        : Promise.resolve(null);
    })() : Promise.resolve(null);

    const [statsData, weatherData] = await Promise.all([statsPromise, weatherPromise]);

    // Build single unified reply
    const lines = [];
    const dateStr = ev.date ? safeDateFull(ev.date) : '';
    lines.push(`**${ev.name}** — Now tracking`);
    lines.push(`${ev.venue}${ev.venue_city?', '+ev.venue_city:''} · ${dateStr}`);

    // Stats block
    if(statsData?.ok && statsData.stats){
      const s=statsData.stats, ext=statsData.extras||{};
      saveSnap('TE',ev.venue||'',ev.performer||'',String(ev.id),ev.name||'',ev.date||ev.date_local||'',s);
      renderSidebar();
      lines.push('');
      lines.push(`**Market** — Floor: $${s.floor} · Avg: $${s.avg} · Max: $${s.max} · ${s.count} listing groups [${statsData.source_label||'TEvo Stats'}]`);
      if(ext.tickets_count>0) lines.push(`${ext.tickets_count.toLocaleString()} tickets · Popularity: ${((ext.popularity_score||0)*100).toFixed(0)}%`);
    }

    // Weather block
    if(weatherData?.ok){
      const w=weatherData;
      const precipFlag = w.precip_pct>30 ? ` ⚠ ${w.precip_pct}% precip` : ` · ${w.precip_pct}% precip`;
      lines.push('');
      lines.push(`**Weather** — ${w.weather_label} · ${w.high_f}°/${w.low_f}°F${precipFlag} · ${w.wind_mph}mph`);
    }

    // Feed context block — from already-loaded feedItems
    const feedTerms = [ev.name, ev.performer, ev.venue]
      .flatMap(s=>(s||'').toLowerCase().split(/\s+at\s+|\s+vs\.?\s+|\s+@\s+/))
      .map(s=>s.replace(/[^\w\s]/g,'').trim()).filter(s=>s.length>=3);
    const feedMatches = feedItems.filter(item=>{
      const t=(item.title||'').trim();
      if(t.length<=5||/^pic\.?$|^image$/i.test(t)) return false;
      const text=[item.title||'',item.desc||'',item.source||''].join(' ').toLowerCase();
      return feedTerms.some(term=>text.includes(term));
    }).slice(0,3);

    if(feedMatches.length){
      lines.push('');
      lines.push(`**Feed (${feedMatches.length} related)**`);
      feedMatches.forEach(item=>{
        const impact=item.impact?` [${item.impact}]`:'';
        lines.push(`· ${item.title.substring(0,90)}${impact}`);
        if(item.reason&&item.reason!=='matched') lines.push(`  _${item.reason}_`);
      });
    } else {
      lines.push('');
      lines.push(`_No feed signals for this event — add keyword feeds in F9 to monitor_`);
    }

    appendChatMsg('ai', lines.join('\n'));
  }catch(e){
    btn.textContent='ERROR'; btn.style.color='var(--red)'; btn.style.borderColor='var(--red)'; btn.style.opacity='1';
    appendToolHint(`Track failed: ${e.message}`);
  }
}

async function fetchChatListings(eid){
  const ev = chatEventStore[eid];
  if(!ev) return;
  const btn=document.getElementById(`gp-${eid}`);
  if(btn){ btn.textContent='LOADING...'; btn.disabled=true; }
  appendToolHint(`fetching listings for ${ev.name}...`);

  try{
    // Fetch listings + weather in parallel
    const listingsPromise = gasGet({
      action:'fetch_te', event_id:eid,
      name:encodeURIComponent(ev.name||''), venue:encodeURIComponent(ev.venue||''),
      performer:encodeURIComponent(ev.performer||''), date:ev.date||ev.date_local||''
    });

    const weatherPromise = (ev.venue_city&&(ev.date||ev.date_local)) ? (() => {
      const daysOut=Math.round((new Date(ev.date||ev.date_local)-new Date())/864e5);
      return daysOut>=0&&daysOut<=15
        ? gasGet({action:'get_weather',city:ev.venue_city,date:new Date(ev.date||ev.date_local).toISOString().split('T')[0]})
        : Promise.resolve(null);
    })() : Promise.resolve(null);

    const [d, weatherData] = await Promise.all([listingsPromise, weatherPromise]);

    if(d.ok && d.stats && d.stats.count>0){
      const s=d.stats, w=d.wholesale_stats||{};
      const srcLabel=d.source_label||(d.source==='listings'?'TEvo Live':'TEvo Stats');
      const lines=[];
      const dateStr=ev.date?safeDateFull(ev.date):'';
      lines.push(`**${ev.name}**`);
      lines.push(`${ev.venue}${ev.venue_city?', '+ev.venue_city:''} · ${dateStr}`);
      lines.push('');

      // Pricing with source tag
      lines.push(`**Retail** — Floor: $${s.floor} · Median: $${s.median} · Avg: $${s.avg} · Max: $${s.max} · ${s.count} listings [${srcLabel}]`);
      if(w.floor&&w.count>0&&(w.floor!==s.floor||w.avg!==s.avg))
        lines.push(`**Wholesale** — Floor: $${w.floor} · Avg: $${w.avg} · Max: $${w.max}`);
      if(d.delivery?.in_hand_count>0||d.delivery?.instant_delivery_count>0)
        lines.push(`${d.delivery.in_hand_count||0} in-hand · ${d.delivery.instant_delivery_count||0} instant delivery`);
      if(d.source==='stats') lines.push(`_(aggregate stats — live listings not available)_`);

      // Weather
      if(weatherData?.ok){
        const wr=weatherData;
        const precipFlag=wr.precip_pct>30?` ⚠ ${wr.precip_pct}% precip`:` · ${wr.precip_pct}% precip`;
        lines.push('');
        lines.push(`**Weather** — ${wr.weather_label} · ${wr.high_f}°/${wr.low_f}°F${precipFlag} · ${wr.wind_mph}mph`);
      }

      // Feed context
      const feedTerms=[ev.name,ev.performer,ev.venue]
        .flatMap(s=>(s||'').toLowerCase().split(/\s+at\s+|\s+vs\.?\s+|\s+@\s+/))
        .map(s=>s.replace(/[^\w\s]/g,'').trim()).filter(s=>s.length>=3);
      const feedMatches=feedItems.filter(item=>{
        const t=(item.title||'').trim();
        if(t.length<=5||/^pic\.?$|^image$/i.test(t)) return false;
        const text=[item.title||'',item.desc||'',item.source||''].join(' ').toLowerCase();
        return feedTerms.some(term=>text.includes(term));
      }).slice(0,3);

      lines.push('');
      if(feedMatches.length){
        lines.push(`**Feed (${feedMatches.length} related)**`);
        feedMatches.forEach(item=>{
          const impact=item.impact?` [${item.impact}]`:'';
          lines.push(`· ${item.title.substring(0,90)}${impact}`);
          if(item.reason&&item.reason!=='matched') lines.push(`  _${item.reason}_`);
        });
      } else {
        lines.push(`_No feed signals — check F9 to add keyword feeds_`);
      }

      appendChatMsg('ai', lines.join('\n'));
      if(btn){ btn.textContent='PRICES SHOWN'; btn.style.opacity='0.4'; }

      // Auto-save snapshot if tracked
      const key=`TE::${eid}`;
      if(tracked[key]){ saveSnap('TE',ev.venue||'',ev.performer||'',eid,ev.name||'',ev.date||ev.date_local||'',s); renderSidebar(); }
      return;
    }

    appendChatMsg('ai', `${ev.name}\n${d.error||'No listings or stats available'}`);
    if(btn){ btn.textContent='NO DATA'; btn.style.opacity='0.5'; }

  }catch(e){
    appendChatMsg('ai', `Failed to fetch: ${e.message}`);
    if(btn){ btn.textContent='GET PRICES'; btn.disabled=false; }
  }
}
