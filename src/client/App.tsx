import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Folder, Identity, MessageDetail, MessageSummary, Status, ThreadDetail } from '../shared/types.js';
import { mailApi as api, openAttachment } from './mailApi.js';
import { MailIcon, type MailIconName } from './MailIcon.js';
import { SettingsPanel } from './SettingsPanel.js';

type Draft = {
  id:string; replyToMessageId:string|null; fromIdentity:string; to:string[]; cc:string[]; bcc:string[];
  subject:string; textBody:string; updatedAt:string;
};
type ComposeState = {
  id?:string; replyToMessageId?:string|null; from:string; to:string; cc:string; bcc:string;
  subject:string; text:string; attachments:File[];
};

const folders: {id:Folder; label:string; icon:MailIconName}[] = [
  {id:'inbox',label:'Inbox',icon:'inbox'},
  {id:'starred',label:'Starred',icon:'star'},
  {id:'sent',label:'Sent',icon:'send'},
  {id:'drafts',label:'Drafts',icon:'draft'},
  {id:'outbox',label:'Outbox',icon:'clock'},
  {id:'archive',label:'Archive',icon:'archive'},
  {id:'trash',label:'Trash',icon:'trash'},
];

const csv = (value:string) => value.split(',').map(v=>v.trim()).filter(Boolean);
const niceDate = (value:string|null|undefined) => {
  if (!value) return '';
  const d = new Date(value);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})
    : d.toLocaleDateString([], {day:'numeric',month:'short'});
};
const initials = (name:string) => name.split(/[ @._-]+/).filter(Boolean).slice(0,2).map(x=>x[0]?.toUpperCase()).join('') || '?';

