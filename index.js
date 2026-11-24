const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);
require('dotenv').config();
const mongoose = require('mongoose');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const { Client, Snapshot, User, Digest } = require('./models');   //added digest
const axios = require('axios');
const cron = require('node-cron');
const { google } = require('googleapis');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');
const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');


// ---------- SETUP ----------
const app = express();
if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is not set. Add it to your .env file.');
  process.exit(1);
}
app.set('trust proxy', 1); // Render runs behind a proxy; needed for correct client IPs
app.use(cors());
app.use(express.json());

// const db = new Database('data.db');
// db.exec(`
//   CREATE TABLE IF NOT EXISTS clients (
//     id INTEGER PRIMARY KEY AUTOINCREMENT,
//     name TEXT NOT NULL,
//     ga4_property_id TEXT NOT NULL,
//     gsc_site_url TEXT NOT NULL,
//     semrush_domain TEXT,
//     status TEXT DEFAULT 'pending',
//     created_at TEXT DEFAULT (datetime('now'))
//   );
//   CREATE TABLE IF NOT EXISTS snapshots (
//     client_id INTEGER PRIMARY KEY,
//     data TEXT,
//     insights TEXT,
//     updated_at TEXT,
//     FOREIGN KEY (client_id) REFERENCES clients(id)
//   );
// `);

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err.message));

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
    metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'keyEvents' }],
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
        content: `You are an SEO analyst. Given this GA4 traffic, GA4 events, Search Console query, and indexing data, write a concise summary (max 220 words) covering: key trends, any anomalies, indexing issues if notIndexed is high relative to submitted, and 3 concrete action items.${semrushNote}\n\nData:\n${JSON.stringify(data)} Note: "conversions" counts GA4 key events. If it is 0, do not treat that as a funnel failure; say that key events may not be configured in GA4 and suggest marking the relevant events.`,
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
    getTrafficData(client.ga4PropertyId),
    getSearchData(client.gscSiteUrl),
    getEventsData(client.ga4PropertyId),
    getIndexingStatus(client.gscSiteUrl).catch(e => { console.error(`Indexing failed for ${client.name}:`, e.message); return null; }),
    getAcquisitionData(client.ga4PropertyId).catch(e => { console.error(`Acquisition failed for ${client.name}:`, e.message); return { channels: [], sources: [] }; }),
    getDeviceData(client.ga4PropertyId).catch(e => { console.error(`Device data failed for ${client.name}:`, e.message); return []; }),
    getCountryData(client.ga4PropertyId).catch(e => { console.error(`Country data failed for ${client.name}:`, e.message); return []; }),
    getTopPages(client.ga4PropertyId).catch(e => { console.error(`Top pages failed for ${client.name}:`, e.message); return []; }),
    getPageBreakdown(client.ga4PropertyId).catch(e => { console.error(`Page breakdown failed for ${client.name}:`, e.message); return {}; }),
    getPageKeywords(client.gscSiteUrl).catch(e => { console.error(`Page keywords failed for ${client.name}:`, e.message); return {}; }),
  ]);

  let domain = null;
  let semrushStatus = 'not_added';
  if (client.semrushDomain) {
    try {
      domain = await getDomainOverview(client.semrushDomain);
      semrushStatus = 'ok';
    } catch (e) {
      semrushStatus = 'error';
      console.error(`Semrush fetch failed for ${client.name}:`, e.message);
    }
  }

  const blogPages = topPages.map(p => {
    const match = Object.entries(pageKeywords).find(([url]) => url.endsWith(p.path));
    return {
      ...p,
      topSources: pageBreakdown[p.path]?.topSources || [],
      topDevices: pageBreakdown[p.path]?.topDevices || [],
      topKeywords: match ? match[1] : [],
    };
  });

  const data = { traffic, search, events, indexing, acquisition, devices, countries, blogPages, domain, semrushStatus };
  const insights = await generateInsights(data);

  await Snapshot.findOneAndUpdate(
    { clientId: client._id },
    { clientId: client._id, data, insights, updatedAt: new Date() },
    { upsert: true, new: true }
  );

  return { data, insights };
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

// ---------- AUTH ----------

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many login attempts. Try again in 15 minutes.' },
});

// Verifies the token AND re-checks the user in the database, so deleting
// a user (or changing their role) takes effect immediately.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Not authenticated.' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(payload.id);
    if (!user) return res.status(401).json({ message: 'Account no longer exists.' });
    req.user = {
  id: user._id.toString(), username: user.username, role: user.role,
  allClients: user.role === 'admin' || user.allClients !== false,
  clientIds: (user.clientIds || []).map(String),
};
    next();
  } catch {
    return res.status(401).json({ message: 'Session expired. Please log in again.' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ message: 'Admin access required.' });
  }
  next();
}

function canAccessClient(user, clientId) {
  return user.allClients || user.clientIds.includes(String(clientId));
}

function requireClientAccess(req, res, next) {
  if (!canAccessClient(req.user, req.params.clientId)) {
    return res.status(403).json({ message: 'You do not have access to this client.' });
  }
  next();
}

app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!username || !password) {
    return res.status(400).json({ message: 'Username and password are required.' });
  }

  const user = await User.findOne({ username });
  const valid = user && await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ message: 'Invalid username or password.' });

  const token = jwt.sign({ id: user._id.toString() }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { username: user.username, role: user.role } });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ username: req.user.username, role: req.user.role });
});

// ----- Admin: manage user accounts -----

app.get('/api/users', requireAuth, requireAdmin, async (req, res) => {
  const users = await User.find().sort({ createdAt: 1 });
  res.json(users.map(u => ({
  id: u._id, username: u.username, role: u.role, createdAt: u.createdAt,
  allClients: u.role === 'admin' || u.allClients !== false,
  clientIds: (u.clientIds || []).map(String),
})));
});

app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const role = req.body.role === 'admin' ? 'admin' : 'user';

  if (username.length < 3) return res.status(400).json({ message: 'Username must be at least 3 characters.' });
  if (password.length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters.' });
  if (await User.findOne({ username })) return res.status(409).json({ message: 'That username is already taken.' });

  const user = await User.create({
  username,
  passwordHash: await bcrypt.hash(password, 12),
  role,
  allClients: role === 'admin', // new regular users start with no clients until you assign them
  clientIds: [],
});
  res.json({ id: user._id, username: user.username, role: user.role });
});

app.patch('/api/users/:id/password', requireAuth, requireAdmin, async (req, res) => {
  const password = String(req.body.password || '');
  if (password.length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters.' });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'User not found.' });

  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ message: 'User not found.' });

  user.passwordHash = await bcrypt.hash(password, 12);
  await user.save();
  res.json({ status: 'ok' });
});

app.delete('/api/users/:id', requireAuth, requireAdmin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'User not found.' });
  if (req.params.id === req.user.id) return res.status(400).json({ message: "You can't delete your own account." });
  await User.findByIdAndDelete(req.params.id);
  res.json({ status: 'ok' });
});

app.put('/api/users/:id/access', requireAuth, requireAdmin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'User not found.' });
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ message: 'User not found.' });
  if (user.role === 'admin') return res.status(400).json({ message: 'Admins can already view every client.' });

  const ids = Array.isArray(req.body.clientIds) ? [...new Set(req.body.clientIds.map(String))] : [];
  if (!ids.every(id => mongoose.isValidObjectId(id))) return res.status(400).json({ message: 'Invalid client selection.' });
  if (ids.length && (await Client.countDocuments({ _id: { $in: ids } })) !== ids.length) {
    return res.status(400).json({ message: 'One of the selected clients no longer exists.' });
  }

  user.allClients = req.body.allClients === true;
  user.clientIds = ids;
  await user.save();
  res.json({ status: 'ok' });
});


// ---------- COMPARISON ("What changed") ----------

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const DAY_MS = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const fmtDate = d => d.toISOString().slice(0, 10);
const parseDate = s => new Date(`${s}T00:00:00Z`);
const addDays = (d, n) => new Date(d.getTime() + n * DAY_MS);
const pctChange = (cur, prev) => (prev > 0 ? ((cur - prev) / prev) * 100 : cur > 0 ? null : 0);

