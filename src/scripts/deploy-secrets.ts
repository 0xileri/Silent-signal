// Writes the deployment's secret variables to deploy-secrets.env (gitignored) for pasting into the
// host's variable editor. Nothing secret is printed. Needs the server's own Orbio login first
// (ORBIO_STATE_DIR=.orbio-server npm run orbio:login), so a deployed agent and a local one never
// refresh the same tokens.
import '../env.js'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const STATE = '.orbio-server'
const OUT = 'deploy-secrets.env'
const read = (file: string) => JSON.parse(readFileSync(join(STATE, file), 'utf8'))

if (!existsSync(join(STATE, 'tokens.json'))) {
  throw new Error(`No server login in ${STATE}/. Run: ORBIO_STATE_DIR=${STATE} npm run orbio:login`)
}
const previous = existsSync(OUT) ? readFileSync(OUT, 'utf8').match(/^ADMIN_TOKEN=(.+)$/m)?.[1] : undefined
const secrets = {
  ADMIN_TOKEN: previous ?? randomBytes(24).toString('base64url'),
  ORBIO_LOGIN_SEED: Buffer.from(JSON.stringify({ client: read('client.json'), tokens: read('tokens.json') })).toString('base64'),
}
writeFileSync(OUT, Object.entries(secrets).map(([name, value]) => `${name}=${value}`).join('\n') + '\n', { mode: 0o600 })
console.log(`Wrote ${Object.keys(secrets).join(', ')} to ${OUT}. Paste its contents into the host's variable editor.`)
