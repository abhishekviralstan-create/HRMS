const dns = require('dns');
const mongoose = require('mongoose');

// Node's built-in DNS resolver sometimes fails SRV lookups on Windows (ECONNREFUSED)
// even though the OS itself can resolve them - pointing it at a public resolver fixes it.
dns.setServers(['8.8.8.8', '1.1.1.1']);

async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set in .env');
  await mongoose.connect(uri);
  console.log('[db] connected to MongoDB');
}

module.exports = { connectDB };
