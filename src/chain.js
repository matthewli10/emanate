export function createChain() {
  let tail = Promise.resolve()
  return function chain(fn) {
    const run = tail.then(() => fn())
    tail = run.then(
      () => {},
      () => {},
    )
    return run
  }
}
