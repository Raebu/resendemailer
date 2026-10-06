import { CapacitorHttp } from '@capacitor/core';
import { all, isoNow, json, one, run, uid } from './db.js';

type AliasRow={id:string;account_id:string;address:string;pattern:string|null;persona:string|null;tone:string|null;default_language:string;folder:string|null;notification_priority:string;ai_mode:string;signature_id:string|null;forward_to_json:string;is_dynamic:number};
type Intel={category:string;priority:string;needs_reply:boolean;needs_me:boolean;waiting:boolean;language:string;why_it_matters:string;summary:string;actions:any[];deadline_at:string|null;labels:string[];confidence:number;sensitive:boolean};

const lower=(v:any)=>String(v||'').trim().toLowerCase();
const domain=(email:string)=>lower(email).split('@').at(-1)||'';
const parseEmail=(v:string)=>lower(v.match(/<([^<>\s]+@[^<>\s]+)>/)?.[1]||v);
function wildcard(pattern:string,value:string){const e=pattern.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\?/g,'.');return new RegExp(`^${e}$`,'i').test(value);}

async function setting(key:string){return (await one<{value:string}>('SELECT value FROM settings WHERE key=?',[key]))?.value||null;}
async function ai(path:string,payload:any){
  const url=await setting('ai_gateway_url'),token=await setting('ai_gateway_token');
  if(!url||!token)throw new Error('AI gateway is not configured');
  const r=await CapacitorHttp.post({url:url.replace(/\/$/,'')+path,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},data:payload,connectTimeout:20_000,readTimeout:60_000});
  if(r.status<200||r.status>=300)throw new Error(String(r.data?.error||`AI gateway HTTP ${r.status}`));
  return r.data;
}

export async function resolveAlias(message:any):Promise<AliasRow|null>{
  const recipients=json<string[]>(message.to_json,[]).map(parseEmail);
  for(const address of recipients){
    const account=await one<{account_id:string}>("SELECT account_id FROM domains WHERE domain=? AND status='verified' AND can_receive=1 LIMIT 1",[domain(address)]);
    if(!account)continue;
    const rows=await all<AliasRow>('SELECT * FROM aliases WHERE enabled=1 AND account_id=? ORDER BY is_dynamic ASC,created_at ASC',[account.account_id]);
    const exact=rows.find(a=>lower(a.address)===address);
    if(exact)return exact;
    const inherited=rows.find(a=>a.pattern&&wildcard(a.pattern.includes('@')?a.pattern:`${a.pattern}@${domain(address)}`,address));
    const id=uid('alias_'),now=isoNow();
    await run(`INSERT OR IGNORE INTO aliases(id,account_id,address,pattern,persona,tone,default_language,folder,notification_priority,ai_mode,signature_id,forward_to_json,is_dynamic,enabled,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,1,?,?)`,[id,account.account_id,address,null,inherited?.persona||null,inherited?.tone||null,inherited?.default_language||'auto',inherited?.folder||null,inherited?.notification_priority||'normal',inherited?.ai_mode||'inherit',inherited?.signature_id||null,inherited?.forward_to_json||'[]',now,now]);
    return one<AliasRow>('SELECT * FROM aliases WHERE account_id=? AND address=?',[account.account_id,address]);
  }
  return null;
}

