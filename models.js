const mongoose = require('mongoose');

const clientSchema = new mongoose.Schema({
  name: { type: String, required: true },
  ga4PropertyId: { type: String, required: true },
  gscSiteUrl: { type: String, required: true },
  semrushDomain: { type: String, default: null },
  status: { type: String, default: 'pending' },
}, { timestamps: true });

const snapshotSchema = new mongoose.Schema({
  clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true, unique: true },
  data: { type: Object, required: true },
  insights: { type: String, default: '' },
  updatedAt: { type: Date, default: Date.now },
});

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['admin', 'user'], default: 'user' },
}, { timestamps: true });

const Client = mongoose.model('Client', clientSchema);
const Snapshot = mongoose.model('Snapshot', snapshotSchema);
const User = mongoose.model('User', userSchema);

module.exports = { Client, Snapshot, User };