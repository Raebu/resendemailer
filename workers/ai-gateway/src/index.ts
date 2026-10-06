export interface Env {
  OPENAI_API_KEY: string;
  GIBP_AI_GATEWAY_TOKEN: string;
  OPENAI_MODEL?: string;
}

const decisionSchema={type:'object',additionalProperties:false,properties:{
  action:{type:'string',enum:['no_action','draft_reply','send_reply','schedule_followup','create_outreach','escalate']},
  category:{type:'string'},confidence:{type:'number',minimum:0,maximum:1},subject:{type:'string'},body:{type:'string'},
  follow_up_days:{type:'integer',minimum:0,maximum:30},reason:{type:'string'},sensitive:{type:'boolean'},unsubscribe:{type:'boolean'},
},required:['action','category','confidence','subject','body','follow_up_days','reason','sensitive','unsubscribe']};

const intelligenceSchema={type:'object',additionalProperties:false,properties:{
  category:{type:'string'},priority:{type:'string',enum:['urgent','high','normal','low']},
  needs_reply:{type:'boolean'},needs_me:{type:'boolean'},waiting:{type:'boolean'},language:{type:'string'},
  why_it_matters:{type:'string'},summary:{type:'string'},
  actions:{type:'array',items:{type:'object',additionalProperties:false,properties:{label:{type:'string'},due_at:{type:['string','null']}},required:['label','due_at']}},
  deadline_at:{type:['string','null']},labels:{type:'array',items:{type:'string'}},confidence:{type:'number',minimum:0,maximum:1},sensitive:{type:'boolean'},
},required:['category','priority','needs_reply','needs_me','waiting','language','why_it_matters','summary','actions','deadline_at','labels','confidence','sensitive']};

const languageSchema={type:'object',additionalProperties:false,properties:{
  text:{type:'string'},source_language:{type:'string'},back_translation:{type:'string'},
},required:['text','source_language','back_translation']};

const searchSchema={type:'object',additionalProperties:false,properties:{
  matches:{type:'array',maxItems:50,items:{type:'object',additionalProperties:false,properties:{
    threadId:{type:'string'},reason:{type:'string'},score:{type:'number',minimum:0,maximum:1},
  },required:['threadId','reason','score']}},
},required:['matches']};

const threadAssistSchema={type:'object',additionalProperties:false,properties:{
  summary:{type:'string'},
  status:{type:'string'},
  language:{type:'string'},
  suggested_replies:{type:'array',maxItems:3,items:{type:'object',additionalProperties:false,properties:{
    label:{type:'string'},body:{type:'string'},tone:{type:'string'},
  },required:['label','body','tone']}},
},required:['summary','status','language','suggested_replies']};

const attachmentSummarySchema={type:'object',additionalProperties:false,properties:{
  summary:{type:'string'},
  key_points:{type:'array',maxItems:12,items:{type:'string'}},
  actions:{type:'array',maxItems:12,items:{type:'string'}},
  risks:{type:'array',maxItems:12,items:{type:'string'}},
  language:{type:'string'},
},required:['summary','key_points','actions','risks','language']};

const briefingSchema={type:'object',additionalProperties:false,properties:{
  title:{type:'string'},summary:{type:'string'},
  priorities:{type:'array',maxItems:20,items:{type:'object',additionalProperties:false,properties:{
    threadId:{type:'string'},headline:{type:'string'},reason:{type:'string'},urgency:{type:'string',enum:['urgent','high','normal']},
  },required:['threadId','headline','reason','urgency']}},
  reminders:{type:'array',maxItems:20,items:{type:'object',additionalProperties:false,properties:{
    id:{type:'string'},label:{type:'string'},due_at:{type:'string'},
  },required:['id','label','due_at']}},
},required:['title','summary','priorities','reminders']};

function extractText(response:any):string{
  if(typeof response?.output_text==='string')return response.output_text;
  for(const item of response?.output||[])for(const content of item?.content||[])if(content?.type==='output_text'&&typeof content.text==='string')return content.text;
  throw new Error('OpenAI response contained no output text');
}
async function structured(env:Env,name:string,schema:any,system:string,user:any):Promise<Response>{
  const payload={model:env.OPENAI_MODEL||'gpt-5.6-luna',store:false,input:[
    {role:'system',content:[{type:'input_text',text:system}]},
    {role:'user',content:[{type:'input_text',text:JSON.stringify(user).slice(0,60000)}]},
  ],text:{format:{type:'json_schema',name,strict:true,schema}}};
  const upstream=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const raw:any=await upstream.json();
  if(!upstream.ok)return Response.json({error:raw?.error?.message||'OpenAI request failed'},{status:502});
  try{return Response.json(JSON.parse(extractText(raw)),{headers:{'Cache-Control':'no-store'}});}
  catch{return Response.json({error:'Invalid structured AI response'},{status:502});}
}
async function structuredFile(env:Env,name:string,schema:any,system:string,input:any):Promise<Response>{
  const filename=String(input?.filename||'attachment').slice(0,240);
  const fileData=String(input?.file_data||'');
  if(!fileData||fileData.length>12_000_000)return Response.json({error:'Attachment is missing or too large'},{status:413});
  const payload={model:env.OPENAI_MODEL||'gpt-5.6-luna',store:false,input:[
    {role:'system',content:[{type:'input_text',text:system}]},
    {role:'user',content:[
      {type:'input_text',text:JSON.stringify({filename,content_type:String(input?.content_type||'application/octet-stream')})},
      {type:'input_file',filename,file_data:fileData},
    ]},
  ],text:{format:{type:'json_schema',name,strict:true,schema}}};
  const upstream=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const raw:any=await upstream.json();
  if(!upstream.ok)return Response.json({error:raw?.error?.message||'OpenAI file analysis failed'},{status:502});
  try{return Response.json(JSON.parse(extractText(raw)),{headers:{'Cache-Control':'no-store'}});}
  catch{return Response.json({error:'Invalid structured attachment summary'},{status:502});}
}

