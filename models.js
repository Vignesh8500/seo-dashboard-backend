const mongoose = require('mongoose');

const clientSchema = new mongoose.Schema({
  name: { type: String, required: true },
  ga4PropertyId: { type: String, required: true },
  gscSiteUrl: { type: String, required: true },
  semrushDomain: { type: String, default: null },
  slackWebhookUrl: { type: String, default: '' },
  emailRecipients: { type: [String], default: [] },
  weeklyReport: { type: Boolean, default: false },
  emailEnabled: { type: Boolean, default: true },
  slackEnabled: { type: Boolean, default: true },
  status: { type: String, default: 'pending' },
  loginUsername: { type: String, default: '' },
  loginPasswordEnc: { type: String, default: '' },
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
  allClients: { type: Boolean, default: true },
clientIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
}, { timestamps: true });

const Client = mongoose.model('Client', clientSchema);
const Snapshot = mongoose.model('Snapshot', snapshotSchema);
const User = mongoose.model('User', userSchema);


const digestSchema = new mongoose.Schema({
  clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Client', required: true },
  weekKey: { type: String, required: true },
  range: { start: String, end: String },
  status: { type: String, enum: ['draft', 'sending', 'sent', 'failed', 'discarded'], default: 'draft' },
  slackText: String, emailSubject: String, emailBody: String,
  delivery: {
    slack: { status: String, error: String, at: Date },
    email: { status: String, error: String, at: Date },
    weeklyReport: { type: Boolean, default: false },
    emailEnabled: { type: Boolean, default: true },
    slackEnabled: { type: Boolean, default: true },
  },
  approvedBy: String,
  sentAt: Date,
}, { timestamps: true });
digestSchema.index({ clientId: 1, weekKey: 1 }, { unique: true });
const Digest = mongoose.model('Digest', digestSchema);

module.exports = { Client, Snapshot, User, Digest };