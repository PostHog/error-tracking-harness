import { withPostHogConfig } from '@posthog/nextjs-config'

// The harness passes the plugin options for the case under test as one JSON variable.
const posthogOptions = JSON.parse(process.env.POSTHOG_HARNESS_OPTIONS)

export default withPostHogConfig(
    {
        serverExternalPackages: ['posthog-node'],
        // A fixed build id: nothing in this fixture relies on it changing between releases.
        generateBuildId: async () => 'harness-build',
    },
    posthogOptions
)
