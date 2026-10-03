import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { Network } from '@capacitor/network';
import { mailApi } from '../client/mailApi.js';

let started=false;
let timer:number|null=null;
let running=false;

async function sync():Promise<void>{
  if(running)return;
  running=true;
  try{await mailApi('/api/sync',{method:'POST'});}catch{/* offline/errors remain visible in mailbox status */}
  finally{running=false;}
}

export async function startMobileLifecycle():Promise<void>{
  if(started||!Capacitor.isNativePlatform())return;
  started=true;

  const network=await Network.getStatus();
  if(network.connected)void sync();

  await App.addListener('appStateChange',state=>{
    if(state.isActive)void sync();
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