function clampNum(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Turns ?days=28 or ?start=&end= into the selected range plus the equal-length range before it
function resolveRange(q) {
  const today = parseDate(fmtDate(new Date()));
  let start, end;

  if (q.start || q.end) {
    if (!DATE_RE.test(q.start || '') || !DATE_RE.test(q.end || '')) {
      throw new HttpError(400, 'Pick both a start and an end date.');
    }
    start = parseDate(q.start);
    end = parseDate(q.end);
    if (isNaN(start) || isNaN(end)) throw new HttpError(400, 'That date is not valid.');
  } else {
    const days = [7, 28, 90].includes(Number(q.days)) ? Number(q.days) : 28;
    end = addDays(today, -1);
    start = addDays(end, -(days - 1));
  }

  if (start > end) throw new HttpError(400, 'Start date must be before the end date.');
  if (end >= today) throw new HttpError(400, 'End date must be before today.');
  const len = Math.round((end - start) / DAY_MS) + 1;
  if (len > 365) throw new HttpError(400, 'Pick a range of 365 days or less.');

  const prevEnd = addDays(start, -1);
  const prevStart = addDays(prevEnd, -(len - 1));
  return { start: fmtDate(start), end: fmtDate(end), prevStart: fmtDate(prevStart), prevEnd: fmtDate(prevEnd), len };
}

// Search Console data lags ~3 days. Shift the whole window earlier so both periods stay complete.
function shiftForGsc(r) {
  const limit = addDays(parseDate(fmtDate(new Date())), -3);
  const end = parseDate(r.end);
  if (end <= limit) return { ...r, shiftedDays: 0 };
  const shift = Math.round((end - limit) / DAY_MS);
  const mv = s => fmtDate(addDays(parseDate(s), -shift));
  return { start: mv(r.start), end: mv(r.end), prevStart: mv(r.prevStart), prevEnd: mv(r.prevEnd), len: r.len, shiftedDays: shift };
}

async function getGa4Totals(propertyId, start, end) {
  const [response] = await analyticsClient.runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate: start, endDate: end }],
    metrics: [{ name: 'sessions' }, { name: 'activeUsers' }, { name: 'keyEvents' }],
  });
  const row = response.rows?.[0];
  const v = i => Number(row?.metricValues?.[i]?.value || 0);
  return { sessions: v(0), users: v(1), keyEvents: v(2) };
}

