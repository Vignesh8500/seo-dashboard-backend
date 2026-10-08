require('dotenv').config();
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const { User } = require('./models');

const [username, password] = process.argv.slice(2);

if (!username || !password) {
  console.error('Usage: node createAdmin.js <username> <password>');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const normalized = username.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(password, 12);

  const existing = await User.findOne({ username: normalized });
  if (existing) {
    existing.passwordHash = passwordHash;
    existing.role = 'admin';
    await existing.save();
    console.log(`Updated existing user "${normalized}" and set role to admin.`);
  } else {
    await User.create({ username: normalized, passwordHash, role: 'admin' });
    console.log(`Admin "${normalized}" created.`);
  }

  await mongoose.disconnect();
})().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});