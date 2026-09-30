require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const axios = require('axios');
const cron = require('node-cron');
const { google } = require('googleapis');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');
const Anthropic = require('@anthropic-ai/sdk');

// ---------- SETUP ----------
const app = express();
app.use(cors());
app.use(express.json());

const db = new Database('data.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    ga4_property_id TEXT NOT NULL,
    gsc_site_url TEXT NOT NULL,
    semrush_domain TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS snapshots (
    client_id INTEGER PRIMARY KEY,
    data TEXT,
    insights TEXT,
    updated_at TEXT,
    FOREIGN KEY (client_id) REFERENCES clients(id)
  );
`);

const analyticsClient = new BetaAnalyticsDataClient({
  keyFilename: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH,
});

const googleAuth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH,
  scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------- DATA FETCHERS ----------

async function getTrafficData(propertyId) {
  const [response] = await analyticsClient.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }],
    dimensions: [{ name: 'date' }],
    metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'conversions' }],
  });
  if (!response.rows) return [];

  const rows = response.rows.map(row => ({
    date: row.dimensionValues[0].value,
    sessions: Number(row.metricValues[0].value),
    users: Number(row.metricValues[1].value),
    conversions: Number(row.metricValues[2].value),
  }));

  rows.sort((a, b) => a.date.localeCompare(b.date));
  console.log('Traffic dates in order:', rows.map(r => r.date).join(', '));
  return rows;
}

async function getAcquisitionData(propertyId) {
  // Channel-level grouping (Organic Search, Organic Social, Paid Social, Direct, Referral, etc.)
  const [channelResponse] = await analyticsClient.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }],
    dimensions: [{ name: 'sessionDefaultChannelGroup' }],
    metrics: [{ name: 'sessions' }],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
  });

  // Source/medium detail (google/organic, linkedin.com/referral, instagram/paid social, etc.)
  const [sourceResponse] = await analyticsClient.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }],
    dimensions: [{ name: 'sessionSource' }, { name: 'sessionMedium' }],
    metrics: [{ name: 'sessions' }],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 15,
  });

  const channels = (channelResponse.rows || []).map(row => ({
    channel: row.dimensionValues[0].value,
    sessions: Number(row.metricValues[0].value),
  }));

  const sources = (sourceResponse.rows || []).map(row => ({
    source: row.dimensionValues[0].value,
    medium: row.dimensionValues[1].value,
    sessions: Number(row.metricValues[0].value),
  }));

  return { channels, sources };
}

async function getDeviceData(propertyId) {
  const [response] = await analyticsClient.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }],
    dimensions: [{ name: 'deviceCategory' }],
    metrics: [{ name: 'sessions' }],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
  });
  if (!response.rows) return [];
  return response.rows.map(row => ({
    device: row.dimensionValues[0].value, // "desktop" | "mobile" | "tablet"
    sessions: Number(row.metricValues[0].value),
  }));
}

async function getSearchData(siteUrl) {
  const authClient = await googleAuth.getClient();
  const searchconsole = google.searchconsole({ version: 'v1', auth: authClient });
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 28);
  const fmt = d => d.toISOString().split('T')[0];

  const res = await searchconsole.searchanalytics.query({
    siteUrl,
    requestBody: {
      startDate: fmt(start),
      endDate: fmt(end),
      dimensions: ['query'],
      rowLimit: 15,
    },
  });
  return res.data.rows || [];
}

async function getDomainOverview(domain) {
  const res = await axios.get('https://api.semrush.com/', {
    params: {
      type: 'domain_ranks',
      key: process.env.SEMRUSH_API_KEY,
      domain,
      database: 'us',
      export_columns: 'Dn,Rk,Or,Ot,Oc,Ad',
    },
  });
  const text = res.data.trim();
  if (!text || text.startsWith('ERROR')) throw new Error(text || 'Empty Semrush response');
  const [header, ...rows] = text.split('\n');
  const keys = header.split(';');
  return rows.map(row => {
    const vals = row.split(';');
    return Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
  });
}

async function generateInsights(data) {
  const semrushNote = data.semrushStatus === 'ok'
    ? ''
    : '\n\nNote: Semrush data is not connected for this client — do not comment on its absence, just analyze the other sources.';

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `You are an SEO analyst. Given this GA4 traffic, GA4 events, Search Console query, and indexing data, write a concise summary (max 220 words) covering: key trends, any anomalies, indexing issues if notIndexed is high relative to submitted, and 3 concrete action items.${semrushNote}\n\nData:\n${JSON.stringify(data)}`,
      }],
    });
    return msg.content[0].text;
  } catch (e) {
    console.error('Claude insights failed:', e.message);
    return `Insights unavailable right now (${e.status === 400 ? 'Anthropic billing/credit issue' : 'API error'}). Data below is still current.`;
  }
}

async function refreshClient(client) {
  const [traffic, search, events, indexing, acquisition, devices, countries, topPages, pageBreakdown, pageKeywords] = await Promise.all([
    getTrafficData(client.ga4_property_id),
    getSearchData(client.gsc_site_url),
    getEventsData(client.ga4_property_id),
    getIndexingStatus(client.gsc_site_url).catch(e => { console.error(`Indexing failed for ${client.name}:`, e.message); return null; }),
    getAcquisitionData(client.ga4_property_id).catch(e => { console.error(`Acquisition failed for ${client.name}:`, e.message); return { channels: [], sources: [] }; }),
    getDeviceData(client.ga4_property_id).catch(e => { console.error(`Device data failed for ${client.name}:`, e.message); return []; }),
    getCountryData(client.ga4_property_id).catch(e => { console.error(`Country data failed for ${client.name}:`, e.message); return []; }),
    getTopPages(client.ga4_property_id).catch(e => { console.error(`Top pages failed for ${client.name}:`, e.message); return []; }),
    getPageBreakdown(client.ga4_property_id).catch(e => { console.error(`Page breakdown failed for ${client.name}:`, e.message); return {}; }),
    getPageKeywords(client.gsc_site_url).catch(e => { console.error(`Page keywords failed for ${client.name}:`, e.message); return {}; }),
  ]);

  let domain = null;
  let semrushStatus = 'not_added';
  if (client.semrush_domain) {
    try {
      domain = await getDomainOverview(client.semrush_domain);
      semrushStatus = 'ok';
    } catch (e) {
      semrushStatus = 'error';
      console.error(`Semrush fetch failed for ${client.name}:`, e.message);
    }
  }

  // Merge top pages with their breakdown + keywords into one structure
  const blogPages = topPages.map(p => {
  // Find the matching GSC entry by checking if any key ends with this path
  const matchingKeywordsEntry = Object.entries(pageKeywords).find(([url]) => url.endsWith(p.path));
  return {
    ...p,
    topSources: pageBreakdown[p.path]?.topSources || [],
    topDevices: pageBreakdown[p.path]?.topDevices || [],
    topKeywords: matchingKeywordsEntry ? matchingKeywordsEntry[1] : [],
  };
});

  const data = { traffic, search, events, indexing, acquisition, devices, countries, blogPages, domain, semrushStatus };
  const insights = await generateInsights(data);
  const updatedAt = new Date().toISOString();

  db.prepare(`
    INSERT INTO snapshots (client_id, data, insights, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(client_id) DO UPDATE SET data=excluded.data, insights=excluded.insights, updated_at=excluded.updated_at
  `).run(client.id, JSON.stringify(data), insights, updatedAt);

  return { data, insights, updatedAt };
}



async function getEventsData(propertyId) {
  const [response] = await analyticsClient.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }],
    dimensions: [{ name: 'eventName' }],
    metrics: [{ name: 'eventCount' }],
    orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
    limit: 50, // GA4's practical ceiling for distinct event names on most properties
  });
  if (!response.rows) return [];
  return response.rows.map(row => ({
    name: row.dimensionValues[0].value,
    count: Number(row.metricValues[0].value),
  }));
}

async function getIndexingStatus(siteUrl) {
  const authClient = await googleAuth.getClient();
  const searchconsole = google.searchconsole({ version: 'v1', auth: authClient });

  const res = await searchconsole.sitemaps.list({ siteUrl });
  const sitemaps = res.data.sitemap || [];

  let submitted = 0;
  sitemaps.forEach(sm => {
    (sm.contents || []).forEach(c => {
      submitted += Number(c.submitted || 0);
    });
  });

  return {
    submitted,
    sitemapCount: sitemaps.length,
    lastSubmitted: sitemaps[0]?.lastSubmitted || null,
  };
}

// Sessions by country — powers the map
async function getCountryData(propertyId) {
  const [response] = await analyticsClient.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }],
    dimensions: [{ name: 'country' }],
    metrics: [{ name: 'sessions' }],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 250,
  });
  if (!response.rows) return [];
  return response.rows.map(row => ({
    country: row.dimensionValues[0].value,
    sessions: Number(row.metricValues[0].value),
  }));
}

// Top pages by traffic — the base list for the Blog Pages section
// Top blog pages by traffic
async function getTopPages(propertyId) {
  const [response] = await analyticsClient.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }],
    dimensions: [{ name: 'pagePath' }],
    metrics: [{ name: 'sessions' }, { name: 'screenPageViews' }],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 200, // pull wide, then filter down to blog posts only
  });
  if (!response.rows) return [];

  return response.rows
    .map(row => ({
      path: row.dimensionValues[0].value,
      sessions: Number(row.metricValues[0].value),
      pageViews: Number(row.metricValues[1].value),
    }))
    .filter(p => p.path.startsWith('/blog'))
    .slice(0, 25);
}

// Per-page source + device breakdown, filtered to blog pages
async function getPageBreakdown(propertyId) {
  const [response] = await analyticsClient.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }],
    dimensions: [{ name: 'pagePath' }, { name: 'sessionSource' }, { name: 'deviceCategory' }],
    metrics: [{ name: 'sessions' }],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 5000,
  });
  if (!response.rows) return {};

  const byPage = {};
  response.rows.forEach(row => {
    const path = row.dimensionValues[0].value;
    if (!path.startsWith('/blog')) return; // skip non-blog pages entirely

    const source = row.dimensionValues[1].value;
    const device = row.dimensionValues[2].value;
    const sessions = Number(row.metricValues[0].value);

    if (!byPage[path]) byPage[path] = { sources: {}, devices: {} };
    byPage[path].sources[source] = (byPage[path].sources[source] || 0) + sessions;
    byPage[path].devices[device] = (byPage[path].devices[device] || 0) + sessions;
  });

  const result = {};
  Object.entries(byPage).forEach(([path, { sources, devices }]) => {
    result[path] = {
      topSources: Object.entries(sources).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, sessions]) => ({ name, sessions })),
      topDevices: Object.entries(devices).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, sessions]) => ({ name, sessions })),
    };
  });
  return result;
}

// Top search queries per blog page, from GSC
async function getPageKeywords(siteUrl) {
  const authClient = await googleAuth.getClient();
  const searchconsole = google.searchconsole({ version: 'v1', auth: authClient });
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 28);
  const fmt = d => d.toISOString().split('T')[0];

  const res = await searchconsole.searchanalytics.query({
    siteUrl,
    requestBody: {
      startDate: fmt(start),
      endDate: fmt(end),
      dimensions: ['page', 'query'],
      rowLimit: 5000,
    },
  });

  const byPage = {};
  (res.data.rows || []).forEach(row => {
    const [page, query] = row.keys;
    // page here is a full URL (https://site.com/blog/...), so check it contains /blog
    if (!page.includes('/blog')) return;
    if (!byPage[page]) byPage[page] = [];
    byPage[page].push({ query, clicks: row.clicks });
  });

  const result = {};
  Object.entries(byPage).forEach(([page, queries]) => {
    result[page] = queries.sort((a, b) => b.clicks - a.clicks).slice(0, 3);
  });
  return result;
}

// ---------- ROUTES ----------

// List all clients
app.get('/api/clients', (req, res) => {
  const rows = db.prepare('SELECT id, name, status FROM clients ORDER BY name').all();
  res.json(rows);
});

// Add + verify a new client
app.post('/api/clients', async (req, res) => {
  const { name, ga4PropertyId, gscSiteUrl, semrushDomain } = req.body;
  if (!name || !ga4PropertyId || !gscSiteUrl) {
    return res.status(400).json({ message: 'Client name, GA4 Property ID, and Search Console Site URL are required.' });
  }

  try {
    await getTrafficData(ga4PropertyId);
  } catch (e) {
    return res.status(400).json({ message: `GA4 connection failed. Confirm the Property ID is correct and the service account has Viewer access. (${e.message})` });
  }

  try {
    await getSearchData(gscSiteUrl);
  } catch (e) {
    return res.status(400).json({ message: `Search Console connection failed. Confirm the site URL matches exactly (use sc-domain:example.com for Domain properties) and the service account has been added as a user. (${e.message})` });
  }

  // Semrush is optional — validate only if provided, but never block saving
  if (semrushDomain) {
    try {
      await getDomainOverview(semrushDomain);
    } catch (e) {
      console.warn(`Semrush check failed for ${name} (non-blocking): ${e.message}`);
    }
  }

  const result = db.prepare(`
    INSERT INTO clients (name, ga4_property_id, gsc_site_url, semrush_domain, status)
    VALUES (?, ?, ?, ?, 'verified')
  `).run(name, ga4PropertyId, gscSiteUrl, semrushDomain || null);

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(result.lastInsertRowid);
  refreshClient(client).catch(err => console.error('Initial refresh failed:', err.message));

  res.json({ id: result.lastInsertRowid });
});

// Get dashboard data for a client (from cached snapshot)
app.get('/api/dashboard/:clientId', (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.clientId);
  if (!client) return res.status(404).json({ message: 'Client not found.' });

  const snapshot = db.prepare('SELECT * FROM snapshots WHERE client_id = ?').get(client.id);
  if (!snapshot) return res.status(404).json({ message: 'No data yet — trigger a refresh.' });

  res.json({
    client: client.name,
    data: JSON.parse(snapshot.data),
    insights: snapshot.insights,
    updatedAt: snapshot.updated_at,
  });
});
//---------------------------CLAUDE MINI CHAT BOX-----------------------------------------------------------------

app.post('/api/dashboard/:clientId/ask', async (req, res) => {
  const { question } = req.body;
  if (!question || !question.trim()) {
    return res.status(400).json({ message: 'Question cannot be empty.' });
  }

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.clientId);
  if (!client) return res.status(404).json({ message: 'Client not found.' });

  const snapshot = db.prepare('SELECT data FROM snapshots WHERE client_id = ?').get(client.id);
  if (!snapshot) return res.status(400).json({ message: 'No data yet for this client — refresh first.' });

  const data = JSON.parse(snapshot.data);

  try {
    const msg = await anthropic.messages.create({
        model: 'claude-sonnet-5',
        max_tokens: 1024,
        thinking: { type: 'disabled' },
        messages: [{
            role: 'user',
            content: `You are an SEO analyst assistant for the client "${client.name}". Answer the question using ONLY the data below — cite specific numbers where relevant. If the data doesn't contain what's needed to answer, say so plainly rather than guessing.\n\nData:\n${JSON.stringify(data)}\n\nQuestion: ${question}`,
        }],
    });

    console.log('Claude raw response content:', JSON.stringify(msg.content, null, 2));

    const textBlock = msg.content.find(block => block.type === 'text');
    const answer = textBlock?.text || 'Claude returned a response with no readable text — check backend logs.';

    res.json({ answer });
  } catch (e) {
    console.error('Ask Claude failed:', e.message);
    res.status(500).json({ message: `Claude request failed: ${e.message}` });
  }
});

// Force refresh a client's data
app.post('/api/dashboard/:clientId/refresh', async (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.clientId);
  if (!client) return res.status(404).json({ message: 'Client not found.' });

  try {
    await refreshClient(client);
    res.json({ status: 'ok' });
  } catch (e) {
    res.status(500).json({ message: `Refresh failed: ${e.message}` });
  }
});
//------------------delete client data-------------------------
app.delete('/api/clients/:id', (req, res) => {
  const id = req.params.id;
  db.prepare('DELETE FROM snapshots WHERE client_id = ?').run(id);
  db.prepare('DELETE FROM clients WHERE id = ?').run(id);
  res.json({ status: 'ok' });
});

// ---------- SCHEDULED DAILY REFRESH ----------
cron.schedule('0 6 * * *', async () => {
  console.log('Running daily refresh for all clients…');
  const clients = db.prepare('SELECT * FROM clients').all();
  for (const client of clients) {
    try {
      await refreshClient(client);
      console.log(`Refreshed ${client.name}`);
    } catch (e) {
      console.error(`Failed to refresh ${client.name}:`, e.message);
    }
  }
});

// ---------- START ----------
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));