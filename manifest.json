// Run this locally to generate the value for ADMIN_PASSWORD_HASH.
// Your real password never leaves your own computer this way — only the
// resulting hash gets pasted into Vercel's environment variables.
//
// Usage:
//   npm install bcryptjs
//   node scripts/hash-password.js "your-chosen-password"

const bcrypt = require('bcryptjs');

const password = process.argv[2];
if (!password) {
  console.error('Usage: node scripts/hash-password.js "your-chosen-password"');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 12);
console.log('\nAdd this as ADMIN_PASSWORD_HASH in Vercel:\n');
console.log(hash);
console.log('');
