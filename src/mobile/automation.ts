import { CapacitorHttp } from '@capacitor/core';
import { all, isoNow, json, nextRevision, one, run, uid } from './db.js';
import { queueAndSend } from './sync.js';
import { AUTO_SAFE_CATEGORIES, canAutoSend } from '../shared/policy.js';

export type AutomationAction =
  | 'no_action' | 'draft_reply' | 'send_reply' | 'schedule_followup'
  | 'create_outreach' | 'escalate';

export interface AutomationDecision {
  action: AutomationAction;
  category: string;
  confidence: number;
  subject: string;
  body: string;
  follow_up_days: number;
  reason: string;
  sensitive: boolean;
  unsubscribe: boolean;
}

async function setting(key: string): Promise<string | null> {
  return (await one<{ value: string }>('SELECT value FROM settings WHERE key=?', [key]))?.value || null;
}

async function gateway(task: 'inbound'|'outreach'|'followup', payload: any): Promise<AutomationDecision> {
  const url = await setting('ai_gateway_url');
  const token = await setting('ai_gateway_token');
  if (!url || !token) throw new Error('AI gateway is not configured');
  const response = await CapacitorHttp.post({
    url: url.replace(/\/$/, '') + '/v1/decision',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: { task, payload },
    connectTimeout: 20_000,
    readTimeout: 60_000,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(String(response.data?.error || `AI gateway HTTP ${response.status}`));
  }
  return response.data as AutomationDecision;
}

async function audit(input: {
  messageId?: string; campaignId?: string; decision: AutomationDecision; executed: boolean; error?: string;
}): Promise<void> {
  await run(
    'INSERT INTO automation_audit(id,message_id,campaign_id,action,decision_json,executed,error,created_at) VALUES(?,?,?,?,?,?,?,?)',
    [uid('audit_'), input.messageId || null, input.campaignId || null, input.decision.action,
      JSON.stringify(input.decision), input.executed ? 1 : 0, input.error || null, isoNow()],
  );
}

function threadPrompt(messages: any[]): string {
  return messages.map(m =>
    `${m.direction === 'inbound' ? 'THEM' : 'US'} | ${m.from_address} | ${m.created_at}\nSubject: ${m.subject}\n${m.text_body || m.preview || ''}`
  ).join('\n\n---\n\n').slice(-30_000);
}

async function activeRule(accountId: string): Promise<any | null> {
  return one(
    "SELECT * FROM automation_rules WHERE enabled=1 AND (account_id=? OR account_id IS NULL) ORDER BY CASE WHEN account_id=? THEN 0 ELSE 1 END LIMIT 1",
    [accountId, accountId],
  );
}

async function replyCountLastHour(): Promise<number> {
  const row = await one<{ n: number }>(
    "SELECT count(*) n FROM automation_audit WHERE executed=1 AND action='send_reply' AND created_at>=datetime('now','-1 hour')",
  );
  return Number(row?.n || 0);
}

function hasAutomatedHeader(message: any): boolean {
  const text = String(message.text_body || '') + ' ' + String(message.subject || '');
  return /auto(?:matic)?[- ]?reply|out of office|delivery status|mailer-daemon/i.test(text);
}

export async function evaluateInbound(messageId: string): Promise<AutomationDecision | null> {
  const message: any = await one('SELECT * FROM messages WHERE id=? AND direction=?', [messageId, 'inbound']);
  if (!message) return null;
  const rule = await activeRule(message.account_id);
  if (!rule) return null;

  const sender = String(message.from_address || '').toLowerCase();
  if (await one('SELECT 1 FROM suppressions WHERE email=?', [sender])) return null;
  if (hasAutomatedHeader(message)) return null;

  const thread = await all<any>('SELECT * FROM messages WHERE thread_id=? AND deleted_at IS NULL ORDER BY created_at', [message.thread_id]);
  let decision: AutomationDecision;
  try {
    decision = await gateway('inbound', {
      instruction: 'Classify this email and decide the safest useful next action. Never invent facts, commitments, pricing, regulatory status, or prior relationships.',
      conversation: threadPrompt(thread),
    });
  } catch (e) {
    const fallback: AutomationDecision = {
      action:'escalate', category:'ai_error', confidence:0, subject:'', body:'', follow_up_days:0,
      reason:e instanceof Error?e.message:String(e), sensitive:true, unsubscribe:false,
    };
    await audit({messageId,decision:fallback,executed:false,error:fallback.reason});
    return fallback;
  }

  if (decision.unsubscribe || /unsubscribe|do not contact|stop emailing|remove me/i.test(String(message.text_body || ''))) {
    await run(
      'INSERT INTO suppressions(email,reason,created_at) VALUES(?,?,?) ON CONFLICT(email) DO UPDATE SET reason=excluded.reason',
      [sender, 'unsubscribe', isoNow()],
    );
    decision.action = 'no_action';
  }

  const threshold = Number(rule.confidence_threshold || 0.92);
  const mode = String(rule.mode || 'draft');
  const autoAllowed = canAutoSend({
    mode,
    category: decision.category,
    sensitive: decision.sensitive,
    confidence: decision.confidence,
    threshold,
    action: decision.action,
    sentLastHour: await replyCountLastHour(),
    hourlyLimit: Number(rule.max_auto_replies_per_hour || 10),
  });

  if (autoAllowed && decision.body.trim()) {
    try {
      const result = await queueAndSend({
        from: message.to_json ? json<string[]>(message.to_json, [])[0] || '' : '',
        to: [sender],
        subject: decision.subject || (/^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`),
        text: decision.body,
        replyToMessageId: message.id,
      });
      const executed = result.status === 'sent' || result.status === 'queued';
      await audit({messageId,decision,executed,error:result.error});
      return decision;
    } catch (e) {
      await audit({messageId,decision,executed:false,error:e instanceof Error?e.message:String(e)});
      return decision;
    }
  }

  // Draft-only and sensitive outcomes are retained in the audit log for user approval.
  await audit({messageId,decision,executed:false});
  return decision;
}

export async function reconcileCampaignReplies(): Promise<number> {
  const contacts = await all<any>(
    "SELECT cc.* FROM campaign_contacts cc JOIN campaigns c ON c.id=cc.campaign_id WHERE c.status='active' AND cc.state IN ('sent','followup_due')",
  );
  let changed = 0;
  for (const contact of contacts) {
    const reply = await one<any>(
      "SELECT id,text_body,subject FROM messages WHERE direction='inbound' AND lower(from_address)=lower(?) AND created_at>=? ORDER BY created_at LIMIT 1",
      [contact.email, contact.created_at],
    );
    if (!reply) continue;
    const text = `${reply.subject || ''} ${reply.text_body || ''}`;
    if (/unsubscribe|do not contact|remove me|stop emailing/i.test(text)) {
      await run(
        'INSERT INTO suppressions(email,reason,created_at) VALUES(?,?,?) ON CONFLICT(email) DO UPDATE SET reason=excluded.reason',
        [contact.email.toLowerCase(), 'unsubscribe', isoNow()],
      );
      await run("UPDATE campaign_contacts SET state='unsubscribed',updated_at=? WHERE id=?", [isoNow(), contact.id]);
    } else {
      await run("UPDATE campaign_contacts SET state='replied',updated_at=? WHERE id=?", [isoNow(), contact.id]);
    }
    changed++;
  }
  return changed;
}

async function campaignSendCount(campaignId: string, period: 'hour'|'day'): Promise<number> {
  const offset = period === 'hour' ? '-1 hour' : '-1 day';
  const row = await one<{ n: number }>(
    `SELECT count(*) n FROM automation_audit WHERE campaign_id=? AND executed=1 AND action='create_outreach' AND created_at>=datetime('now',?)`,
    [campaignId, offset],
  );
  return Number(row?.n || 0);
}

export async function runCampaignTick(campaignId?: string): Promise<{ attempted:number; sent:number; skipped:number }> {
  await reconcileCampaignReplies();
  const campaigns = campaignId
    ? await all<any>("SELECT * FROM campaigns WHERE id=? AND status='active'", [campaignId])
    : await all<any>("SELECT * FROM campaigns WHERE status='active' ORDER BY created_at");
  let attempted=0, sent=0, skipped=0;

  for (const campaign of campaigns) {
    const perHour = await campaignSendCount(campaign.id, 'hour');
    const perDay = await campaignSendCount(campaign.id, 'day');
    if (perHour >= Math.min(25, Number(campaign.max_per_hour || 25)) || perDay >= Number(campaign.max_per_day || 100)) continue;

    const contact = await one<any>(
      `SELECT * FROM campaign_contacts
       WHERE campaign_id=? AND state IN ('queued','followup_due')
       AND (next_action_at IS NULL OR next_action_at<=?)
       ORDER BY created_at LIMIT 1`,
      [campaign.id, isoNow()],
    );
    if (!contact) continue;
    attempted++;

    if (await one('SELECT 1 FROM suppressions WHERE lower(email)=lower(?)', [contact.email])) {
      await run("UPDATE campaign_contacts SET state='suppressed',updated_at=? WHERE id=?", [isoNow(), contact.id]);
      skipped++;
      continue;
    }

    let decision: AutomationDecision;
    try {
      decision = await gateway(contact.step > 0 ? 'followup' : 'outreach', {
        objective: campaign.objective,
        sender: campaign.from_address,
        contact: { name:contact.name, email:contact.email, company:contact.company, context:contact.context },
        step: contact.step,
        instruction: 'Write concise, factual, personalized B2B outreach. Do not pretend there was prior contact unless the supplied context proves it. No pressure, deception, or invented claims.',
      });
    } catch (e) {
      const d:AutomationDecision={action:'escalate',category:'ai_error',confidence:0,subject:'',body:'',follow_up_days:0,reason:String(e),sensitive:true,unsubscribe:false};
      await audit({campaignId:campaign.id,decision:d,executed:false,error:String(e)});
      skipped++;
      continue;
    }

    if (!decision.body.trim() || decision.sensitive || decision.unsubscribe) {
      await audit({campaignId:campaign.id,decision,executed:false});
      skipped++;
      continue;
    }

    decision.action='create_outreach';
    const result = await queueAndSend({
      from:campaign.from_address,
      to:[contact.email],
      subject:decision.subject || campaign.name,
      text:decision.body,
    });
    const executed=result.status==='sent'||result.status==='queued';
    await audit({campaignId:campaign.id,decision,executed,error:result.error});
    if (executed) {
      const days=Math.max(1,Math.min(14,decision.follow_up_days||campaign.followup_days||3));
      const next=new Date(Date.now()+days*86400000).toISOString();
      await run(
        "UPDATE campaign_contacts SET state='sent',step=step+1,next_action_at=?,updated_at=? WHERE id=?",
        [next,isoNow(),contact.id],
      );
      sent++;
    } else skipped++;
  }
  return {attempted,sent,skipped};
}

export async function configureAi(url:string,token:string):Promise<void>{
  for(const [k,v] of [['ai_gateway_url',url],['ai_gateway_token',token]] as const){
    await run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',[k,v]);
  }
}

export async function createDefaultRule():Promise<string>{
  const existing=await one<{id:string}>("SELECT id FROM automation_rules WHERE name='Default safe automation'");
  if(existing)return existing.id;
  const id=uid('rule_'), now=isoNow();
  await run(
    'INSERT INTO automation_rules(id,name,enabled,mode,confidence_threshold,categories_json,max_auto_replies_per_hour,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
    [id,'Default safe automation',1,'draft',0.92,JSON.stringify([...AUTO_SAFE_CATEGORIES]),10,now,now],
  );
  return id;
}