function matchRule(c:any,ctx:any){
  if(c.to&&!wildcard(c.to,ctx.to))return false;if(c.from&&!wildcard(c.from,ctx.from))return false;
  if(c.fromDomain&&lower(c.fromDomain)!==domain(ctx.from))return false;
  if(c.subjectContains&&!lower(ctx.subject).includes(lower(c.subjectContains)))return false;
  if(c.bodyContains&&!lower(ctx.body).includes(lower(c.bodyContains)))return false;
  if(c.hasAttachment!==undefined&&Boolean(c.hasAttachment)!==ctx.hasAttachment)return false;
  return true;
}
async function deterministicRoute(message:any,alias:AliasRow|null,intel:Partial<Intel>){
  const ctx={to:alias?.address||json<string[]>(message.to_json,[])[0]||'',from:parseEmail(message.from_address),subject:message.subject||'',body:message.text_body||message.preview||'',hasAttachment:Boolean(await one('SELECT 1 x FROM attachments WHERE message_id=? LIMIT 1',[message.id]))};
  const out:any={priority:intel.priority||'normal',needsReply:Boolean(intel.needs_reply),needsMe:Boolean(intel.needs_me),waiting:Boolean(intel.waiting),labels:Array.isArray(intel.labels)?intel.labels:[],archive:false,snooze:null,reminder:null};
  for(const r of await all<any>('SELECT * FROM routing_rules WHERE enabled=1 ORDER BY priority,created_at')){
    const c=json<any>(r.conditions_json,{});if(!matchRule(c,ctx))continue;const a=json<any>(r.actions_json,{});
    if(a.priority)out.priority=a.priority;if(a.label)out.labels=[...new Set([...out.labels,a.label])];if(a.needsReply!==undefined)out.needsReply=!!a.needsReply;if(a.needsMe!==undefined)out.needsMe=!!a.needsMe;if(a.waiting!==undefined)out.waiting=!!a.waiting;if(a.archive!==undefined)out.archive=!!a.archive;if(a.snoozeUntil)out.snooze=a.snoozeUntil;if(a.reminderAt)out.reminder=a.reminderAt;if(r.stop_processing)break;
  }
  return out;
}

export async function analyzeInbound(messageId:string){
  const m=await one<any>("SELECT * FROM messages WHERE id=? AND direction='inbound'",[messageId]);if(!m)return null;
  const alias=await resolveAlias(m);let intel:Partial<Intel>={};
  try{intel=await ai('/v1/intelligence',{subject:m.subject||'',from:m.from_address,to:json(m.to_json,[]),text:String(m.text_body||m.preview||'').slice(0,30000),alias:alias?{address:alias.address,persona:alias.persona,tone:alias.tone}:null});}catch{}
  const route=await deterministicRoute(m,alias,intel),now=isoNow();
  const final:Intel={category:String(intel.category||'unclassified'),priority:String(route.priority||'normal'),needs_reply:!!route.needsReply,needs_me:!!route.needsMe,waiting:!!route.waiting,language:String(intel.language||'unknown'),why_it_matters:String(intel.why_it_matters||''),summary:String(intel.summary||m.preview||''),actions:Array.isArray(intel.actions)?intel.actions:[],deadline_at:intel.deadline_at?String(intel.deadline_at):null,labels:route.labels||[],confidence:Number(intel.confidence||0),sensitive:!!intel.sensitive};
  await run(`INSERT INTO message_intelligence(message_id,alias_id,category,priority,needs_reply,needs_me,waiting,language,why_it_matters,summary,actions_json,deadline_at,labels_json,ai_confidence,analyzed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET alias_id=excluded.alias_id,category=excluded.category,priority=excluded.priority,needs_reply=excluded.needs_reply,needs_me=excluded.needs_me,waiting=excluded.waiting,language=excluded.language,why_it_matters=excluded.why_it_matters,summary=excluded.summary,actions_json=excluded.actions_json,deadline_at=excluded.deadline_at,labels_json=excluded.labels_json,ai_confidence=excluded.ai_confidence,analyzed_at=excluded.analyzed_at`,
    [m.id,alias?.id||null,final.category,final.priority,final.needs_reply?1:0,final.needs_me?1:0,final.waiting?1:0,final.language,final.why_it_matters,final.summary,JSON.stringify(final.actions),final.deadline_at,JSON.stringify(final.labels),final.confidence,now]);
  if(route.archive)await run('UPDATE messages SET is_archived=1 WHERE id=?',[m.id]);
  if(route.snooze)await snoozeThread(m.thread_id,String(route.snooze));
  if(route.reminder)await createReminder(m.thread_id,m.id,'follow_up',String(route.reminder),'Routing rule follow-up');
  if(final.deadline_at)await createReminder(m.thread_id,m.id,'deadline',final.deadline_at,final.why_it_matters||'Email deadline');
  const email=parseEmail(m.from_address);if(email.includes('@'))await run(`INSERT INTO contact_memory(email,name,preferred_language,last_thread_id,last_contact_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET name=coalesce(excluded.name,contact_memory.name),preferred_language=coalesce(excluded.preferred_language,contact_memory.preferred_language),last_thread_id=excluded.last_thread_id,last_contact_at=excluded.last_contact_at,updated_at=excluded.updated_at`,[email,m.from_name||null,final.language==='unknown'?null:final.language,m.thread_id,m.created_at||now,now]);
  return final;
}

