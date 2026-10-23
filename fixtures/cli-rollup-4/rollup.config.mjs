// No PostHog plugin: the harness runs posthog-cli on the built files afterwards, the way a
// user without a bundler plugin does. POSTHOG_HARNESS_SOURCEMAP=hidden drops the comment.
export default {
    input: { main: 'src/index.js' },
    external: ['posthog-node'],
    output: {
        dir: 'dist',
        format: 'es',
        entryFileNames: '[name].mjs',
        chunkFileNames: '[name]-[hash].mjs',
        sourcemap: process.env.POSTHOG_HARNESS_SOURCEMAP === 'hidden' ? 'hidden' : true,
    },
}
