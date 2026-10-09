import { registerPlugin } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

export type BackgroundAccount={
  id:string;
  name:string;
  api_key?:string;
  auth_mode?:'api_key'|'oauth'|string;
};

export type BackgroundAutomationState={
  campaigns:any[];
  suppressions:string[];
  audit:Array<{
    id:string;
    messageId?:string|null;
    campaignId?:string|null;
    action:string;
    executed:boolean;
    error?:string|null;
    createdAt:string;
  }>;
};

interface BackgroundMailboxPlugin {
  configureAccount(options:{id:string;name:string;apiKey:string}):Promise<void>;
  configureOAuthAccount(options:{
    id:string;name:string;clientId:string;accessToken:string;refreshToken:string;
    expiresIn:number;scope:string;
  }):Promise<void>;
  getBearer(options:{id:string}):Promise<{token:string}>;
  revokeAccount(options:{id:string}):Promise<void>;
  removeAccount(options:{id:string}):Promise<void>;
  openExternalUrl(options:{url:string}):Promise<void>;
  configureAutomation(options:{
    url:string;token:string;mode:string;threshold:number;maxRepliesPerHour:number;
  }):Promise<void>;
  setAutomationMode(options:{mode:string;threshold:number;maxRepliesPerHour:number}):Promise<void>;
  setSuppressions(options:{suppressionsJson:string}):Promise<void>;
  setForegroundAudit(options:{auditJson:string}):Promise<void>;
  upsertCampaign(options:{id:string;campaignJson:string}):Promise<void>;
  removeCampaign(options:{id:string}):Promise<void>;
  getAutomationState():Promise<BackgroundAutomationState>;
  syncNow():Promise<void>;
}
const BackgroundMailbox=registerPlugin<BackgroundMailboxPlugin>('BackgroundMailbox');

export async function configureBackgroundAccount(account:BackgroundAccount):Promise<void>{
  if(account.auth_mode==='oauth')return; // OAuth tokens live only in the native Keystore-backed store.
  try{await LocalNotifications.requestPermissions();}catch{/* user may deny notifications */}
  await BackgroundMailbox.configureAccount({id:account.id,name:account.name,apiKey:String(account.api_key||'')});
}

export async function configureBackgroundOAuthAccount(input:{
  id:string;name:string;clientId:string;accessToken:string;refreshToken:string;
  expiresIn:number;scope:string;
}):Promise<void>{
  try{await LocalNotifications.requestPermissions();}catch{/* user may deny notifications */}
  await BackgroundMailbox.configureOAuthAccount(input);
}

export async function getBackgroundBearer(id:string):Promise<string>{
  const result=await BackgroundMailbox.getBearer({id});
  if(!result?.token)throw new Error('Resend authorization is unavailable.');
  return result.token;
}

export async function revokeBackgroundAccount(id:string):Promise<void>{
  await BackgroundMailbox.revokeAccount({id});
}

export async function removeBackgroundAccount(id:string):Promise<void>{
  await BackgroundMailbox.removeAccount({id});
}

export async function openExternalUrl(url:string):Promise<void>{
  await BackgroundMailbox.openExternalUrl({url});
}

export async function configureBackgroundAutomation(input:{
  url:string;token:string;mode:string;threshold:number;maxRepliesPerHour:number;
}):Promise<void>{
  await BackgroundMailbox.configureAutomation(input);
}
export async function setBackgroundAutomationMode(input:{
  mode:string;threshold:number;maxRepliesPerHour:number;
}):Promise<void>{
  await BackgroundMailbox.setAutomationMode(input);
}
export async function setBackgroundSuppressions(emails:string[]):Promise<void>{
  await BackgroundMailbox.setSuppressions({suppressionsJson:JSON.stringify(emails)});
}
export async function setBackgroundForegroundAudit(audit:any[]):Promise<void>{
  await BackgroundMailbox.setForegroundAudit({auditJson:JSON.stringify(audit)});
}
export async function upsertBackgroundCampaign(id:string,campaign:any):Promise<void>{
  await BackgroundMailbox.upsertCampaign({id,campaignJson:JSON.stringify(campaign)});
}
export async function removeBackgroundCampaign(id:string):Promise<void>{
  await BackgroundMailbox.removeCampaign({id});
}
export async function getBackgroundAutomationState():Promise<BackgroundAutomationState>{
  return BackgroundMailbox.getAutomationState();
}
export async function triggerBackgroundMailboxSync():Promise<void>{
  await BackgroundMailbox.syncNow();
}