function App() {
  const [folder,setFolder] = useState<Folder>('inbox');
  const [messages,setMessages] = useState<MessageSummary[]>([]);
  const [drafts,setDrafts] = useState<Draft[]>([]);
  const [thread,setThread] = useState<ThreadDetail|null>(null);
  const [query,setQuery] = useState('');
  const [status,setStatus] = useState<Status|null>(null);
  const [identities,setIdentities] = useState<Identity[]>([]);
  const [compose,setCompose] = useState<ComposeState|null>(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState<string|null>(null);
  const [settingsOpen,setSettingsOpen] = useState(false);
  const [mobileFoldersOpen,setMobileFoldersOpen] = useState(false);
  const [mobileSearchOpen,setMobileSearchOpen] = useState(false);
  const draftTimer = useRef<number|null>(null);
  const mobileSearchRef = useRef<HTMLInputElement|null>(null);

  const refreshStatus = useCallback(async()=>setStatus(await api<Status>('/api/status')),[]);
  const loadList = useCallback(async()=>{
    try {
      setError(null);
      if (folder === 'drafts') {
        const rows=await api<Draft[]>('/api/drafts'); setDrafts(rows); setMessages([]); return;
      }
      const q=query.trim()? `&q=${encodeURIComponent(query.trim())}`:'';
      setMessages(await api<MessageSummary[]>(`/api/messages?folder=${folder}${q}`));
      setDrafts([]);
    } catch(e) { setError(e instanceof Error?e.message:String(e)); }
  },[folder,query]);

  useEffect(()=>{ void Promise.all([api<Identity[]>('/api/identities').then(setIdentities),refreshStatus()]); },[refreshStatus]);
  useEffect(()=>{ const t=window.setTimeout(()=>void loadList(),180); return()=>clearTimeout(t); },[loadList]);
  useEffect(()=>{
    const t=window.setInterval(()=>{void refreshStatus(); void loadList();},15_000);
    return()=>clearInterval(t);
  },[loadList,refreshStatus]);
  useEffect(()=>{
    if (!mobileSearchOpen) return;
    const t=window.setTimeout(()=>mobileSearchRef.current?.focus(),80);
    return()=>window.clearTimeout(t);
  },[mobileSearchOpen]);

  const selectFolder=(id:Folder)=>{
    setFolder(id);
    setThread(null);
    setMobileFoldersOpen(false);
  };
  const openThread=async (m:MessageSummary)=>{
    const value=await api<ThreadDetail>(`/api/threads/${m.threadId}`);
    setThread(value); void loadList();
  };
  const patch=async(id:string,body:Record<string,unknown>)=>{
    await api(`/api/messages/${id}`,{method:'PATCH',body:JSON.stringify(body)});
    if (thread && (body.trash || body.isArchived)) setThread(null);
    await loadList();
  };
  const runSync=async()=>{
    setBusy(true); setError(null);
    try { await api('/api/sync',{method:'POST'}); await Promise.all([loadList(),refreshStatus()]); }
    catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{setBusy(false);}
  };

  const defaultIdentity=identities[0]?.address || '';
  const newCompose=()=>setCompose({from:defaultIdentity,to:'',cc:'',bcc:'',subject:'',text:'',attachments:[]});
  const reply=(m:MessageDetail)=>{
    const to=m.direction==='inbound'?m.fromAddress:(m.toAddresses[0]||'');
    const verifiedDomains=new Set(identities.map(i=>i.address.split('@')[1]?.toLowerCase()).filter(Boolean));
    const ownAddress=(m.direction==='inbound'
      ? m.toAddresses.find(address=>verifiedDomains.has(address.split('@')[1]?.toLowerCase()))
      : (verifiedDomains.has(m.fromAddress.split('@')[1]?.toLowerCase())?m.fromAddress:undefined)
    )||defaultIdentity;
    setCompose({
      replyToMessageId:m.id, from:ownAddress, to, cc:'', bcc:'',
      subject:/^re:/i.test(m.subject)?m.subject:`Re: ${m.subject}`, text:'', attachments:[]
    });
  };
  const openDraft=(d:Draft)=>setCompose({
    id:d.id, replyToMessageId:d.replyToMessageId, from:d.fromIdentity, to:d.to.join(', '),
    cc:d.cc.join(', '),bcc:d.bcc.join(', '),subject:d.subject,text:d.textBody,attachments:[]
  });

  const persistDraft=useCallback(async(c:ComposeState)=>{
    if (!c.from) return;
    const out=await api<{id:string}>('/api/drafts',{method:'POST',body:JSON.stringify({
      id:c.id,replyToMessageId:c.replyToMessageId??null,fromIdentity:c.from,
      to:csv(c.to),cc:csv(c.cc),bcc:csv(c.bcc),subject:c.subject,textBody:c.text
    })});
    if (!c.id) setCompose(prev=>prev?{...prev,id:out.id}:prev);
  },[]);

  useEffect(()=>{
    if (!compose) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current=window.setTimeout(()=>void persistDraft(compose),900);
    return()=>{ if(draftTimer.current) clearTimeout(draftTimer.current); };
  },[compose,persistDraft]);

  const send=async()=>{
    if(!compose) return;
    setBusy(true); setError(null);
    try {
      const attachments=await Promise.all(compose.attachments.map(async f=>({
        filename:f.name,contentType:f.type||'application/octet-stream',base64:await fileToBase64(f)
      })));
      const result=await api<{status:string;error?:string}>('/api/send',{method:'POST',body:JSON.stringify({
        draftId:compose.id,from:compose.from,to:csv(compose.to),cc:csv(compose.cc),bcc:csv(compose.bcc),
        subject:compose.subject,text:compose.text,replyToMessageId:compose.replyToMessageId??null,attachments
      })});
      setCompose(null);
      if(result.status==='queued') setError(result.error ? `Queued locally: ${result.error}` : 'Queued locally and will send automatically when online.');
      await Promise.all([loadList(),refreshStatus()]);
    } catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{setBusy(false);}
  };

  const unread=useMemo(()=>messages.filter(m=>!m.isRead).length,[messages]);
  const currentFolder=folders.find(f=>f.id===folder) || folders[0];

  return <div className="app">
    <aside className="sidebar" aria-label="Mailbox navigation">
      <div className="brand">
        <div className="brandMark" aria-hidden="true">G</div>
        <div><strong>GIBP</strong><span>MAIL</span></div>
      </div>
      <button className="composeBtn" onClick={newCompose}>
        <MailIcon name="compose" size={19}/><span>Compose</span>
      </button>
      <nav>{folders.map(f=><button key={f.id} className={folder===f.id?'active':''} onClick={()=>selectFolder(f.id)}>
        <MailIcon name={f.icon} size={19} className="navIcon"/><span>{f.label}</span>
        {f.id==='inbox'&&unread>0&&<b>{unread}</b>}{f.id==='outbox'&&status?.queued ? <b>{status.queued}</b>:null}
      </button>)}</nav>
      <div className="accounts">
        <small>IDENTITIES</small>
        {identities.slice(0,5).map(i=><div className="identity" key={i.address}>
          <span className="identityAvatar">{initials(i.name||i.address)}</span>
          <div><b>{i.name||'GIBP'}</b><em>{i.address}</em></div>
        </div>)}
      </div>
      <div className="syncState">
        <span className={status?.configured?'health good':'health bad'}/>
        <div><b>{status?.configured?'Connected':'Not configured'}</b><small>{status?.lastSyncAt?`Synced ${niceDate(status.lastSyncAt)}`:'Local mailbox'}</small></div>
      </div>
    </aside>

    <main className="mail">
      <header className="desktopToolbar">
        <div className="search">
          <MailIcon name="search" size={19}/>
          <input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search mail" aria-label="Search mail"/>
        </div>
        <button className="iconBtn" onClick={()=>setSettingsOpen(true)} title="Settings" aria-label="Settings"><MailIcon name="settings"/></button>
        <button className="iconBtn" onClick={runSync} disabled={busy} title="Sync now" aria-label="Sync now">
          <MailIcon name="sync" className={busy||status?.syncing?'spin':''}/>
        </button>
      </header>

      {!thread&&<header className="mobileTopbar">
        <button className="mobileBrandButton" onClick={()=>setMobileFoldersOpen(true)} aria-label="Open folders">
          <span className="brandMark mobileBrandMark">G</span>
        </button>
        <div className="mobileTitle">
          <strong>{currentFolder.label}</strong>
          <span>{status?.lastSyncAt?`Synced ${niceDate(status.lastSyncAt)}`:'GIBP Mail'}</span>
        </div>
        <div className="mobileTopActions">
          <button className="mobileIconButton" onClick={()=>setMobileSearchOpen(v=>!v)} aria-label="Search">
            <MailIcon name={mobileSearchOpen?'close':'search'} size={22}/>
          </button>
          <button className="mobileIconButton" onClick={()=>void runSync()} disabled={busy} aria-label="Sync now">
            <MailIcon name="sync" size={21} className={busy||status?.syncing?'spin':''}/>
          </button>
        </div>
      </header>}

      {!thread&&mobileSearchOpen&&<div className="mobileSearchBar">
        <MailIcon name="search" size={20}/>
        <input
          ref={mobileSearchRef}
          value={query}
          onChange={e=>setQuery(e.target.value)}
          placeholder="Search mail"
          aria-label="Search mail"
        />
        {query&&<button onClick={()=>setQuery('')} aria-label="Clear search"><MailIcon name="close" size={18}/></button>}
      </div>}

      {error&&<div className="notice"><span>{error}</span><button onClick={()=>setError(null)} aria-label="Dismiss"><MailIcon name="close" size={18}/></button></div>}

      <div className="content">
        <section className={`listPane ${thread?'withThread':''}`}>
          <div className="listTitle">
            <div>
              <h1>{currentFolder.label}</h1>
              <span>{folder==='drafts'?drafts.length:messages.length} {folder==='drafts'?'drafts':'conversations'}</span>
            </div>
          </div>

          {folder==='drafts' ? <div className="messageList">
            {drafts.map(d=><button className="messageRow draftRow" key={d.id} onClick={()=>openDraft(d)}>
              <div className="avatar draft"><MailIcon name="draft" size={19}/></div>
              <div className="msgMain">
                <div className="msgTop"><b>Draft</b><time>{niceDate(d.updatedAt)}</time></div>
                <strong>{d.subject||'(no subject)'}</strong>
                <p>{d.textBody||'Empty draft'}</p>
              </div>
            </button>)}
            {!drafts.length&&<Empty label="No drafts"/>}
          </div> : <div className="messageList">
            {messages.map(m=><article
              className={`messageRow ${!m.isRead?'unread':''} ${thread?.id===m.threadId?'selected':''}`}
              key={m.id}
              onClick={()=>void openThread(m)}
              onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();void openThread(m);}}}
              role="button"
              tabIndex={0}
            >
              <div className="avatar">{initials(m.fromName||m.fromAddress)}</div>
              <div className="msgMain">
                <div className="msgTop">
                  <b>{m.direction==='outbound'?`To: ${m.toAddresses[0]||''}`:(m.fromName||m.fromAddress)}</b>
                  <time>{niceDate(m.receivedAt||m.sentAt||m.createdAt)}</time>
                </div>
                <strong>{m.subject||'(no subject)'} {m.threadCount>1&&<i>{m.threadCount}</i>}</strong>
                <p>{m.preview||'No preview'}</p>
                <div className="rowMeta">
                  {m.attachmentCount>0&&<span><MailIcon name="attach" size={14}/>{m.attachmentCount}</span>}
                  {m.status==='queued'&&<span className="queued">Queued</span>}
                </div>
              </div>
              <button
                className={`starButton ${m.isStarred?'on':''}`}
                onClick={e=>{e.stopPropagation();void patch(m.id,{isStarred:!m.isStarred});}}
                aria-label={m.isStarred?'Remove star':'Add star'}
              ><MailIcon name="star" size={20}/></button>
            </article>)}
            {!messages.length&&<Empty label={query?'No matching mail':'Nothing here yet'}/>}
          </div>}
        </section>

        {thread&&<section className="threadPane">
          <div className="threadHeader">
            <div className="threadHeaderTitle">
              <button className="backBtn" onClick={()=>setThread(null)} aria-label="Back to inbox"><MailIcon name="back"/></button>
              <h2>{thread.subject||'(no subject)'}</h2>
            </div>
            <div className="threadActions">
              <button title="Archive" aria-label="Archive" onClick={()=>void patch(thread.messages.at(-1)!.id,{isArchived:true})}><MailIcon name="archive" size={20}/></button>
              <button title="Trash" aria-label="Move to trash" onClick={()=>void patch(thread.messages.at(-1)!.id,{trash:true})}><MailIcon name="trash" size={20}/></button>
            </div>
          </div>
          <div className="threadMessages">{thread.messages.map(m=><article className="emailCard" key={m.id}>
            <div className="emailMeta">
              <div className="avatar">{initials(m.fromName||m.fromAddress)}</div>
              <div className="sender">
                <b>{m.fromName||m.fromAddress}</b>
                <span>&lt;{m.fromAddress}&gt;</span>
                <small>to {m.toAddresses.join(', ')}</small>
              </div>
              <time>{new Date(m.createdAt).toLocaleString([], {dateStyle:'medium',timeStyle:'short'})}</time>
            </div>
            {m.htmlBody ? <iframe title={m.subject} sandbox="" srcDoc={m.htmlBody}/> : <div className="plainBody">{m.textBody||'(empty message)'}</div>}
            {!!m.attachments.length&&<div className="attachments">{m.attachments.map(a=><button className="attachmentButton" key={a.id} onClick={()=>void openAttachment(a.id)}>
              <span className="attachmentIcon"><MailIcon name="attach" size={19}/></span>
              <div><b>{a.filename}</b><small>{a.sizeBytes?formatBytes(a.sizeBytes):a.contentType}</small></div>
            </button>)}</div>}
            <div className="emailActions"><button onClick={()=>reply(m)}><MailIcon name="reply" size={18}/>Reply</button></div>
          </article>)}</div>
        </section>}
      </div>
    </main>

    {!thread&&<nav className="mobileBottomNav" aria-label="Primary navigation">
      <MobileNavButton active={folder==='inbox'} icon="inbox" label="Inbox" onClick={()=>selectFolder('inbox')} badge={unread||undefined}/>
      <MobileNavButton active={folder==='starred'} icon="star" label="Starred" onClick={()=>selectFolder('starred')}/>
      <button className="mobileComposeButton" onClick={newCompose} aria-label="Compose">
        <MailIcon name="compose" size={23}/>
      </button>
      <MobileNavButton active={folder==='sent'} icon="send" label="Sent" onClick={()=>selectFolder('sent')}/>
      <MobileNavButton active={mobileFoldersOpen} icon="more" label="More" onClick={()=>setMobileFoldersOpen(true)}/>
    </nav>}

    {mobileFoldersOpen&&<div className="mobileSheetBackdrop" onClick={e=>{if(e.currentTarget===e.target)setMobileFoldersOpen(false);}}>
      <section className="mobileFolderSheet" aria-label="Folders and accounts">
        <div className="sheetHandle"/>
        <div className="sheetHeader">
          <div><strong>GIBP Mail</strong><span>Folders & accounts</span></div>
          <button onClick={()=>setMobileFoldersOpen(false)} aria-label="Close"><MailIcon name="close"/></button>
        </div>
        <div className="sheetFolders">{folders.map(f=><button key={f.id} className={folder===f.id?'active':''} onClick={()=>selectFolder(f.id)}>
          <span className="sheetFolderIcon"><MailIcon name={f.icon} size={21}/></span>
          <span>{f.label}</span>
          {f.id==='inbox'&&unread>0&&<b>{unread}</b>}
          {f.id==='outbox'&&status?.queued ? <b>{status.queued}</b>:null}
        </button>)}</div>
        {!!identities.length&&<div className="sheetIdentities">
          <small>IDENTITIES</small>
          {identities.slice(0,4).map(i=><div key={i.address}>
            <span className="identityAvatar">{initials(i.name||i.address)}</span>
            <p><b>{i.name||'GIBP'}</b><em>{i.address}</em></p>
          </div>)}
        </div>}
        <button className="sheetSettings" onClick={()=>{setMobileFoldersOpen(false);setSettingsOpen(true);}}>
          <MailIcon name="settings" size={20}/><span>Settings</span>
        </button>
        <div className="sheetStatus"><span className={status?.configured?'health good':'health bad'}/>{status?.configured?'Resend connected':'Resend not configured'}</div>
      </section>
    </div>}

    {compose&&<Compose value={compose} identities={identities} busy={busy} onChange={setCompose} onClose={()=>setCompose(null)} onSend={()=>void send()}/>}
    {settingsOpen&&<SettingsPanel onClose={()=>setSettingsOpen(false)} onChanged={()=>void Promise.all([api<Identity[]>('/api/identities').then(setIdentities),refreshStatus(),loadList()])} onError={setError}/>}
  </div>
}

