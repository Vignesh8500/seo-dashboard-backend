require('dotenv').config();
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const mongoose = require('mongoose');
const Database = require('better-sqlite3');
const { Client, Snapshot } = require('./models');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = new Database('data.db', { readonly: true });

  const oldClients = db.prepare('SELECT * FROM clients').all();
  const idMap = {}; // old SQLite integer id -> new Mongo ObjectId
  let created = 0;

  for (const c of oldClients) {
    let doc = await Client.findOne({
      name: c.name,
      ga4PropertyId: c.ga4_property_id,
      gscSiteUrl: c.gsc_site_url,
    });
    if (!doc) {
      doc = await Client.create({
        name: c.name,
        ga4PropertyId: c.ga4_property_id,
        gscSiteUrl: c.gsc_site_url,
        semrushDomain: c.semrush_domain || null,
        status: c.status || 'verified',
      });
      created++;
    }
    idMap[c.id] = doc._id;
  }

  const oldSnaps = db.prepare('SELECT * FROM snapshots').all();
  let snapsMigrated = 0;

  for (const s of oldSnaps) {
    const newId = idMap[s.client_id];
    if (!newId) continue;
    await Snapshot.findOneAndUpdate(
      { clientId: newId },
      {
        clientId: newId,
        data: JSON.parse(s.data),
        insights: s.insights || '',
        updatedAt: new Date(s.updated_at),
      },
      { upsert: true }
    );
    snapsMigrated++;
  }

  console.log(`Done. Clients created: ${created} (of ${oldClients.length}), snapshots migrated: ${snapsMigrated}`);
  await mongoose.disconnect();
  process.exit(0);
})().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});