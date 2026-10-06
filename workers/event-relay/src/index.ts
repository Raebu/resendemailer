export interface Env {
  RESEND_WEBHOOK_SECRET: string;
  GIBP_EVENT_TOKEN: string;
  PUSH_TARGET_URL?: string;
  PUSH_TARGET_TOKEN?: string;
  EVENTS?: KVNamespace;
}

type MinimalEvent={
  id:string;
  type:string;
  email_id:string|null;
  recipient:string|null;
  created_at:string;
};

function base64Bytes(value:string):Uint8Array{
  const raw=atob(value.replace(/-/g,'+').replace(/_/g,'/'));
  return Uint8Array.from(raw,c=>c.charCodeAt(0));
}
function equalBytes(a:Uint8Array,b:Uint8Array):boolean{
  if(a.length!==b.length)return false;
  let out=0;for(let i=0;i<a.length;i++)out|=a[i]^b[i];return out===0;
}
async function verifyWebhook(request:Request,raw:string,secret:string):Promise<boolean>{
  const id=request.headers.get('svix-id');
  const ts=request.headers.get('svix-timestamp');
  const sig=request.headers.get('svix-signature');
  if(!id||!ts||!sig||!secret)return false;
  const seconds=Number(ts);
  if(!Number.isFinite(seconds)||Math.abs(Date.now()/1000-seconds)>300)return false;
  const keyRaw=secret.replace(/^whsec_/,'');
  let key:Uint8Array;try{key=base64Bytes(keyRaw);}catch{return false;}
  const cryptoKey=await crypto.subtle.importKey('raw',key,{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signed=new TextEncoder().encode(`${id}.${ts}.${raw}`);
  const digest=new Uint8Array(await crypto.subtle.sign('HMAC',cryptoKey,signed));
  for(const part of sig.split(' ')){
    const [version,value]=part.split(',');
    if(version!=='v1'||!value)continue;
    try{if(equalBytes(digest,base64Bytes(value)))return true;}catch{}
  }
  return false;
}
function auth(request:Request,env:Env):boolean{
  return Boolean(env.GIBP_EVENT_TOKEN&&request.headers.get('authorization')===`Bearer ${env.GIBP_EVENT_TOKEN}`);
}
function minimal(payload:any,request:Request):MinimalEvent{
  const data=payload?.data||{};
  const to=Array.isArray(data.to)?data.to[0]:data.to;
  return{
    id:request.headers.get('svix-id')||String(payload?.id||crypto.randomUUID()),
    type:String(payload?.type||'unknown'),
    email_id:data.email_id?String(data.email_id):(data.id?String(data.id):null),
    recipient:to?String(to).toLowerCase():null,
    created_at:String(payload?.created_at||new Date().toISOString()),
  };
}

export default {
  async fetch(request:Request,env:Env):Promise<Response>{
    const url=new URL(request.url);
    if(request.method==='POST'&&url.pathname==='/resend'){
      const raw=await request.text();
      if(!await verifyWebhook(request,raw,env.RESEND_WEBHOOK_SECRET))return Response.json({error:'Invalid webhook signature'},{status:401});
      let payload:any;try{payload=JSON.parse(raw);}catch{return Response.json({error:'Invalid JSON'},{status:400});}
      const event=minimal(payload,request);
      if(env.EVENTS){
        const key=`${Date.parse(event.created_at)||Date.now()}:${event.id}`;
        await env.EVENTS.put(key,JSON.stringify(event),{expirationTtl:604800});
      }
      if(env.PUSH_TARGET_URL){
        try{
          await fetch(env.PUSH_TARGET_URL,{
            method:'POST',
            headers:{'Content-Type':'application/json',...(env.PUSH_TARGET_TOKEN?{Authorization:`Bearer ${env.PUSH_TARGET_TOKEN}`}:{})},
            body:JSON.stringify({type:event.type,email_id:event.email_id,event_id:event.id}),
          });
        }catch{}
      }
      return Response.json({ok:true});
    }

    if(request.method==='GET'&&url.pathname==='/events'){
      if(!auth(request,env))return Response.json({error:'Unauthorized'},{status:401});
      if(!env.EVENTS)return Response.json({error:'Event queue not configured'},{status:501});
      const after=url.searchParams.get('after')||'';
      const listed=await env.EVENTS.list({limit:100});
      const events:MinimalEvent[]=[];
      for(const key of listed.keys.sort((a,b)=>a.name.localeCompare(b.name))){
        if(after&&key.name<=after)continue;
        const value=await env.EVENTS.get<MinimalEvent>(key.name,'json');
        if(value)events.push({...value,id:value.id});
      }
      const cursor=listed.keys.length?listed.keys.sort((a,b)=>a.name.localeCompare(b.name)).at(-1)!.name:after;
      return Response.json({events,cursor},{headers:{'Cache-Control':'no-store'}});
    }

    if(request.method==='GET'&&url.pathname==='/health')return Response.json({ok:true,queue:Boolean(env.EVENTS),push:Boolean(env.PUSH_TARGET_URL)});
    return Response.json({error:'Not found'},{status:404});
  },
};
