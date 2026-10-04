import { CapacitorHttp } from '@capacitor/core';
import { Filesystem } from '@capacitor/filesystem';
import { all, isoNow, json, one, run } from './db.js';

async function attachmentPayload(messageIds:string[]):Promise<any[]>{
  if(!messageIds.length)return[];
  const placeholders=messageIds.map(()=>'?').join(',');
  const rows=await all<any>(`SELECT * FROM attachments WHERE message_id IN (${placeholders})`,messageIds);
  const out:any[]=[];
  for(const a of rows){
    let content:string|null=null;
    if(a.local_path){
      try{content=String((await Filesystem.readFile({path:a.local_path})).data);}catch{/* metadata only */}
    }
    out.push({...a,content});
  }
  return out;
}

export async function pushReplicaTarget(targetId:string):Promise<{messages:number;revision:number}>{
  const target=await one<any>('SELECT * FROM replica_targets WHERE id=? AND enabled=1',[targetId]);
  if(!target)throw new Error('Replica target not found');
  if(!/^https:\/\//i.test(target.url))throw new Error('Replica target must use HTTPS');
  const messages=await all<any>(
    'SELECT * FROM messages WHERE revision>? ORDER BY revision LIMIT 100',[Number(target.last_revision||0)]
  );
  const drafts=await all<any>(
    'SELECT * FROM drafts WHERE revision>? ORDER BY revision LIMIT 100',[Number(target.last_revision||0)]
  );
  if(!messages.length&&!drafts.length)return{messages:0,revision:Number(target.last_revision||0)};
  const maxRevision=Math.max(
    Number(target.last_revision||0),
    ...messages.map((x:any)=>Number(x.revision||0)),
    ...drafts.map((x:any)=>Number(x.revision||0)),
  );
  const attachments=await attachmentPayload(messages.map((x:any)=>x.id));
  const response=await CapacitorHttp.post({
    url:target.url.replace(/\/$/,'')+'/api/replica/push',
    headers:{Authorization:`Bearer ${target.token}`,'Content-Type':'application/json'},
    data:{device:'gibp-mail-phone',revision:maxRevision,messages,drafts,attachments},
    connectTimeout:15_000,readTimeout:60_000,
  });
  if(response.status<200||response.status>=300){
    const error=String(response.data?.error||`Replica HTTP ${response.status}`);
    await run('UPDATE replica_targets SET last_error=? WHERE id=?',[error,targetId]);
    throw new Error(error);
  }
  await run('UPDATE replica_targets SET last_revision=?,last_sync_at=?,last_error=NULL WHERE id=?',[maxRevision,isoNow(),targetId]);
  return{messages:messages.length,revision:maxRevision};
}

export async function pushAllReplicas():Promise<void>{
  const targets=await all<{id:string}>('SELECT id FROM replica_targets WHERE enabled=1');
  for(const target of targets){try{await pushReplicaTarget(target.id);}catch{/* retry next foreground/background cycle */}}
}