export async function createReminder(threadId:string,messageId:string|null,kind:string,dueAt:string,note=''){const id=uid('rem_'),now=isoNow();await run('INSERT INTO reminders(id,thread_id,message_id,kind,due_at,state,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',[id,threadId,messageId,kind,dueAt,'pending',note,now,now]);return id;}
export async function snoozeThread(threadId:string,untilAt:string){const now=isoNow();await run(`INSERT INTO snoozes(thread_id,until_at,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET until_at=excluded.until_at,updated_at=excluded.updated_at`,[threadId,untilAt,now,now]);}
export async function markWaiting(threadId:string,messageId:string|null,dueAt?:string){await run('UPDATE message_intelligence SET waiting=1 WHERE message_id IN (SELECT id FROM messages WHERE thread_id=?)',[threadId]);if(dueAt)await createReminder(threadId,messageId,'waiting_reply',dueAt,'Waiting for reply');}

export async function languageTransform(input:{text:string;sourceLanguage?:string;targetLanguage:string;mode?:string;tone?:string}){
  return ai('/v1/language',{text:input.text,source_language:input.sourceLanguage||'auto',target_language:input.targetLanguage,mode:input.mode||'translate',tone:input.tone||'professional',preserve:['names','account numbers','URLs','currency values','reference numbers','quoted text']});
}
export async function smartSearch(query:string){
  const rows=await all<any>(`SELECT m.thread_id,m.from_address,m.subject,m.preview,m.created_at,mi.category,mi.priority,mi.needs_reply,mi.needs_me,mi.waiting,mi.language,mi.summary,mi.labels_json FROM messages m LEFT JOIN message_intelligence mi ON mi.message_id=m.id WHERE m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 300`);
  try{return (await ai('/v1/search',{query,items:rows})).matches||[];}catch{const q=lower(query);return rows.filter(r=>lower(JSON.stringify(r)).includes(q)).slice(0,50).map(r=>({threadId:r.thread_id,reason:'Local text match',score:.5}));}
}
export async function attentionBriefing(){
  const items=await all<any>(`SELECT m.thread_id,m.from_address,m.subject,m.preview,m.created_at,mi.* FROM messages m JOIN message_intelligence mi ON mi.message_id=m.id WHERE m.deleted_at IS NULL AND (mi.needs_me=1 OR mi.needs_reply=1 OR mi.priority IN ('urgent','high') OR mi.deadline_at IS NOT NULL) ORDER BY m.created_at DESC LIMIT 80`);
  const reminders=await all<any>("SELECT * FROM reminders WHERE state='pending' ORDER BY due_at LIMIT 50");let content:any={title:'What needs your attention',items,reminders};try{content=await ai('/v1/briefing',{items,reminders});}catch{}await run('INSERT INTO briefings(id,kind,content_json,created_at) VALUES(?,?,?,?)',[uid('brief_'),'attention',JSON.stringify(content),isoNow()]);return content;
}
