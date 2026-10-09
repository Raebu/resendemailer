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
  const lastRevision=Number(target.last_revision||0);
  const pending=await all<{revision:number}>(`
    SELECT revision FROM (
      SELECT revision FROM messages WHERE revision>?
      UNION ALL
      SELECT revision FROM drafts WHERE revision>?
    ) ORDER BY revision LIMIT 100
  `,[lastRevision,lastRevision]);
  const cutoff=Number(pending.at(-1)?.revision||lastRevision);
  if(cutoff===lastRevision)return{messages:0,revision:lastRevision};
  const messages=await all<any>(
    'SELECT * FROM messages WHERE revision>? AND revision<=? ORDER BY revision',[lastRevision,cutoff]
  );
  const drafts=await all<any>(
    'SELECT * FROM drafts WHERE revision>? AND revision<=? ORDER BY revision',[lastRevision,cutoff]
  );
  const attachments=await attachmentPayload(messages.map((x:any)=>x.id));
  const response=await CapacitorHttp.post({
    url:target.url.replace(/\/$/,'')+'/api/replica/push',
    headers:{Authorization:`Bearer ${target.token}`,'Content-Type':'application/json'},
    data:{device:'gibp-mail-phone',revision:cutoff,messages,drafts,attachments},
    connectTimeout:15_000,readTimeout:60_000,
  });
  if(response.status<200||response.status>=300){
    const error=String(response.data?.error||`Replica HTTP ${response.status}`);
    await run('UPDATE replica_targets SET last_error=? WHERE id=?',[error,targetId]);
    throw new Error(error);
  }
  if(Number(response.data?.revision)!==cutoff)throw new Error('Replica did not acknowledge the requested revision');
  await run('UPDATE replica_targets SET last_revision=?,last_sync_at=?,last_error=NULL WHERE id=?',[cutoff,isoNow(),targetId]);
  return{messages:messages.length,revision:cutoff};
}

export async function pushAllReplicas():Promise<void>{
  const targets=await all<{id:string}>('SELECT id FROM replica_targets WHERE enabled=1');
  for(const target of targets){try{await pushReplicaTarget(target.id);}catch{/* retry next foreground/background cycle */}}
}
