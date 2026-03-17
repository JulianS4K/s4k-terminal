// ================================================================
// feed.js — S4K Terminal
// F4 live feed — X/Twitter + ESPN merged, event strip
// ================================================================
'use strict';

async function loadFeed(){
  const btn=document.getElementById('btn-feed-ref');
  btn.disabled=true; btn.textContent='FETCHING...'; setSt('FETCHING LIVE FEED...');
  try{
    // Fetch X/Twitter (feed_items/) and ESPN (espn_feed/) in parallel
    const [xItems, espnItems] = await Promise.allSettled([
      loadXFeedItems(),
      loadEspnFeedItems()
    ]);

    xFeedItems    = xItems.status==='fulfilled'    ? xItems.value    : xFeedItems;
    espnFeedItems = espnItems.status==='fulfilled' ? espnItems.value : espnFeedItems;

    // Merge + sort by pubDate descending
    feedItems = mergeFeeds(xFeedItems, espnFeedItems);

    const xCount    = xFeedItems.length;
    const espnCount = espnFeedItems.length;
    const matched   = feedItems.filter(i=>i.matched||i.event_id).length;

    document.getElementById('feed-badge').textContent=`${feedItems.length} ITEMS${matched?` · ${matched} MATCHED`:''}`;
    const srcEl = document.getElementById('feed-src-counts');
    if(srcEl) srcEl.textContent=`𝕏 ${xCount} · ESPN ${espnCount}`;
    document.getElementById('feed-updated').textContent=` · ${new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})}`;

    feedItems.length ? renderFeed() : document.getElementById('feed-list').innerHTML=`<div class="empty"><span style="font-size:16px;color:var(--border);">▬▬▬</span><span>NO ITEMS YET<span class="blink">_</span></span><span style="font-size:10px;">CREATE FEEDS IN MANAGE SOURCES · ITEMS ARRIVE VIA WEBHOOK</span></div>`;

    // Update event context strip if an event is selected
    if(selKey) updateEventFeedStrip(selKey);
    setSt('FEED READY');
  }catch(e){toast(`FEED FAILED: ${e.message}`,'err');setSt('FEED ERROR');}
  btn.disabled=false; btn.textContent='REFRESH';
}

// Fetch X/Twitter items from feed_items/ Firestore

async function loadXFeedItems(){
  try {
    const opts = {limit:300};
    const docs = await FS.getFeedItems(opts);
    return docs.map(d=>({
      title:    d.post_text||d.title||'',
      link:     d.post_url||d.url||'',
      desc:     d.post_full||d.description||'',
      pubDate:  d.posted_at||d.received_ts||'',
      source:   d.feed_name||d.feed_title||'',
      author:   d.author_name||'',
      handle:   d.author_handle||'',
      league:   d.league||d.feed_league||d.attr_league||'General',
      impact:   d.impact||null,
      category: d.attr_category||d.category||null,
      matched:  d.matched||!!(d.matched_event_id),
      event_id: d.matched_event_id||'',
      event_name:d.matched_event_name||'',
      price_floor:d.price_floor_at_match||0,
      keywords: d.attr_keywords||[],
      srcType:  'x',
      affected_event_ids:  d.affected_event_ids||[],
      affected_event_names:d.affected_event_names||[]
    }));
  } catch(e) {
    // GAS fallback
    const d = await gasGet({action:'get_rss_live', limit:300});
    return (d.items||[]).map(i=>({
      title:i.post_text||i.item_title||'', link:i.post_url||i.item_url||'',
      desc:i.post_full||i.item_description||'',
      pubDate:i.posted_at||i.item_published||i.received_ts||'',
      source:i.feed_name||i.feed_title||'', author:i.author_name||'',
      handle:i.author_handle||'', league:i.league||i.feed_league||'General',
      impact:i.impact||null, category:i.attr_category||i.category||null,
      matched:!!(i.matched_event_id), event_id:i.matched_event_id||'',
      event_name:i.matched_event_name||'', price_floor:i.price_floor_at_match||0,
      keywords:[], srcType:'x'
    }));
  }
}

// Fetch ESPN items from espn_feed/ Firestore

