import { PostHog } from 'posthog-node'
import { explode } from './boom.js'

async function main() {
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
    const { lazyExplode } = await import('./lazy.js')
    try {
        lazyExplode()
    } catch (error) {
        client.captureException(error, 'harness-user', { harness_case: 'lazy' })
    }
    await client.shutdown()
}

main().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
