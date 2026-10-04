import test from 'node:test';
import assert from 'node:assert/strict';
import { addressDomain, canAutoSend } from '../src/shared/policy.js';

test('dynamic sender domain is normalized',()=>{
  assert.equal(addressDomain('purpose@GIBP.GLOBAL'),'gibp.global');
  assert.equal(addressDomain('not-an-email'),null);
});

test('safe high-confidence routine reply may auto-send',()=>{
  assert.equal(canAutoSend({
    mode:'auto_safe',category:'general_enquiry',sensitive:false,confidence:.98,threshold:.92,
    action:'send_reply',sentLastHour:2,hourlyLimit:10,
  }),true);
});

test('sensitive and regulated categories never auto-send',()=>{
  assert.equal(canAutoSend({
    mode:'auto_safe',category:'regulatory',sensitive:false,confidence:1,threshold:.5,
    action:'send_reply',sentLastHour:0,hourlyLimit:10,
  }),false);
  assert.equal(canAutoSend({
    mode:'auto_safe',category:'general_enquiry',sensitive:true,confidence:1,threshold:.5,
    action:'send_reply',sentLastHour:0,hourlyLimit:10,
  }),false);
});

test('hourly safety cap is enforced',()=>{
  assert.equal(canAutoSend({
    mode:'auto_safe',category:'support_routine',sensitive:false,confidence:1,threshold:.9,
    action:'send_reply',sentLastHour:10,hourlyLimit:10,
  }),false);
});
