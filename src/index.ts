import debugFactory from 'debug';
import uuid from 'uuid/v1';

const debug = debugFactory('smart-request-balancer');

type Rule = {
  rate: number;
  limit: number;
  priority: number;
};

type RetryFunction = (delay: number) => void;
type QueueRequest = (RetryFunction: RetryFunction) => Promise<any>;
type Callback = (error: Error | null, data?: any) => void;

type QueueItemData = {
  id: string;
  request: QueueRequest;
  callback: Callback;
};

type QueueItem = {
  id: string;
  cooldown: number;
  key: string;
  data: QueueItemData[];
  rule: Rule;
  ruleName: string;
};

type ShiftItemStructure = {
  queue: QueueItem;
  item: QueueItemData;
};

type UserConfig = {
  rules?: {
    [key: string]: Rule;
  };
  default?: {
    rule: string;
    key: string;
  };
  overall?: Rule;
  retryTime?: number;
  ignoreOverallOverheat?: boolean;
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

const defaultParams: UserConfig = {
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
  private overheat = 0;
  private pending = false;
  private readonly heatPart: number;

  constructor(params?: UserConfig) {
    this.params = Object.assign({}, defaultParams, params) as QueueConfig;

    this.heatPart = (this.params.overall.limit * 1000) / this.params.overall.rate;
  }

  public request(
    fn: QueueRequest,
    key: string = this.params.default.key,
    rule: string = this.params.default.rule
  ): Promise<any> {
    debug('Adding queue request', key, rule);

    return new Promise((resolve, reject) => {
      this.add(
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

  public get isOverheated(): boolean {
    return this.overheat > 0;
  }

  public get totalLength(): number {
    let length = 0;

    this.queue.forEach(queue => {
      length += queue.data.length;
    });

    return length;
  }

  private add(
    request: QueueRequest,
    callback: Callback,
    key: string = this.params.default.key,
    rule: string = this.params.default.rule
  ): void {
    const queue = this.createQueue(key, request, callback, rule);

    debug('Adding request to the queue', queue.id);

    if (!this.pending) {
      this.execute(queue);
    }
  }

  private createQueue(queueName: string, request: QueueRequest, callback: Callback, rule: string): QueueItem {
    if (!this.queue.has(queueName)) {
      const queueId = uuid();

      debug('Creating queue', queueId, queueName, rule);

      this.queue.set(queueName, {
        cooldown: 0,
        data: [],
        id: queueId,
        key: queueName,
        rule: this.getRule(rule),
        ruleName: rule
      });
    }

    const queue = this.queue.get(queueName) as QueueItem;
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

  private async execute(queue?: QueueItem): Promise<void> {
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
      const startTime = Date.now();
      const data = await nextItem.item.request(retryFn);
      const endTime = Date.now();
      const executionTime = endTime - startTime;

      this.heat(executionTime);
      this.setCooldown(nextItem.queue, executionTime);

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

    return this.execute();
  }

  private async shift(queue?: QueueItem): Promise<ShiftItemStructure | null> {
    const currentQueue = await this.findMostImportant(queue);

    if (!currentQueue || currentQueue.data.length === 0) {
      return null;
    }

    return {
      item: currentQueue.data.shift() as QueueItemData,
      queue: currentQueue
    };
  }

  private heat(part: number = 0) {
    if (this.params.ignoreOverallOverheat) {
      return;
    }

    if (part >= this.heatPart) {
      debug('Overall queue is already cold');

      return;
    }

    this.overheat += this.heatPart;

    debug('Heating overall queue', this.overheat);

    setTimeout(() => {
      this.overheat = Math.max(this.overheat - this.heatPart, 0);

      debug('Cooling down overall queue', this.overheat);
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

    this.queue.forEach((queue: QueueItem) => {
      if (queue.rule.priority < maximumPriority && queue.data.length && this.isCool(queue)) {
        maximumPriority = queue.rule.priority;
        selectedQueue = queue;
      }

      if (queue.cooldown < minimalCooldown) {
        minimalCooldown = queue.cooldown;
      }
    });

    if (minimalCooldown > 0 && minimalCooldown !== Infinity) {
      debug('Waiting for cooldown', minimalCooldown);

      await this.delay(minimalCooldown);

      return this.findMostImportant();
    }

    if (this.isOverheated && !this.params.ignoreOverallOverheat) {
      debug('Everything is overheated');

      await this.delay(this.overheat);

      return this.findMostImportant();
    }

    if (!selectedQueue && this.totalLength === 0) {
      debug('No queues available. Stopping queue');

      this.pending = false;

      return null;
    }

    debug('Finding best queue', selectedQueue && (selectedQueue as QueueItem).id);

    return selectedQueue;
  }

  private setCooldown(queue: QueueItem, part: number = 0) {
    const ruleData = this.params.rules[queue.ruleName];
    const cooldown = (ruleData.limit * 1000) / ruleData.rate;

    if (part >= cooldown) {
      debug('Queue is already cold', queue.id);

      if (!queue.data.length) {
        this.remove(queue.key);
      }

      return;
    }

    queue.cooldown = cooldown;

    debug('Setting cooldown', queue.id, cooldown);

    setTimeout(() => {
      queue.cooldown = Math.max(queue.cooldown - cooldown, 0);

      debug('Removing cooldown', queue.id, cooldown);

      if (!queue.data.length) {
        this.remove(queue.key);
      }
    }, cooldown);
  }

  private delay(time = 0): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, time));
  }

  private isCool(queue: QueueItem): boolean {
    const cooldown = (queue.rule.limit * 1000) / queue.rule.rate;

    return queue.cooldown < cooldown;
  }

  private remove(key: string) {
    debug('Deleting queue', key);

    this.queue.delete(key);
  }
}

export = SmartQueue;
