import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { mailApi as api } from './mailApi.js';
import { MailIcon } from './MailIcon.js';

type Props = {
  onClose: () => void;
  onChanged: () => void;
  onError: (message: string | null) => void;
};

type Account = {
  id: string;
  name: string;
  enabled: number;
  verified_domains: number;
  last_sync_at?: string | null;
  last_error?: string | null;
};

type Rule = {
  id: string;
  name: string;
  enabled: number;
  mode: 'off' | 'draft' | 'auto_safe';
  confidence_threshold: number;
  max_auto_replies_per_hour: number;
};

type Replica = {
  id: string;
  name: string;
  url: string;
  enabled: number;
  last_revision: number;
  last_sync_at?: string | null;
  last_error?: string | null;
};

type Campaign = {
  id: string;
  name: string;
  from_address: string;
  objective: string;
  status: string;
  max_per_hour: number;
  max_per_day: number;
};

const inputClass = 'settingsInput';

export function SettingsPanel({ onClose, onChanged, onError }: Props) {
  const native = Capacitor.isNativePlatform();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [replicas, setReplicas] = useState<Replica[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [aliases,setAliases]=useState<any[]>([]);
  const [routingRules,setRoutingRules]=useState<any[]>([]);
  const [signatures,setSignatures]=useState<any[]>([]);
  const [templates,setTemplates]=useState<any[]>([]);
  const [busy, setBusy] = useState(false);

  const [accountName, setAccountName] = useState('');
  const [accountKey, setAccountKey] = useState('');

  const [aiUrl, setAiUrl] = useState('');
  const [aiToken, setAiToken] = useState('');

  const [replicaName, setReplicaName] = useState('Garuda PC');
  const [replicaUrl, setReplicaUrl] = useState('');
  const [replicaToken, setReplicaToken] = useState('');

  const [campaignName, setCampaignName] = useState('');
  const [campaignFrom, setCampaignFrom] = useState('');
  const [campaignObjective, setCampaignObjective] = useState('');
  const [campaignContacts, setCampaignContacts] = useState('');

  const [aliasAccount,setAliasAccount]=useState('');
  const [aliasAddress,setAliasAddress]=useState('');
  const [aliasPattern,setAliasPattern]=useState('');
  const [aliasPersona,setAliasPersona]=useState('');
  const [aliasTone,setAliasTone]=useState('professional');
  const [aliasLanguage,setAliasLanguage]=useState('auto');
  const [aliasSignature,setAliasSignature]=useState('');

  const [routeName,setRouteName]=useState('');
  const [routeConditions,setRouteConditions]=useState('{\n  "to": "bank*@gibp.global"\n}');
  const [routeActions,setRouteActions]=useState('{\n  "priority": "high",\n  "needsMe": true\n}');

  const [signatureName,setSignatureName]=useState('');
  const [signatureBody,setSignatureBody]=useState('');
  const [templateName,setTemplateName]=useState('');
  const [templateSubject,setTemplateSubject]=useState('');
  const [templateBody,setTemplateBody]=useState('');
  const [templateLanguage,setTemplateLanguage]=useState('');

  const refresh = async () => {
    if (!native) return;
    const [a, r, p, c, al, rr, sig, tpl] = await Promise.all([
      api<Account[]>('/api/accounts'),
      api<Rule[]>('/api/automation/rules'),
      api<Replica[]>('/api/replicas'),
      api<Campaign[]>('/api/campaigns'),
      api<any[]>('/api/aliases'),
      api<any[]>('/api/routing-rules'),
      api<any[]>('/api/signatures'),
      api<any[]>('/api/templates'),
    ]);
    setAccounts(a);setRules(r);setReplicas(p);setCampaigns(c);
    setAliases(al);setRoutingRules(rr);setSignatures(sig);setTemplates(tpl);
    if(!aliasAccount&&a[0]?.id)setAliasAccount(a[0].id);
  };

  useEffect(() => {
    void refresh().catch(e => onError(e instanceof Error ? e.message : String(e)));
  }, []);

  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    onError(null);
    try {
      await fn();
      await refresh();
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const addAccount = () => action(async () => {
    if (!accountName.trim() || !accountKey.trim()) throw new Error('Account name and Resend API key are required.');
    await api('/api/accounts', {
      method: 'POST',
      body: JSON.stringify({ name: accountName.trim(), apiKey: accountKey.trim() }),
    });
    setAccountName('');
    setAccountKey('');
  });

  const saveAi = () => action(async () => {
    if (!/^https:\/\//i.test(aiUrl)) throw new Error('AI gateway must use HTTPS.');
    if (!aiToken.trim()) throw new Error('AI gateway token is required.');
    await api('/api/ai/config', {
      method: 'POST',
      body: JSON.stringify({ url: aiUrl.trim(), token: aiToken.trim() }),
    });
    setAiToken('');
  });

  const updateRule = (rule: Rule, mode: Rule['mode']) => action(async () => {
    await api(`/api/automation/rules/${rule.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        enabled: mode !== 'off',
        mode,
        confidenceThreshold: rule.confidence_threshold,
        maxAutoRepliesPerHour: rule.max_auto_replies_per_hour,
      }),
    });
  });

  const addReplica = () => action(async () => {
    if (!/^https:\/\//i.test(replicaUrl)) throw new Error('Replica URL must use HTTPS.');
    if (!replicaToken.trim()) throw new Error('Replica token is required.');
    await api('/api/replicas', {
      method: 'POST',
      body: JSON.stringify({ name: replicaName.trim() || 'PC', url: replicaUrl.trim(), token: replicaToken.trim() }),
    });
    setReplicaUrl('');
    setReplicaToken('');
  });

  const createCampaign = () => action(async () => {
    if (!campaignName.trim() || !campaignFrom.trim() || !campaignObjective.trim()) {
      throw new Error('Campaign name, From address and objective are required.');
    }
    const created = await api<{ id: string }>('/api/campaigns', {
      method: 'POST',
      body: JSON.stringify({
        name: campaignName.trim(),
        from: campaignFrom.trim(),
        objective: campaignObjective.trim(),
        maxPerHour: 25,
        maxPerDay: 100,
        followupDays: 3,
      }),
    });

    const contacts = campaignContacts
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const [email = '', name = '', company = '', ...context] = line.split(',').map(v => v.trim());
        return { email, name, company, context: context.join(', ') };
      })
      .filter(c => c.email.includes('@'));

    if (contacts.length) {
      await api(`/api/campaigns/${created.id}/contacts`, {
        method: 'POST',
        body: JSON.stringify({ contacts }),
      });
    }
    setCampaignName('');
    setCampaignFrom('');
    setCampaignObjective('');
    setCampaignContacts('');
  });

  const saveAlias=()=>action(async()=>{
    if(!aliasAccount||!aliasAddress.trim())throw new Error('Alias account and address are required.');
    await api('/api/aliases',{method:'POST',body:JSON.stringify({
      accountId:aliasAccount,address:aliasAddress.trim(),pattern:aliasPattern.trim()||null,
      persona:aliasPersona.trim()||null,tone:aliasTone,defaultLanguage:aliasLanguage,
      signatureId:aliasSignature||null,notificationPriority:'normal',aiMode:'inherit'
    })});
    setAliasAddress('');setAliasPattern('');setAliasPersona('');
  });

  const saveRoutingRule=()=>action(async()=>{
    if(!routeName.trim())throw new Error('Routing rule name is required.');
    let conditions:any,actions:any;
    try{conditions=JSON.parse(routeConditions);actions=JSON.parse(routeActions);}catch{throw new Error('Routing conditions/actions must be valid JSON.');}
    await api('/api/routing-rules',{method:'POST',body:JSON.stringify({
      name:routeName.trim(),priority:100,conditions,actions,stopProcessing:false
    })});
    setRouteName('');
  });

  const saveSignature=()=>action(async()=>{
    if(!signatureName.trim())throw new Error('Signature name is required.');
    await api('/api/signatures',{method:'POST',body:JSON.stringify({name:signatureName.trim(),textBody:signatureBody})});
    setSignatureName('');setSignatureBody('');
  });

  const saveTemplate=()=>action(async()=>{
    if(!templateName.trim())throw new Error('Template name is required.');
    await api('/api/templates',{method:'POST',body:JSON.stringify({
      name:templateName.trim(),subject:templateSubject,textBody:templateBody,language:templateLanguage||null
    })});
    setTemplateName('');setTemplateSubject('');setTemplateBody('');setTemplateLanguage('');
  });

  return <div className="settingsBackdrop" onMouseDown={e => {
    if (e.target === e.currentTarget) onClose();
  }}>
    <section className="settingsPanel">
      <header className="settingsHeader">
        <div>
          <h2>GIBP Mail Settings</h2>
          <p>{native ? 'Phone-primary mailbox controller' : 'Desktop replica / local client'}</p>
        </div>
        <button onClick={onClose} aria-label="Close settings"><MailIcon name="close" size={21}/></button>
      </header>

      {!native && <div className="settingsNotice">
        Multi-account, AI and phone→PC replica controls are configured in the Android app. This desktop build remains a local mailbox/replica.
      </div>}

      {native && <>
        <div className="settingsGrid">
          <section className="settingsCard">
            <h3><MailIcon name="mail" size={18}/>Resend accounts</h3>
            <p>Add as many Resend accounts/teams as you need. The key is validated before it is retained in the encrypted phone database.</p>
            <input className={inputClass} value={accountName} onChange={e=>setAccountName(e.target.value)} placeholder="Account / company name"/>
            <input className={inputClass} type="password" value={accountKey} onChange={e=>setAccountKey(e.target.value)} placeholder="re_…"/>
            <button className="settingsPrimary" disabled={busy} onClick={()=>void addAccount()}>Add Resend account</button>
            <div className="settingsList">
              {accounts.map(a => <article key={a.id}>
                <div><b>{a.name}</b><small>{a.verified_domains} verified domain{a.verified_domains===1?'':'s'}</small></div>
                <span className={a.last_error ? 'pill warn' : 'pill ok'}>{a.last_error ? 'Check' : 'Connected'}</span>
              </article>)}
              {!accounts.length && <em>No Resend accounts connected yet.</em>}
            </div>
          </section>

          <section className="settingsCard">
            <h3><MailIcon name="check" size={18}/>AI gateway</h3>
            <p>The OpenAI key stays in the stateless gateway, never in the APK. Mail remains stored on this device.</p>
            <input className={inputClass} value={aiUrl} onChange={e=>setAiUrl(e.target.value)} placeholder="https://gibp-mail-ai-gateway.…workers.dev"/>
            <input className={inputClass} type="password" value={aiToken} onChange={e=>setAiToken(e.target.value)} placeholder="Gateway bearer token"/>
            <button className="settingsPrimary" disabled={busy} onClick={()=>void saveAi()}>Save AI gateway</button>
            {rules.map(rule => <div className="ruleRow" key={rule.id}>
              <div><b>{rule.name}</b><small>Auto-send is blocked for sensitive categories.</small></div>
              <select value={rule.enabled ? rule.mode : 'off'} onChange={e=>void updateRule(rule,e.target.value as Rule['mode'])}>
                <option value="off">Off</option>
                <option value="draft">Draft only</option>
                <option value="auto_safe">Auto-send safe categories</option>
              </select>
            </div>)}
          </section>

          <section className="settingsCard settingsWide">
            <h3><MailIcon name="sparkles" size={18}/>Alias & identity intelligence</h3>
            <p>Exact addresses and wildcard families inherit persona, tone, language and signature. New verified-domain aliases are registered locally on first use.</p>
            <div className="miniForm">
              <select className={inputClass} value={aliasAccount} onChange={e=>setAliasAccount(e.target.value)}>
                <option value="">Resend account</option>{accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <input className={inputClass} value={aliasAddress} onChange={e=>setAliasAddress(e.target.value)} placeholder="banking@gibp.global"/>
              <input className={inputClass} value={aliasPattern} onChange={e=>setAliasPattern(e.target.value)} placeholder="Optional family pattern: bank-*"/>
              <input className={inputClass} value={aliasPersona} onChange={e=>setAliasPersona(e.target.value)} placeholder="Persona: Banking / Partnerships / Support"/>
              <select className={inputClass} value={aliasTone} onChange={e=>setAliasTone(e.target.value)}>
                <option value="professional">Professional</option><option value="formal">Formal</option><option value="friendly">Friendly</option>
                <option value="banking">Banking</option><option value="partnership">Partnership</option><option value="support">Support</option><option value="sales">Sales</option>
              </select>
              <select className={inputClass} value={aliasLanguage} onChange={e=>setAliasLanguage(e.target.value)}>
                <option value="auto">Auto language</option><option>English</option><option>Nepali</option><option>Hindi</option><option>French</option><option>German</option><option>Spanish</option><option>Arabic</option><option>Chinese</option>
              </select>
              <select className={inputClass} value={aliasSignature} onChange={e=>setAliasSignature(e.target.value)}>
                <option value="">No signature</option>{signatures.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <button className="settingsPrimary" disabled={busy} onClick={()=>void saveAlias()}>Save alias / family</button>
            </div>
            <div className="settingsList">
              {aliases.slice(0,20).map(a=><article key={a.id}>
                <div><b>{a.address}</b><small>{a.pattern?`inherits ${a.pattern} • `:''}{a.persona||'Default persona'} • {a.default_language||'auto'}{a.is_dynamic?' • auto-registered':''}</small></div>
                <span className="pill ok">{a.ai_mode||'inherit'}</span>
              </article>)}
              {!aliases.length&&<em>Aliases will also appear automatically when mail is received or a new verified-domain sender is used.</em>}
            </div>
          </section>

          <section className="settingsCard">
            <h3><MailIcon name="priority" size={18}/>Rules before AI</h3>
            <p>Conditions run deterministically before AI classification. Use JSON so multiple conditions/actions stay explicit and auditable.</p>
            <input className={inputClass} value={routeName} onChange={e=>setRouteName(e.target.value)} placeholder="Banking is always high priority"/>
            <textarea className={inputClass} value={routeConditions} onChange={e=>setRouteConditions(e.target.value)} aria-label="Rule conditions JSON"/>
            <textarea className={inputClass} value={routeActions} onChange={e=>setRouteActions(e.target.value)} aria-label="Rule actions JSON"/>
            <button className="settingsPrimary" disabled={busy} onClick={()=>void saveRoutingRule()}>Add routing rule</button>
            <div className="settingsList">{routingRules.slice(0,12).map(r=><article key={r.id}><div><b>{r.name}</b><small className="ruleSummary">{r.conditions_json} → {r.actions_json}</small></div><span className={r.enabled?'pill ok':'pill warn'}>{r.enabled?'On':'Off'}</span></article>)}</div>
          </section>

          <section className="settingsCard">
            <h3><MailIcon name="draft" size={18}/>Signatures & templates</h3>
            <p>Signatures are applied server-side once, so retries cannot duplicate them. Templates can be selected directly in Compose.</p>
            <div className="intelligenceSettingsGrid">
              <input className={inputClass} value={signatureName} onChange={e=>setSignatureName(e.target.value)} placeholder="Signature name"/>
              <textarea className={inputClass} value={signatureBody} onChange={e=>setSignatureBody(e.target.value)} placeholder={"Martin Raeburn\nGIBP"}/>
              <button className="settingsPrimary" disabled={busy} onClick={()=>void saveSignature()}>Save signature</button>
              <input className={inputClass} value={templateName} onChange={e=>setTemplateName(e.target.value)} placeholder="Template name"/>
              <input className={inputClass} value={templateSubject} onChange={e=>setTemplateSubject(e.target.value)} placeholder="Subject"/>
              <textarea className={inputClass} value={templateBody} onChange={e=>setTemplateBody(e.target.value)} placeholder="Reusable message body"/>
              <input className={inputClass} value={templateLanguage} onChange={e=>setTemplateLanguage(e.target.value)} placeholder="Optional language"/>
              <button className="settingsPrimary" disabled={busy} onClick={()=>void saveTemplate()}>Save template</button>
            </div>
            <div className="settingsList">
              {signatures.map(s=><article key={s.id}><div><b>{s.name}</b><small>{String(s.text_body||'').split('\n')[0]}</small></div><span className="pill ok">Signature</span></article>)}
              {templates.map(t=><article key={t.id}><div><b>{t.name}</b><small>{t.subject||'No subject'}{t.language?` • ${t.language}`:''}</small></div><span className="pill ok">Template</span></article>)}
            </div>
          </section>

          <section className="settingsCard">
            <h3><MailIcon name="sync" size={18}/>PC replica</h3>
            <p>The phone is authoritative. When your PC is reachable, changed revisions and local attachments are pushed to it over HTTPS.</p>
            <input className={inputClass} value={replicaName} onChange={e=>setReplicaName(e.target.value)} placeholder="Garuda PC"/>
            <input className={inputClass} value={replicaUrl} onChange={e=>setReplicaUrl(e.target.value)} placeholder="https://your-pc-private-address"/>
            <input className={inputClass} type="password" value={replicaToken} onChange={e=>setReplicaToken(e.target.value)} placeholder="Replica bearer token"/>
            <button className="settingsPrimary" disabled={busy} onClick={()=>void addReplica()}>Add replica</button>
            <div className="settingsList">
              {replicas.map(r => <article key={r.id}>
                <div><b>{r.name}</b><small>Revision {r.last_revision}{r.last_sync_at ? ` • ${new Date(r.last_sync_at).toLocaleString()}` : ''}</small></div>
                <button onClick={()=>void action(async()=>{await api(`/api/replicas/${r.id}/push`,{method:'POST'});})}>Sync now</button>
              </article>)}
              {!replicas.length && <em>No replica configured.</em>}
            </div>
          </section>

          <section className="settingsCard settingsWide">
            <h3><MailIcon name="send" size={18}/>Business development campaigns</h3>
            <p>Campaigns are local, suppression-aware and capped at 25 new sends per hour. A reply or unsubscribe stops that contact automatically.</p>
            <div className="settingsTwo">
              <input className={inputClass} value={campaignName} onChange={e=>setCampaignName(e.target.value)} placeholder="Campaign name"/>
              <input className={inputClass} value={campaignFrom} onChange={e=>setCampaignFrom(e.target.value)} placeholder="purpose@verified-domain"/>
            </div>
            <textarea className={inputClass} value={campaignObjective} onChange={e=>setCampaignObjective(e.target.value)} placeholder="Objective, offer and factual context the AI may use"/>
            <textarea className={inputClass} value={campaignContacts} onChange={e=>setCampaignContacts(e.target.value)} placeholder={"One contact per line:\nemail,name,company,context"}/>
            <button className="settingsPrimary" disabled={busy} onClick={()=>void createCampaign()}>Create campaign</button>
            <div className="settingsList">
              {campaigns.map(c => <article key={c.id}>
                <div><b>{c.name}</b><small>{c.from_address} • {c.status} • max {c.max_per_hour}/hour</small></div>
                <div className="settingsActions">
                  {c.status!=='active' && <button onClick={()=>void action(async()=>{await api(`/api/campaigns/${c.id}/start`,{method:'POST'});})}>Start</button>}
                  <button onClick={()=>void action(async()=>{await api(`/api/campaigns/${c.id}/run`,{method:'POST'});})}>Run one</button>
                </div>
              </article>)}
              {!campaigns.length && <em>No campaigns yet.</em>}
            </div>
          </section>
        </div>
      </>}
    </section>
  </div>;
}
