                                          
import { buildStateProxy } from './state-proxy.js';

                                                                                   

const finding = /(?:root cause\s*(?:is|:)|(?:bug|problem|issue|cause)\s+is\b|caused by\b|根因[是：:]|原因[是：:])/i;
const resultLine = /(?:\b\d+\s+(?:passed|failed|errors?)\b|^\s*(?:FAILED|ERROR)\b|测试.*(?:通过|失败))/i;
const clip = (s        , n        )         => s.length <= n ? s : `${s.slice(0, Math.max(0,n-1))}…`;

/** Local evidence extraction, not another LLM call. Plans alone never mark an edit/test complete. */
export function milestoneState(segments                    , anchorId        , maxChars        ,
  cache                )         {
 const start=segments.findIndex(s=>s.id===anchorId);
 if(start<0||!Number.isFinite(maxChars)||maxChars<=0)return '';
 const task=segments.slice(start+1);
 const calls=new Map(task.filter(s=>s.kind==='toolCall').map(s=>[s.chunkOf??s.id,s]));
 let diagnosis='',change='';
 const checks=new Map               ();
 for(const s of task){
  if(s.kind==='trace'||s.kind==='assistant'){
   // A revised explicit finding supersedes the old one; ordinary planning does not.
   const line=s.text.split('\n').find(line=>finding.test(line));if(line)diagnosis=clip(line,480);
   continue;
  }
  if(s.kind!=='toolResult'||!s.toolCallId)continue;
  const call=calls.get(s.toolCallId);if(!call)continue;
  const match=/^tool call: ([^\n]+)\n([\s\S]*)$/.exec(call.text);if(!match)continue;
  const name=match[1]??'';
  let args                       ;
  try{args=JSON.parse(match[2]??'')                          ;}catch{continue;}
  if(!args||typeof args!=='object')continue;
  const file=typeof args.file_path==='string'?args.file_path:typeof args.path==='string'?args.path:'';
  if(/^(?:edit|write|apply_patch)$/.test(name)&&s.toolError!==true&&
     (s.toolError===false||/(?:successfully|has been (?:updated|written)|success|已更新|已写入)/i.test(s.text))){
   change=`${clip(file||name,160)}\n${clip(s.text,200)}`;
   // Results for the previous working tree cannot certify this new edit.
   checks.clear();
  }
  const command=typeof args.command==='string'?args.command:'';
  if(!/\b(?:pytest|npm\s+test|pnpm\s+test|node\s+--test|cargo\s+test|go\s+test)\b/.test(command))continue;
  const lines=s.text.split('\n').filter(line=>resultLine.test(line));
  if(!lines.length)continue;
  // Store the latest observed outcome per exact command, including failed runs.
  // Concurrent results are matched by callId, never by arrival adjacency.
  checks.delete(command);checks.set(command,`${clip(command,140)}\n${clip(lines.slice(-2).join('\n'),200)}${s.toolError===true?'\n[tool reported an error]':''}`);
 }
 const evidence=[diagnosis&&`Finding (model statement):\n${diagnosis}`,change&&`Latest write/edit result:\n${change}`,
  ...[...checks.values()].slice(-3).map(t=>`Verification evidence:\n${t}`)].filter(Boolean).join('\n\n');
 const key=evidence||'initial-trace';
 if(cache.id===anchorId&&cache.milestoneKey===key&&cache.text!=='')return cache.text;
 const limit=Math.max(0,Math.floor(maxChars));
 let text='';
 if(evidence){
  const head='<task_progress>\n',foot='\n</task_progress>';
  if(limit>head.length+foot.length)text=head+clip(evidence,limit-head.length-foot.length)+foot;
 }else{
  text=buildStateProxy({segments,anchorId,maxChars:limit,updatePolicy:'perTask',now:0});
 }
 cache.id=anchorId;cache.text=text;cache.milestoneKey=key;
 return text;
}
