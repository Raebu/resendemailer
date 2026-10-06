import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Folder, Identity, MessageDetail, MessageSummary, Status, ThreadDetail } from '../shared/types.js';
import { mailApi as api, openAttachment } from './mailApi.js';
import { MailIcon, type MailIconName } from './MailIcon.js';
import { SettingsPanel } from './SettingsPanel.js';
import { IntelligencePanel } from './IntelligencePanel.js';

type Draft = {
  id:string; replyToMessageId:string|null; fromIdentity:string; to:string[]; cc:string[]; bcc:string[];
  subject:string; textBody:string; updatedAt:string;
};
type ComposeState = {
  id?:string; replyToMessageId?:string|null; from:string; to:string; cc:string; bcc:string;
  subject:string; text:string; attachments:File[]; language?:string;
};

const folders: {id:Folder; label:string; icon:MailIconName}[] = [
  {id:'inbox',label:'Inbox',icon:'inbox'},
  {id:'needs_me',label:'Needs Me',icon:'priority'},
  {id:'waiting',label:'Waiting',icon:'clock'},
  {id:'snoozed',label:'Snoozed',icon:'snooze'},
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
  const [intelligenceOpen,setIntelligenceOpen] = useState(false);
  const [mobileFoldersOpen,setMobileFoldersOpen] = useState(false);
  const [mobileSearchOpen,setMobileSearchOpen] = useState(false);
  const [translations,setTranslations] = useState<Record<string,{text:string;backTranslation:string}>>({});
  const [attachmentSummaries,setAttachmentSummaries]=useState<Record<string,{summary:string;key_points:string[];actions:string[];risks:string[];language:string}>>({});
  const [pendingUndo,setPendingUndo]=useState<{id:string;until:string}|null>(null);
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
  const openThreadId=async(threadId:string)=>{
    const value=await api<ThreadDetail>(`/api/threads/${threadId}`);
    setIntelligenceOpen(false);setThread(value);void loadList();
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
  const newCompose=()=>setCompose({from:defaultIdentity,to:'',cc:'',bcc:'',subject:'',text:'',attachments:[],language:'English'});
  const reply=(m:MessageDetail)=>{
    const to=m.direction==='inbound'?m.fromAddress:(m.toAddresses[0]||'');
    const verifiedDomains=new Set(identities.map(i=>i.address.split('@')[1]?.toLowerCase()).filter(Boolean));
    const ownAddress=(m.direction==='inbound'
      ? m.toAddresses.find(address=>verifiedDomains.has(address.split('@')[1]?.toLowerCase()))
      : (verifiedDomains.has(m.fromAddress.split('@')[1]?.toLowerCase())?m.fromAddress:undefined)
    )||defaultIdentity;
    setCompose({
      replyToMessageId:m.id, from:ownAddress, to, cc:'', bcc:'',
      subject:/^re:/i.test(m.subject)?m.subject:`Re: ${m.subject}`, text:'', attachments:[], language:(m.language&&m.language!=='unknown')?m.language:'English'
    });
  };
  const openDraft=(d:Draft)=>setCompose({
    id:d.id, replyToMessageId:d.replyToMessageId, from:d.fromIdentity, to:d.to.join(', '),
    cc:d.cc.join(', '),bcc:d.bcc.join(', '),subject:d.subject,text:d.textBody,attachments:[],language:'English'
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

  const send=async(options:{scheduledAt?:string;undoSeconds?:number}={})=>{
    if(!compose) return;
    setBusy(true); setError(null);
    try {
      const attachments=await Promise.all(compose.attachments.map(async f=>({
        filename:f.name,contentType:f.type||'application/octet-stream',base64:await fileToBase64(f)
      })));
      const result=await api<{id?:string;status:string;error?:string;undoUntil?:string;scheduledAt?:string}>('/api/send',{method:'POST',body:JSON.stringify({
        draftId:compose.id,from:compose.from,to:csv(compose.to),cc:csv(compose.cc),bcc:csv(compose.bcc),
        subject:compose.subject,text:compose.text,replyToMessageId:compose.replyToMessageId??null,attachments,
        scheduledAt:options.scheduledAt,undoSeconds:options.undoSeconds||0,
      })});
      setCompose(null);
      if(result.status==='queued') setError(result.error ? `Queued locally: ${result.error}` : 'Queued locally and will send automatically when online.');
      if(result.status==='scheduled'){
        if(options.undoSeconds&&result.id&&result.undoUntil){
          setPendingUndo({id:result.id,until:result.undoUntil});
          const delay=Math.max(250,new Date(result.undoUntil).getTime()-Date.now()+350);
          window.setTimeout(()=>{
            setPendingUndo(prev=>prev?.id===result.id?null:prev);
            void api('/api/sync',{method:'POST'}).catch(()=>undefined);
          },delay);
        }else{
          setError(`Scheduled for ${new Date(result.scheduledAt||options.scheduledAt||'').toLocaleString()}.`);
        }
      }
      await Promise.all([loadList(),refreshStatus()]);
    } catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{setBusy(false);}
  };
  const translateMessage=async(m:MessageDetail)=>{
    const source=m.textBody||m.preview||'';
    if(!source)return;
    setBusy(true);
    try{
      const result=await api<{text:string;back_translation?:string;backTranslation?:string}>('/api/language',{method:'POST',body:JSON.stringify({
        text:source,sourceLanguage:m.language||'auto',targetLanguage:'English',mode:'translate',tone:'professional'
      })});
      setTranslations(prev=>({...prev,[m.id]:{text:result.text,backTranslation:result.back_translation||result.backTranslation||''}}));
    }catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{setBusy(false);}
  };
  const summarizeAttachment=async(id:string)=>{
    setBusy(true);setError(null);
    try{
      const result=await api<{summary:string;key_points:string[];actions:string[];risks:string[];language:string}>(`/api/attachments/${encodeURIComponent(id)}/summary`,{method:'POST'});
      setAttachmentSummaries(prev=>({...prev,[id]:result}));
    }catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{setBusy(false);}
  };
  const snoozeCurrent=async(hours:number)=>{
    const t=thread?.messages.at(-1);if(!t)return;
    await api('/api/snooze',{method:'POST',body:JSON.stringify({threadId:t.threadId,untilAt:new Date(Date.now()+hours*3600000).toISOString()})});
    setThread(null);await loadList();
  };
  const waitCurrent=async(days:number)=>{
    const t=thread?.messages.at(-1);if(!t)return;
    await api('/api/waiting',{method:'POST',body:JSON.stringify({threadId:t.threadId,messageId:t.id,dueAt:new Date(Date.now()+days*86400000).toISOString()})});
    setThread(null);await loadList();
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
        <button className="iconBtn" onClick={()=>setIntelligenceOpen(true)} title="GIBP Intelligence" aria-label="GIBP Intelligence"><MailIcon name="sparkles"/></button>
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
          <button className="mobileIconButton" onClick={()=>setIntelligenceOpen(true)} aria-label="GIBP Intelligence"><MailIcon name="sparkles" size={21}/></button>
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
                  {m.priority&&m.priority!=='normal'&&<span className={`intelBadge priority-${m.priority}`}><MailIcon name="priority" size={12}/>{m.priority}</span>}
                  {m.aliasAddress&&<span className="intelBadge">{m.aliasAddress}</span>}
                  {m.language&&m.language!=='unknown'&&<span className="intelBadge"><MailIcon name="language" size={12}/>{m.language}</span>}
                  {m.needsMe&&<span className="intelBadge needsMe">Needs me</span>}
                  {m.waiting&&<span className="intelBadge waiting">Waiting</span>}
                  {m.attachmentCount>0&&<span><MailIcon name="attach" size={14}/>{m.attachmentCount}</span>}
                  {m.status==='queued'&&<span className="queued">Queued</span>}
                  {m.direction==='outbound'&&['delivered','delayed','bounced','complained','failed'].includes(m.status)&&<span className={`deliveryBadge ${m.status}`}>{m.status}</span>}
                </div>
                {m.whyItMatters&&<p className="whyItMatters">{m.whyItMatters}</p>}
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
              <button title="Snooze 24 hours" aria-label="Snooze 24 hours" onClick={()=>void snoozeCurrent(24)}><MailIcon name="snooze" size={20}/></button>
              <button title="Waiting for reply — remind in 3 days" aria-label="Waiting for reply" onClick={()=>void waitCurrent(3)}><MailIcon name="clock" size={20}/></button>
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
            {(m.whyItMatters||m.priority||m.aliasAddress||m.language)&&<div className="intelligenceStrip">
              <span><MailIcon name="sparkles" size={15}/>{m.whyItMatters||m.intelligenceSummary||m.category||'Message intelligence'}</span>
              <div>
                {m.priority&&m.priority!=='normal'&&<b className={`priority-${m.priority}`}>{m.priority}</b>}
                {m.aliasAddress&&<b>{m.aliasAddress}</b>}
                {m.language&&m.language!=='unknown'&&<b>{m.language}</b>}
              </div>
            </div>}
            {translations[m.id]
              ? <div className="translatedBody"><div className="translationLabel"><MailIcon name="language" size={15}/>English translation</div>{translations[m.id].text}</div>
              : (m.htmlBody ? <iframe title={m.subject} sandbox="" srcDoc={m.htmlBody}/> : <div className="plainBody">{m.textBody||'(empty message)'}</div>)}
            {!!m.attachments.length&&<div className="attachments">{m.attachments.map(a=><div className="attachmentItem" key={a.id}>
              <div className="attachmentActions">
                <button className="attachmentButton" onClick={()=>void openAttachment(a.id)}>
                  <span className="attachmentIcon"><MailIcon name="attach" size={19}/></span>
                  <div><b>{a.filename}</b><small>{a.sizeBytes?formatBytes(a.sizeBytes):a.contentType}</small></div>
                </button>
                <button className="attachmentSummaryButton" disabled={busy} onClick={()=>void summarizeAttachment(a.id)}>
                  <MailIcon name="sparkles" size={15}/>{attachmentSummaries[a.id]?'Refresh summary':'Summarize'}
                </button>
              </div>
              {attachmentSummaries[a.id]&&<div className="attachmentSummary">
                <b>AI attachment summary</b>
                <p>{attachmentSummaries[a.id].summary}</p>
                {!!attachmentSummaries[a.id].key_points?.length&&<ul>{attachmentSummaries[a.id].key_points.map((x,i)=><li key={i}>{x}</li>)}</ul>}
                {!!attachmentSummaries[a.id].actions?.length&&<div><strong>Actions</strong><ul>{attachmentSummaries[a.id].actions.map((x,i)=><li key={i}>{x}</li>)}</ul></div>}
                {!!attachmentSummaries[a.id].risks?.length&&<div><strong>Risks / caveats</strong><ul>{attachmentSummaries[a.id].risks.map((x,i)=><li key={i}>{x}</li>)}</ul></div>}
              </div>}
            </div>)}</div>}
            <div className="emailActions">
              <button onClick={()=>reply(m)}><MailIcon name="reply" size={18}/>Reply</button>
              {m.direction==='inbound'&&m.language&&m.language!=='English'&&m.language!=='unknown'&&
                <button onClick={()=>translations[m.id]?setTranslations(prev=>{const x={...prev};delete x[m.id];return x;}):void translateMessage(m)}>
                  <MailIcon name="language" size={18}/>{translations[m.id]?'Show original':'Translate'}
                </button>}
            </div>
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

    {pendingUndo&&<div className="undoSnackbar"><span>Message will send shortly.</span><button onClick={()=>void (async()=>{await api(`/api/scheduled/${pendingUndo.id}/cancel`,{method:'POST'});setPendingUndo(null);setError('Send cancelled.');await loadList();})()}>Undo</button></div>}
    {intelligenceOpen&&<IntelligencePanel onClose={()=>setIntelligenceOpen(false)} onOpenThread={id=>void openThreadId(id)} onError={message=>setError(message)}/>}
    {compose&&<Compose value={compose} identities={identities} busy={busy} onChange={setCompose} onClose={()=>setCompose(null)} onSend={options=>void send(options)}/>}
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

function Compose({value,identities,busy,onChange,onClose,onSend}:{value:ComposeState;identities:Identity[];busy:boolean;onChange:(v:ComposeState)=>void;onClose:()=>void;onSend:(options?:{scheduledAt?:string;undoSeconds?:number})=>void}) {
  const languages=['English','Nepali','Hindi','French','German','Spanish','Arabic','Chinese','Japanese','Portuguese','Italian','Dutch','Bengali','Urdu','Korean'];
  const [targetLanguage,setTargetLanguage]=useState(value.language||'English');
  const [tone,setTone]=useState('professional');
  const [backTranslation,setBackTranslation]=useState('');
  const [aiBusy,setAiBusy]=useState(false);
  const [scheduleOpen,setScheduleOpen]=useState(false);
  const [scheduledAt,setScheduledAt]=useState('');
  const [undoSeconds,setUndoSeconds]=useState(10);
  const [context,setContext]=useState<any>(null);

  useEffect(()=>{
    if(!value.from)return;
    const t=window.setTimeout(()=>{
      void api<any>('/api/compose/context',{method:'POST',body:JSON.stringify({from:value.from})}).then(setContext).catch(()=>setContext(null));
    },250);
    return()=>window.clearTimeout(t);
  },[value.from]);

  const transform=async(mode:'translate'|'improve'|'bilingual')=>{
    if(!value.text.trim())return;
    setAiBusy(true);
    try{
      const result=await api<{text:string;back_translation?:string;backTranslation?:string}>('/api/language',{method:'POST',body:JSON.stringify({
        text:value.text,sourceLanguage:'auto',targetLanguage,mode,tone
      })});
      onChange({...value,text:result.text,language:targetLanguage});
      setBackTranslation(result.back_translation||result.backTranslation||'');
    }finally{setAiBusy(false);}
  };
  const applyTemplate=(template:any)=>{
    onChange({...value,subject:template.subject||value.subject,text:template.text_body||value.text,language:template.language||value.language});
  };
  const dictate=()=>{
    const Ctor=(window as any).SpeechRecognition||(window as any).webkitSpeechRecognition;
    if(!Ctor)return;
    const recognition=new Ctor();
    recognition.lang='en-GB';
    recognition.interimResults=false;
    recognition.maxAlternatives=1;
    recognition.onresult=(event:any)=>{
      const text=event.results?.[0]?.[0]?.transcript||'';
      if(text)onChange({...value,text:`${value.text}${value.text?' ':''}${text}`});
    };
    recognition.start();
  };
  const speechAvailable=Boolean((window as any).SpeechRecognition||(window as any).webkitSpeechRecognition);

  return <div className="composeBackdrop">
    <section className="compose">
      <div className="composeHead">
        <button className="composeClose" onClick={onClose} aria-label="Close compose"><MailIcon name="close"/></button>
        <b>{value.replyToMessageId?'Reply':'New message'}</b>
        <button className="composeSendTop" disabled={busy||!csv(value.to).length||!value.from} onClick={()=>onSend({undoSeconds})}>
          {busy?'Sending…':'Send'}<MailIcon name="send" size={18}/>
        </button>
      </div>
      {context?.alias&&<div className="personaBar"><MailIcon name="sparkles" size={15}/><span>{context.alias.address}</span>{context.alias.persona&&<b>{context.alias.persona}</b>}{context.alias.tone&&<em>{context.alias.tone}</em>}{context.signature&&<small>Signature: {context.signature.name}</small>}</div>}
      <div className="field"><label>From</label><input list="gibp-from-identities" value={value.from} onChange={e=>onChange({...value,from:e.target.value.trim()})} placeholder="name@verified-domain"/><datalist id="gibp-from-identities">{identities.map(i=><option key={i.address} value={i.address}>{i.formatted}</option>)}</datalist></div>
      <div className="field"><label>To</label><input autoFocus value={value.to} onChange={e=>onChange({...value,to:e.target.value})} placeholder="name@example.com"/></div>
      <details><summary>Cc / Bcc</summary><div className="field"><label>Cc</label><input value={value.cc} onChange={e=>onChange({...value,cc:e.target.value})}/></div><div className="field"><label>Bcc</label><input value={value.bcc} onChange={e=>onChange({...value,bcc:e.target.value})}/></div></details>
      <input className="subject" value={value.subject} onChange={e=>onChange({...value,subject:e.target.value})} placeholder="Subject"/>
      <div className="composeAiBar">
        <select value={targetLanguage} onChange={e=>setTargetLanguage(e.target.value)} aria-label="Target language">
          {languages.map(l=><option key={l}>{l}</option>)}
        </select>
        <select value={tone} onChange={e=>setTone(e.target.value)} aria-label="Tone">
          <option value="professional">Professional</option><option value="formal">Formal</option><option value="friendly">Friendly</option>
          <option value="banking">Banking</option><option value="partnership">Partnership</option><option value="support">Support</option><option value="sales">Sales</option>
        </select>
        <button disabled={aiBusy||!value.text.trim()} onClick={()=>void transform('translate')}><MailIcon name="language" size={16}/>Translate</button>
        <button disabled={aiBusy||!value.text.trim()} onClick={()=>void transform('improve')}><MailIcon name="sparkles" size={16}/>Improve</button>
        <button disabled={aiBusy||!value.text.trim()} onClick={()=>void transform('bilingual')}>Bilingual</button>
        {speechAvailable&&<button onClick={dictate}><MailIcon name="mic" size={16}/>Dictate</button>}
      </div>
      {!!context?.templates?.length&&<div className="templateBar"><span>Templates</span>{context.templates.slice(0,5).map((t:any)=><button key={t.id} onClick={()=>applyTemplate(t)}>{t.name}</button>)}</div>}
      <textarea value={value.text} onChange={e=>{onChange({...value,text:e.target.value});setBackTranslation('');}} placeholder="Write your message…"/>
      {backTranslation&&<div className="backTranslation"><b>English back-translation</b><span>{backTranslation}</span></div>}
      {!!value.attachments.length&&<div className="composeFiles">{value.attachments.map((f,i)=><span key={i}>{f.name}<button onClick={()=>onChange({...value,attachments:value.attachments.filter((_,x)=>x!==i)})} aria-label={`Remove ${f.name}`}><MailIcon name="close" size={15}/></button></span>)}</div>}
      {scheduleOpen&&<div className="scheduleBar">
        <label>Send at <input type="datetime-local" value={scheduledAt} onChange={e=>setScheduledAt(e.target.value)}/></label>
        <label>Undo <select value={undoSeconds} onChange={e=>setUndoSeconds(Number(e.target.value))}><option value={0}>Off</option><option value={5}>5 sec</option><option value={10}>10 sec</option><option value={15}>15 sec</option></select></label>
        <button disabled={!scheduledAt||busy} onClick={()=>onSend({scheduledAt:new Date(scheduledAt).toISOString(),undoSeconds:0})}>Schedule</button>
      </div>}
      <div className="composeFoot">
        <button className="sendBtn" disabled={busy||!csv(value.to).length||!value.from} onClick={()=>onSend({undoSeconds})}>{busy?'Sending…':'Send'}<MailIcon name="send" size={17}/></button>
        <label className="attachBtn" aria-label="Attach files"><MailIcon name="attach" size={21}/><input type="file" multiple onChange={e=>onChange({...value,attachments:[...value.attachments,...Array.from(e.target.files||[])]})}/></label>
        <button className="attachBtn" onClick={()=>setScheduleOpen(v=>!v)} aria-label="Send later"><MailIcon name="clock" size={21}/></button>
        <span className="undoSetting">Undo: {undoSeconds?`${undoSeconds}s`:'off'}</span>
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
