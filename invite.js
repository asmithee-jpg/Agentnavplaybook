// netlify/functions/invite.js
// Server-side rep invite using Supabase service role key
// Deploy to: netlify/functions/invite.js

const { createClient } = require('@supabase/supabase-js');

exports.handler = async function(event, context) {
  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { email, fullName, role, invitedBy } = body;

  if (!email || !email.includes('@')) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Valid email required' }) };
  }

  // Require admin email to match — basic server-side auth check
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'asmithee@insurewithcompass.com';
  if (!invitedBy || invitedBy.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Admin access required' }) };
  }

  // Use SERVICE ROLE KEY (not anon key) — set in Netlify env vars
  const supabaseUrl  = process.env.SUPABASE_URL;
  const serviceKey   = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in Netlify environment variables' })
    };
  }

  // Admin client with service role key
  const adminClient = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  try {
    // inviteUserByEmail sends a proper invite email with a set-password link
    const { data, error } = await adminClient.auth.admin.inviteUserByEmail(email, {
      data: {
        full_name: fullName || email.split('@')[0],
        role: role || 'ae',
        invited_by: invitedBy
      },
      redirectTo: process.env.SITE_URL || process.env.URL || 'https://your-site.netlify.app'
    });

    if (error) {
      // If user already exists, send a password reset instead
      if (error.message && error.message.toLowerCase().includes('already been registered')) {
        const { error: resetError } = await adminClient.auth.admin.generateLink({
          type: 'recovery',
          email: email
        });
        if (resetError) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: resetError.message }) };
        }
        return {
          statusCode: 200, headers,
          body: JSON.stringify({ success: true, message: 'User already exists — password reset email sent', existing: true })
        };
      }
      return { statusCode: 400, headers, body: JSON.stringify({ error: error.message }) };
    }

    return {
      statusCode: 200, headers,
      body: JSON.stringify({ success: true, userId: data.user?.id, message: 'Invite sent successfully' })
    };

  } catch(err) {
    console.error('Invite error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Internal server error' }) };
  }
};
