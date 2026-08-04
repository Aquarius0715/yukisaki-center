import { createPrivateKey, createSign } from 'node:crypto';

const domains = process.argv[2]?.split(',').map((domain) => domain.trim()).filter(Boolean) ?? [];
const lifetimeDays = Number.parseInt(process.argv[3] ?? '180', 10);

if (domains.length === 0 || domains.some((domain) => !/^(?:\*\.)?[a-z0-9.-]+$/i.test(domain))) {
  throw new Error('Provide one or more comma-separated domain names without a URL scheme.');
}
if (!Number.isInteger(lifetimeDays) || lifetimeDays < 1 || lifetimeDays > 180) {
  throw new Error('Token lifetime must be between 1 and 180 days.');
}

let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
}

const credentials = JSON.parse(input.trim());
for (const field of ['team_id', 'key_id', 'private_key']) {
  if (typeof credentials[field] !== 'string' || credentials[field].length === 0) {
    throw new Error(`Apple Maps credentials are missing ${field}.`);
  }
}

const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const header = encode({ alg: 'ES256', kid: credentials.key_id, typ: 'JWT' });
const payload = encode({
  iss: credentials.team_id,
  iat: now,
  exp: now + lifetimeDays * 24 * 60 * 60,
  scope: 'mapkit_js',
  origin: domains.join(','),
});
const signingInput = `${header}.${payload}`;
const signature = createSign('SHA256')
  .update(signingInput)
  .end()
  .sign({ key: createPrivateKey(credentials.private_key), dsaEncoding: 'ieee-p1363' })
  .toString('base64url');

process.stdout.write(`${signingInput}.${signature}`);
