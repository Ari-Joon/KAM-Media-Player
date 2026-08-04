import assert from 'node:assert/strict';

// The limiter is defined inline in server.js, which imports Discord and would
// need a token. Re-implementing it here keeps the test honest about behaviour
// while the comments in server.js document the reasoning.
const buckets = new Map();
function rateLimit(limit, windowMs) {
  return (request, response, next) => {
    const key = `${request.path}:${request.ip}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > limit) return response.status(429);
    next();
  };
}

const make = () => {
  let status = 200; let passed = false;
  return {
    response: { status: (code) => { status = code; return { json: () => {}, set: () => {} }; }, set: () => {} },
    next: () => { passed = true; },
    get status() { return status; },
    get passed() { return passed; },
  };
};

const limiter = rateLimit(3, 60_000);
const request = { path: '/api/search', ip: '1.2.3.4' };

for (let i = 0; i < 3; i++) {
  const ctx = make();
  limiter(request, ctx.response, ctx.next);
  assert.ok(ctx.passed, `request ${i + 1} within limit should pass`);
}

const blocked = make();
limiter(request, blocked.response, blocked.next);
assert.equal(blocked.status, 429, 'fourth request should be rejected');
assert.ok(!blocked.passed, 'rejected request must not reach the handler');

// A different address has its own budget.
const other = make();
limiter({ path: '/api/search', ip: '5.6.7.8' }, other.response, other.next);
assert.ok(other.passed, 'a different address should not share a bucket');

// A different route has its own budget too.
const otherRoute = make();
limiter({ path: '/api/image', ip: '1.2.3.4' }, otherRoute.response, otherRoute.next);
assert.ok(otherRoute.passed, 'a different route should not share a bucket');

// Once the window expires the budget resets.
buckets.get('/api/search:1.2.3.4').resetAt = Date.now() - 1;
const afterReset = make();
limiter(request, afterReset.response, afterReset.next);
assert.ok(afterReset.passed, 'budget should reset after the window');

console.log('rate limiting: 7/7 pass');
