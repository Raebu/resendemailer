import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Folder, Identity, MessageDetail, MessageSummary, Status, ThreadDetail } from '../shared/types.js';

type Draft = {
  id:string; replyToMessageId:string|null; fromIdentity:string; to:string[]; cc:string[]; bcc:string[];
  subject:string; textBody:string; updatedAt:string;
};
type ComposeState = {
  id?:string; replyToMessageId?:string|null; from:string; to:string; cc:string; bcc:string;
  subject:string; text:string; attachments:File[];
};

const folders: {id:Folder; label:string; icon:string}[] = [
  {id:'inbox',label:'Inbox',icon:'▣'}, {id:'starred',label:'Starred',icon:'☆'},
  {id:'sent',label:'Sent',icon:'↗'}, {id:'drafts',label:'Drafts',icon:'◫'},
  {id:'outbox',label:'Outbox',icon:'⌛'}, {id:'archive',label:'Archive',icon:'▤'},
  {id:'trash',label:'Trash',icon:'♲'},
];

async function api<T>(url:string, init?:RequestInit):Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {'Content-Type':'application/json', ...(init?.headers||{})},
  });
  const data = await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status})`);
  return data as T;
}
const csv = (value:string) => value.split(',').map(v=>v.trim()).filter(Boolean);
const niceDate = (value:string|null|undefined) => {
  if (!value) return '';
  const d = new Date(value);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})
    : d.toLocaleDateString([], {day:'2-digit',month:'short'});
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
  const draftTimer = useRef<number|null>(null);

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
    setCompose({
      replyToMessageId:m.id, from:defaultIdentity, to, cc:'', bcc:'',
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

  return <div className="app">
    <aside className="sidebar">
      <div className="brand"><div className="brandMark">G</div><div><strong>GIBP</strong><span>MAIL</span></div></div>
      <button className="composeBtn" onClick={newCompose}><span>＋</span> Compose</button>
      <nav>{folders.map(f=><button key={f.id} className={folder===f.id?'active':''} onClick={()=>{setFolder(f.id);setThread(null)}}>
        <span className="navIcon">{f.icon}</span><span>{f.label}</span>
        {f.id==='inbox'&&unread>0&&<b>{unread}</b>}{f.id==='outbox'&&status?.queued ? <b>{status.queued}</b>:null}
      </button>)}</nav>
      <div className="accounts">
        <small>IDENTITIES</small>
        {identities.map(i=><div className="identity" key={i.address}><span className="dot"/><div><b>{i.name||'GIBP'}</b><em>{i.address}</em></div></div>)}
      </div>
      <div className="syncState">
        <span className={status?.configured?'health good':'health bad'}/>
        <div><b>{status?.configured?'Resend connected':'Resend not configured'}</b><small>{status?.lastSyncAt?`Synced ${niceDate(status.lastSyncAt)}`:'Local mailbox'}</small></div>
      </div>
    </aside>

    <main className="mail">
      <header>
        <div className="search"><span>⌕</span><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search mail"/></div>
        <button className="iconBtn" onClick={runSync} disabled={busy} title="Sync now">{busy||status?.syncing?'◌':'↻'}</button>
      </header>
      {error&&<div className="notice">{error}<button onClick={()=>setError(null)}>×</button></div>}
      <div className="content">
        <section className={`listPane ${thread?'withThread':''}`}>
          <div className="listTitle"><div><h1>{folders.find(f=>f.id===folder)?.label}</h1><span>{folder==='drafts'?drafts.length:messages.length} conversations</span></div></div>
          {folder==='drafts' ? <div className="messageList">
            {drafts.map(d=><button className="messageRow" key={d.id} onClick={()=>openDraft(d)}>
              <div className="avatar draft">D</div><div className="msgMain"><div className="msgTop"><b>Draft</b><time>{niceDate(d.updatedAt)}</time></div><strong>{d.subject||'(no subject)'}</strong><p>{d.textBody||'Empty draft'}</p></div>
            </button>)}
            {!drafts.length&&<Empty label="No drafts"/>}
          </div> : <div className="messageList">
            {messages.map(m=><button className={`messageRow ${!m.isRead?'unread':''} ${thread?.id===m.threadId?'selected':''}`} key={m.id} onClick={()=>void openThread(m)}>
              <div className="avatar">{initials(m.fromName||m.fromAddress)}</div>
              <div className="msgMain"><div className="msgTop"><b>{m.direction==='outbound'?'To: '+(m.toAddresses[0]||''):(m.fromName||m.fromAddress)}</b><time>{niceDate(m.receivedAt||m.sentAt||m.createdAt)}</time></div>
                <strong>{m.subject||'(no subject)'} {m.threadCount>1&&<i>{m.threadCount}</i>}</strong><p>{m.preview||'No preview'}</p>
                <div className="rowMeta">{m.attachmentCount>0&&<span>⌕ {m.attachmentCount}</span>}{m.status==='queued'&&<span className="queued">Queued</span>}</div>
              </div>
              <span className={`star ${m.isStarred?'on':''}`} onClick={e=>{e.stopPropagation();void patch(m.id,{isStarred:!m.isStarred})}}>★</span>
            </button>)}
            {!messages.length&&<Empty label={query?'No matching mail':'Nothing here yet'}/>}
          </div>}
        </section>

        {thread&&<section className="threadPane">
          <div className="threadHeader"><div><button className="backBtn" onClick={()=>setThread(null)}>←</button><h2>{thread.subject||'(no subject)'}</h2></div>
            <div className="threadActions">
              <button title="Archive" onClick={()=>void patch(thread.messages.at(-1)!.id,{isArchived:true})}>▤</button>
              <button title="Trash" onClick={()=>void patch(thread.messages.at(-1)!.id,{trash:true})}>♲</button>
            </div>
          </div>
          <div className="threadMessages">{thread.messages.map(m=><article className="emailCard" key={m.id}>
            <div className="emailMeta"><div className="avatar">{initials(m.fromName||m.fromAddress)}</div><div className="sender"><b>{m.fromName||m.fromAddress}</b><span>&lt;{m.fromAddress}&gt;</span><small>to {m.toAddresses.join(', ')}</small></div><time>{new Date(m.createdAt).toLocaleString()}</time></div>
            {m.htmlBody ? <iframe title={m.subject} sandbox="" srcDoc={m.htmlBody}/> : <div className="plainBody">{m.textBody||'(empty message)'}</div>}
            {!!m.attachments.length&&<div className="attachments">{m.attachments.map(a=><a key={a.id} href={`/api/attachments/${a.id}`}><span>▧</span><div><b>{a.filename}</b><small>{a.sizeBytes?formatBytes(a.sizeBytes):a.contentType}</small></div></a>)}</div>}
            <div className="emailActions"><button onClick={()=>reply(m)}>↩ Reply</button></div>
          </article>)}</div>
        </section>}
      </div>
    </main>

    {compose&&<Compose value={compose} identities={identities} busy={busy} onChange={setCompose} onClose={()=>setCompose(null)} onSend={()=>void send()}/>}
  </div>
}

function Empty({label}:{label:string}) { return <div className="empty"><div>✉</div><b>{label}</b><span>GIBP Mail stores your mailbox locally on this computer.</span></div>; }

function Compose({value,identities,busy,onChange,onClose,onSend}:{value:ComposeState;identities:Identity[];busy:boolean;onChange:(v:ComposeState)=>void;onClose:()=>void;onSend:()=>void}) {
  return <div className="compose">
    <div className="composeHead"><b>{value.replyToMessageId?'Reply':'New message'}</b><button onClick={onClose}>×</button></div>
    <div className="field"><label>From</label><select value={value.from} onChange={e=>onChange({...value,from:e.target.value})}>{identities.map(i=><option key={i.address} value={i.address}>{i.formatted}</option>)}</select></div>
    <div className="field"><label>To</label><input autoFocus value={value.to} onChange={e=>onChange({...value,to:e.target.value})} placeholder="name@example.com"/></div>
    <details><summary>Cc / Bcc</summary><div className="field"><label>Cc</label><input value={value.cc} onChange={e=>onChange({...value,cc:e.target.value})}/></div><div className="field"><label>Bcc</label><input value={value.bcc} onChange={e=>onChange({...value,bcc:e.target.value})}/></div></details>
    <input className="subject" value={value.subject} onChange={e=>onChange({...value,subject:e.target.value})} placeholder="Subject"/>
    <textarea value={value.text} onChange={e=>onChange({...value,text:e.target.value})} placeholder="Write your message…"/>
    {!!value.attachments.length&&<div className="composeFiles">{value.attachments.map((f,i)=><span key={i}>{f.name}<button onClick={()=>onChange({...value,attachments:value.attachments.filter((_,x)=>x!==i)})}>×</button></span>)}</div>}
    <div className="composeFoot"><button className="sendBtn" disabled={busy||!csv(value.to).length||!value.from} onClick={onSend}>{busy?'Sending…':'Send'} <span>↗</span></button>
      <label className="attachBtn">⌕<input type="file" multiple onChange={e=>onChange({...value,attachments:[...value.attachments,...Array.from(e.target.files||[])]})}/></label>
      <span className="saved">Saved locally</span>
    </div>
  </div>
}

function fileToBase64(file:File):Promise<string>{
  return new Promise((resolve,reject)=>{const r=new FileReader();r.onerror=()=>reject(r.error);r.onload=()=>resolve(String(r.result).split(',')[1]||'');r.readAsDataURL(file);});
}
function formatBytes(n:number){if(n<1024)return n+' B';if(n<1048576)return (n/1024).toFixed(1)+' KB';return (n/1048576).toFixed(1)+' MB';}
export default App;