export default {
  async fetch(request:Request,env:Env):Promise<Response>{
    if(request.method!=='POST')return new Response('Method Not Allowed',{status:405});
    if(!env.GIBP_AI_GATEWAY_TOKEN||request.headers.get('authorization')!==`Bearer ${env.GIBP_AI_GATEWAY_TOKEN}`)return Response.json({error:'Unauthorized'},{status:401});
    let input:any;try{input=await request.json();}catch{return Response.json({error:'Invalid JSON'},{status:400});}
    const path=new URL(request.url).pathname;

    if(path==='/v1/decision'){
      if(!['inbound','outreach','followup'].includes(input?.task))return Response.json({error:'Invalid task'},{status:400});
      return structured(env,'mail_decision',decisionSchema,[
        'You are the constrained decision engine for a business email client.',
        'Never invent facts, prices, credentials, regulatory claims, relationships, meetings, promises, or authority.',
        'Mark sensitive=true for legal, regulatory, complaints, payment disputes, security/privacy, employment, medical, fraud, or contractual commitments.',
        'Honor unsubscribe/do-not-contact language immediately.',
        'For outreach, be concise and factual only from supplied context. Never imply prior contact unless context proves it.',
        'When uncertain choose escalate or draft_reply rather than autonomous send.',
      ].join(' '),input);
    }

    if(path==='/v1/intelligence'){
      return structured(env,'mail_intelligence',intelligenceSchema,[
        'Analyze inbound business email for prioritization, not autonomous execution.',
        'Identify language, intent/category, urgency, whether the user must reply or act, waiting state, deadlines and concise action items.',
        'why_it_matters must be one short sentence. summary must be concise.',
        'Use ISO-8601 for deadlines when a concrete date/time can be inferred; otherwise null.',
        'Mark sensitive for legal, regulatory, complaints, payment disputes, security/privacy, employment, medical, fraud or contractual commitments.',
        'Do not invent facts or deadlines.',
      ].join(' '),input);
    }

    if(path==='/v1/language'){
      return structured(env,'mail_language',languageSchema,[
        'You are a professional multilingual business correspondence engine.',
        'Translate or compose naturally in the requested target language while preserving meaning and tone.',
        'Never alter names, account numbers, URLs, currency values, reference numbers or quoted text when listed in preserve.',
        'Use any supplied alias glossary consistently and do not translate glossary terms marked to stay unchanged.',
        'If mode is compose, turn the supplied instruction or rough notes into a complete polished email in the target language without inventing facts.',
        'If mode is bilingual, return target-language text followed by the source-language equivalent.',
        'back_translation must be a faithful English rendering of the produced text for approval.',
        'Do not add claims, commitments or facts that were not in the input.',
      ].join(' '),input);
    }

    if(path==='/v1/search'){
      return structured(env,'mail_search',searchSchema,[
        'Rank the supplied mailbox metadata against the natural-language search request.',
        'Return only genuinely relevant threads. Use the supplied threadId exactly.',
        'Do not infer facts not present in the items.',
      ].join(' '),input);
    }

    if(path==='/v1/thread-assist'){
      return structured(env,'thread_assist',threadAssistSchema,[
        'Summarize the supplied email thread and identify its current status.',
        'Provide up to three materially different suggested replies that are ready to edit/send.',
        'Use only facts present in the supplied messages/contact context; never invent commitments, dates, prices, authority or relationships.',
        'For legal, regulatory, complaints, payment disputes, security/privacy, employment, medical, fraud or contractual matters, suggestions must be conservative and require human review.',
      ].join(' '),input);
    }

    if(path==='/v1/attachment-summary'){
      return structuredFile(env,'attachment_summary',attachmentSummarySchema,[
        'Summarize the attached business file faithfully and concisely.',
        'Identify material key points, explicit actions or deadlines, and genuine risks or caveats.',
        'Do not invent facts, amounts, obligations or conclusions that are not in the file.',
        'If the file is unreadable or content is ambiguous, say so in the summary rather than guessing.',
      ].join(' '),input);
    }

    if(path==='/v1/briefing'){
      return structured(env,'mail_briefing',briefingSchema,[
        'Create a concise executive mailbox briefing from supplied priority messages and reminders.',
        'Prefer urgent deadlines, messages needing the user, and overdue waiting/follow-ups.',
        'Use only supplied facts and thread IDs.',
      ].join(' '),input);
    }

    return Response.json({error:'Not found'},{status:404});
  },
};
