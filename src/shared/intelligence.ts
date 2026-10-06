export interface RoutingContext {
  to: string;
  from: string;
  subject: string;
  body: string;
  hasAttachment: boolean;
  language?: string | null;
  senderKnown?: boolean;
}

export interface RoutingConditions {
  to?: string;
  from?: string;
  fromDomain?: string;
  subjectContains?: string;
  bodyContains?: string;
  hasAttachment?: boolean;
  language?: string;
  senderKnown?: boolean;
}

const lower=(value:unknown)=>String(value??'').trim().toLowerCase();

export function emailDomain(address:string):string{
  return lower(address).split('@').at(-1)||'';
}

export function wildcardMatch(pattern:string,value:string):boolean{
  const specials='\\^$.*+?()[]{}|';
  let source='^';
  for(const char of pattern){
    if(char==='*')source+='.*';
    else if(char==='?')source+='.';
    else source+=specials.includes(char)?'\\\\'+char:char;
  }
  source+='$';
  return new RegExp(source,'i').test(value);
}

export function routingRuleMatches(conditions:RoutingConditions,ctx:RoutingContext):boolean{
  if(conditions.to&&!wildcardMatch(conditions.to,ctx.to))return false;
  if(conditions.from&&!wildcardMatch(conditions.from,ctx.from))return false;
  if(conditions.fromDomain&&lower(conditions.fromDomain)!==emailDomain(ctx.from))return false;
  if(conditions.subjectContains&&!lower(ctx.subject).includes(lower(conditions.subjectContains)))return false;
  if(conditions.bodyContains&&!lower(ctx.body).includes(lower(conditions.bodyContains)))return false;
  if(conditions.hasAttachment!==undefined&&Boolean(conditions.hasAttachment)!==ctx.hasAttachment)return false;
  if(conditions.language&&ctx.language&&lower(conditions.language)!==lower(ctx.language))return false;
  if(conditions.senderKnown!==undefined&&Boolean(conditions.senderKnown)!==Boolean(ctx.senderKnown))return false;
  return true;
}

export function scheduledDueAt(scheduledAt:string,undoSeconds:number,nowMs=Date.now()):{
  scheduledAt:string;undoUntil:string|null;
}{
  const requested=new Date(scheduledAt);
  if(Number.isNaN(requested.getTime()))throw new Error('Invalid scheduled send time');
  const seconds=Math.max(0,Math.min(30,Math.floor(undoSeconds||0)));
  const undoUntil=seconds?new Date(nowMs+seconds*1000):null;
  const due=undoUntil&&undoUntil>requested?undoUntil:requested;
  return{scheduledAt:due.toISOString(),undoUntil:undoUntil?.toISOString()||null};
}

const suppressionEvents=new Set(['email.bounced','email.complained','email.failed','contact.unsubscribed']);
export function shouldSuppressDeliveryEvent(eventType:string):boolean{
  return suppressionEvents.has(eventType);
}

const deliveryStatus:Record<string,string>={
  'email.delivered':'delivered',
  'email.bounced':'bounced',
  'email.complained':'complained',
  'email.failed':'failed',
  'email.sent':'sent',
  'email.delivery_delayed':'delayed',
};
export function deliveryStatusForEvent(eventType:string):string|null{
  return deliveryStatus[eventType]||null;
}
