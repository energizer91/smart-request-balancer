const SmartQueue = require('../dist/index.js');
const chai = require('chai');
const sinon = require('sinon');
const sinonChai = require('sinon-chai');

const expect = chai.expect;
chai.use(sinonChai);

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
  })
  it('should make requests', async () => {
    const queue = new SmartQueue(params);
    const response = {a: 1};

    const result = await queue.request(() => response);

    expect(result).to.eq(response);
  });

  it('should measure length', (done) => {
    const queue = new SmartQueue(params);
    queue.request(() => 1);

    queue.request(() => 2);

    queue.request(() => 3).then(() => done());

    expect(queue.totalLength).to.eq(3);
  });

  it('should execute sequentally', async () => {
    const queue = new SmartQueue(params);
    const callback = sinon.spy();

    await queue.request(() => 1).then(callback);
    await queue.request(() => 2).then(callback);
    await queue.request(() => 3).then(callback);

    expect(queue.totalLength).to.eq(0);
    expect(callback).to.have.been.called;
    expect(callback).to.have.been.calledThrice;
    expect(callback.getCall(0)).to.have.been.calledWith(1);
    expect(callback.getCall(1)).to.have.been.calledWith(2);
    expect(callback.getCall(2)).to.have.been.calledWith(3);
  });

  it('should not execute calls faster than rate limit', async () => {
    const queue = new SmartQueue(params);
    const callback = sinon.spy();
    const rateLimit = Math.round(params.rules.common.limit / params.rules.common.rate * 1000);

    await queue.request(() => 1).then(callback);
    const firstEnd = Date.now();
    await queue.request(() => 2).then(callback);
    const secondEnd = Date.now();

    expect(queue.totalLength).to.eq(0);
    expect(secondEnd - firstEnd).is.gte(rateLimit);
  });

  it('should make retry', async () => {
    const queue = new SmartQueue(params);
    const callback = sinon.spy();
    let retryFlag = false;

    await queue.request(retry => {
      if (!retryFlag) {
        retryFlag = true;
        retry(0.1);

        return;
      }

      return 1;
    }).then(callback);

    expect(queue.totalLength).to.eq(0);
    expect(callback).to.have.been.calledOnce;
    expect(callback).to.have.been.calledWith(1);
  });

  it('should return error', async () => {
    const queue = new SmartQueue(params);
    const request = sinon.stub().throws();
    const callback = sinon.spy();

    await queue.request(request).catch(callback);

    expect(queue.totalLength).to.eq(0);
    expect(callback).to.have.been.calledOnce;
    expect(callback).to.have.been.calledWith(sinon.match.instanceOf(Error));
  });

  it('should hit overall heat limit', async () => {
    const overallRule = {
      rate: 1,
      limit: 1
    };
    const queue = new SmartQueue(Object.assign({}, params, {
      ignoreOverallOverheat: false,
      overall: overallRule
    }));
    const rateLimit = Math.round(overallRule.rate / overallRule.limit * 1000);
    const callback = sinon.spy();

    await queue.request(() => 1).then(callback);
    const firstEnd = Date.now();
    await queue.request(() => 2).then(callback);
    const secondEnd = Date.now();

    expect(queue.totalLength).to.eq(0);
    expect(secondEnd - firstEnd).is.gte(rateLimit);
  });

  it('should create new rule if nothing found', async () => {
    const queue = new SmartQueue(params);
    const callback = sinon.spy();

    await queue.request(() => 1, 1, 'lol').then(callback);

    expect(queue.totalLength).to.eq(0);
    expect(callback).to.have.been.calledOnce;
    expect(callback).to.have.been.calledWith(1);
    expect(queue.params.rules).to.have.property('lol');
  });

  it('should prioritize calls', async () => {
    const queue = new SmartQueue(params);
    const callback = sinon.spy();

    await Promise.all([
      queue.request(() => 1, 1, 'group').then(callback),
      queue.request(() => 2, 2, 'group').then(callback),
      queue.request(() => 3, 3, 'individual').then(callback)
    ]);

    expect(queue.totalLength).to.eq(0);
    expect(callback).to.have.been.calledThrice;
    expect(callback).to.have.been.calledWith(1);
    expect(callback).to.have.been.calledWith(3);
    expect(callback).to.have.been.calledWith(2);
  });
});