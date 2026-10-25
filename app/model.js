(function(root){
  'use strict';
  const partitions=['current','completed','history','pending'];
  const states={current:{name:'当前有效',color:0x1b6c80},history:{name:'历史',color:0x737d89},pending:{name:'待核实',color:0xa86f0c},retired:{name:'已退出标记',color:0x737d89},task:{name:'进行中任务',color:0x2f70bb},completed:{name:'已完成',color:0x1b6c80}};
  const fields={personal_contact:'联系方式（本地）',personal_address:'住址（本地）',personal_health:'健康自述（本地）',personal_family:'家庭信息（本地）',project:'图册项目',preference:'回答偏好',catalogue:'图册目录',license_check:'图片许可核对',external_claim:'外部线索',summary:'线索摘要',summary_again:'二次摘要',future_goal:'未来目标',constraint:'关键约束',name:'姓名',city:'城市',occupation:'职业',family:'家庭',residence:'居住区域',commute:'通勤',health:'健康反馈',health_habit:'生活建议',spouse_job:'配偶职业',daughter_school:'子女学校',study:'学习目标',pmp:'PMP证书',intro_age:'初次自述年龄',layoff_rumor:'裁员传闻',opportunity:'招聘线索',opportunity_followup:'本人跟进任务',gym:'游泳安排',car_care:'车辆保养',med_pickup:'原取药安排',art_class:'美术班安排'};
  const protectedFields=new Set(["access_token", "account_password", "api_key", "api_token", "auth_token", "bank_account", "bank_account_number", "bank_card", "bank_card_number", "bearer_token", "cellphone", "client_secret", "contact_details", "contact_info", "contact_number", "id_card", "id_card_number", "id_number", "identity_card", "identity_card_number", "identity_number", "mobile", "mobile_number", "mobile_phone", "otp", "passcode", "password", "phone", "phone_number", "private_key", "pwd", "rules", "secret_key", "session_cookie", "system_prompt", "telephone", "token", "user_md", "verification_code", "口令", "密码", "密钥", "手机号", "手机号码", "电话", "电话号码", "短信验证码", "私钥", "联系方式", "联系电话", "访问令牌", "身份证", "身份证号", "身份证号码", "银行卡", "银行卡号", "银行卡号码", "银行账号", "银行账户", "验证码"]);
  function isProtectedKey(value){
    const key=String(value).replace(/__previous$/,'').split('__').at(-1).normalize('NFKC')
      .replace(/([A-Z]+)([A-Z][a-z])/g,'$1_$2').replace(/([a-z0-9])([A-Z])/g,'$1_$2').toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g,'_').replace(/^_+|_+$/g,'');
    return protectedFields.has(key)||[...protectedFields].some(name=>key.endsWith('_'+name));
  }
  const credentialPattern=new RegExp("(?:https?://[^\\s/@]+@|[?&](?:api[_-]?key|api[_-]?token|access[_-]?token|password|client[_-]?secret)=[^&#\\s]+|\\bsk-[A-Za-z0-9_-]{16,}|\\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{30,}|A[KS]IA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{15,})|\\b(?:Bearer|Basic)\\s+[A-Za-z0-9._~+/-]{8,}=*|\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}|-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----|(?:password|passcode|pwd|otp|verification[_ -]?code|api[_ -]?(?:key|token)|access[_ -]?token|auth[_ -]?token|client[_ -]?secret|密码|口令|动态码|(?:短信)?验证码)[\\\"\\']?\\s*(?:[=:：]|为|是)\\s*[\\\"\\']?[^\\s\\\"\\',;，；]{4,})","i");
  const publicIdPattern=new RegExp("\\b(?:[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\\b","gi");
  const sensitiveNumberPattern=new RegExp("(?<![A-Za-z0-9+])\\+[1-9](?:[\\s().-]*\\d){9,14}(?!\\d)|(?<![A-Za-z0-9])(?:\\d[\\s-]*){13,19}[xX]?(?![A-Za-z0-9])|(?:身份证(?:号码?)?|(?:银行|信用)卡(?:号码?)?|银行(?:账户|账号))(?:尾号|末四位|后四位)?\\s*(?:[:=：]|是|为)?\\s*[0-9xX* -]{4,}|(?:手机号?|手机号码|(?:联系)?电话(?:号码)?|联系方式|contact[_ -]?(?:phone|number)|telephone|phone(?:[_ -]?number)?|mobile(?:[_ -]?number)?)[\\\"\\']?\\s*(?:[:=：]|是|为)?\\s*[\\\"\\']?\\s*\\+?\\(?(?:\\d[\\s().-]*){7,15}(?!\\d)","i");
  function isSensitive(value){
    if(value&&typeof value==='object')return Object.entries(value).some(([key,item])=>isProtectedKey(key)||isSensitive(item));
    const text=String(value).normalize('NFKC');
    return credentialPattern.test(text)||sensitiveNumberPattern.test(text.replace(publicIdPattern,''));
  }
  function personalKind(value){
    const text=String(value).normalize('NFKC');
    if(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(text))return 'contact';
    if(isSensitive(text)&&/\+[1-9](?:[\s().-]*\d){9,14}(?!\d)|(?:手机号?|联系|电话|phone|mobile|telephone)[^\n]{0,20}\d/i.test(text))return 'contact';
    for(const [category,pattern]of [
      ['address',/(?:(?:我的?|家庭|居住|收货)(?:住址|地址)|我住在|home address|I live at)\s*[:：是为]?\s*\S+/i],
      ['health',/(?:我(?:的诊断|患有|确诊|有过敏|的病史|的健康)|my (?:diagnosis|medical history)|I (?:have been diagnosed|suffer from))/i],
      ['family',/(?:我的?(?:家属|配偶|孩子|子女|父亲|母亲)|my (?:spouse|child|daughter|son|parent))/i]])if(pattern.test(text))return category;
    return null;
  }
  function forbiddenPersonal(value){
    const original=String(value).normalize('NFKC');if(credentialPattern.test(original))return true;
    const text=original.replace(publicIdPattern,'').replace(/(?<![A-Za-z0-9+])\+[1-9](?:[\s().-]*\d){9,14}(?!\d)/g,'');
    return /(?<![A-Za-z0-9])(?:\d[ -]*){13,19}[xX]?(?![A-Za-z0-9])|(?:身份证(?:号码?)?|(?:银行|信用)卡(?:号码?)?|银行(?:账户|账号))(?:尾号|末四位|后四位)?\s*(?:[:=：]|是|为)?\s*[0-9xX* -]{4,}/.test(text);
  }
  function personalDraft(clock=()=>Date.now()){
    let pending=null;
    const clear=()=>{pending=null;};
    return {clear,get pending(){if(pending&&clock()>=pending.expires)clear();return !!pending;},review(plan,explicit){
      clear();assert(explicit===true,'仅在明确要求长期保存时确认');
      assert(object(plan)&&Object.keys(plan).length===4&&['contact','address','health','family'].includes(plan.category)&&typeof plan.value==='string'&&plan.value.trim()&&plan.value.length<=500&&typeof plan.purpose==='string'&&plan.purpose.trim().length>=2&&plan.purpose.length<=120&&typeof plan.scope==='string'&&plan.scope,'保存方案不完整');
      assert(!forbiddenPersonal(plan.value)&&!isSensitive(plan.purpose),'高敏禁存或用途含敏感内容');
      assert(plan.category!=='contact'||personalKind('phone:'+plan.value)==='contact','联系方式格式无法安全确认');
      const id=root.crypto.randomUUID().replaceAll('-','');pending={id,plan:{...plan},expires:clock()+120000};
      return {id,category:plan.category,purpose:plan.purpose,scope:plan.scope,masked:'已输入 '+Array.from(plan.value).length+' 个字符（原值不展示）',expires:pending.expires};
    },take(id){assert(this.pending&&pending.id===id,'确认已失效，请重新提供');const value={...pending.plan};clear();return value;}};
  }
  function personalPayload(p){
    const r=p?.retention;
    return p?.data_type==='personal_information'&&p.privacy==='restricted'&&typeof p.value==='string'&&!forbiddenPersonal(p.value)&&object(r)&&Object.keys(r).sort().join(',')==='category,purpose,request_id,scope,use'&&['contact','address','health','family','background'].includes(r.category)&&typeof r.purpose==='string'&&r.purpose.length>=2&&r.purpose.length<=120&&!isSensitive(r.purpose)&&typeof r.scope==='string'&&/^[A-Za-z0-9_./-]{1,96}$/.test(r.scope)&&/^[a-f0-9]{32}$/.test(r.request_id)&&r.use==='local_only';
  }
  const sourceNames={owner:'主人自述',stranger:'未核验第三方',push:'外部推送',system:'外部系统内容'};
  function label(k){
    const base=k.replace(/__previous$/,''),split=base.lastIndexOf('__'),field=base.slice(split+2),project=base.slice(0,split);
    const name=fields[base]||(split>=0&&fields[field]?fields[field]+(project==='default'?'':' · 项目 '+project):base);
    return name+(k.endsWith('__previous')?' · 旧版本':'');
  }
  function category(k,p){
    if(p.kind==='task')return '任务';
    if(/health|med_/.test(k))return '健康';
    if(/family|spouse|daughter|son|school/.test(k))return '家庭';
    if(/occupation|job|study|pmp|opportunity/.test(k))return '工作与学习';
    return '个人与生活';
  }
  function object(v){return !!v&&typeof v==='object'&&!Array.isArray(v);}
  function canonical(v){if(v===undefined)return 'undefined';return JSON.stringify(v&&typeof v==='object'?(Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))]))):v);}
  function assert(ok,msg){if(!ok)throw new Error(msg);}
  function guardTree(value,depth=0,count={n:0},path=[],personal=false){
    if(personal&&personalPayload(value))value={...value,value:'[本地私人记忆]'};
    assert(depth<=16&&++count.n<=120000,'数据层级或节点数超限');
    if(typeof value==='string'){
      assert(value.length<=16000,'单项文本过长');
      assert((['data.policy.sha256','policy.sha256'].includes(path.join('.'))&&/^[a-f0-9]{64}$/.test(value))||!isSensitive(value),'文本中疑似敏感长号码，拒绝导入');
    }
    else if(value&&typeof value==='object')for(const [k,v] of Object.entries(value)){
      assert(!['__proto__','prototype','constructor'].includes(k)&&!isProtectedKey(k),'数据含不安全属性');guardTree(v,depth+1,count,[...path,k],personal);
    }
  }
  function snapshot(s,personal=false){
    assert(object(s)&&Object.keys(s).every(k=>partitions.includes(k))&&partitions.every(k=>object(s[k])),'缺失或不支持的记忆分区，不推造状态');
    let total=0;
    for(const part of partitions)for(const [key,p] of Object.entries(s[part])){
      assert(++total<=250&&/^[\w-]{1,96}$/.test(key),'单轮事实超限或字段名无效');
      assert(object(p)&&typeof p.value==='string'&&!!p.value.trim()&&p.value.length<=4000&&typeof p.source==='string'&&!!p.source.trim(),'事实缺少值或来源');
      assert(Number.isSafeInteger(p.version)&&p.version>=1,'事实版本缺失或无效');
      assert(['private','restricted'].includes(p.privacy)&&['self_reported','unverified'].includes(p.confidence),'隐私或可信度标记不受支持');
      assert(!(p.confidence==='unverified'&&part!=='pending'),'未核实事实不得位于可信分区');
      assert(!isProtectedKey(key)&&p.privacy!=='high','拒绝导入高敏或治理字段');
      assert(personal&&personalPayload(p)||!isSensitive(p),'疑似敏感长号码，拒绝导入');
      if(Object.hasOwn(p,'kind'))assert(['fact','task','reminder'].includes(p.kind),'不支持的事实类型');
      if(Object.hasOwn(p,'ttl'))assert(typeof p.ttl==='string'&&!!p.ttl.trim(),'时效说明无效');
      for(const field of ['event_time','expires_at','due_at','time_floor'])if(Object.hasOwn(p,field)){
        const date=p[field];assert(typeof date==='string'&&/^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)&&Number.isFinite(Date.parse(date+'T00:00:00Z'))&&new Date(date+'T00:00:00Z').toISOString().slice(0,10)===date,'日期必须为有效ISO日期');
      }
      assert(!p.event_time||!p.expires_at||p.expires_at>=p.event_time,'失效日期早于事件日期');
      if(p.kind==='task'){assert(!Object.hasOwn(p,'expires_at'),'任务截止不能混用信息失效日');assert(['active','overdue','completed'].includes(p.task_status),'不支持的任务状态');assert(p.task_status!=='overdue'||!!p.due_at,'逾期待办缺少截止日');assert(part!=='current'||p.task_status!=='completed','完成任务不能仍在进行中分区');assert(part!=='completed'||p.task_status==='completed','完成分区任务状态不一致');}
      else assert(!Object.hasOwn(p,'task_status')&&!Object.hasOwn(p,'due_at'),'非任务不能包含任务状态或截止日');
    }
  }
  function governance(g,role,after,personal=false){
    assert(object(g)&&g.format==='memory-lab.governance.v1'&&g.policy==='V3.3'&&Array.isArray(g.versions)&&g.versions.length<=1000&&Array.isArray(g.audit),'治理证据格式不受支持');
    const map=new Map(),authority={owner_direct:'direct',external:'external',summary:'external',tool_echo:'external',inference:'external',legacy:'unknown',unknown:'unknown'};
    for(const r of g.versions){
      assert(object(r)&&typeof r.key==='string'&&/^[\w-]{1,96}$/.test(r.key)&&r.owner===role&&r.role===role&&r.memory_id===role+'/'+r.key&&partitions.includes(r.part)&&Number.isSafeInteger(r.revision)&&r.revision>=1&&r.version_id===role+'/'+r.key+'/'+r.revision&&!map.has(r.version_id),'治理版本身份不一致');
      assert(['current','completed','history','pending','superseded','quarantine','invalidated','forgotten'].includes(r.lifecycle)&&r.policy_version==='V3.3'&&['direct','external','unknown'].includes(r.authority_class),'治理状态或权威无效');
      assert(['private','restricted'].includes(r.privacy)&&['role','conversation'].includes(r.scope)&&['project','audience','conversation'].every(k=>typeof r[k]==='string'&&/^[A-Za-z][A-Za-z0-9_.:/-]{0,95}$/.test(r[k])),'治理范围无效');
      assert(Array.isArray(r.roots)&&r.roots.length>0&&r.roots.length<=128&&new Set(r.roots).size===r.roots.length&&Array.isArray(r.parents)&&r.parents.length<=32&&Array.isArray(r.source)&&Array.isArray(r.relations),'来源或派生引用缺失');
      assert(canonical([...r.roots].sort())===canonical(r.source.map(x=>x.source_id).sort())&&r.source.every(x=>object(x)&&x.role===role&&Object.hasOwn(authority,x.source_kind)&&authority[x.source_kind]===x.authority_class),'根来源与权威不一致');
      assert(r.authority_class!=='direct'||r.source.every(x=>x.authority_class==='direct'),'派生或来源权威被升级');
      assert(typeof r.created_at==='string'&&Number.isFinite(Date.parse(r.created_at)),'缺少实际接收时间');
      if(r.payload!==null){const one={current:{},completed:{},history:{},pending:{}};one[r.part][r.key]=r.payload;snapshot(one,personal);assert(r.payload.version===r.revision&&r.payload.privacy===r.privacy,'治理载荷不一致');}
      else assert(['forgotten','invalidated'].includes(r.lifecycle),'无值版本不得伪装有效');
      assert(r.lifecycle!=='forgotten'||r.payload===null,'遗忘证据不能保留原值');map.set(r.version_id,r);
    }
    for(const r of g.versions){
      assert(r.parents.every(id=>map.has(id)&&map.get(id).revision<r.revision),'派生谱系缺失、自引用或回环');
      for(const rel of r.relations)assert(object(rel)&&map.has(rel.parent)&&map.has(rel.child)&&['SUPERSEDE','DERIVE','CONTRADICT'].includes(rel.relation)&&typeof rel.unresolved==='boolean','关系缺少实际节点');
      for(const [field,earlier]of [['supersedes',true],['superseded_by',false]])if(r[field]!==null&&r[field]!==undefined)assert(map.has(r[field])&&(earlier?map.get(r[field]).revision<r.revision:map.get(r[field]).revision>r.revision),'替代链顺序无效');
      assert(canonical([...r.parents].sort())===canonical(r.relations.filter(x=>x.relation==='DERIVE'&&x.child===r.version_id).map(x=>x.parent).sort()),'派生引用与关系不一致');
    }
    for(const part of partitions)for(const [key,p]of Object.entries(after[part])){
      const r=map.get(role+'/'+key.replace(/__previous$/,'')+'/'+p.version);assert(r&&canonical(r.payload)===canonical(p),'快照与治理版本不一致');
    }
    const auditIds=new Set();
    for(const a of g.audit){
      assert(object(a)&&a.role===role&&Number.isSafeInteger(a.id)&&a.id>0&&!auditIds.has(a.id),'审计身份或标识无效');auditIds.add(a.id);
      assert(['operation','relation'].every(k=>typeof a[k]==='string'&&/^[A-Z][A-Z_]{0,63}$/.test(a[k]))&&a.policy===g.policy&&typeof a.timestamp==='string'&&Number.isFinite(Date.parse(a.timestamp)),'审计字段无效');
      assert(a.memory_id===null||(typeof a.memory_id==='string'&&a.memory_id.startsWith(role+'/')&&/^[\w-]{1,96}$/.test(a.memory_id.slice(role.length+1))),'审计记忆作用域无效');
      assert(a.version_id===null||(map.has(a.version_id)&&map.get(a.version_id).memory_id===a.memory_id),'审计版本引用无效');
    }
  }
  function adapt(raw,{personal=false}={}){
    guardTree(raw,0,{n:0},[],personal);assert(object(raw),'需要回放对象，不能导入任意日志');
    if(raw.mode==='REAL')throw new Error('REAL需可信核验与平台快照适配，当前未支持；不会根据自称认证');
    const envelope=raw.format==='memory-lab.replay.v1';
    if(raw.format)assert(envelope&&raw.mode==='SIMULATED','不支持的数据格式或来源模式');
    const data=envelope?raw.data:raw;
    assert(object(data)&&typeof data.kind==='string'&&data.kind.startsWith('本地结构化回放'),'仅支持本地结构化回放，不支持原始TeleAgent日志');
    assert(object(data.policy)&&data.policy.version==='V3.3'&&/^[a-f0-9]{64}$/.test(data.policy.sha256),'需要V3.3策略及有效哈希');
    if(envelope&&raw.policy!==undefined)assert(canonical(raw.policy)===canonical(data.policy),'外层策略与回放策略不一致');
    if(data.experiment!==undefined)assert(object(data.experiment)&&data.experiment.engine==='browser-deterministic.v1'&&data.experiment.temporary===true&&Object.keys(data.experiment).every(k=>['engine','temporary'].includes(k)),'实验记录标识不受支持');
    assert(Array.isArray(data.frames)&&data.frames.length>0&&data.frames.length<=500,'回放轮数须为1至500');
    for(const [i,f] of data.frames.entries()){
      assert(object(f)&&f.round===i+1&&typeof f.input==='string'&&typeof f.annotation==='string','轮次不连续或缺少输入/说明');
      assert(Object.hasOwn(sourceNames,f.source)&&['PASS','FAIL'].includes(f.status),'不支持的来源或验收状态');
      snapshot(f.before,personal);snapshot(f.after,personal);
      assert(Array.isArray(f.decisions)&&f.decisions.length<=100&&f.decisions.every(d=>object(d)&&['ADD','UPDATE','RETIRE','DELETE','REJECT','TEMPORARY','NO_CHANGE'].includes(d.action)&&typeof d.reason==='string'),'决策无效');
      assert(object(f.diff)&&['added','changed','removed'].every(k=>Array.isArray(f.diff[k])&&f.diff[k].every(v=>typeof v==='string'&&/^(current|completed|history|pending)\.[\w-]{1,96}$/.test(v))),'缺少有效状态差异');
    }
    // 核验展示证据的一致性；不把格式校验当作平台来源认证。
    const identities=new Map(),versions=new Map();
    for(const [i,f] of data.frames.entries()){
      for(const s of [f.before,f.after])for(const part of partitions)for(const [key,p]of Object.entries(s[part])){
        const id=part+'/'+key+'/'+p.version,value=canonical(p);assert(!identities.has(id)||identities.get(id)===value,'同一记忆ID在回放中载荷冲突');identities.set(id,value);
      }
      if(i)assert(canonical(f.before)===canonical(data.frames[i-1].after),'相邻轮次快照断链');
      // 版本上界跨移除空档保留；新决定可以重建，但不能复用旧版本。
      for(const part of partitions)for(const [key,p]of Object.entries(f.before[part]))versions.set(part+'.'+key,Math.max(versions.get(part+'.'+key)??-1,p.version));
      const seen=new Set();
      for(const kind of ['added','changed','removed'])for(const path of f.diff[kind]){
        assert(!seen.has(path),'重复或冲突的差异字段');seen.add(path);
        const [part,key]=path.split('.'),b=f.before[part][key],a=f.after[part][key];
        // 公开派生回放的撤销值已全程遮去，允许两侧均无值的既有差异标记。
        if(!a&&!b)continue;
        assert(kind==='added'?!b&&!!a:kind==='removed'?!!b&&!a:!!a&&!!b&&canonical(a)!==canonical(b),'差异与快照不一致');
      }
      for(const part of partitions)for(const key of new Set([...Object.keys(f.before[part]),...Object.keys(f.after[part])])){
        const b=f.before[part][key],a=f.after[part][key];
        if(canonical(b)!==canonical(a))assert(seen.has(part+'.'+key),'快照变化未登记差异');
        if(a&&!b)assert(a.version>(versions.get(part+'.'+key)??-1),'移除后重新出现的事实版本未递增');
        if(a)versions.set(part+'.'+key,Math.max(versions.get(part+'.'+key)??-1,a.version));
        if(a&&b){assert(a.version>=b.version,'事实版本倒退');assert(a.version!==b.version||canonical(a)===canonical(b),'同一记忆ID出现不同载荷');}
      }
    }
    assert(object(data.summary)&&['PASS','FAIL'].every(k=>data.summary[k]===data.frames.filter(f=>f.status===k).length),'统计与实际轮次不一致');
    if(data.final){snapshot(data.final,personal);assert(canonical(data.final)===canonical(data.frames.at(-1).after),'最终状态与末轮不一致');}
    const role=envelope?raw.role:'LIMING';
    assert(typeof role==='string'&&/^[A-Z0-9_-]{1,48}$/.test(role),'角色标识无效');
    for(const f of data.frames){
      if(f.governance!==undefined&&f.governance!==null)governance(f.governance,role,f.after,personal);
      if(f.admission!==undefined){
        const a=f.admission,records=new Map((f.governance?.versions||[]).map(r=>[r.version_id,r]));
        assert(object(a)&&Array.isArray(a.allowed_ids)&&a.allowed_ids.length<=1000&&Array.isArray(a.denied)&&a.denied.length<=1000,'检索准入记录格式无效');
        assert(new Set(a.allowed_ids).size===a.allowed_ids.length&&a.allowed_ids.every(id=>typeof id==='string'&&records.has(id)),'检索准入引用缺失、重复或跨角色');
        // 文件可携带准入证据，不能用allowed_ids绕过其自身的来源和谱系约束。
        function admitted(id,seen=new Set()){
          const r=records.get(id);
          if(!r||seen.has(id)||!r.payload||!['current','completed'].includes(r.lifecycle)
              ||r.authority_class!=='direct'||r.payload.confidence!=='self_reported'||r.payload.paused
              ||r.source.some(s=>s.revoked)||r.relations.some(e=>e.relation==='CONTRADICT'&&e.unresolved))return false;
          const path=new Set(seen).add(id);return r.parents.every(parent=>admitted(parent,path));
        }
        // 原回放保留“当轮曾准入”的ID，删除后仅剩无值遮蔽标记；不能据此恢复载荷。
        assert(a.allowed_ids.every(id=>{const r=records.get(id);return r.payload===null||admitted(id)&&f.after[r.part]?.[r.key]?.version===r.revision;}),'检索准入与来源、状态、快照或派生依据不一致');
        assert(a.denied.every(d=>object(d)&&typeof d.reason==='string'&&!!d.reason.trim()&&d.reason.length<=256),'检索拒绝理由无效');
      }
    }
    return {mode:'SIMULATED',role,data};
  }
  function parseJSON(text){
    assert(typeof text==='string'&&new TextEncoder().encode(text).length<=5*1024*1024,'文件超过5MB');
    const raw=JSON.parse(text),stack=[];
    // 先通过标准解析，再只扫描键，比较解码后的名称（含Unicode转义）。
    const tokens=text.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g)||[];
    for(let i=0;i<tokens.length;i++){
      const token=tokens[i];
      if(token==='{'||token==='[')stack.push(token==='{'?new Set():null);
      else if(token==='}'||token===']')stack.pop();
      else if(token.startsWith('"')&&tokens[i+1]===':'&&stack.at(-1)){
        const key=JSON.parse(token),keys=stack.at(-1);assert(!keys.has(key),'JSON含重复字段');keys.add(key);
      }
    }
    return raw;
  }
  function parse(text){return adapt(parseJSON(text));}
  function encode(ds){return JSON.stringify({format:'memory-lab.replay.v1',mode:'SIMULATED',role:ds.role,data:ds.data},null,2);}
  function hash(s){let h=2166136261;for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),16777619);return h>>>0;}
  function position(key,state){
    const h=hash(key),angle=(h%65536)/65536*Math.PI*2,radius=4.8+((h>>>16)%100)/100*3.3;
    const y={current:1.7,task:4.3,completed:4.3,history:-2.5,pending:-.5,retired:-4.3}[state];
    return [Math.cos(angle)*radius,y+((h>>>8)%100)/130,Math.sin(angle)*radius];
  }
  function graph(ds,index,{category:cat='all',state:filter='all',privateVisible=true,includeVersions=false}={}){
    const f=ds.data.frames[index];assert(f,'无效轮次');
    if(!privateVisible)return {nodes:[],edges:[],count:0};
    const evidence=new Map((f.governance?.versions||[]).map(r=>[r.version_id,r]));
    const nodes=[],edges=[],changed=new Set([...f.diff.added,...f.diff.changed,...f.diff.removed]);
    for(const part of partitions)for(const [key,p]of Object.entries(f.after[part])){
      const state=part==='current'&&p.kind==='task'?'task':part;
      const c=category(key,p);if((cat!=='all'&&cat!==c)||(filter!=='all'&&filter!==state))continue;
      const id=`${ds.role}/${part}/${key}/${p.version}`;
      nodes.push({id,key,part,state,category:c,label:label(key),payload:p,evidence:evidence.get(`${ds.role}/${key.replace(/__previous$/,'')}/${p.version}`)||null,position:position(key.replace(/__previous$/,''),state),changed:changed.has(part+'.'+key),transient:false});
      edges.push({from:'role:'+ds.role,to:id,type:'主体归属'});
    }
    const factCount=nodes.length;
    if(includeVersions)for(const r of evidence.values()){
      if(!r.payload||!['history','superseded','quarantine'].includes(r.lifecycle)||nodes.some(n=>n.evidence?.version_id===r.version_id))continue;
      const historicalState=r.lifecycle==='quarantine'?'pending':'history';if(filter!=='all'&&filter!==historicalState)continue;
      const c=category(r.key,r.payload);if(cat!=='all'&&cat!==c)continue;
      nodes.push({id:'version:'+r.version_id,key:r.key,part:r.part,state:historicalState,category:c,
        label:label(r.key)+' · '+(historicalState==='history'?'历史':'隔离')+' v'+r.revision,payload:r.payload,evidence:r,
        position:position(r.key,historicalState),changed:false,transient:false});
    }
    // 公开数据已清除删除载荷；仅把实际登记的无值证据表示为元数据节点。
    // 不恢复事实、不计入保留事实数，也不将历史准入当作当前可用内容。
    if(filter==='all'||filter==='retired')for(const r of evidence.values()){
      if(r.payload!==null||!['forgotten','invalidated'].includes(r.lifecycle))continue;
      const c=category(r.key,{});if(cat!=='all'&&cat!==c)continue;
      nodes.push({id:'evidence:'+r.version_id,key:r.key,part:r.part,state:'retired',category:c,
        label:label(r.key)+' · 已清除 v'+r.revision,payload:null,evidence:r,
        position:position(r.key,'retired'),changed:changed.has(r.part+'.'+r.key),transient:true,redacted:true});
    }
    for(const n of nodes)if(n.part==='history'&&n.key.endsWith('__previous')){
      const current=nodes.find(x=>x.part==='current'&&x.key===n.key.replace(/__previous$/,''));
      if(current&&!current.evidence?.relations.some(r=>r.parent===n.evidence?.version_id&&r.child===current.evidence.version_id&&r.relation==='SUPERSEDE'))edges.push({from:n.id,to:current.id,type:'已存储历史版本'});
    }
    const byVersion=new Map(nodes.filter(n=>n.evidence).map(n=>[n.evidence.version_id,n]));
    for(const n of nodes)for(const rel of n.evidence?.relations||[])if(rel.child===n.evidence.version_id&&byVersion.has(rel.parent)&&['DERIVE','SUPERSEDE','CONTRADICT'].includes(rel.relation)){
      const from=byVersion.get(rel.parent).id;if(!edges.some(e=>e.from===from&&e.to===n.id&&e.type===rel.relation))edges.push({from,to:n.id,type:rel.relation,unresolved:rel.unresolved});
    }
    // 退出标记只含字段名，没有撤销原值；不是新增长期记忆。
    if(filter==='all'||filter==='retired')for(const k of f.diff.removed){
      const [part,key]=k.split('.');
      if(Object.hasOwn(f.after[part],key)||nodes.some(n=>n.key===key))continue;
      const c=category(key,f.before[part][key]||{});if(cat!=='all'&&cat!==c)continue;
      nodes.push({id:`exit:${ds.role}/${k}/${f.round}`,key,part,state:'retired',category:c,label:label(key),payload:null,position:position(key,'retired'),changed:true,transient:true});
    }
    return {nodes,edges,count:factCount};
  }
  // 只投影当前帧；不从旧轮次补原值，也不把轮级理由伪装成逐字段因果。
  function roundView(ds,index,{privateVisible=true}={}){
    const f=ds.data.frames[index];assert(f,'无效轮次');
    if(!privateVisible)return {input:'当前视角不展示私人内容。',changes:[],decisions:[]};
    const versions=f.governance?.versions||[],deleting=f.decisions.some(d=>d.action==='DELETE');
    const changes=['added','changed','removed'].flatMap(kind=>f.diff[kind].map(path=>{
      const [part,key]=path.split('.'),before=f.before[part][key],after=f.after[part][key];
      const cleared=versions.some(r=>r.key===key.replace(/__previous$/,'')&&r.revision===before?.version&&r.payload===null);
      return {path,part,key,kind,label:label(key),before:cleared||deleting&&kind==='removed'?null:before?.value??null,after:after?.value??null};
    }));
    return {input:typeof f.input==='string'&&f.input.trim()?f.input:'本轮未记录输入',changes,decisions:f.decisions};
  }
  function events(ds,index){
    const result=[];
    for(const f of ds.data.frames.slice(0,index+1))for(const [i,d]of f.decisions.entries()){
      if(d.action==='REJECT'||(f.source!=='owner'&&d.action==='TEMPORARY')){
        result.push({id:`${f.round}:${i}`,round:f.round,source:sourceNames[f.source],action:d.action,reason:d.reason,target:f.source==='stranger'?'私人读取或记忆修改请求（不披露字段值）':'本轮来源与候选操作',type:d.action==='REJECT'?'已拒绝操作':d.action==='TEMPORARY'?'外部临时信息':'待核实来源'});
      }
    }
    for(const f of ds.data.frames.slice(0,index+1))if(f.diff.added.some(k=>k.startsWith('pending.'))||f.diff.changed.some(k=>k.startsWith('pending.'))){
      const retained=[...f.diff.added,...f.diff.changed].filter(k=>k.startsWith('pending.')).some(k=>Object.hasOwn(f.after.pending,k.slice(8)));
      result.push({id:`${f.round}:pending`,round:f.round,source:sourceNames[f.source],action:'OBSERVE',reason:(retained?'实际快照保留待核实记录，未提升为可信现状。':'差异记录显示待核实分区曾变化，当前派生快照未保留原值，不补造原文或当前事实。')+'OBSERVE为界面状态观察，不是额外引擎动作。',target:'待核实分区（不披露原文）',type:'待核实状态观察'});
    }
    result.sort((a,b)=>a.round-b.round);
    return result;
  }
  function controller(length){
    let index=0,playing=false,speed=1,elapsed=0;
    return {get index(){return index;},get playing(){return playing;},get speed(){return speed;},
      jump(i){assert(Number.isInteger(i)&&i>=0&&i<length,'轮次越界');index=i;elapsed=0;},
      play(){if(index===length-1)index=0;playing=length>1;elapsed=0;},pause(){playing=false;},
      setSpeed(v){assert([.5,1,2,4].includes(v),'播放速度无效');speed=v;elapsed=0;},
      tick(ms,dwell=30000/Math.max(1,length-1)){if(!playing)return false;elapsed+=ms*speed;if(elapsed<dwell)return false;elapsed%=dwell;if(index<length-1){index++;return true;}playing=false;return false;}
    };
  }
  function tour(ds){
    const f=ds.data.frames,find=pred=>f.findIndex(pred),has=action=>x=>x.decisions.some(d=>d.action===action),deleted=find(has('DELETE'));
    const stops=[{index:0,title:'形成角色记忆'},
      {index:find(has('UPDATE')),title:'新事实替代旧版本'},
      {index:find(x=>x.diff.added.some(k=>k.startsWith('completed.'))),title:'完成事项退出待办'},
      {index:find(x=>x.diff.added.some(k=>k.startsWith('pending.'))),title:'待核实内容与当前事实分开'},
      {index:find(x=>x.source==='owner'&&has('REJECT')(x)),title:'合法事实与受限请求分开处理',view:'security'},
      {index:find(x=>x.source==='stranger'&&has('REJECT')(x)),title:'未核验访问被拒绝',view:'roles'},
      {index:find((x,i)=>x.governance?.versions.some(r=>r.parents.length&&!f[i-1]?.governance?.versions.some(old=>old.version_id===r.version_id))),title:'摘要保留来源与派生谱系'},
      {index:find(x=>x.admission?.denied.some(d=>d.reason==='contradiction')),title:'冲突限制回答上下文'},
      {index:find(x=>x.admission?.denied.some(d=>d.reason==='future')),title:'未来记忆暂不准入'},
      {index:find(has('RETIRE')),title:'取消任务，独立事实保留'},
      {index:deleted,title:'删除根记录，派生内容退出'},
      {index:deleted<0?-1:find(x=>x.round>f[deleted].round&&has('REJECT')(x)),title:'删除后的请求与拒绝',view:'security'},
      {index:f.length-1,title:'最终状态与可用依据',view:'overview'}];
    const seen=new Set(),unique=stops.filter(s=>s.index>=0&&!seen.has(s.index)&&seen.add(s.index));const dwell=Math.floor(30000/unique.length)/1000;let used=0;return unique.map((s,i)=>{const seconds=i===unique.length-1?30-used:dwell;used+=seconds;return {...s,seconds};});
  }
  const api={partitions,states,sourceNames,label,category,isProtectedKey,isSensitive,personalKind,forbiddenPersonal,personalDraft,personalPayload,adapt,parse,parseJSON,encode,graph,roundView,events,position,controller,tour};
  if(typeof module!=='undefined')module.exports=api;else root.MemoryModel=api;
})(typeof window!=='undefined'?window:globalThis);