function MobileNavButton({active,icon,label,onClick,badge}:{active:boolean;icon:MailIconName;label:string;onClick:()=>void;badge?:number}){
  return <button className={active?'active':''} onClick={onClick} aria-label={label}>
    <span className="bottomIcon"><MailIcon name={icon} size={22}/>{badge?<b>{badge>99?'99+':badge}</b>:null}</span>
    <small>{label}</small>
  </button>;
}

function Empty({label}:{label:string}) {
  return <div className="empty">
    <div className="emptyIcon"><MailIcon name="mail" size={28}/></div>
    <b>{label}</b>
    <span>Mail is stored privately on this device.</span>
  </div>;
}

function Compose({value,identities,busy,onChange,onClose,onSend}:{value:ComposeState;identities:Identity[];busy:boolean;onChange:(v:ComposeState)=>void;onClose:()=>void;onSend:()=>void}) {
  return <div className="composeBackdrop">
    <section className="compose">
      <div className="composeHead">
        <button className="composeClose" onClick={onClose} aria-label="Close compose"><MailIcon name="close"/></button>
        <b>{value.replyToMessageId?'Reply':'New message'}</b>
        <button className="composeSendTop" disabled={busy||!csv(value.to).length||!value.from} onClick={onSend}>
          {busy?'Sending…':'Send'}<MailIcon name="send" size={18}/>
        </button>
      </div>
      <div className="field"><label>From</label><input list="gibp-from-identities" value={value.from} onChange={e=>onChange({...value,from:e.target.value.trim()})} placeholder="name@verified-domain"/><datalist id="gibp-from-identities">{identities.map(i=><option key={i.address} value={i.address}>{i.formatted}</option>)}</datalist></div>
      <div className="field"><label>To</label><input autoFocus value={value.to} onChange={e=>onChange({...value,to:e.target.value})} placeholder="name@example.com"/></div>
      <details><summary>Cc / Bcc</summary><div className="field"><label>Cc</label><input value={value.cc} onChange={e=>onChange({...value,cc:e.target.value})}/></div><div className="field"><label>Bcc</label><input value={value.bcc} onChange={e=>onChange({...value,bcc:e.target.value})}/></div></details>
      <input className="subject" value={value.subject} onChange={e=>onChange({...value,subject:e.target.value})} placeholder="Subject"/>
      <textarea value={value.text} onChange={e=>onChange({...value,text:e.target.value})} placeholder="Write your message…"/>
      {!!value.attachments.length&&<div className="composeFiles">{value.attachments.map((f,i)=><span key={i}>{f.name}<button onClick={()=>onChange({...value,attachments:value.attachments.filter((_,x)=>x!==i)})} aria-label={`Remove ${f.name}`}><MailIcon name="close" size={15}/></button></span>)}</div>}
      <div className="composeFoot">
        <button className="sendBtn" disabled={busy||!csv(value.to).length||!value.from} onClick={onSend}>{busy?'Sending…':'Send'}<MailIcon name="send" size={17}/></button>
        <label className="attachBtn" aria-label="Attach files"><MailIcon name="attach" size={21}/><input type="file" multiple onChange={e=>onChange({...value,attachments:[...value.attachments,...Array.from(e.target.files||[])]})}/></label>
        <span className="saved"><MailIcon name="check" size={15}/>Saved locally</span>
      </div>
    </section>
  </div>
}

function fileToBase64(file:File):Promise<string>{
  return new Promise((resolve,reject)=>{const r=new FileReader();r.onerror=()=>reject(r.error);r.onload=()=>resolve(String(r.result).split(',')[1]||'');r.readAsDataURL(file);});
}
function formatBytes(n:number){if(n<1024)return n+' B';if(n<1048576)return (n/1024).toFixed(1)+' KB';return (n/1048576).toFixed(1)+' MB';}
export default App;