// No dimensions = one totals row. With dimensions, pages through up to 75k rows.
async function gscQuery(siteUrl, start, end, dimensions = []) {
  const authClient = await googleAuth.getClient();
  const sc = google.searchconsole({ version: 'v1', auth: authClient });
  const PAGE = 25000;
  const rows = [];
  for (let startRow = 0; startRow < PAGE * 3; startRow += PAGE) {
    const res = await sc.searchanalytics.query({
      siteUrl,
      requestBody: {
        startDate: start,
        endDate: end,
        rowLimit: PAGE,
        startRow,
        ...(dimensions.length ? { dimensions } : {}),
      },
    });
    const batch = res.data.rows || [];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}

function findMovers(curRows, prevRows, t, filterKey = () => true) {
  const toMap = rows => new Map(rows.map(r => [r.keys[0], r]));
  const cur = toMap(curRows);
  const prev = toMap(prevRows);
  const items = [];

  for (const key of new Set([...cur.keys(), ...prev.keys()])) {
    if (!filterKey(key)) continue;
    const c = cur.get(key);
    const p = prev.get(key);
    const clicks = c?.clicks || 0;
    const prevClicks = p?.clicks || 0;
    const position = c?.position ?? null;
    const prevPosition = p?.position ?? null;
    items.push({
      key,
      clicks,
      prevClicks,
      impressions: c?.impressions || 0,
      prevImpressions: p?.impressions || 0,
      position,
      prevPosition,
      clickChangePct: pctChange(clicks, prevClicks), // null = new (no clicks last period)
      positionDelta: position != null && prevPosition != null ? prevPosition - position : null, // positive = moved up
    });
  }

  const enoughImpr = i => Math.max(i.impressions, i.prevImpressions) >= t.minImpressions;
  const top = (arr, cmp) => arr.sort(cmp).slice(0, 15);

  return {
    positionUp: top(
      items.filter(i => i.positionDelta != null && i.positionDelta >= t.position && enoughImpr(i)),
      (a, b) => b.positionDelta - a.positionDelta
    ),
    positionDown: top(
      items.filter(i => i.positionDelta != null && i.positionDelta <= -t.position && enoughImpr(i)),
      (a, b) => a.positionDelta - b.positionDelta
    ),
    clickLosers: top(
      items.filter(i => i.prevClicks >= t.minClicks && i.clickChangePct <= -t.clickPct),
      (a, b) => (a.clicks - a.prevClicks) - (b.clicks - b.prevClicks)
    ),
    clickWinners: top(
      items.filter(i => i.clicks >= t.minClicks && (i.clickChangePct == null || i.clickChangePct >= t.clickPct)),
      (a, b) => (b.clicks - b.prevClicks) - (a.clicks - a.prevClicks)
    ),
  };
}

// const compareCache = new Map();
// const COMPARE_CACHE_MS = 10 * 60 * 1000;

// app.get('/api/dashboard/:clientId/compare', requireAuth, async (req, res) => {
  

//   try {

//     if (!mongoose.isValidObjectId(req.params.clientId)) {
//     return res.status(404).json({ message: 'Client not found.' });
//   }
//   const client = await Client.findById(req.params.clientId);
//   if (!client) return res.status(404).json({ message: 'Client not found.' });
  
//     const range = resolveRange(req.query);
//     const t = {
//       position: clampNum(req.query.positionDelta, 3, 1, 50),
//       clickPct: clampNum(req.query.clickPct, 20, 1, 100),
//       minClicks: clampNum(req.query.minClicks, 5, 1, 10000),
//       minImpressions: clampNum(req.query.minImpressions, 20, 1, 100000),
//     };
//     const blogOnly = req.query.blogOnly === 'true';

//     const cacheKey = JSON.stringify([client._id, range, t, blogOnly]);
//     const hit = compareCache.get(cacheKey);
//     if (hit && Date.now() - hit.at < COMPARE_CACHE_MS) return res.json(hit.body);

//     const g = shiftForGsc(range);
//     const [gaCur, gaPrev, gscTotCur, gscTotPrev, qCur, qPrev, pCur, pPrev] = await Promise.all([
//       getGa4Totals(client.ga4PropertyId, range.start, range.end),
//       getGa4Totals(client.ga4PropertyId, range.prevStart, range.prevEnd),
//       gscQuery(client.gscSiteUrl, g.start, g.end),
//       gscQuery(client.gscSiteUrl, g.prevStart, g.prevEnd),
//       gscQuery(client.gscSiteUrl, g.start, g.end, ['query']),
//       gscQuery(client.gscSiteUrl, g.prevStart, g.prevEnd, ['query']),
//       gscQuery(client.gscSiteUrl, g.start, g.end, ['page']),
//       gscQuery(client.gscSiteUrl, g.prevStart, g.prevEnd, ['page']),
//     ]);

//     const tot = rows => rows[0] || { clicks: 0, impressions: 0, ctr: 0, position: 0 };
//     const sc = tot(gscTotCur);
//     const sp = tot(gscTotPrev);
//     const metric = (cur, prev) => ({ cur, prev, changePct: pctChange(cur, prev) });

//     const body = {
//       range,
//       gscRange: g,
//       thresholds: { ...t, blogOnly },
//       totals: {
//         sessions: metric(gaCur.sessions, gaPrev.sessions),
//         users: metric(gaCur.users, gaPrev.users),
//         keyEvents: metric(gaCur.keyEvents, gaPrev.keyEvents),
//         clicks: metric(sc.clicks, sp.clicks),
//         impressions: metric(sc.impressions, sp.impressions),
//         ctr: metric(sc.ctr * 100, sp.ctr * 100),
//         position: {
//           cur: sc.position || null,
//           prev: sp.position || null,
//           delta: sc.position && sp.position ? sp.position - sc.position : null, // positive = improved
//         },
//       },
//       queries: findMovers(qCur, qPrev, t),
//       pages: findMovers(pCur, pPrev, t, blogOnly ? key => key.includes('/blog') : () => true),
//     };

//     if (compareCache.size > 200) compareCache.clear();
//     compareCache.set(cacheKey, { at: Date.now(), body });
//     res.json(body);
//   } catch (e) {
//     if (e instanceof HttpError) return res.status(e.status).json({ message: e.message });
//     console.error('Compare failed:', e.message);
//     res.status(500).json({ message: `Comparison failed: ${e.message}` });
//   }
// });





// =====================================================================
// COMPARISON v2 + EXPLANATIONS + WEEKLY DIGEST  (version 2: with switches + test mode)
//
// WHERE: if you pasted the earlier version of this block, delete it completely
// (from `const compareCache = new Map();` to the line `}, 30 * 1000);` at its end)
// and paste this whole file in its place. If you never pasted it, delete everything
// from `const compareCache = new Map();` to the end of the old compare route and
// paste this in its place. Either way it stays above `// ---------- ROUTES`.
//
// ALSO at the top of index.js:
//   const crypto = require('crypto');
//   const { Client, Snapshot, User, Digest } = require('./models');
// =====================================================================

const compareCache = new Map();
const COMPARE_CACHE_MS = 10 * 60 * 1000;

// ---------- Rule-based "likely cause" reasoning (our own data only) ----------
const LEVELS = ['low', 'medium', 'high'];
const downLevel = c => LEVELS[Math.max(0, LEVELS.indexOf(c) - 1)];

function explainItem(i, t) {
  const imprPct = pctChange(i.impressions, i.prevImpressions); // null = no impressions last period
  const pd = i.positionDelta; // positive = moved up
  const volume = Math.max(i.impressions, i.prevImpressions);
  let cause, confidence, note = '';

  if (i.prevClicks === 0 && i.clicks > 0) {
    cause = 'New or newly visible'; confidence = 'medium'; note = 'No clicks in the previous period.';
  } else {
    // Direction: a big position move wins, otherwise follow the clicks
    let dir;
    if (pd != null && Math.abs(pd) >= t.position) dir = pd > 0 ? 'up' : 'down';
    else dir = i.clicks > i.prevClicks ? 'up' : i.clicks < i.prevClicks ? 'down' : 'flat';

    if (dir === 'flat') {
      cause = 'No clear change'; confidence = 'low';
    } else if (dir === 'up') {
      if (pd != null && pd >= 1) { cause = 'Ranking gain'; confidence = imprPct == null || imprPct >= 10 ? 'high' : 'medium'; }
      else if (imprPct == null || imprPct >= 20) { cause = 'Higher demand or visibility'; confidence = 'medium'; }
      else { cause = 'Better click-through'; confidence = 'low'; note = 'Position and impressions are flat. Check whether the title or snippet changed.'; }
      if (i.clicks < i.prevClicks) note = (note ? note + ' ' : '') + 'Clicks have not followed the ranking yet.';
    } else {
      if (i.impressions === 0) { cause = 'Lost visibility in results'; confidence = 'medium'; }
      else if (pd != null && pd <= -1) { cause = 'Ranking loss'; confidence = imprPct != null && imprPct <= -10 ? 'high' : 'medium'; }
      else if (imprPct != null && imprPct <= -20) { cause = 'Lower demand or visibility'; confidence = 'medium'; }
      else { cause = 'Lower click-through'; confidence = 'low'; note = 'Position and impressions are steady. Possible SERP change, check the live results manually.'; }
      if (i.clicks > i.prevClicks) note = (note ? note + ' ' : '') + 'Clicks have not dropped yet.';
    }
    if (volume < 100) {
      confidence = downLevel(confidence);
      note = (note ? note + ' ' : '') + 'Low volume, treat as a signal only.';
    }
  }
  return { cause, confidence, note };
}

function explainTotals(t) {
  const out = [];
  const s = t.sessions.changePct, c = t.clicks.changePct, k = t.keyEvents.changePct;
  const ip = t.impressions.changePct, pd = t.position.delta;

  if (s != null && s <= -10) {
    out.push(c != null && c <= -10
      ? { metric: 'Sessions', text: 'Down, and Search Console clicks fell too, so organic search is the likely driver.', confidence: 'medium' }
      : { metric: 'Sessions', text: 'Down by more than organic clicks, so the drop is likely from other channels (direct, referral, paid, social) or tracking. Check the GA4 channel report.', confidence: 'low' });
  } else if (s != null && s >= 10) {
    out.push(c != null && c >= 10
      ? { metric: 'Sessions', text: 'Up, and Search Console clicks rose too, so organic search is the likely driver.', confidence: 'medium' }
      : { metric: 'Sessions', text: 'Up by more than organic clicks, so the rise likely comes from other channels (direct, referral, paid, social). Check the GA4 channel report.', confidence: 'low' });
  }

  if (c != null && c <= -10) {
    if (pd != null && pd <= -1) out.push({ metric: 'Clicks', text: 'Down while average position worsened, a likely ranking loss.', confidence: 'medium' });
    else if (ip != null && ip <= -10) out.push({ metric: 'Clicks', text: 'Down with fewer impressions, likely lower demand or visibility.', confidence: 'medium' });
    else out.push({ metric: 'Clicks', text: 'Down while impressions and position held, so click-through fell. Possible SERP change, check the live results manually.', confidence: 'low' });
  } else if (c != null && c >= 10) {
    if (pd != null && pd >= 1) out.push({ metric: 'Clicks', text: 'Up while average position improved, a likely ranking gain.', confidence: 'medium' });
    else if (ip != null && ip >= 10) out.push({ metric: 'Clicks', text: 'Up with more impressions, likely higher demand or visibility.', confidence: 'medium' });
    else out.push({ metric: 'Clicks', text: 'Up while impressions and position held, so click-through improved.', confidence: 'low' });
  }

  if (t.keyEvents.prev === 0 && t.keyEvents.cur === 0) {
    out.push({ metric: 'Key events', text: 'None recorded in either period. Check that key events are marked in GA4.', confidence: 'high' });
  } else if (k != null && k <= -20 && !(s != null && s <= -10)) {
    out.push({ metric: 'Key events', text: 'Down without a matching traffic drop. Check event tracking and the form or booking flow.', confidence: 'low' });
  }
  return out;
}

const withWhy = (moves, t) =>
  Object.fromEntries(Object.entries(moves).map(([k, arr]) => [k, arr.map(i => ({ ...i, why: explainItem(i, t) }))]));

// ---------- Comparison (shared by the dashboard route and the weekly digest) ----------
async function buildComparison(client, query) {
  const range = resolveRange(query);
  const t = {
    position: clampNum(query.positionDelta, 3, 1, 50),
    clickPct: clampNum(query.clickPct, 20, 1, 100),
    minClicks: clampNum(query.minClicks, 5, 1, 10000),
    minImpressions: clampNum(query.minImpressions, 20, 1, 100000),
  };
  const blogOnly = query.blogOnly === true || query.blogOnly === 'true';

  const cacheKey = JSON.stringify([client._id, range, t, blogOnly]);
  const hit = compareCache.get(cacheKey);
  if (hit && Date.now() - hit.at < COMPARE_CACHE_MS) return hit.body;

  const g = shiftForGsc(range);
  const [gaCur, gaPrev, gscTotCur, gscTotPrev, qCur, qPrev, pCur, pPrev] = await Promise.all([
    getGa4Totals(client.ga4PropertyId, range.start, range.end),
    getGa4Totals(client.ga4PropertyId, range.prevStart, range.prevEnd),
    gscQuery(client.gscSiteUrl, g.start, g.end),
    gscQuery(client.gscSiteUrl, g.prevStart, g.prevEnd),
    gscQuery(client.gscSiteUrl, g.start, g.end, ['query']),
    gscQuery(client.gscSiteUrl, g.prevStart, g.prevEnd, ['query']),
    gscQuery(client.gscSiteUrl, g.start, g.end, ['page']),
    gscQuery(client.gscSiteUrl, g.prevStart, g.prevEnd, ['page']),
  ]);


    // LinkedIn traffic from GA4. A failure here must never break the comparison.
  const [liCur, liPrev] = await Promise.all([
    getLinkedInTraffic(client.ga4PropertyId, range.start, range.end),
    getLinkedInTraffic(client.ga4PropertyId, range.prevStart, range.prevEnd),
  ]).catch(e => { console.error('LinkedIn report failed:', e.message); return [null, null]; });

  const tot = rows => rows[0] || { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  const sc = tot(gscTotCur);
  const sp = tot(gscTotPrev);
  const metric = (cur, prev) => ({ cur, prev, changePct: pctChange(cur, prev) });

  const totals = {
    sessions: metric(gaCur.sessions, gaPrev.sessions),
    users: metric(gaCur.users, gaPrev.users),
    keyEvents: metric(gaCur.keyEvents, gaPrev.keyEvents),
    clicks: metric(sc.clicks, sp.clicks),
    impressions: metric(sc.impressions, sp.impressions),
    ctr: metric(sc.ctr * 100, sp.ctr * 100),
    position: {
      cur: sc.position || null,
      prev: sp.position || null,
      delta: sc.position && sp.position ? sp.position - sc.position : null, // positive = improved
    },
  };

  const body = {
    range,
    gscRange: g,
    thresholds: { ...t, blogOnly },
    totals,
    explanations: explainTotals(totals),
    linkedin: buildLinkedIn(liCur, liPrev),
    queries: withWhy(findMovers(qCur, qPrev, t), t),
    pages: withWhy(findMovers(pCur, pPrev, t, blogOnly ? key => key.includes('/blog') : () => true), t),
  };

  if (compareCache.size > 200) compareCache.clear();
  compareCache.set(cacheKey, { at: Date.now(), body });
  return body;
}

app.get('/api/dashboard/:clientId/compare', requireAuth, requireClientAccess, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.clientId)) {
      return res.status(404).json({ message: 'Client not found.' });
    }
    const client = await Client.findById(req.params.clientId);
    if (!client) return res.status(404).json({ message: 'Client not found.' });
    res.json(await buildComparison(client, req.query));
  } catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({ message: e.message });
    console.error('Compare failed:', e.message);
    res.status(500).json({ message: `Comparison failed: ${e.message}` });
  }
});

