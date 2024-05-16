import { describe, expect, it } from '@jest/globals';
import SmartQueue from '../src';

const ERROR_RATE = 10;
const params = {
  rules: {
    common: {
      rate: 30,
      limit: 1,
      priority: 3
    },
    individual: {
      rate: 30,
      limit: 1,
      priority: 1
    },
    group: {
      rate: 3,
      limit: 1,
      priority: 2
    }
  },
  retryTime: 100
};

describe('Smart queue', () => {
  it('should be defined', () => {
    const queue = new SmartQueue(params);

    expect(queue).toBeDefined();
  });

  it('should be an object', () => {
    const queue = new SmartQueue(params);

    expect(queue).toBeInstanceOf(Object);
  });

  it('should have all required methods and fields', () => {
    const queue = new SmartQueue(params);

    expect(queue).toHaveProperty('request');
    expect(queue).toHaveProperty('totalLength');
    expect(queue).toHaveProperty('isOverheated');
  });

  it('should make requests', async () => {
    const queue = new SmartQueue(params);
    const request = jest.fn(async () => 1);

    const result = await queue.request(request);

    expect(result).toEqual(1);
  });

  it('should cool down queue after request', async () => {
    const queue = new SmartQueue(params);
    const request = jest.fn();

    await queue.request(request);

    expect(queue.totalLength).toBe(0);
    expect(queue.isOverheated).toBe(false);
  });

  it('should measure length', () => {
    const queue = new SmartQueue(params);
    const request = jest.fn();

    queue.request(request);
    queue.request(request);
    queue.request(request);

    expect(queue.totalLength).toBe(3);
  });

  it('should have length 0 after request', async () => {
    const queue = new SmartQueue(params);
    const request = jest.fn();

    await queue.request(request);
    await queue.request(request);
    await queue.request(request);

    expect(queue.totalLength).toBe(0);
  });

  it('should execute sequentally', async () => {
    const queue = new SmartQueue(params);
    const request = jest
      .fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(3);
    const callback = jest.fn();

    await queue.request(request).then(callback);
    await queue.request(request).then(callback);
    await queue.request(request).then(callback);

    expect(callback).toHaveBeenCalledTimes(3);
    expect(callback.mock.calls[0][0]).toBe(1);
    expect(callback.mock.calls[1][0]).toBe(2);
    expect(callback.mock.calls[2][0]).toBe(3);
  });

  it('should not execute calls faster than rate limit', async () => {
    const queue = new SmartQueue(params);
    const request = jest.fn();
    const callback = jest.fn();
    const rateLimit = Math.round((params.rules.common.limit / params.rules.common.rate) * 1000);

    await queue.request(request).then(callback);
    const firstEnd = Date.now();
    await queue.request(request).then(callback);
    const secondEnd = Date.now();

    expect(Math.abs(secondEnd - firstEnd - rateLimit)).toBeLessThanOrEqual(ERROR_RATE);
  });

  it('should make retry', async () => {
    const queue = new SmartQueue(params);
    const callback = jest.fn();
    let retryFlag = false;

    await queue
      .request(async retry => {
        if (!retryFlag) {
          retryFlag = true;
          retry(0.1);

          return;
        }

        return 1;
      })
      .then(callback);

    expect(callback).toBeCalledTimes(1);
    expect(callback).toBeCalledWith(1);
  });

  it('should make retry with default config param', async () => {
    const queue = new SmartQueue({ ...params, retryTime: 0.1 });
    const callback = jest.fn();
    let retryFlag = false;

    await queue
      .request(async retry => {
        if (!retryFlag) {
          retryFlag = true;
          retry();

          return;
        }

        return 1;
      })
      .then(callback);

    expect(callback).toBeCalledTimes(1);
    expect(callback).toBeCalledWith(1);
  });

  it('should return error', async () => {
    const queue = new SmartQueue(params);
    const request = jest.fn().mockImplementationOnce(() => {
      throw new Error('error');
    });
    const callback = jest.fn();

    await queue.request(request).catch(callback);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(expect.any(Error));
  });

  it('should hit overall heat limit', async () => {
    const overallRule = {
      rate: 10,
      limit: 1,
      priority: Infinity
    };
    const queue = new SmartQueue({
      ...params,
      ignoreOverallOverheat: false,
      overall: overallRule
    });
    const rateLimit = Math.round((overallRule.limit / overallRule.rate) * 1000);
    const request = jest.fn();
    const callback = jest.fn();

    await queue.request(request).then(callback);
    const firstEnd = Date.now();
    await queue.request(request).then(callback);
    const secondEnd = Date.now();

    expect(secondEnd - firstEnd).toBeGreaterThanOrEqual(rateLimit);
  });

  it('should create new rule if nothing found', async () => {
    const queue = new SmartQueue(params);
    const request = jest.fn().mockResolvedValue(1);
    const callback = jest.fn();

    await queue.request(request, '1', 'lol').then(callback);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(1);
    // @ts-ignore
    expect(queue.params.rules).toHaveProperty('lol');
  });

  it('should prioritize calls', async () => {
    const queue = new SmartQueue(params);
    const request = jest
      .fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(3);
    const callback = jest.fn();

    await Promise.all([
      queue.request(request, '1', 'group').then(callback),
      queue.request(request, '2', 'group').then(callback),
      queue.request(request, '3', 'individual').then(callback)
    ]);

    expect(callback).toHaveBeenCalledTimes(3);
    expect(callback).toHaveBeenCalledWith(1);
    expect(callback).toHaveBeenCalledWith(3);
    expect(callback).toHaveBeenCalledWith(2);
  });

  it('should not wait more than rate limit time', async () => {
    const queue = new SmartQueue(params);
    const request = () => new Promise(resolve => setTimeout(resolve, 50));
    let firstEnd = 0;
    let secondEnd = 0;

    await Promise.all([
      queue.request(request).then(() => (firstEnd = Date.now())),
      queue.request(request).then(() => (secondEnd = Date.now()))
    ]);

    expect(Math.abs(secondEnd - firstEnd - 33)).toBeLessThanOrEqual(ERROR_RATE);
  });

  it('should execute tasks regardless of execution time', async () => {
    const queue = new SmartQueue({
      rules: {
        common: {
          rate: 5,
          limit: 1,
          priority: 1
        }
      }
    });
    const request = () => new Promise(resolve => setTimeout(resolve, 300));
    let firstEnd = 0;
    let secondEnd = 0;

    await Promise.all([
      queue.request(request).then(() => (firstEnd = Date.now())),
      queue.request(request).then(() => (secondEnd = Date.now()))
    ]);

    expect(Math.abs(secondEnd - firstEnd - 200)).toBeLessThanOrEqual(ERROR_RATE);
  });

  it('should properly schedule requests on multiple queues', async () => {
    const queue = new SmartQueue({
      rules: {
        q1: {
          rate: 4,
          limit: 1,
          priority: 2
        },
        q2: {
          rate: 10,
          limit: 1,
          priority: 1
        }
      }
    });
    let r1Start = 0;
    let r2Start = 0;
    let r3Start = 0;
    let r4Start = 0;
    const request1 = () => {
      r1Start = Date.now();
      return Promise.resolve();
    };
    const request2 = () => {
      r2Start = Date.now();
      return Promise.resolve();
    };
    const request3 = () => {
      r3Start = Date.now();
      return Promise.resolve();
    };
    const request4 = () => {
      r4Start = Date.now();
      return Promise.resolve();
    };
    await Promise.all([
      queue.request(request1, 'q1', 'q1'),
      queue.request(request2, 'q1', 'q1'),
      queue.request(request3, 'q2', 'q2'),
      queue.request(request4, 'q2', 'q2')
    ]);
    expect(Math.abs(r3Start - r1Start)).toBeLessThanOrEqual(ERROR_RATE);
    expect(Math.abs(r4Start - r1Start - 100)).toBeLessThanOrEqual(ERROR_RATE);
    expect(Math.abs(r2Start - r1Start - 250)).toBeLessThanOrEqual(ERROR_RATE);
  });

  it('should clear queues', () => {
    const queue = new SmartQueue({
      rules: {
        q1: {
          rate: 10,
          limit: 1,
          priority: 1
        }
      }
    });

    queue.request(() => Promise.resolve(true), '1', 'q1');
    queue.request(() => Promise.resolve(true), '2', 'q1');

    expect(queue.totalLength).toBe(2);

    queue.clear();

    expect(queue.totalLength).toBe(0);
  });
});
