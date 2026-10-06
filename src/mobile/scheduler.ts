import { CapacitorHttp } from '@capacitor/core';
import { isoNow, json, one, run, all, uid } from './db.js';
import { queueAndSend } from './sync.js';

export async function scheduleSend(payload:any,scheduledAt:string,undoSeconds=0){
  const id=uid('sched_'),now=isoNow();
  const undoUntil=undoSeconds>0?new Date(Date.now()+undoSeconds*1000).toISOString():null;
  const due=undoUntil&&new Date(undoUntil)>new Date(scheduledAt)?undoUntil:scheduledAt;
  await run('INSERT INTO scheduled_sends(id,payload_json,scheduled_at,state,undo_until,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
    [id,JSON.stringify(payload),due,'scheduled',undoUntil,now,now]);
  return{id,status:'scheduled',scheduledAt:due,undoUntil};
}
export async function cancelScheduled(id:string){
  await run("UPDATE scheduled_sends SET state='cancelled',updated_at=? WHERE id=? AND state='scheduled'",[isoNow(),id]);
  return{ok:true};
}
export async function flushScheduledSends(limit=20){
  const rows=await all<any>("SELECT * FROM scheduled_sends WHERE state='scheduled' AND scheduled_at<=? ORDER BY scheduled_at LIMIT ?",[isoNow(),limit]);
  let sent=0,failed=0;
  for(const row of rows){
    try{
      const payload=json<any>(row.payload_json,{});
      const result=await queueAndSend({...payload,localId:payload.localId||`scheduled_${row.id}`});
      if(result.status==='sent'||result.status==='queued'){
        await run("UPDATE scheduled_sends SET state='sent',updated_at=?,last_error=? WHERE id=?",[isoNow(),result.error||null,row.id]);
        sent++;
      }else failed++;
    }catch(e){
      failed++;
      await run("UPDATE scheduled_sends SET last_error=?,updated_at=? WHERE id=?",[e instanceof Error?e.message:String(e),isoNow(),row.id]);
    }
  }
  return{sent,failed};
}
export async function listScheduled(){
  return all<any>("SELECT id,scheduled_at,state,undo_until,created_at,last_error FROM scheduled_sends WHERE state IN ('scheduled','cancelled') ORDER BY scheduled_at");
}

export async function recordDeliveryEvent(input:{
  providerEventId?:string;accountId?:string;providerMessageId?:string;eventType:string;recipient?:string;
  occurredAt?:string;payload?:any;
}){
  const id=uid('evt_'),now=isoNow();
  const local=input.providerMessageId
    ?await one<{id:string}>('SELECT id FROM messages WHERE provider_id=? LIMIT 1',[input.providerMessageId])
    :null;
  await run(`INSERT OR IGNORE INTO delivery_events(id,provider_event_id,account_id,provider_message_id,local_message_id,event_type,recipient,payload_json,occurred_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`,[
      id,input.providerEventId||null,input.accountId||null,input.providerMessageId||null,local?.id||null,
      input.eventType,input.recipient?.toLowerCase()||null,JSON.stringify(input.payload||{}),input.occurredAt||now,now,
    ]);
  const suppressEvents=new Set(['email.bounced','email.complained','email.failed','contact.unsubscribed']);
  if(input.recipient&&suppressEvents.has(input.eventType)){
    await run("INSERT INTO suppressions(email,reason,created_at) VALUES(?,?,?) ON CONFLICT(email) DO UPDATE SET reason=excluded.reason",
      [input.recipient.toLowerCase(),input.eventType,now]);
  }
  if(local?.id){
    const statusMap:Record<string,string>={
      'email.delivered':'delivered','email.bounced':'bounced','email.complained':'complained',
      'email.failed':'failed','email.sent':'sent','email.delivery_delayed':'delayed',
    };
    if(statusMap[input.eventType])await run('UPDATE messages SET status=? WHERE id=?',[statusMap[input.eventType],local.id]);
  }
  return{id,localMessageId:local?.id||null};
}


async function getSetting(key:string):Promise<string|null>{
  return (await one<{value:string}>('SELECT value FROM settings WHERE key=?',[key]))?.value||null;
}
async function setSetting(key:string,value:string):Promise<void>{
  await run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',[key,value]);
}
export async function configureEventRelay(url:string,token:string):Promise<void>{
  if(url&&!/^https:\/\//i.test(url))throw new Error('Event relay must use HTTPS');
  await setSetting('event_relay_url',url.replace(/\/$/,''));
  await setSetting('event_relay_token',token);
}
export async function syncEventRelay():Promise<{imported:number;cursor:string|null}>{
  const url=await getSetting('event_relay_url'),token=await getSetting('event_relay_token');
  if(!url||!token)return{imported:0,cursor:null};
  const after=await getSetting('event_relay_cursor')||'';
  const response=await CapacitorHttp.get({
    url:`${url}/events${after?`?after=${encodeURIComponent(after)}`:''}`,
    headers:{Authorization:`Bearer ${token}`},connectTimeout:15_000,readTimeout:30_000,
  });
  if(response.status===501)return{imported:0,cursor:after||null};
  if(response.status<200||response.status>=300)throw new Error(String(response.data?.error||`Event relay HTTP ${response.status}`));
  const events=Array.isArray(response.data?.events)?response.data.events:[];
  for(const event of events){
    await recordDeliveryEvent({
      providerEventId:event.id,providerMessageId:event.email_id||undefined,eventType:String(event.type||'unknown'),
      recipient:event.recipient||undefined,occurredAt:event.created_at||undefined,payload:{source:'event-relay'},
    });
  }
  const cursor=response.data?.cursor?String(response.data.cursor):after;
  if(cursor)await setSetting('event_relay_cursor',cursor);
  return{imported:events.length,cursor:cursor||null};
}
