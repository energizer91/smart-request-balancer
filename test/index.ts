/* tslint:disable:no-unused-expression */
import { expect, use } from 'chai';
import { describe, it } from 'mocha';
import sinon from 'sinon';
import sinonChai from 'sinon-chai';
import SmartQueue from '../src';

use(sinonChai);

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

    expect(queue).not.to.be.undefined;
  });

  it('should be an object', () => {
    const queue = new SmartQueue(params);

    expect(queue).to.be.an('object');
  });

  it('should have all required methods and fields', () => {
    const queue = new SmartQueue(params);

    expect(queue).to.have.property('request');
    expect(queue).to.have.property('totalLength');
    expect(queue).to.have.property('isOverheated');
  });

  it('should make requests', async () => {
    const queue = new SmartQueue(params);
    const request = sinon.stub().returns(1);

    const result = await queue.request(request);

    expect(result).to.eq(1);
  });

  it('should cool down queue after request', async () => {
    const queue = new SmartQueue(params);
    const request = sinon.stub();

    await queue.request(request);

    expect(queue.totalLength).to.eq(0);
    expect(queue.isOverheated).to.eq(false);
  });

  it('should measure length', () => {
    const queue = new SmartQueue(params);
    const request = sinon.stub();

    queue.request(request);
    queue.request(request);
    queue.request(request);

    expect(queue.totalLength).to.eq(3);
  });

  it('should have length 0 after request', async () => {
    const queue = new SmartQueue(params);
    const request = sinon.stub();

    await queue.request(request);
    await queue.request(request);
    await queue.request(request);

    expect(queue.totalLength).to.eq(0);
  });

  it('should execute sequentally', async () => {
    const queue = new SmartQueue(params);
    const request = sinon
      .stub()
      .onFirstCall()
      .returns(1)
      .onSecondCall()
      .returns(2)
      .onThirdCall()
      .returns(3);
    const callback = sinon.spy();

    await queue.request(request).then(callback);
    await queue.request(request).then(callback);
    await queue.request(request).then(callback);

    expect(callback).to.have.been.calledThrice;
    expect(callback.getCall(0)).to.have.been.calledWith(1);
    expect(callback.getCall(1)).to.have.been.calledWith(2);
    expect(callback.getCall(2)).to.have.been.calledWith(3);
  });

  it('should not execute calls faster than rate limit', async () => {
    const queue = new SmartQueue(params);
    const request = sinon.stub();
    const callback = sinon.spy();
    const rateLimit = Math.round((params.rules.common.limit / params.rules.common.rate) * 1000);

    await queue.request(request).then(callback);
    const firstEnd = Date.now();
    await queue.request(request).then(callback);
    const secondEnd = Date.now();

    expect(Math.abs(secondEnd - firstEnd - rateLimit)).is.lte(ERROR_RATE);
  });

  it('should make retry', async () => {
    const queue = new SmartQueue(params);
    const callback = sinon.spy();
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

    expect(callback).to.have.been.calledOnce;
    expect(callback).to.have.been.calledWith(1);
  });

  it('should make retry with default config param', async () => {
    const queue = new SmartQueue({...params, retryTime: 0.1});
    const callback = sinon.spy();
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

    expect(callback).to.have.been.calledOnce;
    expect(callback).to.have.been.calledWith(1);
  });

  it('should return error', async () => {
    const queue = new SmartQueue(params);
    const request = sinon.stub().throws();
    const callback = sinon.spy();

    await queue.request(request).catch(callback);

    expect(callback).to.have.been.calledOnce;
    expect(callback).to.have.been.calledWith(sinon.match.instanceOf(Error));
  });

  it('should hit overall heat limit', async () => {
    const overallRule = {
      rate: 10,
      limit: 1,
      priority: Infinity,
    };
    const queue = new SmartQueue(
      {
        ...params,
        ignoreOverallOverheat: false,
        overall: overallRule
      }
    );
    const rateLimit = Math.round((overallRule.limit / overallRule.rate) * 1000);
    const request = sinon.stub();
    const callback = sinon.spy();

    await queue.request(request).then(callback);
    const firstEnd = Date.now();
    await queue.request(request).then(callback);
    const secondEnd = Date.now();

    expect(secondEnd - firstEnd).is.gte(rateLimit);
  });

  it('should create new rule if nothing found', async () => {
    const queue = new SmartQueue(params);
    const request = sinon.stub().returns(1);
    const callback = sinon.spy();

    await queue.request(request, '1', 'lol').then(callback);

    expect(callback).to.have.been.calledOnce;
    expect(callback).to.have.been.calledWith(1);
    // @ts-ignore
    expect(queue.params.rules).to.have.property('lol');
  });

  it('should prioritize calls', async () => {
    const queue = new SmartQueue(params);
    const request = sinon
      .stub()
      .onFirstCall()
      .returns(1)
      .onSecondCall()
      .returns(2)
      .onThirdCall()
      .returns(3);
    const callback = sinon.spy();

    await Promise.all([
      queue.request(request, '1', 'group').then(callback),
      queue.request(request, '2', 'group').then(callback),
      queue.request(request, '3', 'individual').then(callback)
    ]);

    expect(callback).to.have.been.calledThrice;
    expect(callback).to.have.been.calledWith(1);
    expect(callback).to.have.been.calledWith(3);
    expect(callback).to.have.been.calledWith(2);
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

    expect(Math.abs(secondEnd - firstEnd - 33)).is.lte(ERROR_RATE);
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

    expect(Math.abs(secondEnd - firstEnd - 200)).is.lte(ERROR_RATE);
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
    expect(Math.abs(r3Start - r1Start)).is.lte(ERROR_RATE);
    expect(Math.abs(r4Start - r1Start - 100)).is.lte(ERROR_RATE);
    expect(Math.abs(r2Start - r1Start - 250)).is.lte(ERROR_RATE);
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

    expect(queue.totalLength).to.eql(2);

    queue.clear();

    expect(queue.totalLength).to.eql(0);
  });
});
