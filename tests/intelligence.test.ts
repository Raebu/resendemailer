import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deliveryStatusForEvent,
  routingRuleMatches,
  scheduledDueAt,
  shouldSuppressDeliveryEvent,
  wildcardMatch,
} from '../src/shared/intelligence.js';

test('wildcard aliases match exact families without overmatching',()=>{
  assert.equal(wildcardMatch('bank-*@gibp.global','bank-nepal@gibp.global'),true);
  assert.equal(wildcardMatch('bank-*@gibp.global','banking@gibp.global'),false);
  assert.equal(wildcardMatch('case-????@gibp.app','case-1042@gibp.app'),true);
  assert.equal(wildcardMatch('case-????@gibp.app','case-10422@gibp.app'),false);
});

test('routing rules can deterministically force banking priority before AI',()=>{
  const ctx={
    to:'banking@gibp.global',
    from:'person@example.com',
    subject:'Settlement partnership',
    body:'Please review the attached proposal.',
    hasAttachment:true,
    language:'English',
    senderKnown:false,
  };
  assert.equal(routingRuleMatches({to:'bank*@gibp.global',hasAttachment:true},ctx),true);
  assert.equal(routingRuleMatches({fromDomain:'example.org'},ctx),false);
  assert.equal(routingRuleMatches({subjectContains:'settlement'},ctx),true);
});

test('undo send delays immediate sends but never brings a future schedule forward',()=>{
  const now=Date.parse('2026-10-06T20:00:00.000Z');
  const immediate=scheduledDueAt('2026-10-06T20:00:00.000Z',10,now);
  assert.equal(immediate.scheduledAt,'2026-10-06T20:00:10.000Z');
  assert.equal(immediate.undoUntil,'2026-10-06T20:00:10.000Z');

  const future=scheduledDueAt('2026-10-06T21:00:00.000Z',10,now);
  assert.equal(future.scheduledAt,'2026-10-06T21:00:00.000Z');
  assert.equal(future.undoUntil,'2026-10-06T20:00:10.000Z');
});

test('undo window is clamped to 30 seconds',()=>{
  const now=Date.parse('2026-10-06T20:00:00.000Z');
  assert.equal(
    scheduledDueAt('2026-10-06T20:00:00.000Z',999,now).scheduledAt,
    '2026-10-06T20:00:30.000Z',
  );
});

test('delivery hygiene suppresses hard failures and maps visible states',()=>{
  for(const event of ['email.bounced','email.complained','email.failed','contact.unsubscribed']){
    assert.equal(shouldSuppressDeliveryEvent(event),true,event);
  }
  assert.equal(shouldSuppressDeliveryEvent('email.delivered'),false);
  assert.equal(deliveryStatusForEvent('email.delivered'),'delivered');
  assert.equal(deliveryStatusForEvent('email.delivery_delayed'),'delayed');
  assert.equal(deliveryStatusForEvent('email.bounced'),'bounced');
  assert.equal(deliveryStatusForEvent('unknown.event'),null);
});
