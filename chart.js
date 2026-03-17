// ================================================================
// chart.js — S4K Terminal
// Price chart rendering, feed markers, chart controls
// ================================================================
'use strict';

function renderChart(r){
  const canvas=document.getElementById('main-ch'),empty=document.getElementById('empty-ch');
  const h=(r.history||[]).filter(s=>s.floor>0&&!isNaN(s.floor));
  if(!h.length){
    canvas.style.display='none';
    empty.style.display='flex';
    // Show diagnostic — why is there no data?
    const snapCount = (r.history||[]).length;
    const badSnaps  = (r.history||[]).filter(s=>!(s.floor>0)).length;
    const msg = snapCount===0
      ? 'NO SNAPSHOTS YET — GAS trigger will write data every 5-15 min'
      : `${snapCount} SNAPSHOT${snapCount!==1?'S':''} FILTERED — floor must be > $0 (${badSnaps} invalid)`;
    const msgEl = empty.querySelector('span:nth-child(3)');
    if(msgEl) msgEl.textContent = msg;
    return;
  }
  // Single data point — show as large dot instead of line
  const singlePoint = h.length === 1;
  canvas.style.display='block';empty.style.display='none';
  const labels=h.map(s=>{const d=new Date(s.ts);return`${d.getMonth()+1}/${d.getDate()} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;});
  if(chart){chart.destroy();chart=null;}

  // Build feed markers — from Firestore-loaded ev.feedMarkers
  // Markers are loaded by loadEventFeedMarkers() when event is selected.
  // Each marker has: {ts, title, source, impact, color, sourceType, keywords}
  const rawMarkers = r.feedMarkers || buildFallbackMarkers(r);
  const feedMarkers = [];

  rawMarkers.forEach(marker => {
    const markerTs = new Date(marker.ts).getTime();
    if (isNaN(markerTs)) return;
    // Find the nearest snapshot index (within ±6 hours)
    let bestIdx = -1, bestDiff = 6*3600*1000;
    h.forEach((snap, i) => {
      const diff = Math.abs(new Date(snap.ts).getTime() - markerTs);
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
    });
    if (bestIdx < 0) return; // no nearby snapshot

    // Use floor price at that snapshot for marker Y position
    const y = h[bestIdx].floor || h[bestIdx].avg || 0;
    // Stack multiple markers at same index slightly apart
    const existing = feedMarkers.filter(m => m.x === bestIdx).length;
    feedMarkers.push({
      x:          bestIdx,
      y:          y * (1 + existing * 0.015), // tiny vertical offset if stacked
      label:      marker.title.substring(0,70) + (marker.title.length>70?'...':''),
      source:     marker.source,
      color:      marker.color,
      impact:     marker.impact,
      sourceType: marker.sourceType,
      keywords:   (marker.keywords||[]).join(', ')
    });
  });

  const base={responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},
    plugins:{legend:{labels:{color:'#5A7A60',font:{family:"'IBM Plex Mono',monospace",size:10},boxWidth:12,padding:14}},
      tooltip:{backgroundColor:'rgba(0,0,0,0.4)',borderColor:'#1E2E22',borderWidth:1,titleColor:'#FFB300',bodyColor:'#E8F0E8',padding:10,titleFont:{family:"'IBM Plex Mono',monospace",size:11},bodyFont:{family:"'IBM Plex Mono',monospace",size:11},
        callbacks:{
          afterBody: ctx=>{
            if(!feedMarkers.length) return [];
            const idx=ctx[0]?.dataIndex;
            const hits=feedMarkers.filter(m=>m.x===idx);
            if(!hits.length) return [];
            const lines = [''];
            hits.forEach(m => {
              const src = m.sourceType==='espn' ? '📺 ESPN' : '🐦 X';
              lines.push(`${src} [${m.impact||'—'}] ${m.label}`);
              if(m.source) lines.push(`  ${m.source}`);
              if(m.keywords) lines.push(`  keywords: ${m.keywords}`);
            });
            return lines;
          }
        }
      }
    },
    scales:{x:{ticks:{color:'#5A7A60',font:{family:"'IBM Plex Mono',monospace",size:9},maxRotation:45},grid:{color:'rgba(255,255,255,0.06)'},border:{color:'rgba(255,255,255,0.08)'}},y:{ticks:{color:'#5A7A60',font:{family:"'IBM Plex Mono',monospace",size:10}},grid:{color:'rgba(255,255,255,0.06)'},border:{color:'rgba(255,255,255,0.08)'}}}};

  if(cmode==='price'){
    base.scales.y.ticks.callback=v=>'$'+v.toLocaleString();
    base.plugins.tooltip.callbacks.label=ctx=>` ${ctx.dataset.label}: $${ctx.parsed.y.toLocaleString()}`;
    // Single data point: increase point radius so it's visible as a dot
    const pr = singlePoint ? 8 : 4;
    const ds=[];
    if(son.floor)ds.push({label:'FLOOR',data:h.map(s=>s.floor),borderColor:'#00E5FF',backgroundColor:'rgba(0,229,255,0.05)',tension:0.3,pointRadius:pr,fill:true,borderWidth:1.5,spanGaps:true});
    if(son.med)  ds.push({label:'MEDIAN',data:h.map(s=>s.median),borderColor:'#CE93D8',backgroundColor:'rgba(206,147,216,0.05)',tension:0.3,pointRadius:pr,fill:!son.floor,borderWidth:2,spanGaps:true});
    if(son.avg)  ds.push({label:'AVG',data:h.map(s=>s.avg),borderColor:'#FFB300',tension:0.3,pointRadius:singlePoint?8:3,fill:false,borderWidth:1.5,borderDash:singlePoint?[]:[4,3],spanGaps:true});
    if(son.max)  ds.push({label:'MAX',data:h.map(s=>s.max),borderColor:'#FF1744',tension:0.3,pointRadius:singlePoint?8:3,fill:false,borderWidth:1,borderDash:singlePoint?[]:[2,4],spanGaps:true});
    // Feed marker overlay dataset
    if(feedMarkers.length){
      ds.push({
        label:'FEED',
        data:h.map((_,i)=>{
          const hit=feedMarkers.find(m=>m.x===i);
          return hit?hit.y:null;
        }),
        type:'scatter',
        pointRadius:feedMarkers.map((_,i2)=>feedMarkers.some(m=>m.x===i2)?8:0),
        pointStyle:'triangle',
        pointBackgroundColor:h.map((_,i)=>{
          const hit=feedMarkers.find(m=>m.x===i);
          return hit?hit.color:'transparent';
        }),
        pointBorderColor:'transparent',
        showLine:false,
        order:0
      });
    }
    chart=new Chart(canvas,{type:'line',data:{labels,datasets:ds},options:base});
  } else {
    base.scales.y.ticks.callback=v=>v.toLocaleString();
    base.plugins.tooltip.callbacks.label=ctx=>` ${ctx.dataset.label}: ${ctx.parsed.y.toLocaleString()}`;
    chart=new Chart(canvas,{type:'bar',data:{labels,datasets:[{label:'LISTINGS',data:h.map(s=>s.count),backgroundColor:'rgba(165,214,167,0.2)',borderColor:'#A5D6A7',borderWidth:1.5,borderRadius:2}]},options:base});
  }
}

function togS(s,el){ son[s]=!son[s]; const cls={floor:'of',med:'om',avg:'oa',max:'ox'}; son[s]?el.classList.add(cls[s]):el.classList.remove(cls[s]); if(selKey&&cmode==='price')renderChart(tracked[selKey]); const a=Object.keys(son).filter(k=>son[k]).map(k=>k.toUpperCase()); document.getElementById('clbl').textContent=a.length?a.join(' · ')+' — PER SNAPSHOT':'(SELECT A SERIES)'; }

function switchMode(mode,el){ cmode=mode; document.querySelectorAll('.ctab').forEach(t=>t.classList.remove('active')); el.classList.add('active'); document.getElementById('stgl').style.display=mode==='price'?'flex':'none'; document.getElementById('clbl').textContent=mode==='price'?(Object.keys(son).filter(k=>son[k]).map(k=>k.toUpperCase()).join(' · ')||'(SELECT)')+' — PER SNAPSHOT':'LISTING COUNT — PER SNAPSHOT'; if(selKey)renderChart(tracked[selKey]); }

async function loadEventFeedMarkers(key) {
  const ev = tracked[key];
  if (!ev || !ev.event_id) return;

  const markers = [];
  const eventId = String(ev.event_id);

  // Helper: convert feed item to marker
  function toMarker(item, sourceType) {
    const impact   = item.impact || item.attr_category || 'Low';
    const color    = impact==='High'   ? '#FF1744'
                   : impact==='Medium' ? '#FFB300'
                   : sourceType==='espn' ? '#00E5FF'
                   : '#00E676';
    const ts = item.received_ts || item.posted_at || item.pubDate || '';
    if (!ts) return null;
    return {
      ts,
      title:   item.post_text || item.title || '',
      source:  item.author_handle || item.author_name || item.feed_name || item.creator || '',
      league:  item.league || item.feed_league || '',
      impact,
      color,
      sourceType,
      keywords: item.attr_keywords || item.keywords_hit || []
    };
  }

  try {
    // Primary: use eventFeedMap if already built (instant — no Firestore call needed)
    const mapItems = eventFeedMap[String(eventId)] || [];
    if(mapItems.length > 0) {
      mapItems.forEach(item => {
        const m = toMarker(item, item.srcType||'x');
        if(m) markers.push(m);
      });
    } else {
      // Fallback: query Firestore directly
      const xItems = await FS.getFeedItems({eventId, limit:200});
      xItems.forEach(item => { const m=toMarker(item,'x'); if(m) markers.push(m); });
    }

    // ESPN — try direct match first, then league+text
    const evLeague    = ev.league || inferLeague(ev);
    const performerLc = (ev.performer||'').toLowerCase();
    const nameParts   = performerLc.split(/\s+/).filter(w => w.length >= 4);

    let espnItems = [];
    // Try direct event match first
    const espnDirect = await FS.getEspnItems({eventId, limit:100});
    if (espnDirect.length > 0) {
      espnItems = espnDirect;
    } else if (evLeague) {
      // Fall back to league filter + text match
      const espnByLeague = await FS.getEspnItems({league: evLeague, limit:300});
      espnItems = espnByLeague.filter(item => {
        const text = ((item.title||'') + ' ' + (item.description||'')).toLowerCase();
        return nameParts.length === 0 || nameParts.some(p => text.includes(p));
      });
    }

    espnItems.forEach(item => {
      const m = toMarker(item, 'espn');
      if (m) markers.push(m);
    });

    // Deduplicate by ts+title
    const seen = new Set();
    const deduped = markers.filter(m => {
      const k = m.ts + m.title.substring(0,30);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    // Sort chronologically
    deduped.sort((a,b) => a.ts.localeCompare(b.ts));
    ev.feedMarkers = deduped;

    if (deduped.length > 0) {
      Logger && Logger.log(`[feedMarkers] ${key}: ${deduped.length} markers (${xItems.length} X + ${markers.length - xItems.length} ESPN)`);
    }

  } catch(e) {
    // Firestore not available — fall back to in-memory feedItems text match
    ev.feedMarkers = buildFallbackMarkers(ev);
  }
}

// Infer league from event performer/name for ESPN matching

function inferLeague(ev) {
  const text = ((ev.performer||'') + ' ' + (ev.name||'')).toLowerCase();
  if (/lakers|celtics|knicks|warriors|heat|bucks|76ers|nets|bulls|cavs|nuggets|suns|clippers|pacers|raptors|grizzlies|magic|thunder|jazz|pelicans|spurs|kings|blazers|pistons|hornets|wizards|timberwolves|rockets|mavericks|hawks/.test(text)) return 'NBA';
  if (/chiefs|eagles|cowboys|patriots|49ers|rams|ravens|bills|bengals|packers|steelers|chargers|raiders|broncos|lions|bears|vikings|saints|giants|jets|commanders|falcons|seahawks|buccaneers|titans|colts|jaguars|texans|dolphins|cardinals/.test(text)) return 'NFL';
  if (/yankees|dodgers|red sox|cubs|astros|braves|mets|cardinals|phillies|padres|giants|brewers|mariners|rangers|angels|orioles|guardians|twins|royals|athletics|tigers|reds|pirates|nationals|marlins|rockies|diamondbacks|blue jays|rays|white sox/.test(text)) return 'MLB';
  if (/rangers|bruins|lightning|maple leafs|penguins|capitals|hurricanes|golden knights|avalanche|oilers|flames|canucks|kings|ducks|sharks|blackhawks|red wings|flyers|blues|stars|predators|jets|canadiens|senators|sabres|islanders|devils|wild|kraken/.test(text)) return 'NHL';
  return '';
}

// Fallback when Firestore unavailable — use in-memory feedItems text match

function buildFallbackMarkers(ev) {
  if (!feedItems || !feedItems.length) return [];
  const terms = [(ev.name||''),(ev.performer||'')]
    .flatMap(s => s.toLowerCase().split(/\s+at\s+|\s+vs\.?\s+|\s+@\s+/))
    .map(s => s.replace(/[^\w\s]/g,'').trim())
    .filter(s => s.length >= 4);
  return feedItems
    .filter(item => {
      const text = (item.title||'').toLowerCase();
      return terms.some(t => text.includes(t)) && (item.pubDate||'');
    })
    .map(item => ({
      ts:     item.pubDate||'',
      title:  item.title||'',
      source: item.source||item.handle||'',
      league: item.league||'',
      impact: item.impact||'Low',
      color:  item.impact==='High'?'#FF1744':item.impact==='Medium'?'#FFB300':'#00E676',
      sourceType: 'x'
    }));
}


  const r=tracked[key]; if(!r)return;
  const h=r.history||[],isSG=r.src==='SG',lat=h.length?h[h.length-1]:null,prev=h.length>1?h[h.length-2]:null;
  document.getElementById('det-banner').className=`banner ${isSG?'sg':'te'}`;
  document.getElementById('det-bdot').style.background=isSG?'var(--sg)':'var(--te)';
  const lbl=document.getElementById('det-blbl'); lbl.textContent=isSG?'SEATGEEK':'TICKET EVOLUTION'; lbl.className=`blbl ${isSG?'sg':'te'}`;
  document.getElementById('det-bmeta').textContent=isSG?'Listings API v2 · via GAS':'Listings v9 · HMAC via GAS';
  document.getElementById('det-title').textContent=r.name;
  document.getElementById('det-meta').textContent=`${(r.venue||'').replace(/_/g,' ')} · ${(r.performer||'').replace(/_/g,' ')}${r.date?' · '+safeDate(r.date):''}`;
  const pill=document.getElementById('lst-pill'),pd=document.getElementById('lst-delta');
  if(lat){
    pill.style.display='inline-block'; pill.textContent=`${fmtC(lat.count)} LST`;
    pill.style.borderColor=isSG?'var(--sg)':'var(--te)'; pill.style.color=isSG?'var(--sg)':'var(--te)';
    if(prev){pd.style.display='inline-block';pd.innerHTML=dHtml(lat.count-prev.count,true);}else pd.style.display='none';
    const sv=(id,v,d)=>{ document.getElementById(id).textContent=v; document.getElementById(id+'d').innerHTML=d; };
    sv('m-f',fmt(lat.floor),prev?dHtml(lat.floor-prev.floor,false):'<span style="color:var(--muted)">FIRST</span>');
    sv('m-a',fmt(lat.avg),  prev?dHtml(lat.avg-prev.avg,false):'<span style="color:var(--muted)">—</span>');
    sv('m-m',fmt(lat.median),prev?dHtml(lat.median-prev.median,false):'<span style="color:var(--muted)">—</span>');
    sv('m-x',fmt(lat.max),  prev?dHtml(lat.max-prev.max,false):'<span style="color:var(--muted)">—</span>');
    sv('m-c',fmtC(lat.count),prev?dHtml(lat.count-prev.count,true):'<span style="color:var(--muted)">FIRST</span>');
  }
  document.getElementById('btn-ref').disabled=false; document.getElementById('btn-rem').disabled=false;
  const si=document.getElementById('snapinfo'); si.style.display='flex';
  document.getElementById('snap-l').textContent=`${h.length} SNAPSHOT${h.length!==1?'S':''}`;
  const lastTs=h.length?h[h.length-1].ts:r.lastUpdate;
  const minsAgo=lastTs?Math.round((Date.now()-new Date(lastTs))/60000):null;
  const agoStr=minsAgo===null?'—':minsAgo<2?'just now':minsAgo<60?`${minsAgo}m ago`:minsAgo<1440?`${Math.round(minsAgo/60)}h ago`:`${Math.round(minsAgo/1440)}d ago`;
  document.getElementById('snap-r').textContent=lastTs?`LISTINGS UPDATED: ${agoStr}`:'—';
  renderChart(r);
}
