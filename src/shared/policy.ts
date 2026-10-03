export const ALWAYS_HUMAN_CATEGORIES = new Set([
  'legal','regulatory','complaint','payment_dispute','security',
  'privacy','medical','employment','contract','fraud',
]);

export const AUTO_SAFE_CATEGORIES = new Set([
  'general_enquiry','availability','acknowledgement','partnership_initial',
  'supplier_initial','support_routine','bd_interest','bd_not_interested',
]);

export function canAutoSend(input:{
  mode:string;
  category:string;
  sensitive:boolean;
  confidence:number;
  threshold:number;
  action:string;
  sentLastHour:number;
  hourlyLimit:number;
}):boolean{
  return input.mode==='auto_safe'
    && input.action==='send_reply'
    && !input.sensitive
    && !ALWAYS_HUMAN_CATEGORIES.has(input.category)
    && AUTO_SAFE_CATEGORIES.has(input.category)
    && input.confidence>=input.threshold
    && input.sentLastHour<input.hourlyLimit;
}

export function addressDomain(address:string):string|null{
  const at=address.lastIndexOf('@');
  if(at<=0||at===address.length-1)return null;
  return address.slice(at+1).trim().toLowerCase()||null;
}

export function normalizedEmail(address:string):string{
  return address.trim().toLowerCase();
}