async function loadEspnFeedItems(){
  try {
    const docs = await FS.query(
      'espn_feed',
      [{field:'matched', op:'EQUAL', value:true}],
      [{field:'received_ts', dir:'DESCENDING'}],
      300
    );
    return docs.map(d=>({
      title:    d.title||'',
      link:     d.article_url||'',
      desc:     d.description||'',
      pubDate:  d.pub_date||d.received_ts||'',
      source:   d.creator||'ESPN',
      author:   d.creator||'',
      handle:   '',
      league:   d.feed_league||'General',
      impact:   d.impact||null,
      category: 'espn',
      matched:  !!(d.matched_event_id||d.matched),
      event_id: d.matched_event_id||'',
      event_name:d.matched_event_name||'',
      price_floor:0,
      keywords: (d.keywords_hit||'').split(',').filter(Boolean),
      srcType:  'espn'
    }));
  } catch(e) { return []; }
}

// Merge X + ESPN, deduplicate by title similarity, sort newest first.
// Also builds eventFeedMap: eventId → all feed items affecting that event.
// Uses affected_event_ids (many-to-many) not just matched_event_id.

function mergeFeeds(x, espn){
  const all = [...x, ...espn];

  // Deduplicate: same title prefix within 30 min = same story
  const seen = new Map();
  const merged = all
    .filter(item => {
      if(!item.title||item.title.length<5) return false;
      const key = item.title.substring(0,40).toLowerCase().replace(/[^\w]/g,'');
      const ts  = new Date(item.pubDate||0).getTime();
      const prev = seen.get(key);
      if(prev && Math.abs(prev.ts - ts) < 30*60*1000) return false;
      seen.set(key, {ts});
      return true;
    })
    .sort((a,b)=>new Date(b.pubDate||0)-new Date(a.pubDate||0));

  // Build eventFeedMap — which feed items affect which tracked events
  // Sources: affected_event_ids (GAS multi-match) + matched_event_id (primary)
  const newMap = {};
  merged.forEach(item => {
    const eids = new Set();
    // Add all affected events (the many-to-many field)
    (item.affected_event_ids||[]).forEach(eid => { if(eid) eids.add(String(eid)); });
    // Always include primary match too
    if(item.event_id) eids.add(String(item.event_id));

    eids.forEach(eid => {
      if(!newMap[eid]) newMap[eid] = [];
      newMap[eid].push(item);
    });
  });
  eventFeedMap = newMap;

  return merged;
}


    const prevCount=feedItems.length;
    feedItems=items;
    const newCount=feedItems.length;
    const matched=feedItems.filter(i=>i.matched||i.event_id).length;
    document.getElementById('feed-badge').textContent=`${newCount} ITEMS${matched?` · ${matched} MATCHED`:''}`;
    document.getElementById('feed-updated').textContent=`updated ${new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})}`;
    if(newCount>prevCount) bumpBadge('feed-badge',newCount-prevCount);
    newCount?renderFeed():document.getElementById('feed-list').innerHTML=`<div class="empty"><span style="font-size:16px;color:var(--border);">▬▬▬</span><span>NO ITEMS YET<span class="blink">_</span></span><span style="font-size:10px;">CREATE FEEDS IN MANAGE SOURCES · ITEMS ARRIVE VIA WEBHOOK</span></div>`;
    setSt('FEED READY');
  }catch(e){toast(`FEED FAILED: ${e.message}`,'err');setSt('FEED ERROR');}
  btn.disabled=false; btn.textContent='REFRESH';
}

async function scoreLiveFeed(){
  const btn=document.getElementById('btn-score'); btn.disabled=true; btn.textContent='SCORING...'; setSt('AI SCORING...');
  try{ const d=await gasPost({action:'score_rss_live'}); if(d.error){toast(`SCORE FAILED: ${d.error}`,'err');}else{toast(`${d.scored||0} ITEMS SCORED`);await loadFeed();} }
  catch(e){toast(`SCORE FAILED: ${e.message}`,'err');}
  btn.disabled=false; btn.textContent='SCORE WITH AI'; setSt('READY');
}

