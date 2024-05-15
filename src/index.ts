import debugFactory from 'debug';
import uuid from 'uuid/v1';

const debug = debugFactory('smart-request-balancer');

type Rule = {
  rate: number;
  limit: number;
  priority: number;
};

type RetryFunction = (delay?: number) => void;
type QueueRequest<R> = (RetryFunction: RetryFunction) => Promise<R>;
type Callback<R> = (error: Error | null, data?: R) => void;

type QueueItemData<R> = {
  id: string;
  request: QueueRequest<R>;
  callback: Callback<R>;
};

type QueueItem = {
  id: string;
  cooldown: number;
  key: string;
  data: Array<QueueItemData<any>>;
  rule: Rule;
  ruleName: string;
};

type ShiftItemStructure = {
  queue: QueueItem;
  item: QueueItemData<any>;
};

type QueueConfig = {
  rules: {
    [key: string]: Rule;
  };
  default: {
    rule: string;
    key: string;
  };
  overall: Rule;
  retryTime: number;
  ignoreOverallOverheat: boolean;
};

type QueueMap = Map<string, QueueItem>;

const defaultParams = {
  default: {
    rule: 'common',
    key: 'common'
  },
  rules: {
    common: {
      rate: 30,
      limit: 1,
      priority: 3
    }
  },
  overall: {
    rate: 30,
    limit: 1,
    priority: 1
  },
  retryTime: 300,
  ignoreOverallOverheat: true
};

class SmartQueue {
  private params: QueueConfig;
  private queue: QueueMap = new Map();
  private overheat = Date.now();
  private pending = false;
  private readonly heatPart: number;

  constructor(params?: Partial<QueueConfig>) {
    this.params = Object.assign({}, defaultParams, params);

    this.heatPart = (this.params.overall.limit * 1000) / this.params.overall.rate;
  }

  public request<R>(
    fn: QueueRequest<R>,
    key: string = this.params.default.key,
    rule: string = this.params.default.rule
  ): Promise<R> {
    debug('Adding queue request', key, rule);

    return new Promise((resolve, reject) => {
      this.add<R>(
        fn,
        (error, data) => {
          if (error) {
            debug('Request resolving error', key, rule, error);

            return reject(error);
          }

          debug('Resolving queue request', key, rule);

          return resolve(data);
        },
        key,
        rule
      );
    });
  }

  public clear() {
    debug('Clearing all queues');

    this.queue.clear();
  }

  public get isOverheated(): boolean {
    return this.overheat > Date.now();
  }

  public get totalLength(): number {
    let length = 0;

    this.queue.forEach(queue => {
      length += queue.data.length;
    });

    return length;
  }

  private add<R>(request: QueueRequest<R>, callback: Callback<R>, key: string, rule: string): void {
    const queue = this.createQueue<R>(key, request, callback, rule);

    debug('Adding request to the queue', queue.id);

    if (!this.pending) {
      this.execute(queue);
    }
  }

  private createQueue<R>(queueName: string, request: QueueRequest<R>, callback: Callback<R>, rule: string): QueueItem {
    if (!this.queue.has(queueName)) {
      const queueId = uuid();

      debug('Creating queue', queueId, queueName, rule);

      this.queue.set(queueName, {
        cooldown: Date.now(),
        data: [],
        id: queueId,
        key: queueName,
        rule: this.getRule(rule),
        ruleName: rule
      });
    }

    const queue = this.queue.get(queueName)!;
    const queueItemId = uuid();

    debug('Adding item to existing queue', queue.id, queueItemId);

    queue.data.push({
      callback,
      id: queueItemId,
      request
    });

    return queue;
  }

  private getRule(name: string): Rule {
    if (this.params.rules[name]) {
      return this.params.rules[name];
    }

    this.params.rules[name] = this.params.rules[this.params.default.rule];

    return this.params.rules[name];
  }

  private async addRetry(item: ShiftItemStructure, delay: number) {
    debug('Adding retry', item.queue.id, delay);

    await this.delay(delay * 1000);

    this.add(item.item.request, item.item.callback, item.queue.key, item.queue.ruleName);
  }

