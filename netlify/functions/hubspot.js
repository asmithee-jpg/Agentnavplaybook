// netlify/functions/hubspot.js
// Proxies HubSpot API calls server-side using HUBSPOT_API_KEY

const HS_BASE = 'https://api.hubapi.com';
const API_KEY = process.env.HUBSPOT_API_KEY;

exports.handler = async function(event) {
  if (!API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'HUBSPOT_API_KEY not set' }) };
  }

  const headers = {
    'Authorization': 'Bearer ' + API_KEY,
    'Content-Type': 'application/json'
  };

  const params = event.queryStringParameters || {};
  const action = params.action;

  try {
    let data;

    // ── GET DEALS (pipeline) ─────────────────────────────────
    if (action === 'deals') {
      const res = await fetch(
        HS_BASE + '/crm/v3/objects/deals?limit=100&properties=dealname,dealstage,amount,closedate,hs_lastmodifieddate&associations=contacts',
        { headers }
      );
      const json = await res.json();

      // Get pipeline stages for labels
      const pipeRes = await fetch(
        HS_BASE + '/crm/v3/pipelines/deals',
        { headers }
      );
      const pipeJson = await pipeRes.json();

      // Build stage label map
      const stageMap = {};
      if (pipeJson.results) {
        pipeJson.results.forEach(function(pipeline) {
          (pipeline.stages || []).forEach(function(stage) {
            stageMap[stage.id] = stage.label;
          });
        });
      }

      // Format deals for dashboard
      const deals = (json.results || []).map(function(deal) {
        const props = deal.properties || {};
        return {
          id:       deal.id,
          name:     props.dealname || 'Unnamed Deal',
          stage:    stageMap[props.dealstage] || props.dealstage || 'Unknown',
          stageId:  props.dealstage,
          amount:   parseFloat(props.amount) || 0,
          closeDate: props.closedate,
          updated:  props.hs_lastmodifieddate
        };
      });

      data = { deals, stageMap };
    }

    // ── GET CONTACTS ─────────────────────────────────────────
    else if (action === 'contacts') {
      const limit = params.limit || '50';
      const after = params.after || '';
      const search = params.search || '';

      let url;
      if (search) {
        // Search contacts by name or company
        const body = JSON.stringify({
          query: search,
          limit: 20,
          properties: ['firstname','lastname','company','email','phone','state','lifecyclestage','hs_lead_status']
        });
        const res = await fetch(HS_BASE + '/crm/v3/objects/contacts/search', {
          method: 'POST',
          headers,
          body
        });
        const json = await res.json();
        data = { contacts: formatContacts(json.results || []), total: json.total || 0 };
      } else {
        url = HS_BASE + '/crm/v3/objects/contacts?limit=' + limit
          + '&properties=firstname,lastname,company,email,phone,state,lifecyclestage,hs_lead_status'
          + (after ? '&after=' + after : '');
        const res = await fetch(url, { headers });
        const json = await res.json();
        data = {
          contacts: formatContacts(json.results || []),
          total: json.total || 0,
          nextPage: json.paging && json.paging.next ? json.paging.next.after : null
        };
      }
    }

    // ── GET SINGLE CONTACT WITH DEALS ────────────────────────
    else if (action === 'contact') {
      const id = params.id;
      if (!id) return { statusCode: 400, body: JSON.stringify({ error: 'id required' }) };

      const [contactRes, assocRes] = await Promise.all([
        fetch(HS_BASE + '/crm/v3/objects/contacts/' + id + '?properties=firstname,lastname,company,email,phone,state,lifecyclestage,hs_lead_status,notes_last_contacted,num_contacted_notes', { headers }),
        fetch(HS_BASE + '/crm/v3/objects/contacts/' + id + '/associations/deals', { headers })
      ]);

      const contact = await contactRes.json();
      const assoc   = await assocRes.json();

      // Get associated deals
      let associatedDeals = [];
      if (assoc.results && assoc.results.length > 0) {
        const dealIds = assoc.results.slice(0, 10).map(function(a){ return a.id; }).join(',');
        const dealsRes = await fetch(
          HS_BASE + '/crm/v3/objects/deals?ids=' + dealIds + '&properties=dealname,dealstage,amount,closedate',
          { headers }
        );
        const dealsJson = await dealsRes.json();
        associatedDeals = (dealsJson.results || []).map(function(d){
          return { id: d.id, name: d.properties.dealname, stage: d.properties.dealstage, amount: d.properties.amount };
        });
      }

      data = {
        contact: formatContacts([contact])[0],
        deals: associatedDeals
      };
    }

    // ── GET PIPELINE SUMMARY ─────────────────────────────────
    else if (action === 'pipeline-summary') {
      const [dealsRes, pipeRes] = await Promise.all([
        fetch(HS_BASE + '/crm/v3/objects/deals?limit=200&properties=dealname,dealstage,amount,closedate,createdate&associations=contacts', { headers }),
        fetch(HS_BASE + '/crm/v3/pipelines/deals', { headers })
      ]);

      const dealsJson = await dealsRes.json();
      const pipeJson  = await pipeRes.json();

      const stageMap = {};
      const stageOrder = {};
      if (pipeJson.results) {
        pipeJson.results.forEach(function(pipeline) {
          (pipeline.stages || []).forEach(function(stage, idx) {
            stageMap[stage.id]   = stage.label;
            stageOrder[stage.id] = idx;
          });
        });
      }

      const deals = (dealsJson.results || []).map(function(deal) {
        const props = deal.properties || {};
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

      // Stage counts and value
      const bystage = {};
      deals.forEach(function(d) {
        if (!bystage[d.stage]) bystage[d.stage] = { count: 0, value: 0, order: stageOrder[d.stageId] || 99 };
        bystage[d.stage].count++;
        bystage[d.stage].value += d.amount;
      });

      data = {
        deals,
        byStage: bystage,
        totalValue: deals.reduce(function(s,d){ return s + d.amount; }, 0),
        totalDeals: deals.length
      };
    }

    // ── GET RECENT ACTIVITY (notes/calls from engagement) ────
    else if (action === 'activity') {
      const res = await fetch(
        HS_BASE + '/crm/v3/objects/calls?limit=50&properties=hs_call_title,hs_call_status,hs_call_duration,hs_timestamp&sort=-hs_timestamp',
        { headers }
      );
      const json = await res.json();
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
    const p = c.properties || {};
    return {
      id:       c.id,
      name:     [p.firstname, p.lastname].filter(Boolean).join(' ') || p.company || 'Unknown',
      company:  p.company || '',
      email:    p.email || '',
      phone:    p.phone || '',
      state:    p.state || '',
      status:   p.lifecyclestage || p.hs_lead_status || '',
      lastContacted: p.notes_last_contacted || null,
      contactCount:  p.num_contacted_notes || 0
    };
  });
}
