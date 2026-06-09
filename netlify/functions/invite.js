// netlify/functions/invite.js
// Server-side rep invite using Supabase service role key (no npm deps)

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { email, fullName, role, invitedBy } = body;

  if (!email || !email.includes('@')) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Valid email required' }) };
  }

  const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'asmithee@insurewithcompass.com';
  if (!invitedBy || invitedBy.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Admin access required' }) };
  }

  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in Netlify environment variables'
      })
    };
  }

  const redirectTo = process.env.SITE_URL || process.env.URL || 'https://agentnavplaybook.netlify.app';

  async function supabaseAuthPost(path, payload) {
    const res = await fetch(supabaseUrl + path, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: 'Bearer ' + serviceKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    var data = {};
    try { data = await res.json(); } catch (e) {}
    return { ok: res.ok, status: res.status, data: data };
  }

  try {
    var inviteRes = await supabaseAuthPost('/auth/v1/invite', {
      email: email,
      data: {
        full_name: fullName || email.split('@')[0],
        role: role || 'ae',
        invited_by: invitedBy
      },
      redirect_to: redirectTo
    });

    if (!inviteRes.ok) {
      var msg = (inviteRes.data && (inviteRes.data.msg || inviteRes.data.error_description || inviteRes.data.error)) || 'Invite failed';
      if (String(msg).toLowerCase().indexOf('already') >= 0 || String(msg).toLowerCase().indexOf('registered') >= 0) {
        var resetRes = await supabaseAuthPost('/auth/v1/recover', {
          email: email,
          redirect_to: redirectTo + '#reset-password'
        });
        if (!resetRes.ok) {
          var resetMsg = (resetRes.data && (resetRes.data.msg || resetRes.data.error_description || resetRes.data.error)) || 'Password reset failed';
          return { statusCode: 400, headers, body: JSON.stringify({ error: resetMsg }) };
        }
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            success: true,
            message: 'User already exists — password reset email sent',
            existing: true
          })
        };
      }
      return { statusCode: 400, headers, body: JSON.stringify({ error: msg }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        userId: inviteRes.data && inviteRes.data.id,
        message: 'Invite sent successfully'
      })
    };
  } catch (err) {
    console.error('Invite error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message || 'Internal server error' })
    };
  }
};
