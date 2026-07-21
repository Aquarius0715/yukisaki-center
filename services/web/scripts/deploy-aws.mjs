import { spawnSync } from 'node:child_process'

const required = ['AWS_REGION', 'S3_BUCKET', 'CLOUDFRONT_DISTRIBUTION_ID']
const missing = required.filter((name) => !process.env[name])
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`)
  process.exit(2)
}

function run(args) {
  const result = spawnSync('aws', args, { stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run(['s3', 'sync', 'dist/', `s3://${process.env.S3_BUCKET}/`, '--delete', '--region', process.env.AWS_REGION])
run(['cloudfront', 'create-invalidation', '--distribution-id', process.env.CLOUDFRONT_DISTRIBUTION_ID, '--paths', '/*'])