// ---------- Sending: Slack webhook + email (HTTPS API, because Render free blocks SMTP) ----------
const SLACK_RE = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+$/;
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const sendErr = e => {
  const d = e?.response?.data;
  if (d) return (typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 300);
  return String(e?.message || e).slice(0, 300);
};

async function sendSlack(url, text) {
  if (!SLACK_RE.test(url)) throw new Error('Slack webhook URL is not valid.');
  await axios.post(url, { text }, { timeout: 10000, maxRedirects: 0 });
}

// async function sendEmail({ to, subject, text }) {
//   const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap">${escapeHtml(text)}</div>`;

//   // Option 1: your Gmail account, through a small Google Apps Script web app (plain HTTPS, so it works on Render free).
//   if (process.env.GMAIL_SCRIPT_URL) {
//     if (!process.env.GMAIL_SCRIPT_SECRET) throw new Error('GMAIL_SCRIPT_SECRET is not set on the server.');
//     const r = await axios.post(
//       process.env.GMAIL_SCRIPT_URL,
//       { secret: process.env.GMAIL_SCRIPT_SECRET, to, subject, text, html },
//       { timeout: 30000 } // Apps Script answers with a redirect; axios follows it
//     );
//     if (!r.data || typeof r.data !== 'object' || r.data.ok !== true) {
//       const why = r.data && typeof r.data === 'object'
//         ? (r.data.error || 'unknown error')
//         : 'unexpected reply. Check the web app is deployed with access set to "Anyone".';
//       throw new Error(`Gmail script: ${why}`);
//     }
//     return;
//   }

//   // Option 2: Resend (needs a verified domain to email other people).
//   if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
//     throw new Error('Email is not configured on the server (set GMAIL_SCRIPT_URL + GMAIL_SCRIPT_SECRET, or RESEND_API_KEY + EMAIL_FROM).');
//   }
//   await axios.post(
//     'https://api.resend.com/emails',
//     { from: process.env.EMAIL_FROM, to, subject, text, html },
//     { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` }, timeout: 15000 }
//   );
// }

// Microsoft 365 (Microsoft Graph, app-only). The token is cached until shortly before it expires.
let msToken = { value: null, exp: 0 };
async function getMsToken() {
  if (msToken.value && Date.now() < msToken.exp - 60000) return msToken.value;
  const { MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET } = process.env;
  const r = await axios.post(
    `https://login.microsoftonline.com/${encodeURIComponent(MS_TENANT_ID)}/oauth2/v2.0/token`,
    new URLSearchParams({
      client_id: MS_CLIENT_ID,
      client_secret: MS_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
  );
  msToken = { value: r.data.access_token, exp: Date.now() + r.data.expires_in * 1000 };
  return msToken.value;
}


// async function sendEmail({ to, subject, text }) {

//   const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;white-space:pre-wrap">${escapeHtml(text)}</div>`;

//   // Option 1: your Gmail account, through a small Google Apps Script web app (plain HTTPS, so it works on Render free).
//   if (process.env.GMAIL_SCRIPT_URL) {
//     if (!process.env.GMAIL_SCRIPT_SECRET) throw new Error('GMAIL_SCRIPT_SECRET is not set on the server.');
//     const r = await axios.post(
//       process.env.GMAIL_SCRIPT_URL,
//       { secret: process.env.GMAIL_SCRIPT_SECRET, to, subject, text, html },
//       { timeout: 30000 } // Apps Script answers with a redirect; axios follows it
//     );
//     if (!r.data || typeof r.data !== 'object' || r.data.ok !== true) {
//       const why = r.data && typeof r.data === 'object'
//         ? (r.data.error || 'unknown error')
//         : 'unexpected reply. Check the web app is deployed with access set to "Anyone".';
//       throw new Error(`Gmail script: ${why}`);
//     }
//     return;
//   }

//   // Option 2: Resend (needs a verified domain to email other people).
//   if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
//     throw new Error('Email is not configured on the server (set GMAIL_SCRIPT_URL + GMAIL_SCRIPT_SECRET, or RESEND_API_KEY + EMAIL_FROM).');
//   }
//   await axios.post(
//     'https://api.resend.com/emails',
//     { from: process.env.EMAIL_FROM, to, subject, text, html },
//     { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` }, timeout: 15000 }
//   );
// }


async function sendEmail({ to, subject, text }) {
  // <br> instead of white-space:pre-wrap, because Outlook ignores pre-wrap and would run the lines together
  //const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">${escapeHtml(text).replace(/\r?\n/g, '<br>')}</div>`;
    const html = textToHtml(text);
  const recipients = [].concat(to);

  // Option 1: Microsoft 365 mailbox through Microsoft Graph (plain HTTPS, so it works on Render free).
  if (process.env.MS_CLIENT_ID) {
    const sender = process.env.MS_SENDER_EMAIL;
    if (!process.env.MS_TENANT_ID || !process.env.MS_CLIENT_SECRET || !sender) {
      throw new Error('Microsoft 365 email is not fully set up (need MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_SENDER_EMAIL).');
    }
    const token = await getMsToken();
    await axios.post(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(sender)}/sendMail`,
      {
        message: {
          subject,
          body: { contentType: 'HTML', content: html },
          toRecipients: recipients.map(address => ({ emailAddress: { address } })),
        },
        saveToSentItems: true,
      },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 }
    );
    return;
  }

  // Option 2: a Gmail account, through a small Google Apps Script web app.
  if (process.env.GMAIL_SCRIPT_URL) {
    if (!process.env.GMAIL_SCRIPT_SECRET) throw new Error('GMAIL_SCRIPT_SECRET is not set on the server.');
    const r = await axios.post(
      process.env.GMAIL_SCRIPT_URL,
      { secret: process.env.GMAIL_SCRIPT_SECRET, to: recipients, subject, text, html },
      { timeout: 30000 } // Apps Script answers with a redirect; axios follows it
    );
    if (!r.data || typeof r.data !== 'object' || r.data.ok !== true) {
      const why = r.data && typeof r.data === 'object'
        ? (r.data.error || 'unknown error')
        : 'unexpected reply. Check the web app is deployed with access set to "Anyone".';
      throw new Error(`Gmail script: ${why}`);
    }
    return;
  }

  // Option 3: Resend (needs a verified domain to email other people).
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
    throw new Error('Email is not configured on the server (set the MS_* variables, or GMAIL_SCRIPT_URL + GMAIL_SCRIPT_SECRET, or RESEND_API_KEY + EMAIL_FROM).');
  }
  await axios.post(
    'https://api.resend.com/emails',
    { from: process.env.EMAIL_FROM, to: recipients, subject, text, html },
    { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` }, timeout: 15000 }
  );
}



