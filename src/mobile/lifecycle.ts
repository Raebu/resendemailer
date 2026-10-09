import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { Network } from '@capacitor/network';
import { mailApi } from '../client/mailApi.js';

let started=false;
let timer:number|null=null;
let running=false;
let lastOAuthUrl:string|null=null;

async function sync():Promise<void>{
  if(running)return;
  running=true;
  try{await mailApi('/api/sync',{method:'POST'});}catch{/* offline/errors remain visible in mailbox status */}
  finally{running=false;}
}

async function handleAppUrl(url:string):Promise<void>{
  if(!url.startsWith('global.gibp.mail://oauth/resend')||lastOAuthUrl===url)return;
  lastOAuthUrl=url;
  try{
    await mailApi('/api/accounts/oauth/callback',{
      method:'POST',
      body:JSON.stringify({url}),
    });
    window.dispatchEvent(new CustomEvent('gibp:resend-connected'));
    await sync();
  }catch(error){
    lastOAuthUrl=null; // permit a retry if the callback was received during a transient failure
    const message=error instanceof Error?error.message:String(error);
    window.dispatchEvent(new CustomEvent('gibp:resend-error',{detail:message}));
  }
}

export async function startMobileLifecycle():Promise<void>{
  if(started||!Capacitor.isNativePlatform())return;
  started=true;

  const network=await Network.getStatus();
  if(network.connected)void sync();

  // getLaunchUrl covers a cold-start OAuth callback; appUrlOpen covers callbacks
  // delivered while the process is already alive.
  const launch=await App.getLaunchUrl();
  if(launch?.url)void handleAppUrl(launch.url);

  await App.addListener('appStateChange',state=>{
    if(state.isActive)void sync();
  });
  await App.addListener('appUrlOpen',event=>{
    void handleAppUrl(event.url);
  });
  await Network.addListener('networkStatusChange',state=>{
    if(state.connected)void sync();
  });

  timer=window.setInterval(()=>{
    if(document.visibilityState==='visible')void sync();
  },60_000);
}

export function stopMobileLifecycle():void{
  if(timer!==null)window.clearInterval(timer);
  timer=null;
}
