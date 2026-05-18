// netlify/functions/hubspot.js
// Uses built-in https module — no external dependencies needed

const https = require('https');

const HS_BASE = 'api.hubapi.com';
const API_KEY = process.env.HUBSPOT_API_KEY;

function hsRequest(path, method, body) {
  return new Promise(function(resolve, reject) {
    var options = {
      hostname: HS_BASE,
      path: path,
      method: method || 'GET',
      headers: {
        'Authorization': 'Bearer ' + API_KEY,
        'Content-Type': 'application/json'
      }
    };
    var req = https.request(options, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve({ error: 'Invalid JSON', raw: data.slice(0,200) }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

exports.handler = async function(event) {
  if (!API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'HUBSPOT_API_KEY not set' }) };
  }

  var params = event.queryStringParameters || {};
  var action = params.action;

  try {
    var data;

    // ── GET DEALS ─────────────────────────────────────────────
    if (action === 'deals') {
      var dealsJson = await hsRequest('/crm/v3/objects/deals?limit=100&properties=dealname,dealstage,amount,closedate,hs_lastmodifieddate');
      var pipeJson  = await hsRequest('/crm/v3/pipelines/deals');

      var stageMap = {};
      if (pipeJson.results) {
        pipeJson.results.forEach(function(pipeline) {
          (pipeline.stages || []).forEach(function(stage) {
            stageMap[stage.id] = stage.label;
          });
        });
      }

      var deals = (dealsJson.results || []).map(function(deal) {
        var props = deal.properties || {};
        return {
          id:        deal.id,
          name:      props.dealname || 'Unnamed Deal',
          stage:     stageMap[props.dealstage] || props.dealstage || 'Unknown',
          stageId:   props.dealstage,
          amount:    parseFloat(props.amount) || 0,
          closeDate: props.closedate,
          updated:   props.hs_lastmodifieddate
        };
      });

      data = { deals: deals, stageMap: stageMap };
    }

    // ── SEARCH / LIST CONTACTS ────────────────────────────────
    else if (action === 'contacts') {
      var search = params.search || '';
      var limit  = params.limit  || '50';

      if (search) {
        var body = {
          query: search,
          limit: 20,
          properties: ['firstname','lastname','company','email','phone','state','lifecyclestage','hs_lead_status']
        };
        var json = await hsRequest('/crm/v3/objects/contacts/search', 'POST', body);
        data = { contacts: formatContacts(json.results || []), total: json.total || 0 };
      } else {
        var path = '/crm/v3/objects/contacts?limit=' + limit
          + '&properties=firstname,lastname,company,email,phone,state,lifecyclestage,hs_lead_status'
          + (params.after ? '&after=' + params.after : '');
        var json = await hsRequest(path);
        data = {
          contacts: formatContacts(json.results || []),
          total: json.total || 0,
          nextPage: json.paging && json.paging.next ? json.paging.next.after : null
        };
      }
    }

    // ── SINGLE CONTACT ────────────────────────────────────────
    else if (action === 'contact') {
      var id = params.id;
      if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'id required' }) };

      var contactJson = await hsRequest('/crm/v3/objects/contacts/' + id
        + '?properties=firstname,lastname,company,email,phone,state,lifecyclestage,hs_lead_status,notes_last_contacted');
      var assocJson   = await hsRequest('/crm/v3/objects/contacts/' + id + '/associations/deals');

      var associatedDeals = [];
      if (assocJson.results && assocJson.results.length > 0) {
        var ids = assocJson.results.slice(0,10).map(function(a){ return a.id; }).join(',');
        var dJson = await hsRequest('/crm/v3/objects/deals?ids=' + ids + '&properties=dealname,dealstage,amount');
        associatedDeals = (dJson.results || []).map(function(d) {
          return { id: d.id, name: d.properties.dealname, stage: d.properties.dealstage, amount: d.properties.amount };
        });
      }

      data = { contact: formatContacts([contactJson])[0], deals: associatedDeals };
    }

    // ── PIPELINE SUMMARY ─────────────────────────────────────
    else if (action === 'pipeline-summary') {
      var dealsJson = await hsRequest('/crm/v3/objects/deals?limit=200&properties=dealname,dealstage,amount,closedate,createdate');
      var pipeJson  = await hsRequest('/crm/v3/pipelines/deals');

      var stageMap = {}, stageOrder = {};
      if (pipeJson.results) {
        pipeJson.results.forEach(function(pipeline) {
          (pipeline.stages || []).forEach(function(stage, idx) {
            stageMap[stage.id]   = stage.label;
            stageOrder[stage.id] = idx;
          });
        });
      }

      var deals = (dealsJson.results || []).map(function(deal) {
        var props = deal.properties || {};
        return {
          id:        deal.id,
          name:      props.dealname || 'Unnamed',
          stage:     stageMap[props.dealstage] || props.dealstage || 'Unknown',
          stageId:   props.dealstage,
          amount:    parseFloat(props.amount) || 0,
          closeDate: props.closedate,
          created:   props.createdate
        };
      });

      var byStage = {};
      deals.forEach(function(d) {
        if (!byStage[d.stage]) byStage[d.stage] = { count: 0, value: 0, order: stageOrder[d.stageId] || 99 };
        byStage[d.stage].count++;
        byStage[d.stage].value += d.amount;
      });

      data = {
        deals:      deals,
        byStage:    byStage,
        totalValue: deals.reduce(function(s,d){ return s + d.amount; }, 0),
        totalDeals: deals.length
      };
    }

    // ── ACTIVITY (calls) ──────────────────────────────────────
    else if (action === 'activity') {
      var json = await hsRequest('/crm/v3/objects/calls?limit=50&properties=hs_call_title,hs_call_status,hs_call_duration,hs_timestamp&sort=-hs_timestamp');
      data = { calls: json.results || [], error: json.message || null };
    }

    else {
      return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action: ' + action }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(data)
    };

  } catch(e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

function formatContacts(results) {
  return (results || []).map(function(c) {
    var p = c.properties || {};
    return {
      id:       c.id,
      name:     [p.firstname, p.lastname].filter(Boolean).join(' ') || p.company || 'Unknown',
      company:  p.company  || '',
      email:    p.email    || '',
      phone:    p.phone    || '',
      state:    p.state    || '',
      status:   p.lifecyclestage || p.hs_lead_status || '',
      lastContacted: p.notes_last_contacted || null
    };
  });
}
