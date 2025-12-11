/**
 * Generate a master encryption key for field-level encryption
 *
 * Usage:
 *   npx tsx scripts/generate-encryption-key.ts
 *
 * Then store the output in Cloudflare Secrets Store:
 *   npx wrangler secret put ENCRYPTION_KEY
 *   (paste the generated key when prompted)
 */

import { generateEncryptionKey } from '../src/utils/crypto';

async function main() {
  console.log('Generating 256-bit AES-GCM master key...\n');

  const key = await generateEncryptionKey();

  console.log('✓ Master key generated successfully!\n');
  console.log('Store this key in Cloudflare Secrets Store:\n');
  console.log('  npx wrangler secret put ENCRYPTION_KEY\n');
  console.log('Then paste this value:\n');
  console.log(`  ${key}\n`);
  console.log('IMPORTANT: Save this key securely! If lost, encrypted data cannot be recovered.\n');
}

main().catch(console.error);
