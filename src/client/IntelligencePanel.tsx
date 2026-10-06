import { useEffect, useState } from 'react';
import { mailApi as api } from './mailApi.js';
import { MailIcon } from './MailIcon.js';

type Props={onClose:()=>void;onOpenThread:(threadId:string)=>void;onError:(message:string)=>void};

export function IntelligencePanel({onClose,onOpenThread,onError}:Props){
  const [query,setQuery]=useState('');
  const [results,setResults]=useState<any[]>([]);
  const [briefing,setBriefing]=useState<any>(null);
  const [busy,setBusy]=useState(false);

  const loadBriefing=async()=>{
    setBusy(true);
    try{setBriefing(await api<any>('/api/intelligence/briefing'));}catch(e){onError(e instanceof Error?e.message:String(e));}
    finally{setBusy(false);}
  };
  const search=async()=>{
    if(!query.trim())return;
    setBusy(true);
    try{setResults(await api<any[]>('/api/intelligence/search',{method:'POST',body:JSON.stringify({query:query.trim()})}));}
    catch(e){onError(e instanceof Error?e.message:String(e));}
    finally{setBusy(false);}
  };
  useEffect(()=>{void loadBriefing();},[]);

  return <div className="assistantBackdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}>
    <section className="assistantPanel">
      <header>
        <div><span className="assistantMark"><MailIcon name="sparkles" size={20}/></span><div><h2>GIBP Intelligence</h2><p>Priority briefing & natural-language mail search</p></div></div>
        <button onClick={onClose} aria-label="Close"><MailIcon name="close"/></button>
      </header>
      <div className="assistantSearch">
        <MailIcon name="search" size={20}/>
        <input value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')void search();}} placeholder="e.g. emails from Nepalese banks I haven't replied to"/>
        <button disabled={busy||!query.trim()} onClick={()=>void search()}>Ask</button>
      </div>
      {!!results.length&&<section className="assistantSection">
        <h3>Search results</h3>
        <div className="assistantResults">{results.map((r,i)=><button key={`${r.threadId}-${i}`} onClick={()=>onOpenThread(String(r.threadId))}>
          <span><b>{r.reason||'Relevant conversation'}</b><small>{Math.round(Number(r.score||0)*100)}% match</small></span><MailIcon name="back" size={18} className="resultArrow"/>
        </button>)}</div>
      </section>}
      <section className="assistantSection">
        <div className="assistantSectionTitle"><h3>{briefing?.title||'What needs your attention'}</h3><button onClick={()=>void loadBriefing()} disabled={busy}><MailIcon name="sync" size={17}/></button></div>
        {briefing?.summary&&<p className="briefingSummary">{briefing.summary}</p>}
        <div className="assistantResults">
          {(briefing?.priorities||briefing?.items||[]).slice(0,20).map((item:any,i:number)=>{
            const id=item.threadId||item.thread_id;
            return <button key={`${id||i}-brief`} onClick={()=>id&&onOpenThread(String(id))}>
              <span><b>{item.headline||item.subject||item.summary||'Priority conversation'}</b><small>{item.reason||item.why_it_matters||item.from_address||''}</small></span>
              <em className={`briefingUrgency ${item.urgency||item.priority||'normal'}`}>{item.urgency||item.priority||'review'}</em>
            </button>;
          })}
          {!busy&&!briefing?.priorities?.length&&!briefing?.items?.length&&<div className="assistantEmpty">Nothing urgent is waiting for you.</div>}
        </div>
      </section>
      {!!briefing?.reminders?.length&&<section className="assistantSection"><h3>Reminders</h3><div className="assistantResults">
        {briefing.reminders.slice(0,20).map((r:any)=><div className="reminderRow" key={r.id}><MailIcon name="clock" size={17}/><span><b>{r.label||r.note||r.kind}</b><small>{new Date(r.due_at).toLocaleString()}</small></span></div>)}
      </div></section>}
    </section>
  </div>;
}
