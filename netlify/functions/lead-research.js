// netlify/functions/lead-research.js
// Scans the public web for a lead/company using Claude + web search.
// Response shape matches what app.js's anRunLeadResearch expects:
//   { website: {url, meta:{title, description}}, searchResults: [{url,title,snippet}], quickLinks: [{url,label}], researchedAt }

const https = require('https');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set in Netlify environment variables.' })
    };
  }

  // Require a real, signed-in Supabase user.
  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const callerToken = authHeader.replace(/^Bearer\s+/i, '');
  if (!supabaseUrl || !anonKey || !callerToken) {
    return {
      statusCode: 401,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Sign-in required' })
    };
  }
  try {
    const whoRes = await fetch(supabaseUrl + '/auth/v1/user', {
      headers: { apikey: anonKey, Authorization: 'Bearer ' + callerToken }
    });
    if (!whoRes.ok) {
      return {
        statusCode: 401,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Sign-in required' })
      };
    }
  } catch (e) {
    return {
      statusCode: 401,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Sign-in required' })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Invalid JSON body' })
    };
  }

  const name = (body.name || '').trim();
  const company = (body.company || '').trim();
  const email = (body.email || '').trim();
  const state = (body.state || '').trim();

  if (!name && !company) {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'name or company required' })
    };
  }

  const searchSubject = company || name;
  const prompt = 'Research this insurance agent/agency lead using web search, then summarize what you find. '
    + 'This is for a health insurance broker platform doing a quick public-web scan before a sales call — '
    + 'not a background check. Only use publicly available web results.\n\n'
    + 'Name: ' + (name || 'Unknown') + '\n'
    + (company ? 'Company: ' + company + '\n' : '')
    + (email ? 'Email: ' + email + '\n' : '')
    + (state ? 'State: ' + state + '\n' : '')
    + '\nSearch the web for "' + searchSubject + '" (add "insurance agent" or "insurance agency" to the query if helpful) '
    + 'and find their company website and any other genuinely relevant public info (e.g. agency size, years in business, '
    + 'specialties, recent news). Do not fabricate results — if you find nothing relevant, say so.\n\n'
    + 'After searching, respond with ONLY a JSON object, no markdown, no code fences, no extra text, in exactly this shape:\n'
    + '{\n'
    + '  "website": { "url": "https://...", "meta": { "title": "...", "description": "1-2 sentence real description from the site" } },\n'
    + '  "searchResults": [ { "url": "https://...", "title": "...", "snippet": "1 sentence" }, ... up to 3 items ],\n'
    + '  "quickLinks": [ { "url": "https://...", "label": "short label like \'Website\' or \'LinkedIn\'" }, ... up to 4 items ]\n'
    + '}\n\n'
    + 'Omit the "website" key entirely if you could not confidently find their actual site. Omit "searchResults" or '
    + '"quickLinks" (use empty arrays) if you have nothing genuinely useful — never pad with irrelevant or made-up results.';

  const payload = JSON.stringify({
    model: 'claude-sonnet-4-5',
    max_tokens: 1200,
    messages: [{ role: 'user', content: prompt }],
    tools: [{ type: 'web_search_20250305', name: 'web_search' }]
  });

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      timeout: 25000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const textBlocks = (parsed.content || []).filter(function (b) { return b.type === 'text'; });
          const raw = textBlocks.map(function (b) { return b.text; }).join('\n');
          const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
          const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
          const result = JSON.parse(jsonMatch ? jsonMatch[0] : cleaned);
          result.researchedAt = new Date().toISOString();
          resolve({
            statusCode: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify(result)
          });
        } catch (e) {
          resolve({
            statusCode: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ researchedAt: new Date().toISOString(), searchResults: [], quickLinks: [] })
          });
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        statusCode: 504,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Request timed out. Please try again.' })
      });
    });

    req.on('error', (err) => {
      resolve({
        statusCode: 500,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Request failed: ' + err.message })
      });
    });

    req.write(payload);
    req.end();
  });
};
