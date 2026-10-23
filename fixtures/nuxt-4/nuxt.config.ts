// The harness passes the plugin options for the case under test as one JSON variable, in the
// shape the bundler plugins take; the Nuxt module spells the same options under posthogConfig.
const options = JSON.parse(process.env.POSTHOG_HARNESS_OPTIONS ?? '{}')

export default defineNuxtConfig({
    modules: ['@posthog/nuxt'],
    // A fixed build id: nothing in this fixture relies on it changing between releases.
    buildId: 'harness-build',
    // Nuxt otherwise moves the build directory under node_modules/.cache once one exists, which
    // changes virtual module paths, and with them chunk bytes, between two identical builds.
    buildDir: '.nuxt',
    posthogConfig: {
        publicKey: 'phc_harness',
        host: options.host,
        cliBinaryPath: options.cliBinaryPath,
        sourcemaps: {
            enabled: options.sourcemaps?.enabled ?? true,
            personalApiKey: options.personalApiKey,
            projectId: options.projectId,
            releaseName: options.sourcemaps?.releaseName,
            releaseVersion: options.sourcemaps?.releaseVersion,
            deleteAfterUpload: options.sourcemaps?.deleteAfterUpload,
            logLevel: options.logLevel,
        },
    },
})
