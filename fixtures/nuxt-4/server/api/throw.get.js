import { PostHog } from 'posthog-node'
import { explode } from '../../lib/boom.js'

// A Nitro server route: Node runtime, posthog-node traced into .output/server/node_modules.
export default defineEventHandler(async () => {
    const client = new PostHog('phc_harness', {
        host: process.env.POSTHOG_HARNESS_HOST,
        flushAt: 1,
        flushInterval: 0,
        disableGeoip: true,
        fetchRetryCount: 0,
    })
    try {
        explode('entry chunk')
    } catch (error) {
        client.captureException(error, 'harness-user', { harness_case: 'entry' })
    }
    const { lazyExplode } = await import('../../lib/lazy.js')
    try {
        lazyExplode()
    } catch (error) {
        client.captureException(error, 'harness-user', { harness_case: 'lazy' })
    }
    await client.shutdown()
    return { ok: true }
})
