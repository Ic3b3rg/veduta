/** Serializes asynchronous callbacks and reports each failure without rejecting later work. */
export class SerializedWorkQueue {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly onError: (error: unknown) => void) {}

  enqueue(work: () => Promise<void>): void {
    this.chain = this.chain.then(work, work).catch(this.onError)
  }

  flush(): Promise<void> {
    return this.chain.then(
      () => undefined,
      () => undefined,
    )
  }
}
