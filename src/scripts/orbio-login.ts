// Signs the agent in to Orbio as its own OAuth client (once, in the browser), then prints the MCP's
// real tools and the results of its read-only calls. Later runs refresh the login headlessly.
import '../env.js'
import { connectOrbio } from '../orbio/mcp.js'

// A key must never reach the logs, even if a tool echoes one back.
const redact = (value: unknown) =>
  JSON.stringify(value, null, 2).replace(/sk-(orbio|or)-[\w-]{6,}/g, (key) => `${key.slice(0, 14)}…`)

const client = await connectOrbio({ interactive: true })
console.log('The Hunch agent is signed in to Orbio.')

const { tools } = await client.listTools()
console.log(`\nTools: ${tools.map((t) => t.name).join(', ')}`)

// Only calls that change nothing. The agent mints its key when it starts.
for (const name of ['orbio_get_balance', 'orbio_get_key_status']) {
  const result = await client.callTool({ name, arguments: {} })
  console.log(`\n${name} →\n${redact(result.structuredContent ?? result.content)}`)
}
await client.close()
