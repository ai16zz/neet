/**
 * NEET Verify — Cloudflare Worker
 * Deploy instructions:
 *  1. Go to https://dash.cloudflare.com → Workers & Pages → Create Worker
 *  2. Paste this file, click Deploy
 *  3. Settings → Variables → add Secret:
 *       TWITTER_CLIENT_SECRET = lIxaiWEag4j72H_QmgfiiO3u0Z3MqyrayYUgpBFNEJS47wOT3K
 *  4. Note your worker URL (e.g. https://neet-verify.<subdomain>.workers.dev)
 *  5. callback.html already has BACKEND_URL set to:
 *       https://neet-verify.cardanowhalealert.workers.dev/api/verify-twitter
 *     Update it if your subdomain differs.
 */

const TWITTER_CLIENT_ID = 'QW1EWl9XWDJwWkMwX3d1TVUtSmY6MTpjaQ';
const ALLOWED_ORIGIN    = 'https://ai16zz.github.io';

const CORS = {
  'Access-Control-Allow-Origin':  ALLOWED_ORIGIN,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/api/verify-twitter') {
      return new Response('Not found', { status: 404, headers: CORS });
    }

    try {
      const { wallet, code, code_verifier, redirect_uri } = await request.json();
      if (!wallet || !code || !code_verifier || !redirect_uri)
        return errResp('Missing required fields');

      // Exchange code for token
      const tokenParams = new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri,
        client_id: TWITTER_CLIENT_ID, code_verifier,
      });
      const tokenResp = await fetch('https://api.twitter.com/2/oauth2/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + btoa(TWITTER_CLIENT_ID + ':' + env.TWITTER_CLIENT_SECRET),
        },
        body: tokenParams.toString(),
      });
      const tokenData = await tokenResp.json();
      if (!tokenResp.ok) throw new Error(tokenData.error_description || tokenData.error || 'Token exchange failed');

      // Fetch user profile
      const userResp = await fetch(
        'https://api.twitter.com/2/users/me?user.fields=name,username,profile_image_url',
        { headers: { 'Authorization': 'Bearer ' + tokenData.access_token } }
      );
      const userData = await userResp.json();
      if (!userResp.ok || !userData.data) throw new Error('Could not fetch X user profile');

      const u = userData.data;
      return new Response(JSON.stringify({
        handle: u.username, name: u.name,
        pfp: u.profile_image_url || '', twitter_id: u.id,
      }), { headers: { 'Content-Type': 'application/json', ...CORS } });

    } catch (e) { return errResp(e.message); }

    function errResp(msg) {
      return new Response(JSON.stringify({ error: msg }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }
  },
};
