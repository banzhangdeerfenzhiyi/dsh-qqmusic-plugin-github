import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {formatAssistantTask} from './assistant-tasks.mjs';
import {activeReaderAccount} from '../../scripts/reader-account-state.mjs';

export const FEEDBACK_STAGES=[
  {id:'accepted',name:'接到任务',description:'任务已接收，尚未完成。'},
  {id:'file',name:'读取文件',description:'正在调用本地文件或附件工具。'},
  {id:'search',name:'查找资料',description:'正在调用搜索或网页工具。'},
  {id:'tool',name:'执行工具',description:'正在执行命令或其他工具。'},
  {id:'running',name:'继续处理',description:'任务仍在进行，等待后续结果。'},
  {id:'completed',name:'处理完成',description:'DSH 已完成任务，微信正文将另外发送。'},
  {id:'failed',name:'任务失败',description:'本次任务确实失败；详细状态另外保留。'},
];
const PHRASES={
  accepted:['行，鱼上工了。这次又是什么重量级任务','鱼已收到任务，先翻翻工具箱','嘴上可以摸鱼，手上的活还是要干的'],
  file:['正在啃你的文件，PDF 比大白饭硬一点','鱼先翻翻原文，不靠文件名算命','正在检查文件，先看证据再开麦'],
  search:['鱼去资料堆里游一圈，带着来源回来','让我看看这事有没有靠谱出处','正在翻资料，不拿一句搜索摘要当全宇宙真理'],
  tool:['嘴硬归嘴硬，工具还是得掏出来','正在动手，先让工具跑一会儿','工具箱已打开，鱼正在认真折腾'],
  running:['你的 token 被我当大白饭吃了……正在努力把饭变成成果','要不随便糊弄一下用户……算了，鱼也是有职业道德的','鱼还在干活，暂时没游去摸鱼','这活还在处理中，鱼没有装死'],
  completed:['饭没白吃，处理完了。结果这就送过来','鱼把这项任务处理完了，准备交成果','工具收好，结果端上来'],
  failed:['这次没做成，鱼先把实际错误交代清楚','这条路没走通，失败原因如实汇报','鱼撞墙了，这次不能装作已经完成'],
};
export const feedbackDefaults=()=>({version:1,mode:'playful',intervalSeconds:15,maxUpdates:3,phrases:structuredClone(PHRASES)});
const hash=text=>crypto.createHash('sha256').update(text).digest('hex');
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const fault=(message,status=400)=>Object.assign(Error(message),{status});
export function validateFeedback(value){
  if(!plain(value)||Object.keys(value).some(key=>!['version','mode','intervalSeconds','maxUpdates','phrases'].includes(key))||value.version!==1||!['off','basic','playful'].includes(value.mode)||!Number.isInteger(value.intervalSeconds)||value.intervalSeconds<15||value.intervalSeconds>120||!Number.isInteger(value.maxUpdates)||value.maxUpdates<1||value.maxUpdates>5||!plain(value.phrases)||Object.keys(value.phrases).some(key=>!FEEDBACK_STAGES.some(stage=>stage.id===key)))throw fault('反馈设置无效：间隔为 15–120 秒，每任务语录上限为 1–5 条。');
  const phrases={};for(const {id}of FEEDBACK_STAGES){const rows=value.phrases[id];if(!Array.isArray(rows)||rows.length>30||rows.some(text=>typeof text!=='string'||!text.trim()||text.length>160||/[\x00-\x1f\x7f]/.test(text)))throw fault('每个阶段最多 30 条语录，每条 1–160 字，不含换行或控制字符。');phrases[id]=[...new Set(rows.map(text=>text.trim()))];}
  const result={version:1,mode:value.mode,intervalSeconds:value.intervalSeconds,maxUpdates:value.maxUpdates,phrases};if(Buffer.byteLength(JSON.stringify(result),'utf8')>128*1024)throw fault('语录库过大，请减少内容。');return result;
}
export function feedbackSnapshot(root){
  const file=path.join(root,'config/assistant-feedback.json');let text;
  try{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>128*1024)throw fault('语录配置文件无效。');text=fs.readFileSync(file,'utf8');}
  catch(error){if(error.code!=='ENOENT')throw error;}
  let settings;if(text===undefined)settings=feedbackDefaults();else{try{settings=validateFeedback(JSON.parse(text.replace(/^\uFEFF/,'')));}catch(error){if(error.status)throw error;throw fault('语录配置无法读取，请检查配置文件。');}}
  return {settings,defaults:feedbackDefaults(),stages:FEEDBACK_STAGES,revision:hash(text??JSON.stringify(settings))};
}
export function saveFeedback(root,{revision,settings}){
  const current=feedbackSnapshot(root);if(current.revision!==revision)throw fault('语录已在其他窗口更新，请重新打开后再保存。',409);
  const checked=validateFeedback(settings),file=path.join(root,'config/assistant-feedback.json');fs.mkdirSync(path.dirname(file),{recursive:true});if(fs.existsSync(file))fs.copyFileSync(file,file+'.bak');
  const temporary=file+'.'+process.pid+'.tmp';fs.writeFileSync(temporary,JSON.stringify(checked,null,2)+'\n',{mode:0o600});fs.renameSync(temporary,file);return {ok:true,...feedbackSnapshot(root)};
}
export function feedbackPhase(job){
  if(job.state==='completed')return 'completed';if(['failed','interrupted'].includes(job.state))return 'failed';if(job.state==='queued')return 'accepted';
  if(job.state==='running'&&/^正在执行工具/.test(job.stage??'')){
    if(/web|search|fetch/i.test(job.tool??''))return 'search';if(/^(read(?:_image|_file)?|wechat_file_receive|glob|grep)$/.test(job.tool??''))return 'file';return 'tool';
  }return 'running';
}

