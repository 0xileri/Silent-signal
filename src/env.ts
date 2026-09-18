// Loads .env (gitignored) when present. Import first in every entry point; deployments set real
// environment variables instead.
import { existsSync } from 'node:fs'

if (existsSync('.env')) process.loadEnvFile('.env')
