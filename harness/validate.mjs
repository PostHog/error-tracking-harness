// Fail before a long matrix run when a case or fixture has a typo or an invalid combination.
const FIXTURE = 'bundler cliSelection dist distGlobs distIgnore entry extends immutable integrity layout minCli mode nodeModules optionalIds plugin runtime tags throws version volatileChunks'.split(' ')
const CASE = 'cli description env expect git minCli mode options releases server'.split(' ')
const EXPECT = 'build chunkIds cli events eventsBy maps mapsBy metadataFree release reuploads symbols transport'.split(' ')
const MODES = ['plugin', 'cli', 'next', 'nuxt']
const MAPS = ['deleted', 'kept-hidden', 'kept-visible']
const EXPECT_VALUES = {
    build: ['green'], cli: ['green'], chunkIds: ['all', 'any'],
    maps: MAPS, symbols: ['all'], events: ['resolved'],
    transport: ['PUT', 'POST'],
}

function keys(object, allowed, label) {
    if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error(`${label}: expected an object`)
    for (const key of Object.keys(object)) if (!allowed.includes(key)) throw new Error(`${label}: unknown field ${key}`)
}

export function validateFixture(config, name) {
    keys(config, FIXTURE, `fixture ${name}`)
    if (!MODES.includes(config.mode ?? 'plugin')) throw new Error(`fixture ${name}: invalid mode ${config.mode}`)
    if (!config.throws || !config.bundler) throw new Error(`fixture ${name}: requires bundler and throws`)
    if (!Array.isArray(config.tags) || !config.tags.length || config.tags.some((tag) => typeof tag !== 'string' || !/^[a-z]+(?:-[a-z0-9]+)*$/.test(tag)) || new Set(config.tags).size !== config.tags.length) throw new Error(`fixture ${name}: requires unique lowercase kebab-case tags`)
    if (config.mode !== 'cli' && !config.plugin) throw new Error(`fixture ${name}: requires plugin`)
    if (config.mode === 'cli' && config.plugin) throw new Error(`fixture ${name}: cli mode cannot use a plugin`)
    if (!['node', 'http', 'browser', 'none'].includes(config.runtime?.kind ?? config.runtime ?? 'node')) throw new Error(`fixture ${name}: invalid runtime`)
}

export function validateCase(config, name) {
    keys(config, CASE, `case ${name}`)
    if (!MODES.includes(config.mode ?? 'plugin')) throw new Error(`case ${name}: invalid mode ${config.mode}`)
    if (config.releases !== undefined && (!Number.isInteger(config.releases) || config.releases < 1)) throw new Error(`case ${name}: releases must be a positive integer`)
    if (config.cli && config.mode !== 'cli') throw new Error(`case ${name}: cli steps require cli mode`)
    if (config.options?.sourcemaps?.releaseMode && config.options.sourcemaps.releaseMode !== 'event') throw new Error(`case ${name}: only event release mode is conformance`)
    if ((config.options?.sourcemaps?.releaseName === null || config.options?.sourcemaps?.releaseVersion === null) && !config.git && !config.env) throw new Error(`case ${name}: a release is required`)
    if (config.expect?.reuploads && Object.keys(config.expect.reuploads).some((key) => key === 'minPlugin' || key === 'minCli')) throw new Error(`case ${name}: version-gated expectations are not conformance`)
    if (config.expect) {
        keys(config.expect, EXPECT, `case ${name} expect`)
        for (const [field, allowed] of Object.entries(EXPECT_VALUES)) {
            const value = config.expect[field]
            if (value === undefined) continue
            const choices = typeof value === 'string' ? [value] : Object.values(value)
            if (choices.some((choice) => !allowed.includes(choice))) throw new Error(`case ${name}: invalid expect.${field}`)
        }
        if (config.expect.mapsBy && Object.values(config.expect.mapsBy).some((value) => !MAPS.includes(value))) {
            throw new Error(`case ${name}: invalid expect.mapsBy`)
        }
        if (config.expect.eventsBy !== undefined) {
            const by = config.expect.eventsBy
            if (!by || typeof by !== 'object' || Array.isArray(by)) throw new Error(`case ${name}: invalid expect.eventsBy`)
            for (const [throwName, value] of Object.entries(by)) {
                if (typeof value !== 'string' && (!value || typeof value !== 'object' || Array.isArray(value))) {
                    throw new Error(`case ${name}: invalid expect.eventsBy.${throwName}`)
                }
                const choices = typeof value === 'string' ? [value] : Object.values(value)
                if (choices.some((choice) => !EXPECT_VALUES.events.includes(choice))) {
                    throw new Error(`case ${name}: invalid expect.eventsBy.${throwName}`)
                }
            }
        }
    }
    if (config.cli) {
        keys(config.cli, ['command', 'input'], `case ${name} cli`)
        if (config.cli.command && !['process', 'inject-upload', 'upload'].includes(config.cli.command)) throw new Error(`case ${name}: invalid cli command`)
        if (config.cli.input && !['directory', 'stdin'].includes(config.cli.input)) throw new Error(`case ${name}: invalid cli input`)
    }
    if (config.server) {
        keys(config.server, ['presign'], `case ${name} server`)
        if (config.server.presign && !['both', 'post-only', 'put-only'].includes(config.server.presign)) throw new Error(`case ${name}: invalid presign`)
    }
    if (config.git) keys(config.git, ['remote', 'worktree'], `case ${name} git`)
}