function setLF(l,el){
  lfilt=l;
  document.querySelectorAll('.feed-bar .fpill').forEach(p=>p.classList.remove('active'));
  el.classList.add('active');
  const sub = document.getElementById('feed-subtitle');
  if(sub){
    if(l==='event' && selKey && tracked[selKey]) sub.textContent = `Showing: ${tracked[selKey].name} — last 14 days`;
    else if(l==='matched') sub.textContent = 'Showing: items matched to tracked events';
    else if(l==='all') sub.textContent = 'X/Twitter + ESPN merged · filter by league or event';
    else sub.textContent = `Showing: ${l} · X/Twitter + ESPN`;
  }
  renderFeed();
}

function setIF(i,el){
  ifilt=ifilt===i?null:i;
  document.querySelectorAll('#f-high,#f-med').forEach(p=>p.classList.remove('active'));
  if(ifilt) el.classList.add('active');
  renderFeed();
}

function setSrc(s,el){
  sfilt=sfilt===s?null:s;
  document.querySelectorAll('#fsrc-x,#fsrc-espn').forEach(p=>p.classList.remove('active'));
  if(sfilt) el.classList.add('active');
  renderFeed();
}

// ── Event context feed strip ──────────────────────────────────────
// Shown at top of F4 when an event is selected.
// Shows items from last 14 days mentioning the event's team/performer.
// Sources: both xFeedItems and espnFeedItems.

