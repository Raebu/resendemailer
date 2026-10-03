import { registerPlugin } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import type { MobileAccount } from './resend.js';

interface BackgroundMailboxPlugin {
  configureAccount(options:{id:string;name:string;apiKey:string}):Promise<void>;
  removeAccount(options:{id:string}):Promise<void>;
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
export async function triggerBackgroundMailboxSync():Promise<void>{
  await BackgroundMailbox.syncNow();
}