  private async execute(queue?: QueueItem) {
    if (queue) {
      debug('Executing queue', queue.id);
    }

    this.pending = true;

    let retryState = false;
    let retryTimer = 0;
    const retryFn = (delay?: number) => {
      retryState = true;
      retryTimer = delay || this.params.retryTime;
    };

    const nextItem = await this.shift(queue);

    if (!nextItem || !nextItem.item) {
      return;
    }

    debug('Executing queue item', nextItem.item.id);

    try {
      const requestPromise = nextItem.item.request(retryFn);
      this.heat();
      this.execute();
      const data = await requestPromise;
      if (retryState) {
        this.addRetry(nextItem, retryTimer);
      } else {
        debug('Queue item executed successfully', nextItem.item.id);

        nextItem.item.callback(null, data);
      }
    } catch (error) {
      debug('Queue item request error', error);

      nextItem.item.callback(error);
    }
  }

  private async shift(queue?: QueueItem): Promise<ShiftItemStructure | null> {
    const currentQueue = await this.findMostImportant(queue);

    if (!currentQueue || currentQueue.data.length === 0) {
      return null;
    }

    this.setCooldown(currentQueue);

    return {
      item: currentQueue.data.shift()!,
      queue: currentQueue
    };
  }

  private heat() {
    if (this.params.ignoreOverallOverheat) {
      return;
    }

    this.overheat = Date.now() + this.heatPart;
    const lastOverheat = this.overheat;

    debug('Heating overall queue', this.heatPart);

    setTimeout(() => {
      const leftOverHeat = Math.max(this.overheat - lastOverheat, 0);
      this.overheat = Date.now() + leftOverHeat;

      debug('Cooling down overall queue', leftOverHeat);
    }, this.heatPart);
  }

  private async findMostImportant(bestQueue?: QueueItem): Promise<QueueItem | null> {
    if (bestQueue) {
      debug('Providing best queue', bestQueue.id);

      return bestQueue;
    }

    let maximumPriority = Infinity;
    let selectedQueue: QueueItem | null = null;
    let minimalCooldown = Infinity;

    const now = Date.now();

    this.queue.forEach((queue) => {
      if (queue.rule.priority < maximumPriority && queue.data.length && this.isCool(queue, now)) {
        maximumPriority = queue.rule.priority;
        selectedQueue = queue;
      }

      if (queue.cooldown < minimalCooldown && queue.cooldown > now) {
        minimalCooldown = queue.cooldown;
      }
    });

    const defactoMinimalCooldown = minimalCooldown - now;

    if (!selectedQueue && defactoMinimalCooldown > 0 && minimalCooldown !== Infinity) {
      debug('Waiting for cooldown', defactoMinimalCooldown);

      await this.delay(defactoMinimalCooldown);

      return this.findMostImportant();
    }

    if (this.isOverheated && !this.params.ignoreOverallOverheat) {
      debug('Everything is overheated');

      await this.delay(this.overheat - now);

      return this.findMostImportant();
    }

    if (!selectedQueue && this.totalLength === 0) {
      debug('No queues available. Stopping queue');

      this.pending = false;

      return null;
    }

    debug('Finding best queue', selectedQueue && selectedQueue!.id);

    return selectedQueue;
  }

  private setCooldown(queue: QueueItem) {
    const ruleData = this.params.rules[queue.ruleName];
    const defactoCooldown = (ruleData.limit * 1000) / ruleData.rate;
    const cooldown = Date.now() + defactoCooldown;

    queue.cooldown = cooldown;

    debug('Setting cooldown', queue.id, defactoCooldown);

    setTimeout(() => {
      queue.cooldown = Date.now() + Math.max(queue.cooldown - cooldown, 0);

      debug('Removing cooldown', queue.id, defactoCooldown);

      if (!queue.data.length) {
        this.remove(queue.key);
      }
    }, defactoCooldown);
  }

  private delay(time: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, time));
  }

  private isCool(queue: QueueItem, comparedTo: number): boolean {
    return queue.cooldown <= comparedTo;
  }

  private remove(key: string) {
    debug('Deleting queue', key);

    this.queue.delete(key);
  }
}

export = SmartQueue;