// ---------- Email layout, dashboard-login footer, LinkedIn ----------
const n0 = v => Math.round(Number(v) || 0).toLocaleString('en-US');
const pctTxt = p => (p == null ? 'new' : `${p > 0 ? '+' : ''}${p.toFixed(1)}%`);
const mmss = sec => { const t = Math.round(sec || 0); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
const dayTxt = s => new Date(`${s}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

// Turns the plain-text email into a tidy HTML email: ALL-CAPS lines become headings, "• " lines become bullets, URLs become links.
function textToHtml(text) {
  const link = s => s.replace(/(https?:\/\/[^\s<>"']+)/g, '<a href="$1" style="color:#2563eb">$1</a>');
  const body = String(text).split(/\r?\n/).map(raw => {
    const trimmed = raw.trim();
    const line = escapeHtml(trimmed);
    if (!trimmed) return '<div style="height:10px"></div>';
    if (/^[A-Z][A-Z0-9 &'()\/,.\-–—]{2,48}$/.test(trimmed)) {
      return `<div style="margin:20px 0 6px;padding-bottom:4px;border-bottom:1px solid #e5e7eb;font-weight:700;font-size:13px;letter-spacing:0.04em;color:#111827">${line}</div>`;
    }
    if (line.startsWith('• ')) return `<div style="margin:3px 0;padding-left:16px;text-indent:-12px">${link(line)}</div>`;
    return `<div style="margin:3px 0">${link(line)}</div>`;
  }).join('');
  return `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.55;color:#1f2937;max-width:640px">${body}</div>`;
}

// Saved dashboard passwords are encrypted at rest. CREDENTIAL_KEY must be set on the server.
const credKey = () => crypto.createHash('sha256').update(String(process.env.CREDENTIAL_KEY || '')).digest();
function encryptSecret(plain) {
  if (String(process.env.CREDENTIAL_KEY || '').length < 16) throw new Error('Set CREDENTIAL_KEY (16+ characters) on the server before saving a dashboard password.');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', credKey(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
function decryptSecret(packed) {
  try {
    const [iv, tag, enc] = packed.split('.').map(x => Buffer.from(x, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', credKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch {
    throw new Error('The saved dashboard password could not be read. Enter it again in Delivery settings.');
  }
}

// Added at send time, so the link, login and sign-off never sit in the saved draft.
function emailFooter(client, { masked = false } = {}) {
  const url = clean(process.env.DASHBOARD_URL);
  const user = String(client.loginUsername || '').trim();
  const hasPw = !!client.loginPasswordEnc;
  if (!url && !user && !hasPw) return '';
  const lines = ['DASHBOARD ACCESS'];
  if (url) lines.push(`For more information, visit the SEO Dashboard: ${url}`);
  if (user) lines.push(`Username: ${user}`);
  if (hasPw) lines.push(`Password: ${masked ? '(shown in the real email)' : decryptSecret(client.loginPasswordEnc)}`);
  return lines.join('\n');
}

function finalEmailText(client, body, opts) {
  const text = String(body || '').trimEnd();
  const signedAlready = /(regards|sincerely|thanks),?\s*$/i.test(text);
  const signOff = signedAlready ? '' : `Regards,\n${clean(process.env.EMAIL_SIGNATURE) || 'SEO Team'}`;
  return [text, emailFooter(client, opts), signOff].filter(Boolean).join('\n\n');
}

// LinkedIn visits: any session whose source contains "linkedin" or "lnkd" (linkedin.com, lnkd.in, utm_source=linkedin ...)
async function getLinkedInTraffic(propertyId, start, end) {
  const filter = {
    orGroup: {
      expressions: ['linkedin', 'lnkd'].map(value => ({
        filter: { fieldName: 'sessionSource', stringFilter: { matchType: 'CONTAINS', value, caseSensitive: false } },
      })),
    },
  };
  const metrics = ['sessions', 'totalUsers', 'engagedSessions', 'keyEvents', 'userEngagementDuration'].map(name => ({ name }));
  const num = (row, i) => Number(row.metricValues?.[i]?.value || 0);

  const [[byCampaign], [totalResp]] = await Promise.all([
    analyticsClient.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [{ startDate: start, endDate: end }],
      dimensions: [{ name: 'sessionCampaignName' }, { name: 'sessionMedium' }],
      metrics,
      dimensionFilter: filter,
      limit: 100,
    }).then(r => [r[0]]),
    analyticsClient.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [{ startDate: start, endDate: end }],
      metrics,
      dimensionFilter: filter,
    }).then(r => [r[0]]),
  ]);

  const parse = row => ({ sessions: num(row, 0), users: num(row, 1), engagedSessions: num(row, 2), keyEvents: num(row, 3), engagementSeconds: num(row, 4) });
  const rows = (byCampaign.rows || []).map(r => ({
    campaign: r.dimensionValues[0].value,
    medium: r.dimensionValues[1].value,
    ...parse(r),
  }));
  const totalRow = totalResp.rows?.[0];
  const total = totalRow ? parse(totalRow) : { sessions: 0, users: 0, engagedSessions: 0, keyEvents: 0, engagementSeconds: 0 };
  return { rows, total };
}

function groupLinkedIn(rows) {
  const campaigns = new Map();
  let untaggedSessions = 0;
  for (const r of rows) {
    if (r.campaign.startsWith('(')) { untaggedSessions += r.sessions; continue; } // (not set), (direct), (referral) ...
    const c = campaigns.get(r.campaign) || { name: r.campaign, mediums: new Set(), sessions: 0, users: 0, engagedSessions: 0, keyEvents: 0, engagementSeconds: 0 };
    c.mediums.add(r.medium);
    c.sessions += r.sessions; c.users += r.users; c.engagedSessions += r.engagedSessions;
    c.keyEvents += r.keyEvents; c.engagementSeconds += r.engagementSeconds;
    campaigns.set(r.campaign, c);
  }
  return { campaigns, untaggedSessions };
}

function buildLinkedIn(cur, prev) {
  if (!cur) return null;
  if (cur.total.sessions === 0 && (prev?.total?.sessions || 0) === 0) return null; // no LinkedIn traffic at all: skip the section
  const c = groupLinkedIn(cur.rows);
  const p = groupLinkedIn(prev?.rows || []);
  const campaigns = [...c.campaigns.values()]
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 8)
    .map(x => {
      const before = p.campaigns.get(x.name)?.sessions || 0;
      return {
        name: x.name,
        mediums: [...x.mediums].filter(m => m !== '(not set)'),
        sessions: x.sessions, users: x.users, keyEvents: x.keyEvents,
        engagementRate: x.sessions ? Math.round((x.engagedSessions / x.sessions) * 100) : 0,
        avgEngagementSeconds: x.sessions ? x.engagementSeconds / x.sessions : 0,
        prevSessions: before,
        sessionsChangePct: pctChange(x.sessions, before),
      };
    });
  return {
    total: cur.total,
    prevTotal: prev?.total || { sessions: 0, users: 0, engagedSessions: 0, keyEvents: 0, engagementSeconds: 0 },
    campaigns,
    untaggedSessions: c.untaggedSessions,
  };
}

function linkedinLines(li) {
  const t = li.total;
  const rate = t.sessions ? Math.round((t.engagedSessions / t.sessions) * 100) : 0;
  const lines = [`Total LinkedIn visits: ${n0(t.sessions)} sessions (${pctTxt(pctChange(t.sessions, li.prevTotal.sessions))}) · ${n0(t.users)} users · ${rate}% engaged · ${n0(t.keyEvents)} key events`];
  for (const c of li.campaigns) {
    const med = c.mediums.length ? ` (${c.mediums.join(', ')})` : '';
    lines.push(`• ${c.name}${med}: ${n0(c.sessions)} sessions (${pctTxt(c.sessionsChangePct)}) · ${n0(c.users)} users · ${c.engagementRate}% engaged · avg ${mmss(c.avgEngagementSeconds)} on site · ${n0(c.keyEvents)} key events`);
  }
  if (li.untaggedSessions > 0) {
    lines.push(li.campaigns.length
      ? `• Other LinkedIn visits (no campaign name): ${n0(li.untaggedSessions)} sessions`
      : 'None of these visits carry a campaign name, so results cannot be split by campaign yet.');
  }
  return lines;
}

function linkedinFacts(li) {
  if (!li) return null;
  const t = li.total;
  return {
    sessions: t.sessions, previousSessions: li.prevTotal.sessions, sessionsChangePct: r1(pctChange(t.sessions, li.prevTotal.sessions)),
    users: t.users, engagedPct: t.sessions ? Math.round((t.engagedSessions / t.sessions) * 100) : 0, keyEvents: t.keyEvents,
    campaigns: li.campaigns.slice(0, 6).map(c => ({
      name: c.name, sessions: c.sessions, previousSessions: c.prevSessions, users: c.users,
      engagedPct: c.engagementRate, keyEvents: c.keyEvents,
    })),
    visitsWithoutCampaignName: li.untaggedSessions,
  };
}

function periodLine(cmp) {
  const r = cmp.range, g = cmp.gscRange;
  let s = `Period: ${dayTxt(r.start)} to ${dayTxt(r.end)}, compared with ${dayTxt(r.prevStart)} to ${dayTxt(r.prevEnd)}.`;
  if (g && g.shiftedDays > 0) s += ` Search figures cover ${dayTxt(g.start)} to ${dayTxt(g.end)}, because Google reports search data a few days late.`;
  return s;
}

function keyNumberLines(cmp) {
  const t = cmp.totals;
  const line = (label, m, fmt = n0) => `• ${label}: ${fmt(m.cur)} (${pctTxt(m.changePct)})`;
  const pos = t.position;
  const posTxt = pos.cur == null ? 'n/a'
    : `${pos.cur.toFixed(1)} (${pos.delta == null || Math.abs(pos.delta) < 0.05 ? 'unchanged' : pos.delta > 0 ? `improved by ${pos.delta.toFixed(1)}` : `dropped by ${Math.abs(pos.delta).toFixed(1)}`})`;
  return [
    line('Website sessions', t.sessions),
    line('Website users', t.users),
    line('Key events (goals)', t.keyEvents),
    line('Search clicks', t.clicks),
    line('Search impressions', t.impressions),
    line('Click-through rate', t.ctr, v => `${v.toFixed(1)}%`),
    `• Average search position: ${posTxt}`,
  ];
}

function fallbackChanges(cmp) {
  const out = [];
  const add = (label, arr, isPage) => arr.slice(0, 3).forEach(i => out.push(`• ${label}: ${isPage ? pathOf(i.key) : i.key} (${n0(i.prevClicks)} to ${n0(i.clicks)} clicks)`));
  add('Gained clicks', cmp.queries.clickWinners, false);
  add('Lost clicks', cmp.queries.clickLosers, false);
  add('Page gaining clicks', cmp.pages.clickWinners, true);
  add('Page losing clicks', cmp.pages.clickLosers, true);
  return out.length ? out.join('\n') : '• No search term or page moved past our alert thresholds this week.';
}

