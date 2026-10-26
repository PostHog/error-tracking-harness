// Fail before a long matrix run when a case or fixture has a typo or an invalid combination.
const FIXTURE = 'bundler cliSelection dist distGlobs distIgnore entry extends floorAlias integrity layout minCli minPlugin mode nodeModules optionalIds plugin runtime subject throws version volatileChunks'.split(' ')
const CASE = 'cli cliBinary description env expect fault git minCli minPlugin mode options releases server'.split(' ')
const EXPECT = 'build chunkIds cli events maps mapsBy metadataFree release reuploads symbols transport'.split(' ')
const MODES = ['plugin', 'cli', 'next', 'nuxt']
const MAPS = ['deleted', 'dangling', 'kept-hidden', 'kept-visible']
const EXPECT_VALUES = {
    build: ['green', 'fails'], cli: ['green', 'fails'], chunkIds: ['all', 'none', 'any'],
    maps: MAPS, symbols: ['all', 'none'], events: ['resolved', 'unresolved', 'no-release'],
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
    if (config.mode !== 'cli' && !config.plugin) throw new Error(`fixture ${name}: requires plugin`)
    if (config.mode === 'cli' && config.plugin) throw new Error(`fixture ${name}: cli mode cannot use a plugin`)
    if (!['node', 'http', 'browser', 'none'].includes(config.runtime?.kind ?? config.runtime ?? 'node')) throw new Error(`fixture ${name}: invalid runtime`)
}

export function validateCase(config, name) {
    keys(config, CASE, `case ${name}`)
    if (!MODES.includes(config.mode ?? 'plugin')) throw new Error(`case ${name}: invalid mode ${config.mode}`)
    if (config.releases !== undefined && (!Number.isInteger(config.releases) || config.releases < 1)) throw new Error(`case ${name}: releases must be a positive integer`)
    if (config.cli && config.mode !== 'cli') throw new Error(`case ${name}: cli steps require cli mode`)
    if (config.cliBinary && config.cliBinary !== 'fixture') throw new Error(`case ${name}: invalid cliBinary`)
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
    if (config.fault) keys(config.fault, ['api', 'status', 'code'], `case ${name} fault`)
    if (config.git) keys(config.git, ['remote', 'worktree'], `case ${name} git`)
}
