export interface Env {
  OPENAI_API_KEY: string;
  GIBP_AI_GATEWAY_TOKEN: string;
  OPENAI_MODEL?: string;
}

const schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type:'string', enum:['no_action','draft_reply','send_reply','schedule_followup','create_outreach','escalate'] },
    category: { type:'string' },
    confidence: { type:'number', minimum:0, maximum:1 },
    subject: { type:'string' },
    body: { type:'string' },
    follow_up_days: { type:'integer', minimum:0, maximum:30 },
    reason: { type:'string' },
    sensitive: { type:'boolean' },
    unsubscribe: { type:'boolean' },
  },
  required:['action','category','confidence','subject','body','follow_up_days','reason','sensitive','unsubscribe'],
};

function extractText(response:any):string{
  if(typeof response?.output_text==='string') return response.output_text;
  for(const item of response?.output||[]){
    for(const content of item?.content||[]){
      if(content?.type==='output_text' && typeof content.text==='string') return content.text;
    }
  }
  throw new Error('OpenAI response contained no output text');
}

export default {
  async fetch(request:Request,env:Env):Promise<Response>{
    if(request.method!=='POST') return new Response('Method Not Allowed',{status:405});
    const auth=request.headers.get('authorization');
    if(!env.GIBP_AI_GATEWAY_TOKEN || auth!==`Bearer ${env.GIBP_AI_GATEWAY_TOKEN}`) {
      return Response.json({error:'Unauthorized'},{status:401});
    }

    let input:any;
    try{input=await request.json();}catch{return Response.json({error:'Invalid JSON'},{status:400});}
    if(!['inbound','outreach','followup'].includes(input?.task)) return Response.json({error:'Invalid task'},{status:400});

    const system=[
      'You are the constrained decision engine for a business email client.',
      'Return only the requested structured decision.',
      'Never invent facts, prices, credentials, regulatory claims, relationships, meetings, promises, or authority.',
      'Mark sensitive=true for legal, regulatory, complaints, payment disputes, security/privacy, employment, medical, fraud, or contractual commitments.',
      'Honor unsubscribe/do-not-contact language immediately.',
      'For outreach, be concise, factual and personalized only from supplied context. Never imply prior contact unless supplied context proves it.',
      'When uncertain, choose escalate or draft_reply rather than autonomous send.',
    ].join(' ');

    const payload={
      model:env.OPENAI_MODEL||'gpt-6-luna',
      input:[
        {role:'system',content:[{type:'input_text',text:system}]},
        {role:'user',content:[{type:'input_text',text:JSON.stringify({task:input.task,payload:input.payload}).slice(0,50000)}]},
      ],
      text:{format:{type:'json_schema',name:'mail_decision',strict:true,schema}},
    };

    const upstream=await fetch('https://api.openai.com/v1/responses',{
      method:'POST',
      headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`,'Content-Type':'application/json'},
      body:JSON.stringify(payload),
    });
    const raw=await upstream.json<any>();
    if(!upstream.ok) return Response.json({error:raw?.error?.message||'OpenAI request failed'},{status:502});
    try{
      const result=JSON.parse(extractText(raw));
      return Response.json(result,{headers:{'Cache-Control':'no-store'}});
    }catch{
      return Response.json({error:'Invalid structured AI response'},{status:502});
    }
  },
};
