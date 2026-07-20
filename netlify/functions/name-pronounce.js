// netlify/functions/name-pronounce.js
// Generates a phonetic pronunciation guide for a lead's name using Claude.
// Response shape matches what app.js's anRunNamePronounce expects:
//   { firstPhonetic, firstSyllables, lastPhonetic, speakFirst, speakFull, tip, origin }

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

  const firstName = (body.firstName || '').trim();
  const lastName = (body.lastName || '').trim();
  const state = (body.state || '').trim();
  const preferredLang = (body.preferredLang || 'en').trim();

  if (!firstName) {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'firstName required' })
    };
  }

  const langNames = { en: 'English', es: 'Spanish', pt: 'Portuguese', fr: 'French' };
  const prompt = 'Give a phonetic pronunciation guide for this person\'s name so a salesperson can say it correctly '
    + 'on a phone call. Respond with ONLY a JSON object, no markdown, no code fences, no extra text.\n\n'
    + 'First name: ' + firstName + '\n'
    + (lastName ? 'Last name: ' + lastName + '\n' : '')
    + (state ? 'They live in: ' + state + ' (use this only as a very weak signal of likely origin, not a strong one)\n' : '')
    + 'The salesperson\'s spoken language preference is: ' + (langNames[preferredLang] || 'English') + '\n\n'
    + 'Return exactly this JSON shape:\n'
    + '{\n'
    + '  "firstPhonetic": "simple all-caps phonetic spelling of the first name, e.g. \\"suh-REN-uh\\"",\n'
    + '  "firstSyllables": "same as firstPhonetic but only include this field if it meaningfully differs, otherwise omit or repeat it",\n'
    + '  "lastPhonetic": "simple phonetic spelling of the last name, omit this field entirely if there is no last name",\n'
    + '  "speakFirst": "the first name written in a way a text-to-speech engine will pronounce correctly (e.g. respelled phonetically if the name is unusual, otherwise just the name as-is)",\n'
    + '  "speakFull": "the full name (first plus last) written the same TTS-friendly way",\n'
    + '  "tip": "one short, concrete spoken tip for saying it right, e.g. \'Rhymes with banana\' or \'Stress is on the second syllable\'",\n'
    + '  "origin": "a short 2-6 word guess at likely name origin/language, e.g. \'Likely Vietnamese origin\' — if genuinely uncertain, say \'Origin unclear\'"\n'
    + '}\n\n'
    + 'Be genuinely useful and concrete. If the name is common and simple (like "John Smith"), keep the guide brief and note it\'s straightforward. Never invent a pronunciation you are not reasonably confident in — if you are unsure, say so plainly in the tip field rather than guessing confidently.';

  const payload = JSON.stringify({
    model: 'claude-sonnet-4-5',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }]
  });

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      timeout: 20000,
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
          const textBlock = (parsed.content || []).find(function (b) { return b.type === 'text'; });
          const raw = textBlock ? textBlock.text : '';
          const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
          const result = JSON.parse(cleaned);
          resolve({
            statusCode: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify(result)
          });
        } catch (e) {
          resolve({
            statusCode: 502,
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ error: 'Could not generate pronunciation guide' })
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