// Numbers and tables come from code (always correct); Claude only writes the short explanations.
function assembleEmail(client, cmp, p) {
  const out = [
    'Hello,', '',
    p.summary || `Here is your weekly SEO update for ${client.name}.`, '',
    periodLine(cmp), '',
    'KEY NUMBERS', ...keyNumberLines(cmp), '',
    'WHAT CHANGED IN SEARCH', p.changes || fallbackChanges(cmp), '',
  ];
  if (cmp.linkedin) {
    out.push('LINKEDIN CAMPAIGNS');
    if (p.linkedin) out.push(p.linkedin);
    out.push(...linkedinLines(cmp.linkedin), '');
  }
  if (p.next) out.push('NEXT STEPS', p.next, '');
  return out.join('\n').trimEnd();
}



// ---------- Draft writing (Claude) ----------
const pathOf = u => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };
const r1 = n => (n == null ? null : Math.round(n * 10) / 10);

function digestFacts(client, cmp) {
  const totals = Object.fromEntries(Object.entries(cmp.totals).map(([k, v]) => [
    k,
    k === 'position'
      ? { current: r1(v.cur), previous: r1(v.prev), improvedBy: r1(v.delta) }
      : { current: r1(v.cur), previous: r1(v.prev), changePct: r1(v.changePct) },
  ]));
  const row = (i, isPage) => ({
    item: isPage ? pathOf(i.key) : i.key,
    clicks: i.clicks, previousClicks: i.prevClicks,
    position: r1(i.position), previousPosition: r1(i.prevPosition),
    likelyCause: i.why.cause, confidence: i.why.confidence,
  });
  const top = (arr, isPage) => arr.slice(0, 6).map(i => row(i, isPage));
  return {
    client: client.name,
    period: `${cmp.range.start} to ${cmp.range.end}`,
    previousPeriod: `${cmp.range.prevStart} to ${cmp.range.prevEnd}`,
    searchConsoleWindowShiftedEarlierByDays: cmp.gscRange.shiftedDays,
    totals,
    likelyCausesForTotals: cmp.explanations,
    queries: {
      rankingUp: top(cmp.queries.positionUp), rankingDown: top(cmp.queries.positionDown),
      gainingClicks: top(cmp.queries.clickWinners), losingClicks: top(cmp.queries.clickLosers),
    },
    pages: { gainingClicks: top(cmp.pages.clickWinners, true), losingClicks: top(cmp.pages.clickLosers, true) },

        linkedin: linkedinFacts(cmp.linkedin),
  };
}

// function parseDigest(text, clientName) {
//   // Reads <tag>…</tag>. If the closing tag is missing (reply cut off), reads up to the next tag or the end.
//   const grab = tag => {
//     const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)(?:</${tag}>|(?=<(?:slack|email_subject|email_body)>)|$)`));
//     return m ? m[1] : '';
//   };
//   const clean = s => s.replace(/<\/?(?:slack|email_subject|email_body)>/g, '').trim();
//   return {
//     slackText: clean(grab('slack')) || clean(text).slice(0, 900),
//     emailSubject: (clean(grab('email_subject')) || `${clientName}: weekly SEO update`).slice(0, 200),
//     emailBody: clean(grab('email_body')) || 'The email text was not generated. Click "Generate fresh draft now" to try again.',
//   };
// }

// async function writeDigest(client, cmp) {
//   const facts = digestFacts(client, cmp);
//   const prompt = `You write the weekly SEO update for "${client.name}". Use ONLY the facts in the JSON. Rules:
// - "likelyCause" and "likelyCausesForTotals" are rule-based guesses, not facts. Always call them "likely" or "possible", keep the confidence level, and never add a cause that is not in the JSON.
// - Do not mention AI Overviews or competitors.
// - If a list is empty, say nothing moved past the thresholds there. Do not invent movement.
// - Search Console data lags a few days, so it covers an earlier window than GA4. Mention that once if the shift is above 0.
// - Clicks and impressions are whole numbers. Round other numbers sensibly.

// Write three parts in exactly this format:
// <slack>
// For the internal team, in Slack mrkdwn (single *asterisks* for bold, • for bullets), under 900 characters: one headline line, 3 to 5 bullets on the biggest changes, one line on what to check next.
// </slack>
// <email_subject>
// A short, plain subject line.
// </email_subject>
// <email_body>
// For the client contact, plain text with no markdown, 150 to 250 words, friendly and clear: what happened, the likely reasons, and one suggested next step based only on the data. Start with "Hello," and end with "Regards,".
// </email_body>

// Facts:
// ${JSON.stringify(facts)}`;

//   const msg = await anthropic.messages.create({
//     model: 'claude-sonnet-5',
//     max_tokens: 2500,
//     thinking: { type: 'disabled' },
//     messages: [{ role: 'user', content: prompt }],
//   });
//   const text = msg.content.find(b => b.type === 'text')?.text || '';
//   if (!text) throw new Error('Claude returned no text.');
//   return parseDigest(text, client.name);
// }

// ---------- Weekly drafts (safe to call any number of times) ----------
// Week = Monday to Sunday in IST. One draft per client per week.

const DIGEST_TAGS = ['slack', 'email_subject', 'email_summary', 'email_changes', 'email_linkedin', 'email_next'];

