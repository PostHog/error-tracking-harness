import { PostHog } from 'posthog-node'
import { explode } from '../../lib/boom.js'

// A Pages API route: Node runtime, posthog-node externalized, the way a server captures.
export default async function handler(req, res) {
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
    res.json({ ok: true })
}
