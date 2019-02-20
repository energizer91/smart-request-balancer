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
  it('should make requests', (done) => {
    const queue = new SmartQueue(params);
    const response = {a: 1};

    queue.request(() => response)
      .then(result => {
        expect(result).to.eq(response);
        done();
      });
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
});