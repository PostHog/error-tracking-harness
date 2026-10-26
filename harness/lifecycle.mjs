// Fixture-independent workspace preparation and process runtime. Format-specific collection stays
// in execute.mjs; these phases do not require package.json or an inferred Node entrypoint.
import { writeFileSync } from 'node:fs'
import { prepareNodeModules } from './subject.mjs'
import { runCommand } from './commands.mjs'

export async function prepareWorkspace({ fixture, work, overrides = new Map(), env, tokens }) {
    const workspace = fixture.lifecycle.workspace
    if (workspace.adapter === 'node-modules') return prepareNodeModules({ fixtureDir: fixture.dir, fixture, work, overrides })
    if (overrides.size) throw new Error(`${fixture.name}: command workspace has no binding for ${[...overrides.keys()].join(', ')}`)
    const result = await runCommand(workspace.command, { work, env, tokens })
    if (result.code !== 0) throw new Error(`${fixture.name}: workspace preparation exited with ${result.code}: ${result.output.slice(0, 300)}`)
    return { name: fixture.plugin ?? 'command', version: 'command', source: 'command', packages: {}, framework: null }
}

export async function runProcess({ fixture, work, env, tokens, log }) {
    let output = ''
    let code = 0
    let signal = null
    for (const trigger of fixture.lifecycle.triggers) {
        const result = await runCommand(trigger.command, { work, env, tokens })
        output += result.output
        if (result.code !== 0) { code = result.code; signal = result.signal; break }
    }
    if (log) writeFileSync(log, output)
    return { code, signal, output }
}