function updateEventFeedStrip(key){
  const strip  = document.getElementById('event-feed-strip');
  const itemEl = document.getElementById('event-feed-items');
  const label  = document.getElementById('event-feed-label');
  const count  = document.getElementById('event-feed-count');
  const pill   = document.getElementById('fpill-event');
  if(!strip||!itemEl) return;

  const ev = tracked[key];
  if(!ev){ strip.style.display='none'; if(pill)pill.style.display='none'; return; }

  const cutoff = Date.now() - 14*24*3600*1000;

  // Primary: eventFeedMap (from affected_event_ids — many-to-many, most accurate)
  let relevant = (eventFeedMap[String(ev.event_id||'')] || [])
    .filter(i => new Date(i.pubDate||0).getTime() > cutoff)
    .sort((a,b) => new Date(b.pubDate||0) - new Date(a.pubDate||0));

  // Fallback: text match (for items before affected_event_ids was added)
  if(relevant.length === 0 && feedItems.length > 0){
    const terms = [(ev.performer||''),(ev.name||'')]
      .flatMap(s=>s.toLowerCase().split(/\s+(?:at|vs\.?|@)\s+/).flatMap(t=>t.split(/\s+/)))
      .map(t=>t.replace(/[^\w]/g,'').trim()).filter(t=>t.length>=4);
    relevant = feedItems.filter(item=>{
      if(!item.title||item.title.length<5) return false;
      const age=new Date(item.pubDate||0).getTime();
      if(age<cutoff) return false;
      if(item.event_id&&String(item.event_id)===String(ev.event_id)) return true;
      const text=(item.title+' '+(item.desc||'')).toLowerCase();
      return terms.some(t=>text.includes(t));
    }).sort((a,b)=>new Date(b.pubDate||0)-new Date(a.pubDate||0));
  }

  if(!relevant.length){ strip.style.display='none'; if(pill)pill.style.display='none'; return; }

  strip.style.display='block';
  if(pill) pill.style.display='inline-block';
  const evName=(ev.name||'').length>30?(ev.name||'').substring(0,30)+'...':(ev.name||'');
  label.textContent=`${evName} — last 14 days`;
  const highCount=relevant.filter(i=>i.impact==='High').length;
  count.style.color=highCount?'var(--red)':'var(--muted)';
  count.textContent=`${relevant.length} items${highCount?' · '+highCount+' HIGH':''}`;

  itemEl.innerHTML=relevant.slice(0,20).map(item=>{
    const srcIcon=item.srcType==='espn'?'📺':'🐦';
    const impColor=item.impact==='High'?'var(--red)':item.impact==='Medium'?'var(--amber)':'var(--muted)';
    const handle=item.handle?item.handle:item.source||item.author||'';
    const alsoAffects=(item.affected_event_names||[]).filter(n=>n!==ev.name).slice(0,2);
    const alsoStr=alsoAffects.length?`<span style="color:var(--muted);"> · also: ${alsoAffects.join(', ')}</span>`:'';
    return `<div style="display:flex;gap:8px;align-items:flex-start;padding:4px 0;border-bottom:1px solid var(--bg3);cursor:pointer;" onclick="${item.link?`window.open('${item.link.replace(/'/g,"")}','_blank')`:''}">
      <span style="font-size:11px;flex-shrink:0;">${srcIcon}</span>
      <div style="flex:1;min-width:0;">
        <div style="font-size:11px;color:var(--white);line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${item.title}</div>
        <div style="font-size:10px;color:var(--muted);display:flex;gap:8px;margin-top:1px;flex-wrap:wrap;">
          <span style="color:${impColor};">${item.impact||'—'}</span><span>${handle}</span>
          <span>${ago(item.pubDate)}</span>
          ${item.keywords&&item.keywords.length?`<span style="color:var(--cyan);">${item.keywords.slice(0,2).join(', ')}</span>`:''}
          ${alsoStr}
        </div>
      </div>
      <button onclick="event.stopPropagation();feedToChat('${(item.title||'').replace(/['"]/g,'').substring(0,80)}','${handle}')" style="font-size:9px;padding:1px 6px;border:1px solid var(--purple);color:var(--purple);background:transparent;cursor:pointer;font-family:var(--font);flex-shrink:0;">AI</button>
    </div>`;
  }).join('');
}

function renderFeed(){
  const kw=(document.getElementById('feed-kw').value||'').toLowerCase();
  let items=[...feedItems];

  // Source filter
  if(sfilt==='x')    items=items.filter(i=>i.srcType==='x');
  if(sfilt==='espn') items=items.filter(i=>i.srcType==='espn');

  // League / special filters
  if(lfilt&&lfilt!=='all'){
    if(lfilt==='matched') items=items.filter(i=>i.matched||i.event_id);
    else if(lfilt==='event'){
      // Show items relevant to selected event
      const ev=selKey?tracked[selKey]:null;
      if(ev){
        const terms=[(ev.performer||''),(ev.name||'')]
          .flatMap(s=>s.toLowerCase().split(/\s+(?:at|vs\.?|@)\s+/).flatMap(t=>t.split(/\s+/)))
          .map(t=>t.replace(/[^\w]/g,'').trim()).filter(t=>t.length>=4);
        const cutoff=Date.now()-14*24*3600*1000;
        items=items.filter(i=>{
          if(new Date(i.pubDate||0).getTime()<cutoff) return false;
          if(i.event_id&&String(i.event_id)===String(ev.event_id)) return true;
          const text=(i.title+' '+(i.desc||'')).toLowerCase();
          return terms.some(t=>text.includes(t));
        });
      }
    }
    else items=items.filter(i=>(i.league||'').toLowerCase()===lfilt.toLowerCase());
  }

  if(ifilt) items=items.filter(i=>i.impact===ifilt);
  if(kw)    items=items.filter(i=>(i.title||'').toLowerCase().includes(kw)||(i.handle||'').toLowerCase().includes(kw)||(i.desc||'').toLowerCase().includes(kw)||(i.keywords||[]).some(k=>k.includes(kw)));

  const el=document.getElementById('feed-list');
  if(!items.length){el.innerHTML=`<div class="empty" style="height:200px;"><span style="color:var(--muted);font-size:11px;">NO ITEMS MATCH FILTER</span></div>`;return;}
  el.innerHTML=items.slice(0,200).map(item=>{
    const isMatched=item.matched||!!(item.event_id);
    const srcIcon = item.srcType==='espn'?'<span style="font-size:9px;padding:0 4px;border:1px solid var(--cyan);color:var(--cyan);margin-right:4px;">ESPN</span>':'';
    const authorStr = item.handle ? item.handle : item.source||item.author||'';
    const priceStr  = item.price_floor>0 ? `<span style="font-size:9px;color:var(--cyan);margin-left:6px;">$${item.price_floor} at arrival</span>` : '';
    const eventStr  = item.event_name ? `<span style="font-size:9px;color:var(--amber);margin-left:6px;">→ ${item.event_name.substring(0,28)}</span>` : '';
    const kwStr     = item.keywords&&item.keywords.length ? `<span style="font-size:9px;color:var(--purple);margin-left:6px;">${item.keywords.slice(0,2).join(' · ')}</span>` : '';
    return`<div class="fi" style="${isMatched?'border-left:3px solid var(--rss);':''}" onclick="${item.link?`window.open('${item.link.replace(/'/g,'')}','_blank')`:''}">
      <div class="fi-top">
        <div class="fi-title">${srcIcon}${item.title}</div>
        ${item.impact?`<span class="fi-imp ${item.impact}">${item.impact.toUpperCase()}</span>`:''}
        ${isMatched?`<span style="font-size:9px;padding:1px 5px;border:1px solid var(--rss);color:var(--rss);margin-left:4px;">MATCHED</span>`:''}
      </div>
      <div class="fi-meta">
        <span class="fi-src">${authorStr}</span>
        <span class="fi-tag">${item.league||'General'}</span>
        <span class="fi-time">${ago(item.pubDate)}</span>
        ${priceStr}${eventStr}${kwStr}
      </div>
      ${item.desc&&item.desc!==item.title?`<div class="fi-desc">${item.desc.substring(0,140)}${item.desc.length>140?'...':''}</div>`:''}
      <div style="margin-top:6px;"><button onclick="event.stopPropagation();feedToChat('${(item.title||'').replace(/'/g,'').replace(/"/g,'').substring(0,80)}','${authorStr}')" style="font-size:9px;padding:2px 8px;border:1px solid var(--purple);color:var(--purple);background:transparent;cursor:pointer;font-family:var(--font);">ASK AI ↗</button></div>
    </div>`;
  }).join('');
}

function feedToChat(title, source){
  // Switch to F6 intelligence tab
  showPanel('intel', document.querySelectorAll('.fkey')[5]);
  switchIntelTab('chat', document.getElementById('itab-chat'));
  // Pre-fill the chat with context from the feed item
  const input=document.getElementById('chat-input');
  input.value=`This just came through the feed from ${source||'a source'}: "${title}" — what does this mean for ticket prices and inventory? Check upcoming events and related feed items.`;
  input.focus();
  // Scroll to bottom of chat
  const chatEl=document.getElementById('chat-messages');
  chatEl.scrollTop=chatEl.scrollHeight;
  toast('FEED ITEM SENT TO CHAT');
}

function startFeedPoll(){
  stopFeedPoll();
  feedPollTimer = setInterval(loadFeed, 2*60*1000); // refresh feed every 2 min while F4 open
}

function stopFeedPoll(){ if(feedPollTimer){clearInterval(feedPollTimer);feedPollTimer=null;} }

async function createRSSFeed(){
  const type=document.getElementById('rss-type').value,input=document.getElementById('rss-input').value.trim(),league=document.getElementById('rss-league').value;
  const st=document.getElementById('rss-create-status');
  if(!input){toast('ENTER A KEYWORD OR URL','err');return;}
  st.textContent='CREATING IN RSS.APP...'; st.style.color='var(--amber)';
  try{
    const payload={league}; if(type==='keyword')payload.keyword=input; else payload.url=input;
    const d=await gasPost({action:'rss_create_feed',...payload});
    if(d.error){st.textContent=`ERROR: ${d.error}`;st.style.color='var(--red)';return;}
    st.textContent=`CREATED: ${d.feed?.title||input}`; st.style.color='var(--green)';
    document.getElementById('rss-input').value=''; toast('FEED CREATED'); await loadRSSFeeds();
  }catch(e){st.textContent=`FAILED: ${e.message}`;st.style.color='var(--red)';}
}

async function loadRSSFeeds(){
  const el=document.getElementById('rss-feed-list'); el.innerHTML='<div style="color:var(--muted);font-size:11px;">Loading from rss.app...</div>';
  try{
    const d=await gasGet({action:'rss_list_feeds'}); const feeds=d.feeds||[];
    const c=getCreds(); c._rssCount=feeds.length; localStorage.setItem(CKEY,JSON.stringify(c)); updateSrcBar(c);
    if(!feeds.length){el.innerHTML='<div style="color:var(--muted);font-size:11px;">No feeds yet — create one above</div>';return;}
    el.innerHTML=feeds.map(f=>`<div class="src-row"><div class="src-name" title="${f.source_url||''}">${f.title||f.id}</div><span style="font-size:10px;color:${f.is_active?'var(--green)':'var(--muted)'};">${f.is_active?'ACTIVE':'OFF'}</span><a href="${f.rss_feed_url||'#'}" target="_blank" style="font-size:10px;color:var(--rss);text-decoration:none;flex-shrink:0;">RSS ↗</a><button class="src-del" onclick="deleteRSSFeed('${f.id}','${(f.title||f.id).replace(/'/g,'')}')">REMOVE</button></div>`).join('');
  }catch(e){el.innerHTML=`<div style="color:var(--red);font-size:11px;">FAILED: ${e.message}</div>`;}
}

async function deleteRSSFeed(feedId,name){ if(!confirm(`Remove "${name}" from rss.app?`))return; try{await gasPost({action:'rss_delete_feed',feed_id:feedId});toast(`REMOVED: ${name}`);await loadRSSFeeds();}catch(e){toast(`FAILED: ${e.message}`,'err');} }

function updateRssLabel(){ const t=document.getElementById('rss-type').value,lbl=document.getElementById('rss-input-lbl'),inp=document.getElementById('rss-input'); if(t==='url'){lbl.textContent='WEBSITE URL';inp.placeholder='e.g. https://espn.com/nba';}else{lbl.textContent='KEYWORD OR TOPIC';inp.placeholder='e.g. Lakers injury, NBA trade deadline';} }

// ================================================================
// F5 — THEME ENGINE
// ================================================================
let currentTheme={preset:'default',custom:{},bg:'none',cursor:'default',name:'',marquee:''};
const PRESETS={
  default:{},
  matrix:{'--bg':'#000800','--bg2':'#001200','--bg3':'#001A00','--amber':'#00FF41','--amber2':'#00CC33','--green':'#00FF41','--cyan':'#00FF41','--purple':'#00FF41','--white':'#CCFFCC','--muted':'#2A6B2A','--border':'#003300','--rss':'#00FF41','--sg':'#00FF41','--te':'#00FF41'},
  myspace:{'--bg':'#220033','--bg2':'#2D0044','--bg3':'#380055','--amber':'#FF00FF','--amber2':'#CC00CC','--green':'#FF00FF','--cyan':'#FF99FF','--purple':'#FF00FF','--white':'#FFD6FF','--muted':'#9933AA','--border':'#550077','--rss':'#FF00FF'},
  aol:{'--bg':'#000033','--bg2':'#000044','--bg3':'#000055','--amber':'#FFCC00','--amber2':'#FF9900','--green':'#00CC00','--cyan':'#00CCFF','--purple':'#CC99FF','--white':'#EEEEFF','--muted':'#4444AA','--border':'#0000AA','--rss':'#FF6600'},
  geocities:{'--bg':'#000000','--bg2':'#0A0A1A','--bg3':'#111122','--amber':'#FF6600','--amber2':'#FF3300','--green':'#FFFF00','--cyan':'#00FFFF','--purple':'#FF00FF','--white':'#FFFFFF','--muted':'#666666','--border':'#333333','--rss':'#FF6600'},
  winamp:{'--bg':'#1A1A2E','--bg2':'#16213E','--bg3':'#0F3460','--amber':'#E94560','--amber2':'#C73652','--green':'#00B4D8','--cyan':'#90E0EF','--purple':'#E94560','--white':'#CAF0F8','--muted':'#457B9D','--border':'#1D3557','--rss':'#E94560'},
  livejournal:{'--bg':'#1A0A00','--bg2':'#240E00','--bg3':'#2E1200','--amber':'#FF8C00','--amber2':'#FF6600','--green':'#ADFF2F','--cyan':'#FFD700','--purple':'#FF69B4','--white':'#FFF5E6','--muted':'#7A4A00','--border':'#3D1A00','--rss':'#FF8C00'},
  xanga:{'--bg':'#0D0D1A','--bg2':'#141428','--bg3':'#1A1A33','--amber':'#66CCFF','--amber2':'#3399FF','--green':'#66FF66','--cyan':'#66CCFF','--purple':'#CC99FF','--white':'#E6F0FF','--muted':'#336699','--border':'#1A3366','--rss':'#66CCFF'}
};
const BG_MAPS={none:{bg:'',size:''},dots:{bg:'radial-gradient(circle,rgba(255,255,255,0.12) 1px,transparent 1px)',size:'18px 18px'},grid:{bg:'linear-gradient(rgba(255,255,255,0.04) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,0.04) 1px,transparent 1px)',size:'22px 22px'},scanline:{bg:'repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,0.2) 2px,rgba(0,0,0,0.2) 4px)',size:'auto'},stars:{bg:'radial-gradient(1px 1px at 20% 30%,white,transparent),radial-gradient(1px 1px at 40% 70%,white,transparent),radial-gradient(1px 1px at 60% 20%,white,transparent),radial-gradient(1px 1px at 80% 60%,white,transparent)',size:'auto'},diagonal:{bg:'repeating-linear-gradient(45deg,rgba(255,255,255,0.02),rgba(255,255,255,0.02) 1px,transparent 1px,transparent 10px)',size:'auto'},circuit:{bg:'linear-gradient(rgba(0,255,65,0.05) 1px,transparent 1px),linear-gradient(90deg,rgba(0,255,65,0.05) 1px,transparent 1px)',size:'40px 40px'},noise:{bg:'',size:''}};

function renderF4Portfolio(){
  const el=document.getElementById('f4-portfolio');
  if(!el)return;
  const evs=Object.values(tracked);
  if(!evs.length){el.innerHTML='<div style="color:var(--muted);font-size:10px;padding:8px 0;">No tracked events yet.</div>';return;}
  el.innerHTML=`<div style="font-size:9px;color:var(--cyan);letter-spacing:.1em;margin-bottom:6px;">PORTFOLIO — ${evs.length} TRACKED</div>`+
    evs.map(ev=>{
      const hist=(ev.history||[]).filter(s=>s.floor>0&&s.avg>0);
      const lat=hist.length?hist[hist.length-1]:null;
      const prev=hist.length>1?hist[hist.length-2]:null;
      const fd=lat&&prev?lat.floor-prev.floor:null;
      const cd=lat&&prev?lat.count-prev.count:null;
      const dateStr=ev.date?safeDate(ev.date,{month:'short',day:'numeric'}):''
      return `<div style="padding:5px 0;border-bottom:1px solid rgba(255,255,255,0.05);display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <div style="flex:1;min-width:120px;">
          <div style="font-size:10px;color:var(--white);line-height:1.3;">${(ev.name||ev.event_name||'').substring(0,40)}</div>
          <div style="font-size:9px;color:var(--muted);">${dateStr}</div>
        </div>
        ${lat?`
          <span style="font-size:10px;"><span style="color:var(--muted);">FL </span><span style="color:var(--cyan);">$${lat.floor}</span>${fd!==null?`<span style="color:${fd>0?'var(--red)':'var(--green)'};">${fd>0?'▲':'▼'}${Math.abs(fd)}</span>`:''}</span>
          <span style="font-size:10px;"><span style="color:var(--muted);">AVG </span><span style="color:var(--amber);">$${lat.avg}</span></span>
          <span style="font-size:10px;"><span style="color:var(--muted);">LST </span><span style="color:#A5D6A7;">${(lat.count||0)}</span>${cd!==null?`<span style="color:${cd<0?'var(--red)':'var(--green)'};">${cd>0?'+':''}${cd}</span>`:''}</span>
        `:`<span style="font-size:9px;color:var(--muted);">no data</span>`}
      </div>`;
    }).join('');
}

// ================================================================
// 5-MINUTE SNAPSHOT POLL — silently detects hourly auto-refresh
// ================================================================
// ================================================================
// REAL-TIME FIRESTORE LISTENER
// ================================================================
// Replaces the old 5-min checkForNewSnapshots poll.
// Uses Firestore REST :listen endpoint (Server-Sent Events).
// When GAS writes a new tevo/ snapshot, terminal receives it
// within seconds and updates only the affected event's chart.
//
// Firestore :listen uses long-polling (keepalive HTTP connection).
// If connection drops (tab sleep, network), auto-reconnects.
// Falls back to 5-min poll if Firestore auth not available.
// ================================================================

let _realtimeController = null; // AbortController for cleanup
let _realtimeRetryTimer = null;
let _realtimeActive     = false;
