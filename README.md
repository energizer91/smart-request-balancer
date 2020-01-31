# Smart request balancer 
![npm](https://img.shields.io/npm/v/smart-request-balancer.svg)
[![Build Status](https://travis-ci.org/energizer91/smart-request-balancer.svg?branch=master)](https://travis-ci.org/energizer91/smart-request-balancer)
[![Coverage Status](https://coveralls.io/repos/github/energizer91/smart-request-balancer/badge.svg?branch=master)](https://coveralls.io/github/energizer91/smart-request-balancer?branch=master)
[![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://github.com/prettier/prettier)

Smart request queue with fine tuning of rates and limits of queue execution

## Installation
### NPM
```bash
npm install smart-request-balancer
```
### Yarn
```bash
yarn add smart-request-balancer
```
## Usage

### CommonJS

```js
const Queue = require('smart-request-balancer');
```

### Typescript

```js
import Queue from 'smart-request-balancer';
```

Imagine you have some telegram bot and you need to follow telegram rules of sending messages.
You have [this page](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this) on Telegram bot API
which says that your bot cannot send more than 1 message per second to person and not more 20 messages per minute
to group/chat/channel. You can easily configure it in smart request balancer:
```js

const queue = new Queue({
  rules: {
    telegramIndividual: { // Rule for sending private message via telegram API
      rate: 1,            // one message
      limit: 1,           // per second
      priority: 1
    },
    telegramGroup: {      // Rule for sending group message via telegram API
      rate: 20,           // 20 messages
      limit: 60           // per minute
    }
  }
});
```

And then just send this message easily:

```js
const axios = require('axios');

queue.request((retry) => axios(config)
  .then(response => response.data)
  .catch(error => {
    if (error.response.status === 429) { // We've got 429 - too many requests
      return retry(error.response.data.parameters.retry_after) // usually 300 seconds
    }
    
    throw error; // throw error further
  }), user_id, 'telegramIndividual')
  .then(response => console.log(response)) // our actual response
  .catch(error => console.error(error));
```

Here you see that we are calling `queue.request()` with 3 parameters:
- `fn` Request handler: promise which will be executed
- `key` Unique key of request: For example, user_id of chat
- `rule` Rule name: Rule which we configured at queue creation

Also you can see that we are handling retry in request handler. That's our plan B in
order that Telegram API somehow gets requests overflow. Just call this retry function with some `Number`
and this request will be fulfilled right after this time.

## Queue API

### Configuration
```js
const queue = new Queue({
  rules: {                     // Describing our rules by rule name
    common: {                  // Common rule. Will be used if you won't provide rule argument
      rate: 30,                // Allow to send 30 messages
      limit: 1,                // per 1 second
      priority: 1,             // Rule priority. The lower priority is, the higher chance that
                               // this rule will execute faster 
    }
  },
  default: {                   // Default rules (if provided rule name is not found
    rate: 30,
    limit: 1
  },
  overall: {                   // Overall queue rates and limits
    rate: 30,
    limit: 1
  },
  retryTime: 300,              // Default retry time. Can be configured in retry fn
  ignoreOverallOverheat: true  // Should we ignore overheat of queue itself
})
```

### Making requests
For making requests you should provide callback which will have one argument called `retry` and should return promise
```js
const key = user_id; // Some telegram user id
const rule = 'telegramIndividual'; // Our rule for sending messages to chats
queue.request((retry) => axios(config)
  .then(response => response.data)
  .catch(error => {
    if (error.response.status === 429) { // We've got 429 - too many requests
      return retry(error.response.data.parameters.retry_after) // usually 300 seconds
    }
    
    throw error; // throw error further
  }), key, rule);
```

You can use any available promise-based library to make requests. Promise resolve will be transferred further.

### Getting responses
`queue.request(...)` will return promise which will resolve only when our queue will execute our request and get results.
Let's extend our previous example:
```js
queue.request(requestHandler, key, rule)
  .then(response => console.log(response)) // our actual response
  .catch(error => console.error(error))    // our request error (excluding 429)
```

### Priorities
Each rule has it's own priority. This was made to allow more urgent request execute faster than less urgent.
Imagine you have two rules: for individual messages and for broadcasting. Broadcasting can be a hard routine and
you should not totally wait for it to finish in order to send private message to somebody. In that case you should put
priority 1 for private messages and priority 2 for broadcasting. In that case our queue will send broadcasting continuously
but as soon as it gets private message it will interrupt broadcasting, send message and continue.

### Available methods

- `request(handler: (retry: RetryFunction) => Promise, key: string, rule: string) => Promise` The main
entrypoint for making requests with this library
- `get totalLength(): number` - Getter for total length of queue
- `get isOverheated(): boolean` - Getter for verifying is our queue is overheated

### Getting retry error

You should use `retry` function in request in order to set retry for this request.
You can easily determine it by HTTP 429 code. Sometimes servers also return `retry_after` param which you can pass
to `retry` function and set retry interval for this request. You don't need to do anything special. Our promise will only be resolved
when server will respond us correctly.

### Overall overheat
Sometimes you need to set overall overheat of queue (e.g. Telegram API has restriction to not send more than 30 messages per second overall).
For that purpose you can configure `overall` rule in config and set `ignoreOverallOverheat` to false.

### Debug
In order to debug queue you can use environment variable `DEBUG=smart-request-balancer`.

### Other usages
You can use this queue not only for API requests. This library can also be used for any routines which should be
queued and executed sequentially based on rules, grouping, priority and ability to retry.
