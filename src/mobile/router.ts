import { FileViewer } from '@capacitor/file-viewer';
import { all, isoNow, json, nextRevision, one, run, uid } from './db.js';
import { mobileResend, type MobileAccount } from './resend.js';
import { accountForSender, flushMobileOutbox, refreshDomains, queueAndSend, syncAllAccounts } from './sync.js';
import { configureAi, createDefaultRule, evaluateInbound, reconcileCampaignReplies, runCampaignTick } from './automation.js';
import { pushAllReplicas, pushReplicaTarget } from './replica.js';
import { configureBackgroundAccount, removeBackgroundAccount, configureBackgroundAutomation, setBackgroundAutomationMode, setBackgroundSuppressions, setBackgroundForegroundAudit, upsertBackgroundCampaign, getBackgroundAutomationState } from './background.js';
import { analyzeInbound, attentionBriefing, createReminder, languageTransform, markWaiting, smartSearch, snoozeThread } from './intelligence.js';

let syncing=false;
const parseBody=(init:RequestInit):any=>{
  if(typeof init.body==='string'){try{return JSON.parse(init.body);}catch{return{};}}
  return init.body||{};
};
const toSummary=(r:any)=>({
  id:r.id,threadId:r.thread_id,providerId:r.provider_id,direction:r.direction,status:r.status,
  fromAddress:r.from_address,fromName:r.from_name,toAddresses:json(r.to_json,[]),ccAddresses:json(r.cc_json,[]),
  subject:r.subject,preview:r.preview,createdAt:r.created_at,receivedAt:r.received_at,sentAt:r.sent_at,
  isRead:Boolean(r.is_read),isStarred:Boolean(r.is_starred),isArchived:Boolean(r.is_archived),deletedAt:r.deleted_at,
  attachmentCount:Number(r.attachment_count||0),threadCount:Number(r.thread_count||1),
  category:r.category||null,priority:r.priority||null,needsReply:Boolean(r.needs_reply),needsMe:Boolean(r.needs_me),
  waiting:Boolean(r.waiting),language:r.language||null,whyItMatters:r.why_it_matters||null,
  intelligenceSummary:r.intelligence_summary||null,labels:json(r.labels_json,[]),aliasAddress:r.alias_address||null,
  snoozedUntil:r.snoozed_until||null,
});
const detail=async(r:any)=>({
  ...toSummary(r),bccAddresses:json(r.bcc_json,[]),replyToAddresses:json(r.reply_to_json,[]),
  textBody:r.text_body,htmlBody:r.html_body,messageIdHeader:r.message_id_header,inReplyTo:r.in_reply_to,
  references:json(r.references_json,[]),
  attachments:(await all<any>('SELECT * FROM attachments WHERE message_id=? ORDER BY created_at',[r.id])).map(a=>({
    id:a.id,messageId:a.message_id,providerAttachmentId:a.provider_attachment_id,filename:a.filename,
    contentType:a.content_type,sizeBytes:a.size_bytes,localPath:a.local_path,
  })),
});