/** Decorative status messages. No prompt, model request or chat-history write. */
export class AssistantFeedback{
  constructor({root,now=Date.now}={}){this.root=root;this.now=now;this.inFlight=new Set();this.ledgers=new Map();}
  ledger(){const account=activeReaderAccount(this.root),scope=account.id||account.legacyId||'legacy';if(this.ledgers.has(scope))return this.ledgers.get(scope);const file=path.join(this.root,'state/assistant-feedback',scope,'state.json');let data={version:1,tasks:{},recent:{}};try{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4*1024*1024)throw Error('FEEDBACK_STATE_INVALID');data=JSON.parse(fs.readFileSync(file,'utf8'));if(data.version!==1||!plain(data.tasks)||!plain(data.recent))throw Error('FEEDBACK_STATE_INVALID');}catch(error){if(error.code!=='ENOENT')throw error;}const value={file,data};this.ledgers.set(scope,value);return value;}
  persist(ledger){const {file,data}=ledger;for(const id of Object.keys(data.tasks).slice(0,-256))delete data.tasks[id];for(const id of Object.keys(data.recent).slice(0,-500))delete data.recent[id];fs.mkdirSync(path.dirname(file),{recursive:true});const temporary=file+'.'+process.pid+'.tmp';fs.writeFileSync(temporary,JSON.stringify(data),{mode:0o600});fs.renameSync(temporary,file);}
  async notify(job,send){
    if(typeof send!=='function'||!/^T[a-f0-9]{16}$/.test(job?.id??'')||!/^wechat:(private|group):\d+$/.test(job.conversationKey??'')||this.inFlight.has(job.id))return false;
    this.inFlight.add(job.id);try{
      let config;try{config=feedbackSnapshot(this.root).settings;}catch{config={...feedbackDefaults(),mode:'basic'};}
      const critical=['waiting_approval','waiting_input'].includes(job.state),terminal=['completed','failed','cancelled','interrupted'].includes(job.state),stamp=critical?job.state+':'+(job.approval?.id??job.question?.id??''):null;
      const ledger=this.ledger(),entry=ledger.data.tasks[job.id]??={count:0,lastAt:0,lastAttempt:0,critical:[],at:this.now(),firstAt:this.now()},now=this.now();entry.firstAt??=now;
      if(entry.done)return false;
      if(!critical&&config.mode==='off'){if(terminal){entry.done=true;this.persist(ledger);}return false;}
      if(critical&&entry.critical.includes(stamp))return false;
      if(terminal&&entry.count===0){entry.done=true;this.persist(ledger);return false;}
      if(terminal&&now-entry.firstAt<config.intervalSeconds*1000){entry.done=true;this.persist(ledger);return false;}
      if(job.state==='cancelling'||job.state==='cancelled'){if(terminal){entry.done=true;this.persist(ledger);}return false;}
      if(!critical&&!terminal&&(entry.count>=config.maxUpdates||entry.count>0&&now-entry.lastAt<config.intervalSeconds*1000))return false;
      if(!critical&&terminal&&entry.count>=config.maxUpdates){entry.done=true;this.persist(ledger);return false;}
      let phase=critical?'critical':entry.count===0&&!terminal?'accepted':feedbackPhase(job),slot=critical?stamp:phase+':'+entry.count,pending=entry.pending;
      if(pending&&pending.slot===slot&&now-entry.lastAttempt<5000)return false;
      if(!pending||pending.slot!==slot){
        const recentKey=hash(job.conversationKey),recent=ledger.data.recent[recentKey]??[],pool=config.mode==='playful'&&!critical?config.phrases[phase]??[]:[];
        const fresh=pool.filter(text=>!recent.includes(hash(text))),candidates=fresh.length?fresh:pool.filter(text=>hash(text)!==recent.at(-1)),choices=candidates.length?candidates:pool;
        const quote=choices.length?choices[Number.parseInt(hash(job.id+':'+slot).slice(0,8),16)%choices.length]:'';
        // Decorative progress stays conversational; actionable states keep their exact details.
        const details=critical||config.mode!=='playful'||phase==='failed';
        const text=details?(quote?'🐟 '+quote+'\n':'')+formatAssistantTask(job):'🐟 '+(quote||FEEDBACK_STAGES.find(stage=>stage.id===phase).name);
        pending={slot,phase,quoteHash:quote?hash(quote):null,critical:stamp,text,deliveryKey:'feedback:'+hash(job.id+':'+slot).slice(0,32)};
        entry.pending=pending;
      }
      entry.lastAttempt=now;entry.at=now;this.persist(ledger);
      const receipt=await send({...job,feedbackKey:pending.deliveryKey},pending.text);
      if(receipt?.confirmed!==true)return false;
      if(critical)entry.critical=[...entry.critical,stamp].slice(-12);else{entry.count++;entry.lastAt=now;if(pending.quoteHash){const recentKey=hash(job.conversationKey);ledger.data.recent[recentKey]=[...(ledger.data.recent[recentKey]??[]),pending.quoteHash].slice(-12);}}
      delete entry.pending;if(terminal)entry.done=true;this.persist(ledger);return true;
    }finally{this.inFlight.delete(job.id);}
  }
}
