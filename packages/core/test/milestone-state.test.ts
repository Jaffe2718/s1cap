import test from 'node:test';
import assert from 'node:assert/strict';
import { milestoneState } from '../src/milestone-state.ts';
import type { TaskProxyCache } from '../src/milestone-state.ts';
import { adaptMessages } from '../src/harness-adapter.ts';
import { segmentEvent } from '../src/segmenter.ts';
import type { Segment } from '../src/types.ts';
import { defaultPolicy } from '../src/types.ts';
import { AssociationGraph } from '../src/assoc-graph.ts';
import { observeStep } from '../src/observer.ts';
const seg=(id:string,kind:Segment['kind'],text:string,extra:Partial<Segment>={}):Segment=>
 ({id,kind,text,seq:0,sessionId:'s',tokens:1,ts:0,...extra});
const question=seg('q','user','Fix the failing test.');
const call=(id:string,name:string,args:object)=>seg(id,'toolCall',`tool call: ${name}\n${JSON.stringify(args)}`);
const result=(id:string,text:string,error=false)=>seg(`result-${id}`,'toolResult',text,{toolCallId:id,toolError:error});

test('planning stays stable; findings, successful edits and test outcomes advance the state',()=>{
 const cache:TaskProxyCache={id:'',text:''};
 const rows=[question,seg('a','trace','I will inspect the repository.')];
 const first=milestoneState(rows,'q',2400,cache);
 rows.push(seg('b','trace','Next I will run tests.'));
 assert.equal(milestoneState(rows,'q',2400,cache),first);
 rows.push(seg('c','trace','The root cause is a stale list reference.'));
 assert.match(milestoneState(rows,'q',2400,cache),/stale list reference/);
 rows.push(call('edit','edit',{file_path:'logging.py'}));
 assert.doesNotMatch(milestoneState(rows,'q',2400,cache),/Latest write/);
 rows.push(result('edit','File has been updated.'));
 assert.match(milestoneState(rows,'q',2400,cache),/logging.py/);
 const command='python -m pytest testing/logging -q';
 rows.push(call('t1','pwsh',{command}),result('t1','59 passed in 1.2s'));
 assert.match(milestoneState(rows,'q',2400,cache),/59 passed/);
 rows.push(call('t2','pwsh',{command}),result('t2','1 failed, 58 passed in 1.3s',true));
 const failed=milestoneState(rows,'q',2400,cache);
 assert.match(failed,/1 failed/);assert.doesNotMatch(failed,/59 passed/);
 assert.equal(milestoneState([...rows,seg('d','trace','Let me think further.')],'q',2400,cache),failed);
});

test('parallel results require matching call identities; errors cannot claim a completed edit',()=>{
 const rows=[question,call('e','edit',{file_path:'core.py'}),call('t','pwsh',{command:'python -m pytest -q'}),
  result('e','Could not update; success is required.',true),result('unknown','4 passed'),result('t','3 passed')];
 const text=milestoneState(rows,'q',2400,{id:'',text:''});
 assert.match(text,/3 passed/);assert.doesNotMatch(text,/4 passed|Latest write/);
});

test('new task boundaries discard old evidence and ceilings remain enforced',()=>{
 const cache:TaskProxyCache={id:'',text:''};
 const rows=[question,seg('a','trace','The root cause is '+ 'x'.repeat(600))];
 const text=milestoneState(rows,'q',120,cache);
 assert.ok(text.length<=120);assert.ok(text.endsWith('</task_progress>'));
 rows.push(seg('q2','user','Another task'),seg('b','trace','Inspect another file.'));
 assert.doesNotMatch(milestoneState(rows,'q2',2400,cache),/root cause/);
});

test('tool identity and error status survive real message adaptation and chunking',()=>{
 const raw=adaptMessages([{id:'result',role:'tool',toolCallId:'edit',isError:true,
  content:[{type:'text',text:'failure '.repeat(500)}]}],{sessionId:'s',startSeq:1,now:0}).events[0]!;
 const chunks=segmentEvent(raw);assert.ok(chunks.length>1);
 for(const s of chunks){assert.equal(s.toolCallId,'edit');assert.equal(s.toolError,true);}
});

test('revised findings replace earlier hypotheses and new edits invalidate previous test evidence',()=>{
 const rows=[question,seg('a','trace','The root cause is a timeout.'),
  call('t','pwsh',{command:'python -m pytest -q'}),result('t','3 passed'),
  seg('b','trace','The root cause is actually a stale reference.'),
  call('e','edit',{file_path:'core.py'}),result('e','File has been updated.')];
 const text=milestoneState(rows,'q',2400,{id:'',text:''});
 assert.match(text,/stale reference/);assert.doesNotMatch(text,/timeout|3 passed/);
});

test('the observer updates a shared milestone cache while preserving the assembly callback',async()=>{
 const graph=new AssociationGraph(),policy=defaultPolicy(),cache:TaskProxyCache={id:'',text:''};
 policy.tas.updatePolicy='milestone';policy.tas.tMaxChars=2400;
 graph.addSegments([question,seg('a','trace','I will inspect the repository.')]);
 let assemblies=0;
 const observe=()=>observeStep({sessionId:'s',step:2,seq:0,messages:[],policy,now:0,graph,proxyCache:cache,
  scoreOnStepPath:false,contextWindow:10000,reserveOutputTokens:100,fixedOverheadTokens:0,lambdaMs:0,
  beforeAssemble:()=>{assemblies++;}});
 const first=await observe();assert.equal(first.kind,'assembled');
 graph.addSegments([call('e','edit',{file_path:'core.py'}),result('e','File has been updated.')]);
 const second=await observe();assert.equal(second.kind,'assembled');
 if(second.kind==='assembled')assert.match(second.layout.stateProxy??'',/core.py/);
 assert.equal(assemblies,2);
});