async function listMessages(url:URL):Promise<any[]>{
  const folder=url.searchParams.get('folder')||'inbox';
  const q=(url.searchParams.get('q')||'').trim().toLowerCase();
  let where='m.deleted_at IS NULL';
  if(folder==='inbox')where+=" AND m.direction='inbound' AND m.is_archived=0";
  else if(folder==='sent')where+=" AND m.direction='outbound' AND m.status NOT IN ('queued','draft')";
  else if(folder==='outbox')where+=" AND m.direction='outbound' AND m.status='queued'";
  else if(folder==='archive')where+=' AND m.is_archived=1';
  else if(folder==='trash')where='m.deleted_at IS NOT NULL';
  else if(folder==='starred')where+=' AND m.is_starred=1';
  else if(folder==='needs_me')where+=' AND coalesce(mi.needs_me,0)=1';
  else if(folder==='waiting')where+=" AND (coalesce(mi.waiting,0)=1 OR EXISTS(SELECT 1 FROM reminders rr WHERE rr.thread_id=m.thread_id AND rr.state='pending' AND rr.kind='waiting_reply'))";
  else if(folder==='snoozed')where+=" AND sz.until_at>datetime('now')";
  const params:any[]=[];
  if(q){where+=" AND (lower(m.subject) LIKE ? OR lower(m.from_address) LIKE ? OR lower(coalesce(m.text_body,'')) LIKE ?)";params.push(`%${q}%`,`%${q}%`,`%${q}%`);}
  const rows=await all<any>(`
    SELECT m.*,mi.category,mi.priority,mi.needs_reply,mi.needs_me,mi.waiting,mi.language,mi.why_it_matters,
      mi.summary intelligence_summary,mi.labels_json,al.address alias_address,sz.until_at snoozed_until,
      (SELECT count(*) FROM attachments a WHERE a.message_id=m.id) attachment_count,
      (SELECT count(*) FROM messages x WHERE x.thread_id=m.thread_id AND x.deleted_at IS NULL) thread_count
    FROM messages m
    LEFT JOIN message_intelligence mi ON mi.message_id=m.id
    LEFT JOIN aliases al ON al.id=mi.alias_id
    LEFT JOIN snoozes sz ON sz.thread_id=m.thread_id
    WHERE ${where} ORDER BY
      CASE coalesce(mi.priority,'normal') WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
      m.created_at DESC LIMIT 200
  `,params);
  const seen=new Set<string>();
  return rows.filter(r=>folder==='outbox'||(!seen.has(r.thread_id)&&!!seen.add(r.thread_id))).map(toSummary);
}

async function listIdentities():Promise<any[]>{
  const domains=await all<any>(
    "SELECT d.domain,a.id account_id,a.name account_name FROM domains d JOIN accounts a ON a.id=d.account_id WHERE a.enabled=1 AND d.can_send=1 AND d.status='verified' ORDER BY a.name,d.domain"
  );
  return domains.map(d=>({
    name:d.account_name,address:`hello@${d.domain}`,formatted:`${d.account_name} <hello@${d.domain}>`,
    accountId:d.account_id,domain:d.domain,dynamic:true,
  }));
}

async function addAccount(body:any):Promise<any>{
  const name=String(body.name||'Resend account').trim();
  const apiKey=String(body.apiKey||'').trim();
  if(!/^re_/.test(apiKey))throw new Error('A valid Resend API key is required');
  const id=uid('acct_'), now=isoNow();
  const account:MobileAccount={id,name,api_key:apiKey,enabled:1};
  // Validate before retaining the credential.
  await mobileResend.listDomains(account);
  await run('INSERT INTO accounts(id,name,api_key,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?)',[id,name,apiKey,1,now,now]);
  await refreshDomains(account);
  await configureBackgroundAccount(account);
  return{id,name,enabled:true};
}

async function accountsPublic():Promise<any[]>{
  return all<any>(`
    SELECT a.id,a.name,a.enabled,a.last_sync_at,a.last_error,a.created_at,
      (SELECT count(*) FROM domains d WHERE d.account_id=a.id AND d.status='verified') verified_domains
    FROM accounts a ORDER BY a.created_at
  `);
}

