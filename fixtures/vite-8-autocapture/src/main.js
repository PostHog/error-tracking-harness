// Exercise the packed posthog-js browser SDK and its separately loaded exception script.
// The harness serves the script from the installed tarball on the loopback mock API.
import posthog from 'posthog-js'

const host = new URLSearchParams(location.search).get('host')
posthog.init('phc_harness', {
    api_host: host,
    capture_exceptions: true,
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    disable_session_recording: true,
    advanced_disable_decide: true,
    opt_out_useragent_filter: true,
    persistence: 'memory',
})

document.querySelector('#app').textContent = 'waiting for exception autocapture'
// Wait until the lazy script is present. The SDK calls its wrapper after loading the script;
// the timer lets that callback finish before our exception escapes the browser's event loop.
function throwWhenReady() {
    if (!window.__PosthogExtensions__?.errorWrappingFunctions) return setTimeout(throwWhenReady, 20)
    import('./boom.js').then(({ explodeUncaught }) => setTimeout(explodeUncaught, 0))
}
throwWhenReady()
