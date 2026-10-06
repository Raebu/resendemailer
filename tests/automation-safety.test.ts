import test from 'node:test';
import assert from 'node:assert/strict';
import {
  autoReplyLocalId,
  campaignSendLocalId,
  campaignWithinGlobalHourlyCap,
  containsStopLanguage,
} from '../src/shared/policy.js';

test('auto-reply id is deterministic across engines',()=>{
  assert.equal(
    autoReplyLocalId('acct_gibp','email_123'),
    'reply_acct_gibp_email_123',
  );
  assert.equal(
    autoReplyLocalId('acct_gibp','email_123'),
    autoReplyLocalId('acct_gibp','email_123'),
  );
});

test('campaign id is deterministic per campaign/contact/step',()=>{
  assert.equal(
    campaignSendLocalId('campaign-a','contact-b',2),
    'bd_campaign-a_contact-b_2',
  );
  assert.notEqual(
    campaignSendLocalId('campaign-a','contact-b',1),
    campaignSendLocalId('campaign-a','contact-b',2),
  );
});

test('campaign id rejects invalid steps',()=>{
  assert.throws(()=>campaignSendLocalId('c','x',-1));
  assert.throws(()=>campaignSendLocalId('c','x',1.5));
});

test('unsubscribe language is recognized case-insensitively',()=>{
  for(const text of [
    'UNSUBSCRIBE',
    'Please do not contact me again',
    'Stop emailing this address',
    'Could you remove me from this list?',
  ]){
    assert.equal(containsStopLanguage(text),true,text);
  }
  assert.equal(containsStopLanguage('Thanks, speak soon.'),false);
});

test('global campaign hourly cap is strict',()=>{
  assert.equal(campaignWithinGlobalHourlyCap(0),true);
  assert.equal(campaignWithinGlobalHourlyCap(24),true);
  assert.equal(campaignWithinGlobalHourlyCap(25),false);
  assert.equal(campaignWithinGlobalHourlyCap(26),false);
});