async function importBackgroundAutomationState():Promise<void>{
  let state:any;
  try{state=await getBackgroundAutomationState();}catch{return;}

  for(const email of Array.isArray(state?.suppressions)?state.suppressions:[]){
    if(typeof email!=='string'||!email.includes('@'))continue;
    await run(
      'INSERT INTO suppressions(email,reason,created_at) VALUES(?,?,?) ON CONFLICT(email) DO UPDATE SET reason=excluded.reason',
      [email.toLowerCase(),'background unsubscribe',isoNow()],
    );
  }

  for(const entry of Array.isArray(state?.audit)?state.audit:[]){
    if(!entry?.id||!entry?.action||!entry?.createdAt)continue;
    let localMessageId:string|null=null;
    if(entry.messageId){
      const hit=await one<{id:string}>('SELECT id FROM messages WHERE provider_id=? LIMIT 1',[String(entry.messageId)]);
      if(!hit)continue; // Re-import after Resend catch-up, when the provider id is mapped locally.
      localMessageId=hit.id;
    }
    await run(
      `INSERT OR IGNORE INTO automation_audit(id,message_id,campaign_id,action,decision_json,executed,error,created_at)
       VALUES(?,?,?,?,?,?,?,?)`,
      [
        entry.id,localMessageId,entry.campaignId||null,String(entry.action),
        JSON.stringify({source:'android-background',action:entry.action}),
        entry.executed?1:0,entry.error||null,String(entry.createdAt),
      ],
    );
  }

  for(const campaign of Array.isArray(state?.campaigns)?state.campaigns:[]){
    const campaignId=String(campaign?.id||'');
    if(!campaignId)continue;
    for(const contact of Array.isArray(campaign?.contacts)?campaign.contacts:[]){
      const id=String(contact?.id||'');
      if(!id)continue;
      const current=await one<{updated_at:string}>(
        'SELECT updated_at FROM campaign_contacts WHERE id=? AND campaign_id=?',[id,campaignId]
      );
      if(!current)continue;
      const updatedAt=String(contact.updatedAt||current.updated_at||isoNow());
      if(current.updated_at && current.updated_at>updatedAt)continue;
      await run(
        'UPDATE campaign_contacts SET state=?,step=?,next_action_at=?,updated_at=? WHERE id=? AND campaign_id=?',
        [
          String(contact.state||'queued'),Number(contact.step||0),
          contact.nextActionAt?String(contact.nextActionAt):null,updatedAt,id,campaignId,
        ],
      );
    }
  }
}

async function syncCampaignToBackground(campaignId:string):Promise<void>{
  const campaign=await one<any>('SELECT * FROM campaigns WHERE id=?',[campaignId]);
  if(!campaign)return;
  const contacts=await all<any>('SELECT * FROM campaign_contacts WHERE campaign_id=? ORDER BY created_at',[campaignId]);
  await upsertBackgroundCampaign(campaignId,{
    id:campaign.id,name:campaign.name,accountId:campaign.account_id,fromAddress:campaign.from_address,
    objective:campaign.objective,status:campaign.status,maxPerHour:Number(campaign.max_per_hour||25),
    maxPerDay:Number(campaign.max_per_day||100),followupDays:Number(campaign.followup_days||3),
    updatedAt:campaign.updated_at,
    contacts:contacts.map(contact=>({
      id:contact.id,email:contact.email,name:contact.name||'',company:contact.company||'',
      context:contact.context||'',state:contact.state,step:Number(contact.step||0),
      nextActionAt:contact.next_action_at||null,updatedAt:contact.updated_at,
    })),
  });
}

async function syncAllCampaignsToBackground():Promise<void>{
  const campaigns=await all<{id:string}>('SELECT id FROM campaigns');
  for(const campaign of campaigns){
    try{await syncCampaignToBackground(campaign.id);}catch{/* foreground campaign state remains authoritative on next retry */}
  }
}

async function syncSuppressionsToBackground():Promise<void>{
  const rows=await all<{email:string}>('SELECT email FROM suppressions ORDER BY email');
  try{await setBackgroundSuppressions(rows.map(row=>row.email.toLowerCase()));}catch{/* foreground suppression table remains authoritative */}
}

async function syncForegroundAuditToBackground():Promise<void>{
  const rows=await all<any>(
    "SELECT id,campaign_id,action,executed,created_at FROM automation_audit WHERE executed=1 AND action='create_outreach' AND created_at>=datetime('now','-1 day') ORDER BY created_at"
  );
  try{
    await setBackgroundForegroundAudit(rows.map(row=>({
      id:row.id,campaignId:row.campaign_id||null,action:row.action,
      executed:Boolean(row.executed),createdAt:row.created_at,
    })));
  }catch{/* foreground audit remains authoritative */}
}

async function createCampaign(body:any):Promise<any>{
  const from=String(body.from||'').toLowerCase();
  const account=await accountForSender(from);
  const id=uid('camp_'),now=isoNow();
  await run(
    'INSERT INTO campaigns(id,name,account_id,from_address,objective,status,max_per_hour,max_per_day,followup_days,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    [id,String(body.name||'BD campaign'),account.id,from,String(body.objective||''),'draft',
      Math.min(25,Math.max(1,Number(body.maxPerHour||25))),Math.max(1,Number(body.maxPerDay||100)),
      Math.max(1,Math.min(14,Number(body.followupDays||3))),now,now],
  );
  return{id};
}

