// netlify/functions/invite.js
// Server-side rep invite using Supabase service role key

const { createClient } = require('@supabase/supabase-js');

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

  const supabaseUrl = process.env.SUPABASE_URL;
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

  const adminClient = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  try {
    const redirectTo = process.env.SITE_URL || process.env.URL || 'https://agentnavplaybook.netlify.app';
    const { data, error } = await adminClient.auth.admin.inviteUserByEmail(email, {
      data: {
        full_name: fullName || email.split('@')[0],
        role: role || 'ae',
        invited_by: invitedBy
      },
      redirectTo: redirectTo
    });

    if (error) {
      if (error.message && error.message.toLowerCase().includes('already been registered')) {
        const { error: resetError } = await adminClient.auth.resetPasswordForEmail(email, {
          redirectTo: redirectTo + '#reset-password'
        });
        if (resetError) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: resetError.message }) };
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
      return { statusCode: 400, headers, body: JSON.stringify({ error: error.message }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, userId: data.user?.id, message: 'Invite sent successfully' })
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
