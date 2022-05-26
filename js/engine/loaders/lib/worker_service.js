//========
// Server
//========

class TransferResult {
  constructor(result, transfer) {
    this.result = result;
    this.transfer = transfer;
  }
}

class WorkerService {
  static #workerServices = [];
  static register(workerService) {
    WorkerService.#workerServices.push(workerService);
    workerService.#listen();
  }

  constructor() {
    this.initialized = this.init();
  }

  #listen() {
    addEventListener('message', async (msg) => {
      await this.initialized;

      const id = msg.data.id;
      const args = msg.data.args;

      try {
        const result = await this.onDispatch(args);
        if (result instanceof TransferResult) {
          postMessage({ id, result: result.result }, result.transfer);
        } else {
          postMessage({ id, result });
        }

      } catch(error) {
        postMessage({ id, error });
      }
    });
  }

  async init() {
    // Override with any custom initialization logic that needs to happen asynchronously.
  }

  async onDispatch(args) {
    // Override to handle dispatched messages
    throw new Error('Classes that extend WorkerPoolService must override onDispatch');
  }

  transfer(result, transfer) {
    return new TransferResult(result, transfer);
  }
}