async function addCampaignContacts(campaignId:string,body:any):Promise<any>{
  const contacts=Array.isArray(body.contacts)?body.contacts:[];
  let added=0;
  for(const c of contacts){
    const email=String(c.email||'').trim().toLowerCase();
    if(!email.includes('@'))continue;
    const now=isoNow();
    await run(
      `INSERT OR IGNORE INTO campaign_contacts(id,campaign_id,email,name,company,context,state,step,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      [uid('lead_'),campaignId,email,c.name||null,c.company||null,c.context||null,'queued',0,now,now],
    );
    added++;
  }
  return{added};
}

export async function mobileRequest<T=any>(rawUrl:string,init:RequestInit={}):Promise<T>{
  await createDefaultRule();
  const url=new URL(rawUrl,'https://local.gibp.invalid');
  const path=url.pathname;
  const method=(init.method||'GET').toUpperCase();
  const body=parseBody(init);

  if(path==='/api/status'&&method==='GET'){
    const accounts=await one<{n:number}>('SELECT count(*) n FROM accounts WHERE enabled=1');
    const last=await one<{last_sync_at:string;last_error:string}>('SELECT last_sync_at,last_error FROM accounts ORDER BY last_sync_at DESC LIMIT 1');
    const queued=await one<{n:number}>("SELECT count(*) n FROM messages WHERE status='queued'");
    return {configured:Number(accounts?.n||0)>0,syncing,lastSyncAt:last?.last_sync_at||null,lastSyncError:last?.last_error||null,dataDir:'Encrypted Android app storage',queued:Number(queued?.n||0)} as T;
  }
  if(path==='/api/identities'&&method==='GET')return await listIdentities() as T;
  if(path==='/api/sync'&&method==='POST'){
    if(syncing)return {inbound:0,sent:0} as T;
    const bgAccounts=await all<MobileAccount>('SELECT * FROM accounts WHERE enabled=1');
    for(const account of bgAccounts){try{await configureBackgroundAccount(account);}catch{/* foreground sync still works */}}
    try{await importBackgroundAutomationState();}catch{/* foreground engine can continue */}
    try{await syncSuppressionsToBackground();}catch{/* native suppression retry on next sync */}
    try{await syncForegroundAuditToBackground();}catch{/* native rate audit retry on next sync */}
    try{await syncAllCampaignsToBackground();}catch{/* native campaign retry on next sync */}
    syncing=true;
    try{
      const result=await syncAllAccounts();
      await importBackgroundAutomationState();
      for(const id of result.newInboundIds){await analyzeInbound(id);await evaluateInbound(id);}
      await reconcileCampaignReplies();
      await syncSuppressionsToBackground();
      await flushMobileOutbox();
      await runCampaignTick();
      await syncSuppressionsToBackground();
      await syncForegroundAuditToBackground();
      await syncAllCampaignsToBackground();
      await pushAllReplicas();
      return result as T;
    }finally{syncing=false;}
  }
  if(path==='/api/messages'&&method==='GET')return await listMessages(url) as T;
  if(path.startsWith('/api/threads/')&&method==='GET'){
    const id=decodeURIComponent(path.split('/').pop()!);
    const thread=await one<any>('SELECT * FROM threads WHERE id=?',[id]);
    if(!thread)throw new Error('Thread not found');
    const rows=await all<any>(`
      SELECT m.*,mi.category,mi.priority,mi.needs_reply,mi.needs_me,mi.waiting,mi.language,mi.why_it_matters,
      mi.summary intelligence_summary,mi.labels_json,al.address alias_address,sz.until_at snoozed_until,
      (SELECT count(*) FROM attachments a WHERE a.message_id=m.id) attachment_count,
      (SELECT count(*) FROM messages x WHERE x.thread_id=m.thread_id AND x.deleted_at IS NULL) thread_count
      FROM messages m
      LEFT JOIN message_intelligence mi ON mi.message_id=m.id
      LEFT JOIN aliases al ON al.id=mi.alias_id
      LEFT JOIN snoozes sz ON sz.thread_id=m.thread_id
      WHERE m.thread_id=? AND m.deleted_at IS NULL ORDER BY m.created_at`,[id]);
    for(const row of rows.filter(x=>!x.is_read)){
      await run('UPDATE messages SET is_read=1,revision=? WHERE id=?',[await nextRevision(),row.id]);
    }
    return {id:thread.id,subject:thread.subject,messages:await Promise.all(rows.map(detail))} as T;
  }
  if(path.startsWith('/api/messages/')&&method==='PATCH'){
    const id=decodeURIComponent(path.split('/').pop()!);
    const sets:string[]=['revision=?'];const vals:any[]=[await nextRevision()];
    if(body.isRead!==undefined){sets.push('is_read=?');vals.push(body.isRead?1:0);}
    if(body.isStarred!==undefined){sets.push('is_starred=?');vals.push(body.isStarred?1:0);}
    if(body.isArchived!==undefined){sets.push('is_archived=?');vals.push(body.isArchived?1:0);}
    if(body.trash!==undefined){sets.push('deleted_at=?');vals.push(body.trash?isoNow():null);}
    vals.push(id);await run(`UPDATE messages SET ${sets.join(',')} WHERE id=?`,vals);return {ok:true} as T;
  }
  if(path==='/api/drafts'&&method==='GET'){
    const rows=await all<any>('SELECT * FROM drafts ORDER BY updated_at DESC');
    return rows.map(r=>({id:r.id,replyToMessageId:r.reply_to_message_id,fromIdentity:r.from_identity,to:json(r.to_json,[]),cc:json(r.cc_json,[]),bcc:json(r.bcc_json,[]),subject:r.subject,textBody:r.text_body,updatedAt:r.updated_at})) as T;
  }
  if(path==='/api/drafts'&&method==='POST'){
    const id=body.id||uid('draft_'),now=isoNow(),rev=await nextRevision();
    await run(`
      INSERT INTO drafts(id,reply_to_message_id,from_identity,to_json,cc_json,bcc_json,subject,text_body,updated_at,created_at,revision)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET reply_to_message_id=excluded.reply_to_message_id,from_identity=excluded.from_identity,
      to_json=excluded.to_json,cc_json=excluded.cc_json,bcc_json=excluded.bcc_json,subject=excluded.subject,
      text_body=excluded.text_body,updated_at=excluded.updated_at,revision=excluded.revision`,
      [id,body.replyToMessageId||null,body.fromIdentity||'',JSON.stringify(body.to||[]),JSON.stringify(body.cc||[]),
       JSON.stringify(body.bcc||[]),body.subject||'',body.textBody||'',now,now,rev]);
    return{id} as T;
  }
  if(path.startsWith('/api/drafts/')&&method==='DELETE'){await run('DELETE FROM drafts WHERE id=?',[decodeURIComponent(path.split('/').pop()!)]);return{ok:true} as T;}
  if(path==='/api/send'&&method==='POST')return await queueAndSend(body) as T;

  if(path==='/api/accounts'&&method==='GET')return await accountsPublic() as T;
  if(path==='/api/accounts'&&method==='POST')return await addAccount(body) as T;
  if(path.startsWith('/api/accounts/')&&method==='DELETE'){
    const id=decodeURIComponent(path.split('/').pop()!);
    await run('UPDATE accounts SET enabled=0,updated_at=? WHERE id=?',[isoNow(),id]);
    try{await removeBackgroundAccount(id);}catch{/* encrypted foreground account remains disabled */}
    return{ok:true} as T;
  }
  const domainRefresh=path.match(/^\/api\/accounts\/([^/]+)\/domains\/refresh$/);
  if(domainRefresh&&method==='POST'){
    const account=await one<MobileAccount>('SELECT * FROM accounts WHERE id=?',[decodeURIComponent(domainRefresh[1])]);
    if(!account)throw new Error('Account not found');return{count:await refreshDomains(account)} as T;
  }

  if(path==='/api/ai/config'&&method==='POST'){
    const url=String(body.url||'').trim(), token=String(body.token||'').trim();
    await configureAi(url,token);
    const rule=await one<any>("SELECT * FROM automation_rules WHERE enabled=1 ORDER BY created_at LIMIT 1");
    await configureBackgroundAutomation({
      url,token,mode:String(rule?.mode||'draft'),threshold:Number(rule?.confidence_threshold||0.92),
      maxRepliesPerHour:Number(rule?.max_auto_replies_per_hour||10),
    });
    return{ok:true} as T;
  }
  if(path==='/api/automation/rules'&&method==='GET')return await all<any>('SELECT * FROM automation_rules ORDER BY created_at') as T;
  if(path.startsWith('/api/automation/rules/')&&method==='PATCH'){
    const id=decodeURIComponent(path.split('/').pop()!);
    const mode=['off','draft','auto_safe'].includes(body.mode)?body.mode:'draft';
    const threshold=Math.max(.5,Math.min(1,Number(body.confidenceThreshold||.92)));
    const maxRepliesPerHour=Math.max(1,Math.min(25,Number(body.maxAutoRepliesPerHour||10)));
    await run('UPDATE automation_rules SET enabled=?,mode=?,confidence_threshold=?,max_auto_replies_per_hour=?,updated_at=? WHERE id=?',
      [body.enabled===false?0:1,mode,threshold,maxRepliesPerHour,isoNow(),id]);
    try{await setBackgroundAutomationMode({mode:body.enabled===false?'off':mode,threshold,maxRepliesPerHour});}catch{/* AI may not be configured yet */}
    return{ok:true} as T;
  }
  if(path==='/api/automation/audit'&&method==='GET')return await all<any>('SELECT * FROM automation_audit ORDER BY created_at DESC LIMIT 200') as T;

  if(path==='/api/campaigns'&&method==='GET')return await all<any>('SELECT * FROM campaigns ORDER BY created_at DESC') as T;
  if(path==='/api/campaigns'&&method==='POST'){
    const created=await createCampaign(body);
    try{await syncCampaignToBackground(created.id);}catch{/* background copy can be retried */}
    return created as T;
  }
  const contactsMatch=path.match(/^\/api\/campaigns\/([^/]+)\/contacts$/);
  if(contactsMatch&&method==='POST'){
    const id=decodeURIComponent(contactsMatch[1]);
    const result=await addCampaignContacts(id,body);
    try{await syncCampaignToBackground(id);}catch{/* background copy can be retried */}
    return result as T;
  }
  const campaignStart=path.match(/^\/api\/campaigns\/([^/]+)\/start$/);
  if(campaignStart&&method==='POST'){
    const id=decodeURIComponent(campaignStart[1]);
    await run("UPDATE campaigns SET status='active',updated_at=? WHERE id=?",[isoNow(),id]);
    try{await importBackgroundAutomationState();await syncSuppressionsToBackground();await syncForegroundAuditToBackground();await syncCampaignToBackground(id);}catch{/* foreground campaign remains active */}
    return{ok:true} as T;
  }
  const campaignRun=path.match(/^\/api\/campaigns\/([^/]+)\/run$/);
  if(campaignRun&&method==='POST'){
    const id=decodeURIComponent(campaignRun[1]);
    await importBackgroundAutomationState();
    const result=await runCampaignTick(id);
    await syncForegroundAuditToBackground();
    await syncCampaignToBackground(id);
    return result as T;
  }

  if(path==='/api/replicas'&&method==='GET')return await all<any>('SELECT id,name,url,enabled,last_revision,last_sync_at,last_error FROM replica_targets ORDER BY name') as T;
  if(path==='/api/replicas'&&method==='POST'){
    const id=uid('rep_');await run('INSERT INTO replica_targets(id,name,url,token,enabled,last_revision) VALUES(?,?,?,?,1,0)',
      [id,String(body.name||'PC'),String(body.url||'').replace(/\/$/,''),String(body.token||'')]);return{id} as T;
  }
  const repPush=path.match(/^\/api\/replicas\/([^/]+)\/push$/);
  if(repPush&&method==='POST')return await pushReplicaTarget(decodeURIComponent(repPush[1])) as T;

  throw new Error(`Unsupported mobile route: ${method} ${path}`);
}

export async function openMobileAttachment(id:string):Promise<void>{
  const attachment=await one<any>('SELECT * FROM attachments WHERE id=?',[id]);
  if(!attachment?.local_path)throw new Error('Attachment is not downloaded to this device');
  await FileViewer.openDocumentFromLocalPath({path:attachment.local_path});
}
