// ================================================================
// realtime.js — S4K Terminal
// Firestore SSE stream + snapshot poll fallback
// ================================================================
'use strict';

async function startRealtimeListener() {
  stopRealtimeListener();
  try {
    const token = await FS.getToken();
    if (!token) throw new Error('no token');
    _realtimeActive = true;
    listenToTevoSnapshots(token);
  } catch(e) {
    // Firestore not ready — fall back to polling
    console.log('[realtime] Firestore not ready, falling back to 5-min poll');
    startSnapshotPoll();
  }
}

function stopRealtimeListener() {
  if(_realtimeController) { _realtimeController.abort(); _realtimeController=null; }
  if(_realtimeRetryTimer)  { clearTimeout(_realtimeRetryTimer); _realtimeRetryTimer=null; }
  stopSnapshotPoll();
}

async function listenToTevoSnapshots(token) {
  // Firestore Listen API — streams document changes via chunked HTTP
  // Listens to ALL docs in tevo/ collection
  // Only processes docs for events we're currently tracking
  const projectId = await FS.getProjectId();
  if (!projectId) { startSnapshotPoll(); return; }

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:listen`;

  const body = JSON.stringify({
    database: `projects/${projectId}/databases/(default)`,
    addTarget: {
      query: {
        parent: `projects/${projectId}/databases/(default)/documents`,
        structuredQuery: {
          from: [{collectionId:'tevo'}],
          orderBy: [{field:{fieldPath:'snapshot_ts'}, direction:'DESCENDING'}],
          limit: {value: 1} // only latest per query hit — we handle filtering
        }
      },
      targetId: 1
    }
  });

  _realtimeController = new AbortController();

  try {
    const response = await fetch(url, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: _realtimeController.signal
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    setSt('LIVE ● FIRESTORE STREAMING');

    while(true) {
      const {done, value} = await reader.read();
      if(done) break;

      buffer += decoder.decode(value, {stream:true});

      // Firestore streams JSON objects separated by newlines
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // keep incomplete line

      for(const line of lines) {
        const trimmed = line.trim();
        if(!trimmed || trimmed === '[' || trimmed === ']' || trimmed === ',') continue;
        try {
          const msg = JSON.parse(trimmed.replace(/^,/, ''));
          handleFirestoreStreamMessage(msg);
        } catch(e) {}
      }
    }
  } catch(e) {
    if(e.name === 'AbortError') return; // intentional stop
    console.log('[realtime] stream ended:', e.message);
  }

  // Reconnect after brief delay unless intentionally stopped
  if(_realtimeActive) {
    _realtimeRetryTimer = setTimeout(async () => {
      try {
        const newToken = await FS.getToken();
        listenToTevoSnapshots(newToken);
      } catch(e) { startSnapshotPoll(); }
    }, 3000);
  }
}

function handleFirestoreStreamMessage(msg) {
  // Firestore stream messages have different shapes
  // documentChange = new/updated doc
  // targetChange with CURRENT = initial load complete
  if (!msg.documentChange) return;

  const rawDoc = msg.documentChange.document;
  if (!rawDoc || !rawDoc.fields) return;

  // Decode the snapshot doc
  const snap = FS._decodeFields(rawDoc.fields);
  if (!snap.event_id || !snap.floor) return;

  const eventId = String(snap.event_id);

  // Find the matching tracked event
  const key = Object.keys(tracked).find(k =>
    String(tracked[k].event_id) === eventId
  );
  if (!key) return; // not a tracked event

  const ev = tracked[key];
  const newPoint = {
    ts:     snap.snapshot_ts||new Date().toISOString(),
    floor:  Math.round(Number(snap.floor||0)),
    avg:    Math.round(Number(snap.avg||0)),
    median: Math.round(Number(snap.median||0)),
    max:    Math.round(Number(snap.max||0)),
    count:  Math.round(Number(snap.count||0))
  };

  if(newPoint.floor <= 0 || isNaN(newPoint.floor)) return;

  // Check if we already have this snapshot (dedup by ts)
  const alreadyHave = (ev.history||[]).some(h => h.ts === newPoint.ts);
  if(alreadyHave) return;

  // Append new data point
  if(!ev.history) ev.history = [];
  ev.history.push(newPoint);
  ev.history.sort((a,b) => a.ts.localeCompare(b.ts)); // keep chronological

  // Update UI — only re-render what changed
  renderSidebar();
  if(selKey === key) {
    renderDetail(key); // updates price cards + chart
    setSt(`LIVE UPDATE: ${ev.name} · Floor $${newPoint.floor}`);
    // Refresh feed markers in background after new snapshot
    loadEventFeedMarkers(key).then(() => {
      if(selKey === key) renderChart(tracked[key]);
    }).catch(()=>{});
  }

  // Update next-update timer
  const daysUntilN = ev.date ? Math.max(0,(new Date(ev.date)-new Date())/864e5) : 999;
  const windowMins = daysUntilN<=2 ? 15 : daysUntilN<=7 ? 30 : 240;
  const nextTs     = new Date(new Date(newPoint.ts).getTime() + windowMins*60*1000);
  _nextUpdateMap[eventId] = {
    next_update_ts:    nextTs.toISOString(),
    mins_until_update: Math.max(0,Math.round((nextTs-new Date())/60000)),
    window_mins:       windowMins,
    last_snapshot_ts:  newPoint.ts
  };

  updateTotal();
}

let snapshotPollTimer=null, lastSnapshotTs=null;

function startSnapshotPoll(){
  stopSnapshotPoll();
  snapshotPollTimer=setInterval(checkForNewSnapshots,5*60*1000);
}

function stopSnapshotPoll(){if(snapshotPollTimer){clearInterval(snapshotPollTimer);snapshotPollTimer=null;}}

async function checkForNewSnapshots(){
  try{
    const d=await gasGet({action:'get_settings'});
    if(!d.ok||!d.last_auto_refresh)return;
    if(d.last_auto_refresh===lastSnapshotTs)return;
    lastSnapshotTs=d.last_auto_refresh;
    await loadAllHistories();
    renderSidebar();
    renderF4Portfolio();
    const intelPanel=document.getElementById('panel-intel');
    if(intelPanel&&intelPanel.style.display!=='none') loadIntelFeed();
    const feedPanel=document.getElementById('panel-feed');
    if(feedPanel&&feedPanel.style.display!=='none') loadFeed();
    bumpBadge('intel-badge',1);
    bumpBadge('feed-badge',1);
    toast('↺ Portfolio updated');
    setSt(`LAST REFRESH: ${new Date(d.last_auto_refresh).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})}`);
  }catch(e){}
}

// ================================================================
// INIT
// ================================================================
