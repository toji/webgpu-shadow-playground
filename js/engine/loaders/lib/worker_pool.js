// This utility eases some of the pain points around worker communication and makes setting up pools
// of workers that all do the same thing trivial.

//========
// Client
//========

export class WorkerPool {
  #workerPath;
  #maxWorkerPoolSize;
  #onMessage;
  #pendingWorkItems = new Map();
  #nextWorkItemId = 1;
  #workerPool = [];
  #nextWorker = 0;

  constructor(workerPath, maxWorkerPoolSize = 4) {
    this.#workerPath = workerPath;
    this.#maxWorkerPoolSize = maxWorkerPoolSize;

    this.#onMessage = (msg) => {
      const id = msg.data.id;
      const workItem = this.#pendingWorkItems.get(id);
      if (!workItem) {
        console.error(`Got a result for unknown work item ${id}`);
        return;
      }
      this.#pendingWorkItems.delete(id);

      if (msg.data.error) {
        workItem.reject(msg.data.error);
        return;
      }

      workItem.resolve(msg.data.result);
    };
  }

  #selectWorker(id, resolve, reject) {
    this.#pendingWorkItems.set(id, {resolve, reject});
    if (this.#pendingWorkItems.size >= this.#workerPool.length &&
        this.#workerPool.length < this.#maxWorkerPoolSize) {
      // Add a new worker
      const worker = new Worker(this.#workerPath);
      worker.onmessage = this.#onMessage;
      this.#workerPool.push(worker);
      return worker;
    }
    return this.#workerPool[this.#nextWorker++ % this.#workerPool.length];
  }

  dispatch(args, transfer) {
    return new Promise((resolve, reject) => {
      const id = this.#nextWorkItemId++;
      this.#selectWorker(id, resolve, reject).postMessage({
        id,
        args
      }, transfer);
    });
  }
}
