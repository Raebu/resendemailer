import { registerPlugin } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import type { MobileAccount } from './resend.js';

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
  removeAccount(options:{id:string}):Promise<void>;
  configureAutomation(options:{
    url:string;token:string;mode:string;threshold:number;maxRepliesPerHour:number;
  }):Promise<void>;
  setAutomationMode(options:{mode:string;threshold:number;maxRepliesPerHour:number}):Promise<void>;
  upsertCampaign(options:{id:string;campaignJson:string}):Promise<void>;
  removeCampaign(options:{id:string}):Promise<void>;
  getAutomationState():Promise<BackgroundAutomationState>;
  syncNow():Promise<void>;
}
const BackgroundMailbox=registerPlugin<BackgroundMailboxPlugin>('BackgroundMailbox');

export async function configureBackgroundAccount(account:MobileAccount):Promise<void>{
  try{await LocalNotifications.requestPermissions();}catch{/* user may deny notifications */}
  await BackgroundMailbox.configureAccount({id:account.id,name:account.name,apiKey:account.api_key});
}
export async function removeBackgroundAccount(id:string):Promise<void>{
  await BackgroundMailbox.removeAccount({id});
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
