'use client'
// A client component that bundles posthog-js and throws from the same source files the API route
// uses, so the browser side of the same build is judged too. The harness passes its mock as ?host=.
import posthog from 'posthog-js'
import { useEffect } from 'react'
import { explode } from '../../lib/boom.js'

export default function Page() {
    useEffect(() => {
        const host = new URLSearchParams(location.search).get('host')
        posthog.init('phc_harness', {
            api_host: host,
            autocapture: false,
            capture_pageview: false,
            capture_pageleave: false,
            disable_session_recording: true,
            advanced_disable_decide: true,
            _disable_external_dependency_loading: true,
            opt_out_useragent_filter: true,
            persistence: 'memory',
        })
        try {
            explode('entry chunk')
        } catch (error) {
            posthog.captureException(error, { harness_case: 'browser-entry' })
        }
        import('../../lib/lazy.js').then(({ lazyExplode }) => {
            try {
                lazyExplode()
            } catch (error) {
                posthog.captureException(error, { harness_case: 'browser-lazy' })
            }
        })
    }, [])
    return <p id="client">error tracking harness, client</p>
}
