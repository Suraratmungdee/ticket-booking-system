import { createClient, type RedisClientType } from 'redis'
import { REDIS_URL } from './config.js'

let client: RedisClientType | null = null

// Lazily connected singleton. Connecting on first use (rather than at import
// time) keeps the unit tests — which mock this module — from ever opening a
// socket, and lets the API boot even when Redis is not up yet.
export async function getRedis(): Promise<RedisClientType> {
  if (!client) {
    client = createClient({ url: REDIS_URL })
    client.on('error', (err) => console.error('[redis]', err instanceof Error ? err.message : err))
    await client.connect()
  }
  return client
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit()
    client = null
  }
}
