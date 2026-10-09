import fs from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import { config } from './config.js';
import { db, normalizeSubject, now } from './db.js';

const messageSchema=z.object({
  id:z.string().min(1),thread_id:z.string().min(1),provider_id:z.string().nullable().optional(),
  provider_key:z.string().nullable().optional(),direction:z.enum(['inbound','outbound']),status:z.string(),
  from_address:z.string(),from_name:z.string().nullable().optional(),to_json:z.string(),cc_json:z.string(),
  bcc_json:z.string(),reply_to_json:z.string(),subject:z.string(),text_body:z.string().nullable().optional(),
  html_body:z.string().nullable().optional(),preview:z.string(),message_id_header:z.string().nullable().optional(),
  in_reply_to:z.string().nullable().optional(),references_json:z.string(),created_at:z.string(),
  received_at:z.string().nullable().optional(),sent_at:z.string().nullable().optional(),
  is_read:z.union([z.number(),z.boolean()]),is_starred:z.union([z.number(),z.boolean()]),
  is_archived:z.union([z.number(),z.boolean()]),deleted_at:z.string().nullable().optional(),
  last_error:z.string().nullable().optional(),revision:z.number().int().nonnegative(),
});
const draftSchema=z.object({
  id:z.string(),reply_to_message_id:z.string().nullable().optional(),from_identity:z.string(),
  to_json:z.string(),cc_json:z.string(),bcc_json:z.string(),subject:z.string(),text_body:z.string(),
  updated_at:z.string(),created_at:z.string(),revision:z.number().int().nonnegative(),
  deleted_at:z.string().nullable().optional(),
});
const attachmentSchema=z.object({
  id:z.string(),message_id:z.string(),provider_attachment_id:z.string().nullable().optional(),
  filename:z.string(),content_type:z.string(),size_bytes:z.number().nullable().optional(),
  created_at:z.string(),content:z.string().nullable().optional(),
});
const payloadSchema=z.object({
  device:z.string().default('phone'),revision:z.number().int().nonnegative(),
  messages:z.array(messageSchema).max(100),drafts:z.array(draftSchema).max(100),
  attachments:z.array(attachmentSchema).max(1000),
});

function ensureReplicaSchema():void{
  db.exec(`
    CREATE TABLE IF NOT EXISTS replica_state(
      device TEXT PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS replica_message_state(
      message_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS replica_draft_state(
      draft_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 0
    );
  `);
}

function bool(value:boolean|number):number{return value?1:0;}
function safeName(value:string):string{return value.replace(/[^a-zA-Z0-9._ -]/g,'_').slice(0,180)||'attachment';}

