const https = require('https');

function hsGet(path, apiKey) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.hubapi.com',
      path,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({}); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function hsPost(path, apiKey, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: 'api.hubapi.com',
      path,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve({}); } });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

exports.handler = async function(event) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  const apiKey = process.env.HUBSPOT_API_KEY;
  if (!apiKey) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'HUBSPOT_API_KEY not set' }) };

  const p = event.queryStringParameters || {};
  const action = p.action;

  try {
    // ── SEARCH contacts by name/email ──────────────────────────────
    if (action === 'search') {
      const q = p.q || '';
      const result = await hsPost('/crm/v3/objects/contacts/search', apiKey, {
        query: q,
        limit: 8,
        properties: ['firstname', 'lastname', 'email', 'company', 'hs_lead_status', 'phone']
      });
      const contacts = (result.results || []).map(c => ({
        id: c.id,
        name: `${c.properties.firstname || ''} ${c.properties.lastname || ''}`.trim() || 'Unknown',
        email: c.properties.email || '',
        company: c.properties.company || '',
        lead_status: c.properties.hs_lead_status || ''
      }));
      return { statusCode: 200, headers: cors, body: JSON.stringify({ contacts }) };
    }

    // ── GET full contact profile + deals + notes ───────────────────
    if (action === 'contact') {
      const id = p.id;
      const contactProps = 'firstname,lastname,email,phone,company,jobtitle,hs_lead_status,lifecyclestage,num_contacted_notes,hs_last_sales_activity_timestamp,notes_last_contacted,createdate';

      const [contact, assoc] = await Promise.all([
        hsGet(`/crm/v3/objects/contacts/${id}?properties=${contactProps}`, apiKey),
        hsGet(`/crm/v3/objects/contacts/${id}/associations/deals`, apiKey)
      ]);

      const cp = contact.properties || {};

      // Get associated deals
      let deals = [];
      const dealIds = (assoc.results || []).slice(0, 3).map(d => d.id);
      if (dealIds.length > 0) {
        const dealData = await Promise.all(
          dealIds.map(did =>
            hsGet(`/crm/v3/objects/deals/${did}?properties=dealname,dealstage,amount,closedate,pipeline,hs_next_step`, apiKey)
          )
        );
        deals = dealData.map(d => ({
          id: d.id,
          name: d.properties?.dealname || 'Unnamed Deal',
          stage: d.properties?.dealstage || '',
          amount: d.properties?.amount || '',
          closedate: d.properties?.closedate || '',
          next_step: d.properties?.hs_next_step || ''
        }));
      }

      // Get recent engagements (calls/notes)
      let recentActivity = [];
      try {
        const eng = await hsGet(`/engagements/v1/engagements/associated/CONTACT/${id}/paged?limit=5&count=5`, apiKey);
        recentActivity = (eng.results || []).map(e => ({
          type: e.engagement?.type || '',
          date: new Date(e.engagement?.createdAt || 0).toLocaleDateString(),
          note: (e.metadata?.body || e.metadata?.text || e.metadata?.subject || '').slice(0, 300)
        })).filter(a => a.note).slice(0, 3);
      } catch(e) {}

      return {
        statusCode: 200,
        headers: cors,
        body: JSON.stringify({
          contact: {
            id,
            name: `${cp.firstname || ''} ${cp.lastname || ''}`.trim(),
            email: cp.email || '',
            phone: cp.phone || '',
            company: cp.company || '',
            title: cp.jobtitle || '',
            lead_status: cp.hs_lead_status || '',
            lifecycle: cp.lifecyclestage || '',
            last_contacted: cp.notes_last_contacted || '',
            times_contacted: cp.num_contacted_notes || '0'
          },
          deals,
          recentActivity
        })
      };
    }

    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Unknown action. Use search or contact.' }) };

  } catch(err) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: err.message }) };
  }
};
