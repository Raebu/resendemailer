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

  const refresh = async () => {
    if (!native) return;
    const [a, r, p, c] = await Promise.all([
      api<Account[]>('/api/accounts'),
      api<Rule[]>('/api/automation/rules'),
      api<Replica[]>('/api/replicas'),
      api<Campaign[]>('/api/campaigns'),
    ]);
    setAccounts(a);
    setRules(r);
    setReplicas(p);
    setCampaigns(c);
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
