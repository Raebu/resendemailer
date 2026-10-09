import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../workers/ai-gateway/src/index.js';

const env={OPENAI_API_KEY:'test-only',GIBP_AI_GATEWAY_TOKEN:'gateway-test-token'};

test('AI gateway rejects unknown routes before reading a request body',async()=>{
  const response=await worker.fetch(new Request('https://worker.test/unknown',{method:'POST'}),env);
  assert.equal(response.status,404);
});

test('AI gateway enforces method and bearer authentication',async()=>{
  const method=await worker.fetch(new Request('https://worker.test/v1/decision'),env);
  assert.equal(method.status,405);

  const auth=await worker.fetch(new Request('https://worker.test/v1/decision',{
    method:'POST',body:'{}',headers:{'Content-Type':'application/json'},
  }),env);
  assert.equal(auth.status,401);
});

test('AI gateway rejects oversized decision requests while streaming',async()=>{
  const response=await worker.fetch(new Request('https://worker.test/v1/decision',{
    method:'POST',
    headers:{Authorization:'Bearer gateway-test-token','Content-Type':'application/json'},
    body:JSON.stringify({task:'inbound',payload:'x'.repeat(70_000)}),
  }),env);
  assert.equal(response.status,413);
});

test('AI gateway validates decision task without calling OpenAI',async()=>{
  const response=await worker.fetch(new Request('https://worker.test/v1/decision',{
    method:'POST',
    headers:{Authorization:'Bearer gateway-test-token','Content-Type':'application/json'},
    body:JSON.stringify({task:'unsafe-task',payload:{}}),
  }),env);
  assert.equal(response.status,400);
});