function parseDigest(text, clientName) {
  // Reads <tag>…</tag>. If a closing tag is missing (reply cut off), reads up to the next tag or the end.
  const any = DIGEST_TAGS.join('|');
  const grab = tag => {
    const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)(?:</${tag}>|(?=<(?:${any})>)|$)`));
    return m ? m[1] : '';
  };
  const clean2 = s => s.replace(new RegExp(`</?(?:${any})>`, 'g'), '').trim();
  return {
    slackText: clean2(grab('slack')) || clean2(text).slice(0, 900),
    emailSubject: (clean2(grab('email_subject')) || `${clientName}: weekly SEO update`).slice(0, 200),
    parts: {
      summary: clean2(grab('email_summary')),
      changes: clean2(grab('email_changes')),
      linkedin: clean2(grab('email_linkedin')),
      next: clean2(grab('email_next')),
    },
  };
}

async function writeDigest(client, cmp) {
  const facts = digestFacts(client, cmp);
  const prompt = `You write parts of the weekly SEO update for "${client.name}". Use ONLY the facts in the JSON. Rules:
- "likelyCause" and "likelyCausesForTotals" are rule-based guesses, not facts. Always call them "likely" or "possible", keep the confidence level, and never add a cause that is not in the JSON.
- Do not mention AI Overviews or competitors.
- If a list is empty, say nothing moved past the thresholds there. Do not invent movement.
- Do not write greetings, sign-offs, headings, tables of totals or login details. The system adds those.
- Clicks and impressions are whole numbers. Round other numbers sensibly.
- The "linkedin" fact is website traffic measured in Google Analytics (visits, engagement, key events). It has no ad spend, impressions or clicks. Only describe what the fact contains.

Write in exactly this format:
<slack>
For the internal team, in Slack mrkdwn (single *asterisks* for bold, • for bullets), under 900 characters: one headline line, 3 to 5 bullets on the biggest changes (include LinkedIn if present), one line on what to check next.
</slack>
<email_subject>
A short, plain subject line.
</email_subject>
<email_summary>
2 to 3 plain sentences with the overall picture this week, for the client.
</email_summary>
<email_changes>
3 to 6 lines, each starting with "• ": the biggest search changes (gains first, then things to watch), each with its likely reason in a few words.
</email_changes>
<email_linkedin>
1 to 2 plain sentences on how the LinkedIn traffic performed. Leave this empty if there is no "linkedin" fact.
</email_linkedin>
<email_next>
2 to 3 lines, each starting with "• ": suggested next steps based only on the data.
</email_next>

Facts:
${JSON.stringify(facts)}`;

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 2500,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: prompt }],
  });
  const text = msg.content.find(b => b.type === 'text')?.text || '';
  if (!text) throw new Error('Claude returned no text.');
  const parsed = parseDigest(text, client.name);
  return { slackText: parsed.slackText, emailSubject: parsed.emailSubject, emailBody: assembleEmail(client, cmp, parsed.parts) };
}

function currentWeekKey() {
  const ist = new Date(Date.now() + 330 * 60000);
  const sinceMonday = (ist.getUTCDay() + 6) % 7;
  return fmtDate(new Date(ist.getTime() - sinceMonday * DAY_MS));
}

let digestRunning = false;

async function createWeeklyDrafts({ clientId = null, force = false } = {}) {
  if (digestRunning) return;
  digestRunning = true;
  try {
    const weekKey = currentWeekKey();
    // Scheduled / bulk runs only cover clients whose weekly report is switched ON.
    // A run for one named client (testing) works whatever the switch says.
    const clients = clientId ? await Client.find({ _id: clientId }) : await Client.find({ weeklyReport: true });
    for (const client of clients) {
      try {
        const existing = await Digest.findOne({ clientId: client._id, weekKey });
        if (existing && (!force || ['sent', 'sending'].includes(existing.status))) continue;

        const cmp = await buildComparison(client, { days: 7 });
        const text = await writeDigest(client, cmp);
        await Digest.findOneAndUpdate(
          { clientId: client._id, weekKey },
          { $set: { ...text, range: { start: cmp.range.start, end: cmp.range.end }, status: 'draft', delivery: {}, approvedBy: null, sentAt: null } },
          { upsert: true }
        );
        console.log(`Digest draft ready: ${client.name} (${weekKey})`);
      } catch (e) {
        console.error(`Digest failed for ${client.name}:`, e.message);
      }
    }
  } finally {
    digestRunning = false;
  }
}

// ---------- Digest + delivery-settings routes (admin only) ----------
app.get('/api/delivery', requireAuth, requireAdmin, async (req, res) => {
  const clients = await Client.find().sort({ name: 1 });
  res.json(clients.map(c => ({
    id: c._id,
    name: c.name,
    weeklyReport: c.weeklyReport === true,
    emailEnabled: c.emailEnabled !== false,
    slackEnabled: c.slackEnabled !== false,
    hasWebhook: !!c.slackWebhookUrl,
    webhookHint: c.slackWebhookUrl ? `…${c.slackWebhookUrl.slice(-6)}` : '',
    emailRecipients: c.emailRecipients || [],
    loginUsername: c.loginUsername || '',
    hasLoginPassword: !!c.loginPasswordEnc,
  })));
});

app.put('/api/clients/:id/delivery', requireAuth, requireAdmin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Client not found.' });
  const client = await Client.findById(req.params.id);
  if (!client) return res.status(404).json({ message: 'Client not found.' });

    // If models.js lacks a field, Mongoose silently drops it and the switch would look saved but never persist. Say so instead.
  const fieldFor = { weeklyReport: 'weeklyReport', emailEnabled: 'emailEnabled', slackEnabled: 'slackEnabled', loginUsername: 'loginUsername', loginPassword: 'loginPasswordEnc' };
  const missing = Object.entries(fieldFor).filter(([key, path]) => req.body[key] !== undefined && !Client.schema.path(path)).map(([, path]) => path);
  if (missing.length) {
    return res.status(500).json({ message: `models.js is missing these fields in clientSchema: ${missing.join(', ')}. Add them, push, and wait for Render to redeploy.` });
  }
  
  // const { slackWebhookUrl, emailRecipients, weeklyReport, emailEnabled, slackEnabled } = req.body;
    const { slackWebhookUrl, emailRecipients, weeklyReport, emailEnabled, slackEnabled, loginUsername, loginPassword } = req.body;

  if (typeof weeklyReport === 'boolean') client.weeklyReport = weeklyReport;
  if (typeof emailEnabled === 'boolean') client.emailEnabled = emailEnabled;
  if (typeof slackEnabled === 'boolean') client.slackEnabled = slackEnabled;
    if (typeof loginUsername === 'string') client.loginUsername = loginUsername.trim().slice(0, 100);
  if (typeof loginPassword === 'string') {
    const pw = loginPassword.trim();
    if (pw.length > 200) return res.status(400).json({ message: 'That password is too long.' });
    try { client.loginPasswordEnc = pw ? encryptSecret(pw) : ''; } catch (e) { return res.status(400).json({ message: e.message }); }
  }

  if (typeof slackWebhookUrl === 'string') {
    const url = slackWebhookUrl.trim();
    if (url && !SLACK_RE.test(url)) {
      return res.status(400).json({ message: 'That is not a Slack webhook URL. It should start with https://hooks.slack.com/services/' });
    }
    client.slackWebhookUrl = url;
  }

  if (emailRecipients !== undefined) {
    const raw = Array.isArray(emailRecipients) ? emailRecipients : String(emailRecipients).split(/[,;\s]+/);
    const list = [...new Set(raw.map(s => String(s).trim().toLowerCase()).filter(Boolean))];
    const bad = list.find(e => !EMAIL_RE.test(e));
    if (bad) return res.status(400).json({ message: `"${bad}" is not a valid email address.` });
    if (list.length > 10) return res.status(400).json({ message: 'Use 10 email addresses or fewer per client.' });
    client.emailRecipients = list;
  }

  const emailReady = client.emailEnabled !== false && (client.emailRecipients?.length || 0) > 0;
  const slackReady = client.slackEnabled !== false && !!client.slackWebhookUrl;
  if (client.weeklyReport === true && !emailReady && !slackReady) {
    return res.status(400).json({ message: 'Add at least one email recipient (with Email on), or a Slack webhook (with Slack on), before turning weekly reports on.' });
  }

  await client.save();
  res.json({ status: 'ok' });
});

app.get('/api/digests', requireAuth, requireAdmin, async (req, res) => {
  const digests = await Digest.find().sort({ createdAt: -1 }).limit(60).lean();
  const clients = await Client.find({ _id: { $in: digests.map(d => d.clientId) } }).lean();
  const byId = new Map(clients.map(c => [String(c._id), c]));
  res.json(digests.map(d => {
    const c = byId.get(String(d.clientId));
    return {
      id: d._id,
      clientName: c?.name || 'Deleted client',
      weekKey: d.weekKey,
      range: d.range,
      status: d.status,
      slackText: d.slackText,
      emailSubject: d.emailSubject,
      emailBody: d.emailBody,
      delivery: d.delivery || {},
      approvedBy: d.approvedBy,
      sentAt: d.sentAt,
      // What a real send would reach right now (switches applied)
      slackConfigured: c?.slackEnabled !== false && !!c?.slackWebhookUrl,
      emailCount: c?.emailEnabled !== false ? (c?.emailRecipients?.length || 0) : 0,
      hasWebhook: !!c?.slackWebhookUrl,
      weeklyReport: c?.weeklyReport === true,
      updatedAt: d.updatedAt,
    };
  }));
});

app.delete('/api/digests/:id', requireAuth, requireAdmin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Digest not found.' });
  const d = await Digest.findOneAndDelete({ _id: req.params.id, status: 'discarded' });
  if (!d) return res.status(409).json({ message: 'Only discarded drafts can be deleted.' });
  res.json({ status: 'ok' });
});

app.patch('/api/digests/:id', requireAuth, requireAdmin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Digest not found.' });
  const set = {};
  const { slackText, emailSubject, emailBody } = req.body;
  if (typeof slackText === 'string') set.slackText = slackText.slice(0, 4000);
  if (typeof emailSubject === 'string') set.emailSubject = emailSubject.slice(0, 200);
  if (typeof emailBody === 'string') set.emailBody = emailBody.slice(0, 10000);

  const d = await Digest.findOneAndUpdate({ _id: req.params.id, status: { $in: ['draft', 'failed'] } }, { $set: set });
  if (!d) return res.status(409).json({ message: 'Only drafts can be edited.' });
  res.json({ status: 'ok' });
});

app.post('/api/digests/:id/discard', requireAuth, requireAdmin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Digest not found.' });
  const d = await Digest.findOneAndUpdate({ _id: req.params.id, status: { $in: ['draft', 'failed'] } }, { $set: { status: 'discarded' } });
  if (!d) return res.status(409).json({ message: 'Only drafts can be discarded.' });
  res.json({ status: 'ok' });
});

// Testing: sends a copy to an address you choose (and optionally to the client's Slack channel).
// Never touches the digest's status, never reaches the client's email recipients.
app.post('/api/digests/:id/test-send', requireAuth, requireAdmin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Digest not found.' });
  const d = await Digest.findById(req.params.id);
  if (!d) return res.status(404).json({ message: 'Digest not found.' });
  const client = await Client.findById(d.clientId);

  const email = String(req.body?.email || '').trim().toLowerCase();
  const wantSlack = req.body?.slack === true;
  if (!email && !wantSlack) return res.status(400).json({ message: 'Enter a test email address, or tick the Slack option.' });
  if (email && !EMAIL_RE.test(email)) return res.status(400).json({ message: 'That test email address is not valid.' });
  if (wantSlack && !client?.slackWebhookUrl) return res.status(400).json({ message: 'This client has no Slack webhook saved.' });

  const [emailRes, slackRes] = await Promise.allSettled([
    
    email ? sendEmail({ to: [email], subject: `[TEST] ${d.emailSubject}`, text: `*** TEST: this was not sent to the client ***\n\n${finalEmailText(client || {}, d.emailBody, { masked: true })}` }) : Promise.resolve(),
    wantSlack ? sendSlack(client.slackWebhookUrl, `*[TEST, not the real report]*\n${d.slackText}`) : Promise.resolve(),
  ]);

  const result = {};
  if (email) result.email = emailRes.status === 'fulfilled' ? 'sent' : `failed: ${sendErr(emailRes.reason)}`;
  if (wantSlack) result.slack = slackRes.status === 'fulfilled' ? 'sent' : `failed: ${sendErr(slackRes.reason)}`;
  res.json(result);
});

app.post('/api/digests/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'Digest not found.' });

  // Atomic claim, so a double click can never send twice
  const d = await Digest.findOneAndUpdate(
    { _id: req.params.id, status: { $in: ['draft', 'failed'] } },
    { $set: { status: 'sending', approvedBy: req.user.username } }
  ); // returns the document as it was before the claim
  if (!d) return res.status(409).json({ message: 'This digest is not waiting for approval (already sent, sending or discarded).' });

  const prevStatus = d.status;
  const release = (code, message) => Digest.updateOne({ _id: d._id }, { $set: { status: prevStatus } }).then(() => res.status(code).json({ message }));

  const client = await Client.findById(d.clientId);
  if (!client) return release(404, 'The client for this digest no longer exists.');
  if (client.weeklyReport !== true) {
    return release(400, 'Weekly reports are OFF for this client. Turn them on in Delivery settings, or use Send test.');
  }

  const slackDone = d.delivery?.slack?.status === 'sent';
  const emailDone = d.delivery?.email?.status === 'sent';
  const wantSlack = client.slackEnabled !== false && !!client.slackWebhookUrl && !slackDone;
  const wantEmail = client.emailEnabled !== false && (client.emailRecipients?.length || 0) > 0 && !emailDone;
  if (!wantSlack && !wantEmail && !slackDone && !emailDone) {
    return release(400, 'Nothing to send to. Turn on Email (with recipients) or Slack (with a webhook) in Delivery settings.');
  }

    let emailText = d.emailBody;
  if (wantEmail) {
    try { emailText = finalEmailText(client, d.emailBody); } catch (e) { return release(500, e.message); }
  }

  const [slackRes, emailRes] = await Promise.allSettled([
    wantSlack ? sendSlack(client.slackWebhookUrl, d.slackText) : Promise.resolve(),
    wantEmail ? sendEmail({ to: client.emailRecipients, subject: d.emailSubject, text: emailText }) : Promise.resolve(),
  ]);

  // The dashboard password is for one email only: once it has been delivered, delete it from the server.
  if (wantEmail && emailRes.status === 'fulfilled' && client.loginPasswordEnc) {
    await Client.updateOne({ _id: client._id }, { $set: { loginPasswordEnc: '' } });
  }

  const set = {};
  const record = (name, wanted, r) => {
    if (!wanted) return;
    set[`delivery.${name}.status`] = r.status === 'fulfilled' ? 'sent' : 'failed';
    set[`delivery.${name}.error`] = r.status === 'rejected' ? sendErr(r.reason) : '';
    set[`delivery.${name}.at`] = new Date();
  };
  record('slack', wantSlack, slackRes);
  record('email', wantEmail, emailRes);

  const failed = (wantSlack && slackRes.status === 'rejected') || (wantEmail && emailRes.status === 'rejected');
  set.status = failed ? 'failed' : 'sent';
  if (!failed) set.sentAt = new Date();
  await Digest.updateOne({ _id: d._id }, { $set: set });

  res.json({ status: set.status });
});

app.post('/api/digests/generate', requireAuth, requireAdmin, async (req, res) => {
  if (digestRunning) return res.status(409).json({ message: 'A run is already in progress. Give it a minute, then refresh.' });
  const clientId = mongoose.isValidObjectId(req.body?.clientId) ? req.body.clientId : null;
  if (!clientId && (await Client.countDocuments({ weeklyReport: true })) === 0) {
    return res.status(400).json({ message: 'No clients have weekly reports ON. Pick a specific client, or switch one ON in Delivery settings.' });
  }
  createWeeklyDrafts({ clientId, force: req.body?.force === true }).catch(e => console.error('Digest run failed:', e.message));
  res.status(202).json({ status: 'started' });
});

// Called by an external scheduler (see setup notes). Secret goes in a header, never the URL.
app.post('/api/cron/weekly-digest', (req, res) => {
  const secret = process.env.CRON_SECRET || '';
  const given = String(req.headers['x-cron-secret'] || '');
  const ok = secret.length >= 16 && given.length === secret.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!ok) return res.status(401).json({ message: 'Unauthorized.' });
  res.status(202).json({ status: 'started', weekKey: currentWeekKey() });
  createWeeklyDrafts().catch(e => console.error('Weekly digest run failed:', e.message));
});

// Backup triggers: Monday 08:00 IST if the server happens to be awake, and a catch-up
// shortly after every boot (Render wakes the service, this fills in any missing draft).
cron.schedule('0 8 * * 1', () => {
  createWeeklyDrafts().catch(e => console.error('Weekly digest run failed:', e.message));
}, { timezone: 'Asia/Kolkata' });
setTimeout(() => {
  createWeeklyDrafts().catch(e => console.error('Digest catch-up failed:', e.message));
}, 30 * 1000);



// ---------- ROUTES ----------

// ---------- ROUTES ----------

// The frontend expects `id`, so map Mongo's _id to it
app.get('/api/clients', requireAuth, async (req, res) => {
  const filter = req.user.allClients ? {} : { _id: { $in: req.user.clientIds } };
  const clients = await Client.find(filter).sort({ name: 1 });
  res.json(clients.map(c => ({ id: c._id, name: c.name, status: c.status })));
});

app.post('/api/clients', requireAuth, requireAdmin, async (req, res) => {
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

  if (semrushDomain) {
    try {
      await getDomainOverview(semrushDomain);
    } catch (e) {
      console.warn(`Semrush check failed for ${name} (non-blocking): ${e.message}`);
    }
  }

  const client = await Client.create({
    name,
    ga4PropertyId,
    gscSiteUrl,
    semrushDomain: semrushDomain || null,
    status: 'verified',
  });

  refreshClient(client).catch(err => console.error('Initial refresh failed:', err.message));
  res.json({ id: client._id });
});

app.get('/api/dashboard/:clientId', requireAuth, requireClientAccess, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.clientId)) {
    return res.status(404).json({ message: 'Client not found.' });
  }
  const client = await Client.findById(req.params.clientId);
  if (!client) return res.status(404).json({ message: 'Client not found.' });

  const snapshot = await Snapshot.findOne({ clientId: client._id });
  if (!snapshot) return res.status(404).json({ message: 'No data yet — trigger a refresh.' });

  res.json({
    client: client.name,
    data: snapshot.data,
    insights: snapshot.insights,
    updatedAt: snapshot.updatedAt,
  });
});

app.post('/api/dashboard/:clientId/refresh', requireAuth, requireClientAccess, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.clientId)) {
    return res.status(404).json({ message: 'Client not found.' });
  }
  const client = await Client.findById(req.params.clientId);
  if (!client) return res.status(404).json({ message: 'Client not found.' });

  try {
    await refreshClient(client);
    res.json({ status: 'ok' });
  } catch (e) {
    res.status(500).json({ message: `Refresh failed: ${e.message}` });
  }
});

app.post('/api/dashboard/:clientId/ask', requireAuth, requireClientAccess, async (req, res) => {
  const { question } = req.body;
  if (!question || !question.trim()) {
    return res.status(400).json({ message: 'Question cannot be empty.' });
  }
  if (!mongoose.isValidObjectId(req.params.clientId)) {
    return res.status(404).json({ message: 'Client not found.' });
  }

  const client = await Client.findById(req.params.clientId);
  if (!client) return res.status(404).json({ message: 'Client not found.' });

  const snapshot = await Snapshot.findOne({ clientId: client._id });
  if (!snapshot) return res.status(400).json({ message: 'No data yet for this client — refresh first.' });

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      thinking: { type: 'disabled' },
      messages: [{
        role: 'user',
        content: `You are an SEO analyst assistant for the client "${client.name}". Answer the question using ONLY the data below — cite specific numbers where relevant. If the data doesn't contain what's needed to answer, say so plainly rather than guessing.\n\nData:\n${JSON.stringify(snapshot.data)}\n\nQuestion: ${question}`,
      }],
    });
    const textBlock = msg.content.find(block => block.type === 'text');
    res.json({ answer: textBlock?.text || 'Claude returned no readable text.' });
  } catch (e) {
    console.error('Ask Claude failed:', e.message);
    res.status(500).json({ message: `Claude request failed: ${e.message}` });
  }
});

app.delete('/api/clients/:id', requireAuth, requireAdmin, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({ message: 'Client not found.' });
  }
  await Snapshot.deleteOne({ clientId: req.params.id });
  await Client.findByIdAndDelete(req.params.id);
  await User.updateMany({}, { $pull: { clientIds: req.params.id } });
  res.json({ status: 'ok' });
});

// ---------- SCHEDULED DAILY REFRESH ----------
cron.schedule('0 6 * * *', async () => {
  console.log('Running daily refresh for all clients…');
  const clients = await Client.find();
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