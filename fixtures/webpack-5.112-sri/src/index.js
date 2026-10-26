// A browser entry: posthog-js is bundled, so it reads the chunk ids and release the plugin
// injected into this chunk and the lazy one. The harness passes its mock as ?host=.
import posthog from 'posthog-js'
import { explode } from './boom.js'

const host = new URLSearchParams(location.search).get('host')
posthog.init('phc_harness', {
    api_host: host,
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    disable_session_recording: true,
    advanced_disable_decide: true,
    _disable_external_dependency_loading: true,
    // Playwright is detected as a bot on purpose; this fixture captures from it deliberately.
    opt_out_useragent_filter: true,
    persistence: 'memory',
})

document.querySelector('#app').textContent = 'error tracking harness'
try {
    explode('entry chunk')
} catch (error) {
    posthog.captureException(error, { harness_case: 'entry' })
}
import('./lazy.js').then(({ lazyExplode }) => {
    try {
        lazyExplode()
    } catch (error) {
        posthog.captureException(error, { harness_case: 'lazy' })
    }
})
