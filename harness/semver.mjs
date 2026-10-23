// Enough of node-semver for the ranges published packages declare: `^`, `~`, comparators,
// exact versions, `x`/`*`, space-separated ANDs and `||`. Keeps the harness dependency-free.

export function parse(version) {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version.trim())
    if (!match) throw new Error(`Not a version: ${version}`)
    return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: match[4] }
}

export function compare(a, b) {
    const left = typeof a === 'string' ? parse(a) : a
    const right = typeof b === 'string' ? parse(b) : b
    for (const part of ['major', 'minor', 'patch']) if (left[part] !== right[part]) return left[part] - right[part]
    if (left.prerelease === right.prerelease) return 0
    if (!left.prerelease) return 1
    if (!right.prerelease) return -1
    return left.prerelease < right.prerelease ? -1 : 1
}

// One comparator set: every predicate must hold.
function comparatorSet(range) {
    const predicates = []
    for (const token of range.trim().split(/\s+/).filter(Boolean)) {
        if (token === '*' || token === 'x' || token === '') continue
        const match = /^(\^|~|>=|<=|>|<|=)?v?(\d+|x|\*)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-([0-9A-Za-z.-]+))?$/.exec(token)
        if (!match) throw new Error(`Unsupported range: ${range}`)
        const [, operator = '', majorText, minorText, patchText, prerelease] = match
        const wild = (text) => text === undefined || text === 'x' || text === '*'
        const major = Number(majorText)
        const minor = wild(minorText) ? 0 : Number(minorText)
        const patch = wild(patchText) ? 0 : Number(patchText)
        const low = { major, minor, patch, prerelease }
        const ge = (bound) => (version) => compare(version, bound) >= 0
        const lt = (bound) => (version) => compare(version, bound) < 0
        if (operator === '^') {
            predicates.push(ge(low))
            if (major > 0) predicates.push(lt({ major: major + 1, minor: 0, patch: 0 }))
            else if (minor > 0 || wild(patchText)) predicates.push(lt({ major: 0, minor: minor + 1, patch: 0 }))
            else predicates.push(lt({ major: 0, minor, patch: patch + 1 }))
        } else if (operator === '~' || (operator === '' && wild(patchText) && !wild(minorText))) {
            predicates.push(ge(low), lt({ major, minor: minor + 1, patch: 0 }))
        } else if (operator === '' && wild(minorText)) {
            predicates.push(ge(low), lt({ major: major + 1, minor: 0, patch: 0 }))
        } else if (operator === '' || operator === '=') {
            predicates.push((version) => compare(version, low) === 0)
        } else if (operator === '>=') predicates.push(ge(low))
        else if (operator === '>') predicates.push((version) => compare(version, low) > 0)
        else if (operator === '<=') predicates.push((version) => compare(version, low) <= 0)
        else if (operator === '<') predicates.push(lt(low))
    }
    return (version) => predicates.every((predicate) => predicate(version))
}

export function satisfies(version, range) {
    const parsed = parse(version)
    return range
        .split('||')
        .map(comparatorSet)
        .some((matches) => matches(parsed))
}
