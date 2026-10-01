// Vercel Serverless Function — PM2V ScrapScan AI proxy (replaces the old Render proxy).
// Keeps the Roboflow API key server-side; the browser only ever talks to this endpoint.
// Deployed automatically at https://pm2v.vercel.app/api/roboflow

export const maxDuration = 60; // Roboflow workflows can take several seconds to run

// Large base64 visualization images (e.g. classification_label_visualization) can make
// responses ~4.5MB — dangerously close to Roboflow's 6MB cap. They are unused by the
// frontend, so strip every *visualization key before returning.
function stripVisualizations(x, depth = 0) {
  if (x == null || typeof x !== 'object' || depth > 12) return x;
  if (Array.isArray(x)) { for (const v of x) stripVisualizations(v, depth + 1); return x; }
  for (const k of Object.keys(x)) {
    if (/visualization$/i.test(k)) delete x[k];
    else stripVisualizations(x[k], depth + 1);
  }
  return x;
}

const ALLOWED_HOST = 'serverless.roboflow.com';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed. Use POST.' });

  const apiKey = process.env.ROBOFLOW_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'ROBOFLOW_API_KEY is not configured on the server. Add it in Vercel → Settings → Environment Variables, then redeploy.'
    });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch {
    return res.status(400).json({ error: 'Request body must be valid JSON.' });
  }

  const { workflowUrl, inputs } = body;
  if (!workflowUrl) return res.status(400).json({ error: 'Missing "workflowUrl" in request body.' });
  if (!inputs || typeof inputs !== 'object') {
    return res.status(400).json({ error: 'Missing "inputs" in request body.' });
  }

  // Validate the upstream URL so this function cannot be used as an open proxy.
  let url;
  try {
    url = new URL(String(workflowUrl));
  } catch {
    return res.status(400).json({ error: 'Invalid workflowUrl.' });
  }
  if (url.protocol !== 'https:' || url.host !== ALLOWED_HOST) {
    return res.status(400).json({ error: `workflowUrl must be an https://${ALLOWED_HOST} URL.` });
  }

  // Normalize Roboflow's legacy "/{workspace}/workflows/{id}" path to the
  // documented endpoint "/infer/workflows/{workspace}/{id}".
  // NOTE: the workspace segment must move AFTER "workflows" — blindly
  // prefixing "/infer" yields /infer/{ws}/workflows/{id}, which Roboflow
  // answers with 405 Method Not Allowed.
  const path = url.pathname;
  if (!path.startsWith('/infer/workflows/')) {
    const m = path.match(/^\/([^/]+)\/workflows\/([^/]+)\/?$/);
    if (m) url.pathname = `/infer/workflows/${m[1]}/${m[2]}`;
  }

  try {
    const upstream = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({ inputs })
    });

    const text = await upstream.text();
    let data;
    try {
      data = JSON.parse(text);
      stripVisualizations(data);
    } catch {
      data = { error: `Non-JSON response from Roboflow (HTTP ${upstream.status}).`, raw: text.slice(0, 500) };
    }
    return res.status(upstream.status).json(data);
  } catch (e) {
    return res.status(502).json({
      error: `Upstream request to Roboflow failed: ${e && e.message ? e.message : 'network error'}`
    });
  }
}
