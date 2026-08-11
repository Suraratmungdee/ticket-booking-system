import { createClient, type RedisClientType } from 'redis'
import { REDIS_URL } from './config.js'

let client: RedisClientType | null = null

// Lazily connected singleton. Connecting on first use (rather than at import
// time) keeps the unit tests — which mock this module — from ever opening a
// socket, and lets the API boot even when Redis is not up yet.
//
// The client is only cached after `connect()` succeeds. Caching it earlier
// (the previous bug) meant a failed connect left a poisoned, never-connected
// client in `client` forever — every later call returned it instead of
// retrying, so a Redis outage at boot was permanent until the process
// restarted. Nulling out on failure lets the next call try again.
export async function getRedis(): Promise<RedisClientType> {
  if (client) return client
  const candidate = createClient({ url: REDIS_URL })
  candidate.on('error', (err) => console.error('[redis]', err instanceof Error ? err.message : err))
  try {
    await candidate.connect()
  } catch (err) {
    client = null
    throw err
  }
  client = candidate
  return client
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit()
    client = null
  }
}
