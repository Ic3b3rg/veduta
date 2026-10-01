/** Serializes asynchronous callbacks and reports each failure without rejecting later work. */
export class SerializedWorkQueue {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly onError: (error: unknown) => void) {}

  enqueue(work: () => Promise<void>): Promise<void> {
    const result = this.chain.then(work, work)
    this.chain = result.catch(this.onError)
    return result
  }

  flush(): Promise<void> {
    return this.chain.then(
      () => undefined,
      () => undefined,
    )
  }
}
