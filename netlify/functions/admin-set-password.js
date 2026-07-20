// netlify/functions/admin-set-password.js
// Lets the verified admin directly set another user's password — bypasses the
// email-link reset flow entirely, for cases where reset emails keep getting
// pre-clicked/expired by corporate email security scanners before the real
// user ever sees them.

exports.handler = async function (event) {
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

  const email = (body.email || '').trim().toLowerCase();
  const newPassword = body.newPassword || '';

  if (!email || !email.includes('@')) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Valid email required' }) };
  }
  if (!newPassword || newPassword.length < 8) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Password must be at least 8 characters' }) };
  }

  const supabaseUrl = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey || !anonKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY must be set in Netlify environment variables'
      })
    };
  }

  // Verify the CALLER's real identity — this is a highly privileged action
  // (setting someone else's password), so only the verified admin may do it.
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const callerToken = authHeader.replace(/^Bearer\s+/i, '');
  if (!callerToken) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Sign-in required' }) };
  }

  const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'asmithee@insurewithcompass.com';
  let callerEmail = '';
  try {
    const whoRes = await fetch(supabaseUrl + '/auth/v1/user', {
      headers: { apikey: anonKey, Authorization: 'Bearer ' + callerToken }
    });
    if (whoRes.ok) {
      const whoData = await whoRes.json();
      callerEmail = (whoData && whoData.email) || '';
    }
  } catch (e) {}

  if (!callerEmail || callerEmail.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Admin access required' }) };
  }

  try {
    // Look up the target user's ID by email via the Admin API.
    const listRes = await fetch(
      supabaseUrl + '/auth/v1/admin/users?email=' + encodeURIComponent(email),
      { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } }
    );
    const listData = await listRes.json().catch(() => ({}));
    let targetUser = null;

    if (listRes.ok) {
      const users = listData.users || (Array.isArray(listData) ? listData : []);
      targetUser = users.find(u => (u.email || '').toLowerCase() === email) || users[0] || null;
    }

    // Fallback: some GoTrue versions don't support the email filter param —
    // paginate through the full user list and find a match manually.
    if (!targetUser) {
      for (let page = 1; page <= 20 && !targetUser; page++) {
        const pageRes = await fetch(
          supabaseUrl + '/auth/v1/admin/users?page=' + page + '&per_page=200',
          { headers: { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey } }
        );
        if (!pageRes.ok) break;
        const pageData = await pageRes.json().catch(() => ({}));
        const users = pageData.users || [];
        if (!users.length) break;
        targetUser = users.find(u => (u.email || '').toLowerCase() === email) || null;
      }
    }

    if (!targetUser) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'No account found for ' + email }) };
    }

    const updateRes = await fetch(supabaseUrl + '/auth/v1/admin/users/' + targetUser.id, {
      method: 'PUT',
      headers: {
        apikey: serviceKey,
        Authorization: 'Bearer ' + serviceKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ password: newPassword })
    });
    const updateData = await updateRes.json().catch(() => ({}));

    if (!updateRes.ok) {
      const msg = updateData.msg || updateData.error_description || updateData.error || 'Failed to set password';
      return { statusCode: 400, headers, body: JSON.stringify({ error: msg }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, message: 'Password updated for ' + email })
    };
  } catch (err) {
    console.error('admin-set-password error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Internal server error' }) };
  }
};
