// The agent's own connection to the Orbio MCP. It registers as its own OAuth client and saves
// the login under .orbio/ (gitignored), so after one browser sign-in later runs are headless:
// the SDK refreshes the access token with the saved refresh token.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'

export const ORBIO_MCP_URL = new URL(process.env.ORBIO_MCP_URL ?? 'https://www.orbio.so/api/mcp')
const STATE_DIR = process.env.ORBIO_STATE_DIR ?? '.orbio'
const CALLBACK_PORT = Number(process.env.ORBIO_CALLBACK_PORT ?? 8765)
const REDIRECT_URL = `http://localhost:${CALLBACK_PORT}/callback`
const LOGIN_TIMEOUT_MS = 5 * 60_000

const CLIENT_FILE = 'client.json'
const TOKENS_FILE = 'tokens.json'

function load<T>(file: string): T | undefined {
  const path = join(STATE_DIR, file)
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : undefined
}

function save(file: string, value: unknown): void {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(join(STATE_DIR, file), JSON.stringify(value, null, 2), { mode: 0o600 })
}

/** Client registration and tokens persist on disk; the PKCE verifier only lives for one login. */
class AgentOAuthProvider implements OAuthClientProvider {
  authorizationUrl?: URL
  private verifier?: string

  get redirectUrl() {
    return REDIRECT_URL
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Hunch agent',
      redirect_uris: [REDIRECT_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'orbio:credits',
    }
  }

  clientInformation() {
    return load<OAuthClientInformationMixed>(CLIENT_FILE)
  }

  saveClientInformation(info: OAuthClientInformationMixed) {
    save(CLIENT_FILE, info)
  }

  tokens() {
    return load<OAuthTokens>(TOKENS_FILE)
  }

  saveTokens(tokens: OAuthTokens) {
    save(TOKENS_FILE, tokens)
  }

  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url
  }

  saveCodeVerifier(verifier: string) {
    this.verifier = verifier
  }

  codeVerifier() {
    if (!this.verifier) throw new Error('No PKCE code verifier saved for this login')
    return this.verifier
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'all' || scope === 'client') rmSync(join(STATE_DIR, CLIENT_FILE), { force: true })
    if (scope === 'all' || scope === 'tokens') rmSync(join(STATE_DIR, TOKENS_FILE), { force: true })
    if (scope === 'all' || scope === 'verifier') this.verifier = undefined
  }
}

/**
 * A deployed agent can't open a browser, so its first login arrives as ORBIO_LOGIN_SEED: base64
 * JSON of the client registration and tokens that `npm run orbio:login` saved. From then on it
 * keeps its own refreshed tokens on disk.
 */
function seedLogin(): void {
  const seed = process.env.ORBIO_LOGIN_SEED
  if (!seed || existsSync(join(STATE_DIR, CLIENT_FILE))) return
  const { client, tokens } = JSON.parse(Buffer.from(seed, 'base64').toString('utf8'))
  save(CLIENT_FILE, client)
  save(TOKENS_FILE, tokens)
}

/**
 * Connects to the Orbio MCP as the agent. With `interactive`, a missing or dead login opens the
 * browser once; without it (cron, server) the agent fails loudly instead of waiting forever.
 */
export async function connectOrbio({ interactive = false } = {}): Promise<Client> {
  seedLogin()
  const provider = new AgentOAuthProvider()
  const client = new Client({ name: 'hunch-agent', version: '0.1.0' })
  const transport = new StreamableHTTPClientTransport(ORBIO_MCP_URL, { authProvider: provider })
  try {
    await client.connect(transport)
    return client
  } catch (err) {
    if (!(err instanceof UnauthorizedError)) throw err
  }
  if (!interactive || !provider.authorizationUrl) {
    throw new Error('The agent is not signed in to Orbio. Run `npm run orbio:login` on a machine with a browser.')
  }
  const code = await waitForAuthorizationCode(provider.authorizationUrl)
  await transport.finishAuth(code)
  await client.connect(new StreamableHTTPClientTransport(ORBIO_MCP_URL, { authProvider: provider }))
  return client
}

function waitForAuthorizationCode(authorizationUrl: URL): Promise<string> {
  return new Promise((resolve, reject) => {
    const finish = (err: Error | null, code?: string) => {
      clearTimeout(timer)
      server.close()
      if (err) reject(err)
      else resolve(code!)
    }
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', REDIRECT_URL)
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error_description') ?? url.searchParams.get('error')
      res.writeHead(code ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' })
      res.end(code ? PAGE_SIGNED_IN : PAGE_FAILED)
      if (code) finish(null, code)
      else finish(new Error(`Orbio sign-in failed: ${error ?? 'no authorization code returned'}`))
    })
    const timer = setTimeout(
      () => finish(new Error('Timed out waiting for the Orbio sign-in (5 minutes)')),
      LOGIN_TIMEOUT_MS,
    )
    server.on('error', (err) => finish(err))
    server.listen(CALLBACK_PORT, 'localhost', () => {
      console.log(`\nSign the agent in to Orbio (a browser tab should open):\n${authorizationUrl.href}\n`)
      openInBrowser(authorizationUrl.href)
    })
  })
}

// rundll32 instead of `cmd /c start`, which would cut the URL at its first `&`.
function openInBrowser(url: string): void {
  const [command, args]: [string, string[]] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]]
  spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
}

const PAGE_SIGNED_IN = `<!doctype html><title>Signed in</title>
<body style="font-family:system-ui;padding:3rem"><h1>The agent is signed in to Orbio.</h1><p>You can close this tab.</p></body>`
const PAGE_FAILED = `<!doctype html><title>Sign-in failed</title>
<body style="font-family:system-ui;padding:3rem"><h1>Orbio sign-in failed.</h1><p>Check the terminal for details.</p></body>`
