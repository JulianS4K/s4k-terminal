// ================================================================
// firestore.js — S4K Terminal
// FirestoreReader — direct terminal→Firestore REST reads
// ================================================================
'use strict';

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