function applyMessage(m:z.infer<typeof messageSchema>):void{
  const state=db.prepare('SELECT revision FROM replica_message_state WHERE message_id=?').get(m.id) as {revision:number}|undefined;
  if(state&&state.revision>=m.revision)return;

  db.prepare(`
    INSERT INTO threads(id,subject,normalized_subject,created_at,updated_at)
    VALUES(?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      subject=excluded.subject,
      normalized_subject=excluded.normalized_subject,
      updated_at=CASE WHEN threads.updated_at<excluded.updated_at THEN excluded.updated_at ELSE threads.updated_at END
  `).run(m.thread_id,m.subject,normalizeSubject(m.subject),m.created_at,m.created_at);

  const providerId=m.provider_key||m.provider_id||null;
  const existing=db.prepare('SELECT id FROM messages WHERE id=?').get(m.id) as {id:string}|undefined;
  if(existing){
    db.prepare(`
      UPDATE messages SET thread_id=?,provider_id=?,direction=?,status=?,from_address=?,from_name=?,
      to_json=?,cc_json=?,bcc_json=?,reply_to_json=?,subject=?,text_body=?,html_body=?,preview=?,
      message_id_header=?,in_reply_to=?,references_json=?,created_at=?,received_at=?,sent_at=?,
      is_read=?,is_starred=?,is_archived=?,deleted_at=?,last_error=? WHERE id=?
    `).run(
      m.thread_id,providerId,m.direction,m.status,m.from_address,m.from_name??null,m.to_json,m.cc_json,
      m.bcc_json,m.reply_to_json,m.subject,m.text_body??null,m.html_body??null,m.preview,
      m.message_id_header??null,m.in_reply_to??null,m.references_json,m.created_at,m.received_at??null,
      m.sent_at??null,bool(m.is_read),bool(m.is_starred),bool(m.is_archived),m.deleted_at??null,m.last_error??null,m.id
    );
  }else{
    // A legacy direct-Resend row may already own this provider ID. Leave it alone rather than corrupting it.
    const providerConflict=providerId?db.prepare('SELECT id FROM messages WHERE provider_id=?').get(providerId) as {id:string}|undefined:undefined;
    if(!providerConflict){
      db.prepare(`
        INSERT INTO messages(id,thread_id,provider_id,direction,status,from_address,from_name,to_json,cc_json,bcc_json,
        reply_to_json,subject,text_body,html_body,preview,message_id_header,in_reply_to,references_json,created_at,
        received_at,sent_at,is_read,is_starred,is_archived,deleted_at,last_error)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        m.id,m.thread_id,providerId,m.direction,m.status,m.from_address,m.from_name??null,m.to_json,m.cc_json,
        m.bcc_json,m.reply_to_json,m.subject,m.text_body??null,m.html_body??null,m.preview,m.message_id_header??null,
        m.in_reply_to??null,m.references_json,m.created_at,m.received_at??null,m.sent_at??null,bool(m.is_read),
        bool(m.is_starred),bool(m.is_archived),m.deleted_at??null,m.last_error??null
      );
    }
  }
  db.prepare(`
    INSERT INTO replica_message_state(message_id,revision) VALUES(?,?)
    ON CONFLICT(message_id) DO UPDATE SET revision=excluded.revision
  `).run(m.id,m.revision);
}

function applyDraft(d:z.infer<typeof draftSchema>):void{
  const state=db.prepare('SELECT revision FROM replica_draft_state WHERE draft_id=?').get(d.id) as {revision:number}|undefined;
  if(state&&state.revision>=d.revision)return;
  if(d.deleted_at){
    db.prepare('DELETE FROM drafts WHERE id=?').run(d.id);
  }else{
    db.prepare(`
      INSERT INTO drafts(id,reply_to_message_id,from_identity,to_json,cc_json,bcc_json,subject,text_body,updated_at,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        reply_to_message_id=excluded.reply_to_message_id,from_identity=excluded.from_identity,
        to_json=excluded.to_json,cc_json=excluded.cc_json,bcc_json=excluded.bcc_json,
        subject=excluded.subject,text_body=excluded.text_body,updated_at=excluded.updated_at
    `).run(d.id,d.reply_to_message_id??null,d.from_identity,d.to_json,d.cc_json,d.bcc_json,d.subject,d.text_body,d.updated_at,d.created_at);
  }
  db.prepare(`
    INSERT INTO replica_draft_state(draft_id,revision) VALUES(?,?)
    ON CONFLICT(draft_id) DO UPDATE SET revision=excluded.revision
  `).run(d.id,d.revision);
}

function applyAttachment(a:z.infer<typeof attachmentSchema>):void{
  if(!db.prepare('SELECT id FROM messages WHERE id=?').get(a.message_id))return;
  const existing=db.prepare('SELECT id,local_path FROM attachments WHERE id=?').get(a.id) as {id:string;local_path:string|null}|undefined;
  let localPath=existing?.local_path??null;
  if(a.content){
    const dir=path.join(config.dataDir,'attachments',a.message_id);
    fs.mkdirSync(dir,{recursive:true,mode:0o700});
    const target=path.join(dir,`${a.id}-${safeName(a.filename)}`);
    const tmp=target+'.tmp';
    fs.writeFileSync(tmp,Buffer.from(a.content,'base64'),{mode:0o600});
    fs.renameSync(tmp,target);
    localPath=target;
  }
  db.prepare(`
    INSERT INTO attachments(id,message_id,provider_attachment_id,filename,content_type,size_bytes,local_path,created_at)
    VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET filename=excluded.filename,content_type=excluded.content_type,
    size_bytes=excluded.size_bytes,local_path=coalesce(excluded.local_path,attachments.local_path)
  `).run(a.id,a.message_id,a.provider_attachment_id??null,a.filename,a.content_type,a.size_bytes??null,localPath,a.created_at);
}

export function installReplicaRoutes(app:Express):void{
  ensureReplicaSchema();
  app.post('/api/replica/push',(req:Request,res:Response)=>{
    if(!config.replicaToken)return res.status(404).json({error:'Replica receiver is disabled'});
    const auth=req.header('authorization');
    if(auth!==`Bearer ${config.replicaToken}`)return res.status(401).json({error:'Unauthorized'});
    const parsed=payloadSchema.safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:'Invalid replica payload',details:parsed.error.issues});
    const payload=parsed.data;

    const tx=db.transaction(()=>{
      for(const message of payload.messages)applyMessage(message);
      for(const draft of payload.drafts)applyDraft(draft);
      for(const attachment of payload.attachments)applyAttachment(attachment);
      db.prepare(`
        INSERT INTO replica_state(device,revision,updated_at) VALUES(?,?,?)
        ON CONFLICT(device) DO UPDATE SET
          revision=CASE WHEN replica_state.revision<excluded.revision THEN excluded.revision ELSE replica_state.revision END,
          updated_at=excluded.updated_at
      `).run(payload.device,payload.revision,now());
    });
    tx();
    return res.json({ok:true,revision:payload.revision,messages:payload.messages.length,drafts:payload.drafts.length});
  });

  app.get('/api/replica/status',(req:Request,res:Response)=>{
    if(!config.replicaToken)return res.status(404).json({error:'Replica receiver is disabled'});
    if(req.header('authorization')!==`Bearer ${config.replicaToken}`)return res.status(401).json({error:'Unauthorized'});
    return res.json({devices:db.prepare('SELECT * FROM replica_state ORDER BY updated_at DESC').all()});
  });
}
