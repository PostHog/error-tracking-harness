class LazyFailure extends Error {
    constructor(message) {
        super(message)
        this.name = 'LazyFailure'
    }
}

export function lazyExplode() {
    const values = [1, 2, 3].map((value) => value * 2)
    throw new LazyFailure(`lazy chunk failed with ${values.length} values`) // harness:throw:lazy
}
