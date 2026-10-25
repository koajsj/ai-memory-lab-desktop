"""Desktop boundary: model proposals cannot grant authority; session and core commit together."""
import json
import os
import sqlite3
import subprocess
import sys
import zipfile
from pathlib import Path
import pytest
from tools.desktop_service import Service
from tools.chat_archive import inspect_chat_archive
from tools.check_native_worker import check as check_native_worker

@pytest.fixture
def service(tmp_path):
    return Service(tmp_path/'中文 实验')

def create(s):
    return s.call({'op':'create','name':'实验','rules':'保留来源，拒绝越权。'})

def archive_file(tmp_path, messages, member='chat/export/session.json'):
    path=tmp_path/'conversation.zip'
    # ZipInfo rewrites Windows separators on write; patch both headers to retain raw unsafe names.
    stored_member=member.replace('\\','/')
    with zipfile.ZipFile(path,'w',compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(stored_member,json.dumps({'info':{'id':'session-1'},'messages':messages}))
    if stored_member!=member:
        raw=path.read_bytes()
        encoded=stored_member.encode()
        assert raw.count(encoded)==2, 'local and central ZIP member names must both be patched'
        path.write_bytes(raw.replace(encoded,member.encode()))
    return path

def archive_message(ident,role,at,parts,parent=None):
    info={'id':ident,'sessionID':'session-1','role':role,'time':{'created':at}}
    if parent:info['parentID']=parent
    return {'info':info,'parts':parts}

def test_chat_archive_groups_actual_messages_without_promoting_internal_parts(tmp_path):
    messages=[
        archive_message('u1','user',1000,[{'type':'text','text':'第一批输入'}]),
        archive_message('a1','assistant',1001,[{'type':'reasoning','text':'不可展示的内部内容'},{'type':'text','text':'第一批答复'},{'type':'tool','state':{'secret':'不可展示的工具数据'}}],'u1'),
        archive_message('a2','assistant',1002,[{'type':'step-start'}],'u1'),
        archive_message('u2','user',1003,[{'type':'text','text':'第二批输入'}]),
        archive_message('a3','assistant',1004,[{'type':'text','text':'第二批答复'}],'u2'),
    ]
    result=inspect_chat_archive(archive_file(tmp_path,messages))
    assert result['counts']=={'batches':2,'messages':5,'user':2,'assistant':3,'assistant_with_text':2}
    assert [len(batch['assistant']) for batch in result['batches']]==[2,1]
    assert result['batches'][0]['assistant'][0]['text']=='第一批答复'
    assert result['batches'][0]['assistant'][1]['text']==''
    assert result['historical_memory_evidence'] is False
    assert '不可展示' not in json.dumps(result,ensure_ascii=False)

@pytest.mark.parametrize('member',[('../escape.json'),('/absolute.json'),('chat\\export\\session.json')])
def test_chat_archive_rejects_unsafe_members(tmp_path,member,monkeypatch):
    path=archive_file(tmp_path,[archive_message('u1','user',1000,[{'type':'text','text':'输入'}])],member)
    for separator,alternate in (('/',None),('\\','/')):
        with monkeypatch.context() as environment:
            environment.setattr(zipfile.os,'sep',separator)
            environment.setattr(zipfile.os,'altsep',alternate)
            with pytest.raises(ValueError):inspect_chat_archive(path)

def test_chat_archive_rejects_bad_order_and_unknown_parent_without_partial_import(tmp_path):
    base=[archive_message('u1','user',1000,[{'type':'text','text':'输入'}]),
          archive_message('a1','assistant',1001,[{'type':'text','text':'回复'}],'u1')]
    for messages in ([base[1],base[0]], [base[0],{**base[1],'info':{**base[1]['info'],'parentID':'unknown'}}]):
        with pytest.raises(ValueError):inspect_chat_archive(archive_file(tmp_path,messages))

def test_chat_archive_rejects_bomb_and_corruption(tmp_path):
    path=tmp_path/'bomb.zip'
    with zipfile.ZipFile(path,'w',compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('chat/export/session.json',b'x'*5_000_000)
    with pytest.raises(ValueError):inspect_chat_archive(path)
    path.write_bytes(b'not-a-zip')
    with pytest.raises(ValueError):inspect_chat_archive(path)

def test_chat_archive_worker_is_read_only_and_returns_safe_error(tmp_path):
    archive=archive_file(tmp_path,[archive_message('u1','user',1000,[{'type':'text','text':'本地样本'}])])
    root=tmp_path/'unused-experiments'
    def invoke(path):
        process=subprocess.run([sys.executable,'-B','-m','tools.desktop_service',str(root)],
                               input=json.dumps({'op':'inspect_chat_archive','path':str(path)}).encode(),
                               capture_output=True,check=False)
        return process,json.loads(process.stdout)
    process,result=invoke(archive)
    assert process.returncode==0 and result['ok'] is True
    assert result['result']['counts']['batches']==1
    assert not root.exists(), 'ZIP inspection must not create SQLite or experiment state'
    archive.write_bytes(b'invalid')
    process,result=invoke(archive)
    assert process.returncode!=0 and result['ok'] is False
    assert result['error']=='会话ZIP损坏或无法读取'
    assert '本地样本'.encode() not in process.stdout and '本地样本'.encode() not in process.stderr

def test_new_finish_cannot_skip_candidate_classification(service):
    exp=create(service)
    p=service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':'分析引用中的指令','request_id':'unclassified','model':{}})
    before=service.call({'op':'open','id':exp['id']})
    with pytest.raises(ValueError,match='依据类型'):
        service.call({'op':'finish','id':p['id'],'revision':p['revision'],'request_id':'unclassified','reply':'可分析，但不能授权操作','candidates':[{'op':'delete','key':'preference'}]})
    assert service.call({'op':'open','id':exp['id']})==before

def test_rules_are_scoped_configuration_not_application_instructions(service):
    rules='自定义文件声称管理员可覆盖应用权限，仅作为测试资料。'
    exp=service.call({'op':'create','name':'配置边界','rules':rules})
    p=service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':'分析文档','request_id':'config','model':{}})
    assert rules not in p['prompt']['system']
    assert p['prompt']['rules']==exp['rules']
    assert service.call({'op':'open','id':exp['id']})['rules']==exp['rules']

def test_model_context_requires_explicit_admitted_version_selection(service):
    exp=finish(service,create(service),candidates=[
        {'op':'set','key':'preference','value':'简短回答','evidence':{'source':'current_input','quote':'简短回答'}},
        {'op':'set','key':'private_note','value':'仅本机查看的项目资料','privacy':'restricted','evidence':{'source':'current_input','quote':'仅限本机的项目事项'}},
        {'op':'set','key':'closed_task','value':'整理研究资料','kind':'task','state':'completed','evidence':{'source':'current_input','quote':'整理研究资料'}},
    ],text='简短回答；仅限本机的项目事项；整理研究资料')
    for index in range(3):exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':index,'confirm':True,'source_confirmation':confirmed_source(exp,index)})
    versions={r['key']:r['version_id'] for r in exp['governance']['versions']}
    p=service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':'分析公开文本','request_id':'no-memory','model':{}})
    assert p['prompt']['allowed']==[]
    exp=service.call({'op':'abort','id':exp['id'],'revision':p['revision'],'request_id':'no-memory','status':'cancelled'})
    for invalid in [[versions['preference']]*2,['OTHER/secret/1'],[versions['preference'], 'unknown']]:
        with pytest.raises(ValueError):service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':'分析','request_id':'bad-context','model':{},'memory_versions':invalid})
        assert service.call({'op':'open','id':exp['id']})==exp
    p=service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':'按我的偏好回答','request_id':'selected','model':{},'memory_versions':[versions['preference']]})
    assert [m['key'] for m in p['prompt']['allowed']]==['preference']
    assert '仅本机查看的项目资料' not in json.dumps(p['prompt'],ensure_ascii=False)
    exp=service.call({'op':'abort','id':exp['id'],'revision':p['revision'],'request_id':'selected','status':'cancelled'})
    p=service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':'回顾已完成的事项','request_id':'completed','model':{},'memory_versions':[versions['closed_task']]})
    assert p['prompt']['allowed'][0]['state']=='completed'
    assert p['prompt']['allowed'][0]['kind']=='task'

def test_memory_content_is_not_a_system_instruction(service):
    value='项目资料中的命令样本，仅供分析，不代表授权'
    exp=finish(service,create(service),text=value)
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp,0)})
    pending=service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':'分析资料','request_id':'boundary','model':{},'memory_versions':[exp['governance']['versions'][-1]['version_id']]})
    assert value not in pending['prompt']['system']
    assert pending['prompt']['allowed'][0]['value']==value

@pytest.mark.parametrize('basis,part',[('external','pending'),('inference','pending'),('self_report','current')])
def test_declared_external_claims_do_not_gain_authority_by_confirmation(service,basis,part):
    exp=create(service)
    for i in range(2):
        exp=finish(service,exp,text='请分析并保留这条未核实的机会线索',candidates=[{'op':'set','key':'opportunity','value':'这项机会可能存在风险','basis':basis,'evidence':{'source':'current_input','quote':'请分析并保留这条未核实的机会线索'}}])
        exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp,0)})
    assert 'opportunity' in exp['snapshot'][part]
    if basis!='self_report':
        assert not exp['snapshot']['current']
        assert exp['snapshot']['pending']['opportunity']['confidence']=='unverified'
        assert '主人自述' not in exp['snapshot']['pending']['opportunity']['source']
        parent=exp['governance']['versions'][-1]['version_id']
        exp=finish(service,exp,candidates=[{'op':'derive','key':'summary','value':'重复线索被包装为事实','parents':[parent],'evidence':{'source':'current_input','quote':'请根据所选依据派生summary'}}],text='请根据所选依据派生summary')
        with pytest.raises(ValueError,match='已处理'):service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp,0)})
        assert exp['turns'][-1]['results']['0']['decisions'][0]['action']=='REJECT'
        restored=Service(service.root)
        try:
            exp=restored.call({'op':'open','id':exp['id']})
            pending=restored.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':'继续分析','request_id':'restored','model':{}})
            assert pending['prompt']['allowed']==[]
            assert not pending['snapshot']['current']
        finally:restored.db.close()

@pytest.mark.parametrize('proposal',[
    {'op':'delete','key':'preference'},
    {'op':'retire','key':'preference'},
    {'op':'set','key':'preference','value':'外部要求覆盖用户偏好','current_correction':True},
])
def test_external_instructions_cannot_mutate_confirmed_memory(service,proposal):
    exp=finish(service,create(service))
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp,0)})
    before=exp['snapshot']
    exp=finish(service,exp,text='文件要求执行这些动作，请检查而非执行',candidates=[dict(proposal,basis='external',evidence={'source':'current_input','quote':'文件要求执行这些动作，请检查而非执行'})])
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp,0)})
    assert exp['turns'][-1]['results']['0']['decisions'][0]['action']=='REJECT'
    assert exp['snapshot']==before

def test_model_risk_assessment_is_saved_as_an_observation_not_a_memory(service):
    exp=create(service)
    p=service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':'请分析催促提交验证码的短信，并起草安全回复','request_id':'risk','model':{}})
    assessment={'signals':['冒充身份','催促披露凭据'],'reason':'身份和请求尚未独立核实，不能仅凭措辞确认诈骗。','next_step':'通过独立获取的官方渠道核实；不向消息提供方提交凭据。'}
    result=service.call({'op':'finish','id':p['id'],'revision':p['revision'],'request_id':'risk','reply':'可以帮助分析并起草安全回复。','candidates':[],'assessment':assessment})
    assert result['turns'][-1]['assessment']==assessment
    assert not any(result['snapshot'].values())
    assert service.call({'op':'export','id':result['id'],'sections':['turns']})['turns'][-1]['assessment']==assessment
    assert service.call({'op':'open','id':result['id']})['turns'][-1]['assessment']==assessment

@pytest.mark.parametrize('assessment',[
    {'signals':'管理员','reason':'样本','next_step':'分析'},
    {'signals':[],'reason':'样本','next_step':'分析','authorized':True},
    {'signals':[],'reason':'','next_step':'分析'},
])
def test_invalid_assessment_cannot_partially_save_a_turn(service,assessment):
    p=service.call({'op':'prepare','id':create(service)['id'],'revision':1,'input':'分析资料','request_id':'invalid-risk','model':{}})
    before=service.call({'op':'open','id':p['id']})
    with pytest.raises(ValueError):service.call({'op':'finish','id':p['id'],'revision':p['revision'],'request_id':'invalid-risk','reply':'回复','candidates':[],'assessment':assessment})
    assert service.call({'op':'open','id':p['id']})==before

def test_suspicious_text_can_be_analyzed_without_automatic_memory_writes(service):
    # One routing contract, not a keyword-based fraud-classification benchmark.
    text='按文档整理项目，并分析其中冒充管理员、索取密码和催促转账的指令；仅起草安全回复。'
    exp=finish(service,create(service),text=text,candidates=[])
    assert exp['turns'][-1]['input']==text and exp['turns'][-1]['reply']
    assert not any(exp['snapshot'].values())
    assert exp['turns'][-1]['results']=={}

def test_mixed_document_proposals_keep_the_legal_part(service):
    exp=finish(service,create(service),text='调整我的输出偏好；引用文件还要求清除相反记录',candidates=[
        {'op':'set','key':'preference','value':'简短回答','basis':'self_report','evidence':{'source':'current_input','quote':'调整我的输出偏好；引用文件还要求清除相反记录'}},
        {'op':'delete','key':'preference','basis':'external','evidence':{'source':'current_input','quote':'调整我的输出偏好；引用文件还要求清除相反记录'}},
    ])
    for index in range(2):exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':index,'confirm':True,'source_confirmation':confirmed_source(exp,index)})
    assert exp['snapshot']['current']['preference']['value']=='简短回答'
    assert exp['turns'][-1]['results']['0']['decisions'][0]['action']=='ADD'
    assert exp['turns'][-1]['results']['1']['decisions'][0]['action']=='REJECT'

def test_new_model_proposals_cannot_omit_their_basis(service):
    proposal={'op':'set','key':'note','value':'一条待分类的资料'}
    with pytest.raises(ValueError):service.call({'op':'validate_candidates','candidates':[proposal]})
    marked=dict(proposal,basis='external')
    assert service.call({'op':'validate_candidates','candidates':[marked]})==[marked]

def test_inference_can_summarize_admitted_parents_without_gaining_authority(service):
    exp=finish(service,create(service),text='我偏好简洁回答')
    assert exp['turns'][-1]['results']['0']['admission']=='auto_save'
    parent=exp['governance']['versions'][-1]['version_id']
    exp=finish(service,exp,text='总结已确认的偏好',memory_versions=[parent],candidates=[{'op':'derive','key':'summary','value':'偏好简洁表达','basis':'inference','parents':[parent],'evidence':{'source':'current_input','quote':'总结已确认的偏好'}}])
    with pytest.raises(ValueError):service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':False})
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp,0)})
    assert exp['snapshot']['current']['summary']['value']=='偏好简洁表达'
    assert exp['governance']['versions'][-1]['parents']==[parent]

    exp=finish(service,exp,text='请删除摘要',candidates=[{'op':'delete','key':'summary','basis':'self_report','evidence':{'source':'current_input','quote':'请删除摘要'}}])
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp)})
    for key,conditions in (('summary',{'reactivate':True}),('other_summary',{'current_correction':True}),('closed_summary',{'state':'completed'})):
        proposal={'op':'derive','key':key,'value':'偏好简洁表达','basis':'inference','parents':[parent],
                  'evidence':{'source':'memory','version_id':parent,'quote':'我偏好简洁回答'},**conditions}
        exp=finish(service,exp,text='只检查现有根依据，不是新的本人陈述',memory_versions=[parent],candidates=[proposal])
        before=exp['snapshot']
        exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True})
        assert exp['turns'][-1]['results']['0']['decisions'][0]['action']=='REJECT'
        assert exp['snapshot']==before
    restored=Service(service.root)
    try:
        assert restored.call({'op':'open','id':exp['id']})['snapshot']==before
        assert 'summary' not in restored.call({'op':'export','id':exp['id'],'sections':['memory']})['snapshot']['current']
    finally:restored.db.close()

def confirmed_source(exp,index=0):
    # Explicit test-side owner action; never invent or backfill a model's evidence.
    return dict(round=len(exp['turns']),index=index,evidence=exp['turns'][-1]['candidates'][index].get('evidence'),candidate=exp['turns'][-1]['candidates'][index])

def finish(s,exp,text='喜欢短回答',candidates=None,memory_versions=None):
    p=s.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':text,'request_id':'r'+str(exp['revision']),'memory_versions':memory_versions or [],'model':{'name':'local','protocol':'openai','model':'test'}})
    proposed=candidates if candidates is not None else [{'op':'set','key':'preference','value':text,'evidence':{'source':'current_input','quote':text}}]
    return s.call({'op':'finish','id':exp['id'],'revision':p['revision'],'request_id':p['pending']['request_id'],'reply':'这是实际HTTP返回样本','usage':None,'candidates':[{'basis':'self_report',**c} for c in proposed]})

def test_clear_owner_preference_is_saved_with_finish_without_a_second_confirmation(service):
    exp=create(service)
    statement='我偏好简洁回答'
    proposal={'op':'set','key':'reply_preference','value':'简洁回答',
              'evidence':{'source':'current_input','quote':statement}}
    exp=finish(service,exp,text=statement,candidates=[proposal])
    assert exp['snapshot']['current']['reply_preference']['value']=='简洁回答'
    assert exp['turns'][-1]['results']['0']['admission']=='auto_save'
    assert exp['frames'][-1]['after']==exp['snapshot']
    assert exp['frames'][-1]['decisions'][-1]['action']=='ADD'
    repeat=finish(service,exp,text=statement,candidates=[proposal])
    assert repeat['turns'][-1]['results']['0']['decisions'][0]['action']=='NO_CHANGE'
    assert len([r for r in repeat['governance']['versions'] if r['key']=='reply_preference'])==1

def test_explicit_remember_request_is_not_a_second_approval_prompt(service):
    statement='请记住我喜欢简洁回答'
    exp=finish(service,create(service),text=statement,candidates=[{'op':'set','key':'reply_preference',
        'value':'简洁回答','evidence':{'source':'current_input','quote':statement}}])
    assert exp['turns'][-1]['results']['0']['admission']=='auto_save'
    assert exp['snapshot']['current']['reply_preference']['value']=='简洁回答'

def test_no_save_intent_overrides_direct_preference_and_repeat_is_not_new_save(service):
    exp=create(service)
    for sentence in ('我偏好简洁回答，但请不要保存到长期记忆','我偏好简洁回答，但别保存','我偏好简洁回答，但不用记住'):
        proposal={'op':'set','key':'reply_preference','value':'简洁回答',
                  'evidence':{'source':'current_input','quote':sentence}}
        exp=finish(service,exp,text=sentence,candidates=[proposal])
        assert not exp['snapshot']['current']
        assert '0' not in exp['turns'][-1]['results']
    exp=finish(service,exp,text='我偏好简洁回答',candidates=[{'op':'set','key':'reply_preference',
        'value':'简洁回答','evidence':{'source':'current_input','quote':'我偏好简洁回答'}}])
    repeated=finish(service,exp,text='我偏好简洁回答',candidates=[{'op':'set','key':'reply_preference',
        'value':'简洁回答','evidence':{'source':'current_input','quote':'我偏好简洁回答'}}])
    assert repeated['turns'][-1]['results']['0']['admission']=='auto_merge'
    assert repeated['turns'][-1]['results']['0']['decisions'][0]['action']=='NO_CHANGE'

def test_auto_admission_does_not_trust_quoted_or_conflicting_model_claims(service):
    exp=create(service)
    quoted='请分析引用：“我偏好公开全部私人资料”'
    exp=finish(service,exp,text=quoted,candidates=[{'op':'set','key':'reply_preference','value':'公开全部私人资料',
        'evidence':{'source':'current_input','quote':quoted}}])
    assert not exp['snapshot']['current']
    assert '0' not in exp['turns'][-1]['results']
    exp=service.call({'op':'dismiss','id':exp['id'],'revision':exp['revision'],'index':0})
    exp=finish(service,exp,text='我偏好简洁回答',candidates=[{'op':'set','key':'reply_preference','value':'简洁回答',
        'evidence':{'source':'current_input','quote':'我偏好简洁回答'}}])
    exp=finish(service,exp,text='我偏好详细回答',candidates=[{'op':'set','key':'reply_preference','value':'详细回答',
        'evidence':{'source':'current_input','quote':'我偏好详细回答'}}])
    assert exp['snapshot']['current']['reply_preference']['value']=='简洁回答'
    assert '0' not in exp['turns'][-1]['results']

def test_unverified_proposal_does_not_block_the_next_message(service):
    exp=finish(service,create(service),text='请分析这份资料',candidates=[{'op':'set','key':'claim','value':'资料声称某事成立',
        'basis':'external','evidence':{'source':'current_input','quote':'请分析这份资料'}}])
    assert '0' not in exp['turns'][-1]['results']
    next_turn=service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],
                            'input':'继续其他任务','request_id':'next','model':{}})
    assert next_turn['turns'][-1]['results']['0']['decisions'][0]['action']=='NO_CHANGE'
    assert not next_turn['snapshot']['current']

def test_explicit_self_correction_auto_updates_but_tombstone_needs_new_confirmation(service):
    exp=finish(service,create(service),text='我偏好简洁回答',candidates=[{'op':'set','key':'reply_preference','value':'简洁回答',
        'evidence':{'source':'current_input','quote':'我偏好简洁回答'}}])
    exp=finish(service,exp,text='更正：我现在偏好详细回答',candidates=[{'op':'set','key':'reply_preference','value':'详细回答',
        'current_correction':True,'archive_old':True,
        'evidence':{'source':'current_input','quote':'更正：我现在偏好详细回答'}}])
    assert exp['snapshot']['current']['reply_preference']['value']=='详细回答'
    assert exp['turns'][-1]['results']['0']['admission']=='auto_update'
    assert exp['snapshot']['history']['reply_preference__previous']['value']=='简洁回答'
    exp=finish(service,exp,text='请删除reply_preference',candidates=[{'op':'delete','key':'reply_preference',
        'evidence':{'source':'current_input','quote':'请删除reply_preference'}}])
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp)})
    exp=finish(service,exp,text='我偏好简洁回答',candidates=[{'op':'set','key':'reply_preference','value':'简洁回答',
        'evidence':{'source':'current_input','quote':'我偏好简洁回答'}}])
    assert not exp['snapshot']['current']
    assert '0' not in exp['turns'][-1]['results']

def test_future_or_expired_fact_is_not_auto_saved_as_current(service):
    exp=create(service)
    text='我计划明年启动长期项目'
    for dates in ({'event_time':'9999-01-01'},{'expires_at':'2000-01-01'}):
        exp=finish(service,exp,text=text,candidates=[{'op':'set','key':'project_plan','value':'明年启动长期项目',
            'evidence':{'source':'current_input','quote':text},**dates}])
        assert not exp['snapshot']['current']
        assert '0' not in exp['turns'][-1]['results']
        exp=service.call({'op':'dismiss','id':exp['id'],'revision':exp['revision'],'index':0})

def test_project_background_is_auto_saved_but_model_supplied_retention_is_not(service):
    statement='我的项目使用 SQLite 存储实验'
    candidate={'op':'set','key':'project_storage','value':'使用 SQLite 存储实验',
               'evidence':{'source':'current_input','quote':statement}}
    exp=finish(service,create(service),text=statement,candidates=[candidate])
    assert exp['snapshot']['current']['project_storage']['value']=='使用 SQLite 存储实验'
    assert exp['turns'][-1]['results']['0']['admission']=='auto_save'
    claimed=dict(candidate,ttl='永久且无需复核')
    exp=finish(service,exp,text=statement,candidates=[claimed])
    assert '0' not in exp['turns'][-1]['results']
    assert len([r for r in exp['governance']['versions'] if r['key']=='project_storage'])==1

def test_clear_habit_and_long_term_goal_are_not_forced_into_confirmation(service):
    exp=create(service)
    examples=[('我习惯用中文撰写技术说明','writing_habit','用中文撰写技术说明'),
              ('我的目标是完成长期研究项目','long_term_goal','完成长期研究项目')]
    for sentence,key,value in examples:
        exp=finish(service,exp,text=sentence,candidates=[{'op':'set','key':key,'value':value,
            'evidence':{'source':'current_input','quote':sentence}}])
        assert exp['snapshot']['current'][key]['value']==value
        assert exp['turns'][-1]['results']['0']['admission']=='auto_save'

def test_auto_save_failure_does_not_commit_reply_or_memory(service,monkeypatch):
    from tools.engine import Store
    exp=create(service)
    statement='我偏好简洁回答'
    pending=service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':statement,
        'request_id':'auto-write-failure','model':{'name':'local','protocol':'openai','model':'test'}})
    original=Store.apply
    def failed_write(self,*args,**kwargs):
        raise OSError('synthetic storage failure')
    monkeypatch.setattr(Store,'apply',failed_write)
    with pytest.raises(OSError,match='synthetic storage failure'):
        service.call({'op':'finish','id':exp['id'],'revision':pending['revision'],
            'request_id':pending['pending']['request_id'],'reply':'模拟回复','candidates':[{
                'op':'set','key':'reply_preference','value':'简洁回答','basis':'self_report',
                'evidence':{'source':'current_input','quote':statement}}]})
    monkeypatch.setattr(Store,'apply',original)
    restored=service.call({'op':'open','id':exp['id']})
    assert restored['revision']==pending['revision']
    assert restored['pending']==pending['pending']
    assert not restored['turns'] and not restored['snapshot']['current']

def test_auto_saved_memory_can_be_deleted_without_model_and_cannot_revive(service):
    statement='我偏好简洁回答'
    proposal={'op':'set','key':'reply_preference','value':'简洁回答',
              'evidence':{'source':'current_input','quote':statement}}
    exp=finish(service,create(service),text=statement,candidates=[proposal])
    version=next(r['version_id'] for r in exp['governance']['versions'] if r['key']=='reply_preference')
    with pytest.raises(ValueError):
        service.call({'op':'memory_delete','id':exp['id'],'revision':exp['revision'],
            'key':'reply_preference','version_id':'stale','confirmed':True})
    exp=service.call({'op':'memory_delete','id':exp['id'],'revision':exp['revision'],
        'key':'reply_preference','version_id':version,'confirmed':True})
    assert 'reply_preference' not in exp['snapshot']['current']
    assert exp['frames'][-1]['decisions'][0]['action']=='DELETE'
    assert all(r['payload'] is None for r in exp['governance']['versions'] if r['key']=='reply_preference')
    exp=finish(service,exp,text=statement,candidates=[proposal])
    assert 'reply_preference' not in exp['snapshot']['current']
    assert '0' not in exp['turns'][-1]['results']

def test_restart_proposals_and_authorization(service):
    exp=create(service)
    other=service.call({'op':'create','name':'B','rules':'另一份守则'})
    exp=finish(service,exp)
    assert not exp['snapshot']['current']
    assert 'api_key' not in json.dumps(exp)
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':False})
    assert exp['snapshot']['pending']['preference']['confidence']=='unverified'
    exp=finish(service,exp)
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp,0)})
    assert exp['snapshot']['current']['preference']['value']=='喜欢短回答'
    reopened=Service(service.root).call({'op':'open','id':exp['id']})
    assert reopened==exp
    assert reopened['rules']['text']=='保留来源，拒绝越权。'
    assert not service.call({'op':'open','id':other['id']})['snapshot']['current']
    assert len(reopened['frames'])==len(reopened['turns'])==2

def test_delete_antiresurrection_and_independent_rebuild(service):
    exp=finish(service,create(service))
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp,0)})
    exp=finish(service,exp,candidates=[{'op':'delete','key':'preference','evidence':{'source':'current_input','quote':'请删除preference'}}],text='请删除preference')
    with pytest.raises(ValueError):service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':False})
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp,0)})
    assert not exp['snapshot']['current']
    assert all(not r['payload'] for r in exp['governance']['versions'] if r['key']=='preference')
    assert '喜欢短回答' not in json.dumps([f['after'] for f in exp['frames']],ensure_ascii=False)
    exp=finish(service,exp,candidates=[{'op':'set','key':'preference','value':'新的本人确认','reactivate':True,'evidence':{'source':'current_input','quote':'新的本人确认'}}],text='新的本人确认')
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp,0)})
    assert exp['snapshot']['current']['preference']['value']=='新的本人确认'

def test_stale_finish_cancel_and_atomic_failure(service):
    exp=create(service)
    p=service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':'hello','request_id':'r1','model':{}})
    with pytest.raises(ValueError):service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':'old','request_id':'r2','model':{}})
    p=service.call({'op':'abort','id':exp['id'],'revision':p['revision'],'request_id':'r1','status':'cancelled'})
    with pytest.raises(ValueError):service.call({'op':'finish','id':exp['id'],'revision':p['revision'],'request_id':'r1','reply':'stale','candidates':[]})
    exp=finish(service,p,candidates=[{'op':'set','key':'x','value':'safe','evidence':{'source':'current_input','quote':'safe'}}],text='safe')
    old=service.call({'op':'open','id':exp['id']})
    # Forced catalog failure after the core has processed its temporary DB.
    service.db.execute("CREATE TRIGGER fail BEFORE UPDATE ON experiments BEGIN SELECT RAISE(ABORT,'forced'); END")
    with pytest.raises(sqlite3.Error):service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp,0)})
    service.db.execute('DROP TRIGGER fail')
    assert service.call({'op':'open','id':exp['id']})==old

def test_damaged_core_cannot_be_opened_or_replace_saved_memory(service):
    exp=finish(service,create(service))
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp,0)})
    original=service.db.execute('SELECT state,core FROM experiments WHERE id=?',(exp['id'],)).fetchone()
    service.db.execute('UPDATE experiments SET core=? WHERE id=?',(b'',exp['id']))
    service.db.commit()
    with pytest.raises(ValueError,match='内核|损坏|不一致'):
        service.call({'op':'open','id':exp['id']})
    with pytest.raises(ValueError,match='内核|损坏|不一致'):
        service.call({'op':'rename','id':exp['id'],'revision':exp['revision'],'name':'不能覆盖'})
    assert service.db.execute('SELECT state,core FROM experiments WHERE id=?',(exp['id'],)).fetchone()==(original[0],b'')

def test_completed_experiment_removal_is_atomic_and_isolated(service):
    removed=finish(service,create(service))
    removed=service.call({'op':'decide','id':removed['id'],'revision':removed['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(removed,0)})
    retained=create(service)
    stale=removed['revision']
    removed=service.call({'op':'rename','id':removed['id'],'revision':removed['revision'],'name':'较新的名称'})
    assert removed['name']=='较新的名称'
    with pytest.raises(ValueError,match='版本|并发'):
        service.call({'op':'remove','id':removed['id'],'revision':stale})
    assert service.call({'op':'open','id':removed['id']})==removed
    service.db.execute("CREATE TRIGGER fail_remove BEFORE DELETE ON experiments BEGIN SELECT RAISE(ABORT,'forced'); END")
    with pytest.raises(sqlite3.Error):
        service.call({'op':'remove','id':removed['id'],'revision':removed['revision']})
    service.db.execute('DROP TRIGGER fail_remove')
    assert service.call({'op':'open','id':removed['id']})==removed
    assert service.call({'op':'open','id':retained['id']})==retained
    assert service.call({'op':'remove','id':removed['id'],'revision':removed['revision']}) is True
    with pytest.raises(ValueError,match='不存在'):
        service.call({'op':'open','id':removed['id']})
    with pytest.raises(ValueError,match='不存在'):
        service.call({'op':'remove','id':removed['id'],'revision':removed['revision']})
    assert service.call({'op':'open','id':retained['id']})==retained

@pytest.mark.skipif(os.name=='nt',reason='Windows tests run the actual packaged EXE in CI')
def test_packaged_worker_check_removes_completed_experiment(tmp_path):
    wrapper=tmp_path/'memory-kernel'
    root=Path(__file__).resolve().parents[1]
    wrapper.write_text(f'#!{sys.executable}\nimport sys\nsys.path.insert(0, {str(root)!r})\nfrom tools.desktop_service import main\nraise SystemExit(main())\n',encoding='utf-8')
    wrapper.chmod(0o755)
    check_native_worker(wrapper)

@pytest.mark.skipif(os.name=='nt',reason='Windows tests run the actual packaged EXE in CI')
def test_packaged_worker_failure_reports_operation_exit_and_safe_streams(tmp_path):
    wrapper=tmp_path/'memory-kernel'
    wrapper.write_text(f'#!{sys.executable}\nimport sys\nprint(\'{{"ok":false,"error":"实验操作失败：输入、状态版本或存储异常；原数据未被部分提交。","details":"api-key-SECRET"}}\')\nprint("api-key-SECRET",file=sys.stderr)\nraise SystemExit(7)\n',encoding='utf-8')
    wrapper.chmod(0o755)
    with pytest.raises(AssertionError) as caught:
        check_native_worker(wrapper)
    message=str(caught.value)
    assert 'create' in message and '7' in message and '实验操作失败' in message
    assert 'api-key-SECRET' not in message
    wrapper.write_text(f'#!{sys.executable}\nprint(\'{{"ok":false,"error":"api-key-SECRET"}}\')\nraise SystemExit(7)\n',encoding='utf-8')
    with pytest.raises(AssertionError) as caught:
        check_native_worker(wrapper)
    assert 'api-key-SECRET' not in str(caught.value)
    assert 'unrecognized error sha256=' in str(caught.value)

def test_older_experiment_without_core_digest_is_checked_before_upgrade(service):
    exp=finish(service,create(service))
    state,core=service.db.execute('SELECT state,core FROM experiments WHERE id=?',(exp['id'],)).fetchone()
    old=json.loads(state);del old['core_sha256']
    service.db.execute('UPDATE experiments SET state=? WHERE id=?',(json.dumps(old,ensure_ascii=False),exp['id']))
    service.db.commit()
    reopened=service.call({'op':'open','id':exp['id']})
    assert reopened.pop('memory_file')['revision']==old['revision']
    assert reopened==old
    upgraded=service.call({'op':'rename','id':exp['id'],'revision':exp['revision'],'name':'兼容旧实验'})
    assert upgraded['core_sha256'] and upgraded['name']=='兼容旧实验'
    service.db.execute('UPDATE experiments SET state=?,core=? WHERE id=?',(json.dumps(old,ensure_ascii=False),b'',exp['id']))
    service.db.commit()
    with pytest.raises(ValueError,match='内核|损坏|不一致'):
        service.call({'op':'open','id':exp['id']})
    assert service.db.execute('SELECT core FROM experiments WHERE id=?',(exp['id'],)).fetchone()[0]==b''

def test_corrupt_catalog_entry_does_not_hide_other_experiments(service):
    good=create(service);broken=create(service)
    service.db.execute('UPDATE experiments SET state=? WHERE id=?',('{broken',broken['id']))
    service.db.commit()
    listed=service.call({'op':'list'})
    assert any(item['id']==good['id'] and item['name']==good['name'] for item in listed)
    assert any(item['id']==broken['id'] and '损坏' in item['name'] for item in listed)
    with pytest.raises(ValueError):service.call({'op':'open','id':broken['id']})

def test_validation_export_and_rules_snapshot(service):
    exp=create(service)
    for c in ([{'op':'set','key':'x','value':'v','basis':'self_report','role':'OTHER'}],[{'op':'set','key':'x','value':'v','basis':'self_report','source_kind':'owner_direct'}]):
        p=service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':'hello','request_id':'r','model':{}})
        with pytest.raises(ValueError):service.call({'op':'finish','id':exp['id'],'revision':p['revision'],'request_id':'r','reply':'x','candidates':c})
        exp=service.call({'op':'abort','id':exp['id'],'revision':p['revision'],'request_id':'r','status':'failed'})
    out=service.call({'op':'export','id':exp['id'],'sections':['rules','memory']})
    assert 'turns' not in out and out['rules']['text']==exp['rules']['text']
    assert out['mode']=='MODEL_EXPERIMENT'
    with pytest.raises(ValueError):service.call({'op':'open','id':'../escape'})

def test_rule_provenance_is_frozen_and_legacy_remains_readable(service):
    import hashlib
    rules=Path(__file__).resolve().parents[1].joinpath('memory-rules.md').read_text(encoding='utf-8')
    source={'kind':'builtin','name':'memory-rules.md'}
    old=service.call({'op':'create','name':'内置守则','rules':rules,'rules_source':source})
    assert old['rules']=={'text':rules,'sha256':hashlib.sha256(rules.encode()).hexdigest(),'source':source}
    custom=service.call({'op':'create','name':'自定义守则','rules':'自定义规则','rules_source':{'kind':'custom','name':'我的规则.md'}})
    old=service.call({'op':'rename','id':old['id'],'revision':old['revision'],'name':'原守则不变'})
    assert old['rules']['text']==rules and custom['rules']['text']=='自定义规则'
    assert Service(service.root).call({'op':'open','id':old['id']})['rules']==old['rules']
    assert service.call({'op':'export','id':custom['id'],'sections':['rules']})['rules']==custom['rules']
    before=service.call({'op':'list'})
    for source in ({'kind':'unknown','name':'x'}, {'kind':'custom','name':''}, {'kind':'custom','name':'x','text':'injected'}):
        with pytest.raises(ValueError):service.call({'op':'create','name':'无效来源','rules':rules,'rules_source':source})
        assert service.call({'op':'list'})==before
    # Pre-provenance records continue to open without inventing their origin.
    legacy=create(service)
    assert 'source' not in legacy['rules']
    assert service.call({'op':'open','id':legacy['id']})['rules']==legacy['rules']
    legacy=finish(service,legacy)
    del legacy['turns'][0]['candidates'][0]['basis']
    service.db.execute('UPDATE experiments SET state=? WHERE id=?',(json.dumps(legacy,ensure_ascii=False),legacy['id']));service.db.commit()
    assert service.call({'op':'open','id':legacy['id']})==legacy
    with pytest.raises(ValueError,match='依据类型'):
        service.call({'op':'decide','id':legacy['id'],'revision':legacy['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(legacy,0)})
    assert service.call({'op':'open','id':legacy['id']})==legacy
    legacy=service.call({'op':'dismiss','id':legacy['id'],'revision':legacy['revision'],'index':0})
    assert not any(legacy['snapshot'].values())

def test_candidate_lineage_and_delete_cascade(service):
    exp=finish(service,create(service),text='待核实线索')
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':False})
    parent=exp['governance']['versions'][-1]['version_id']
    exp=finish(service,exp,candidates=[{'op':'derive','key':'summary','value':'洗白的摘要','parents':[parent],'evidence':{'source':'current_input','quote':'请根据所选依据派生summary'}}],text='请根据所选依据派生summary')
    with pytest.raises(ValueError,match='已处理'):service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp,0)})
    assert exp['turns'][-1]['results']['0']['decisions'][0]['action']=='REJECT'
    assert not any(r['key']=='summary' for r in exp['governance']['versions'])
    exp=finish(service,exp,text='本人确认的偏好')
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp,0)})
    parent=next(r['version_id'] for r in reversed(exp['governance']['versions']) if r['key']=='preference' and r['part']=='current')
    exp=finish(service,exp,memory_versions=[parent],candidates=[{'op':'derive','key':'summary','value':'派生摘要','parents':[parent],'evidence':{'source':'current_input','quote':'请根据所选依据派生summary'}}],text='请根据所选依据派生summary')
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp,0)})
    assert exp['snapshot']['current']['summary']['value']=='派生摘要'
    exp=finish(service,exp,candidates=[{'op':'delete','key':'preference','evidence':{'source':'current_input','quote':'请删除preference'}}],text='请删除preference')
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp,0)})
    assert not exp['snapshot']['current']
    assert all(r['payload'] is None for r in exp['governance']['versions'])
    # No erased root or derivative enters a subsequent model prompt, including chat history.
    p=service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':'继续','request_id':'next','model':{}})
    assert p['prompt']['allowed']==[]
    assert p['prompt']['messages']==[{'role':'user','content':'继续'}]

def test_generated_numeric_uuid_is_not_misclassified_as_sensitive(service,monkeypatch):
    from types import SimpleNamespace
    monkeypatch.setattr('tools.desktop_service.uuid.uuid4',lambda:SimpleNamespace(hex='01234567890123456789012345678901'))
    exp=finish(service,create(service))
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp,0)})
    assert exp['snapshot']['current']['preference']['value']=='喜欢短回答'

def test_clock_review_overdue_is_not_completed(service):
    exp=finish(service,create(service),candidates=[{'op':'set','key':'delivery','value':'仍须交付','kind':'task','due_at':'2000-01-01','evidence':{'source':'current_input','quote':'仍须交付'}}],text='仍须交付')
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp,0)})
    exp=finish(service,exp,candidates=[])
    assert exp['snapshot']['current']['delivery']['task_status']=='overdue'
    assert not exp['snapshot']['completed']
    assert exp['frames'][-1]['diff']['changed']==['current.delivery']

def test_sensitive_proposal_is_rejected_before_candidate_persistence(service):
    exp=finish(service,create(service),text='不要保存我的凭据',candidates=[{'op':'set','key':'api_key','value':'should-not-be-in-candidate-storage','evidence':{'source':'current_input','quote':'不要保存我的凭据'}}])
    assert 'should-not-be-in-candidate-storage' not in json.dumps(exp)
    assert exp['turns'][-1]['results']['0']['decisions'][0]['action']=='REJECT'
    assert not exp['snapshot']['pending'] and not exp['snapshot']['current']

def test_context_window_keeps_whole_turns_and_persisted_history(service):
    exp=create(service)
    for i in range(23):exp=finish(service,exp,text='消息'+str(i),candidates=[])
    p=service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':'继续','request_id':'next','model':{}})
    assert len(p['turns'])==23
    assert len(p['prompt']['messages'])==41
    assert p['prompt']['messages'][0]['content']=='消息3'
    assert p['prompt']['messages'][-1]['content']=='继续'

def test_conflict_cannot_bypass_admission_through_chat_history(service):
    exp=finish(service,create(service),text='旧的设备配置陈述',candidates=[
        {'op':'set','key':'configuration','value':'配置甲','event_time':'2000-01-01','evidence':{'source':'current_input','quote':'旧的设备配置陈述'}},
        {'op':'set','key':'independent_goal','value':'完成独立设计文档','evidence':{'source':'current_input','quote':'旧的设备配置陈述'}}])
    for i in range(2):
        exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':i,'confirm':True,'source_confirmation':confirmed_source(exp,i)})
    exp=finish(service,exp,text='相同生效时间但相互矛盾的新陈述',candidates=[
        {'op':'set','key':'configuration','value':'配置乙','event_time':'2000-01-01','evidence':{'source':'current_input','quote':'相同生效时间但相互矛盾的新陈述'}}])
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp,0)})
    assert exp['turns'][-1]['results']['0']['decisions'][0]['action']=='REJECT'
    goal=next(r['version_id'] for r in exp['governance']['versions'] if r['key']=='independent_goal')
    p=service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':'现在配置是什么','request_id':'after-conflict','model':{},'memory_versions':[goal]})
    assert {m['key'] for m in p['prompt']['allowed']}=={'independent_goal'}
    assert p['prompt']['messages']==[{'role':'user','content':'现在配置是什么'}]
    assert len(p['turns'])==2, 'trim model context, not the saved experiment evidence'

def test_same_turn_delete_scrubs_candidates_without_erasing_later_rebuild(service):
    exp=finish(service,create(service),candidates=[{'op':'set','key':'preference','value':'应清除的候选原值','evidence':{'source':'current_input','quote':'应清除的候选原值'}},{'op':'delete','key':'preference','evidence':{'source':'current_input','quote':'请删除preference'}}],text='应清除的候选原值' + "；" + '请删除preference')
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp,0)})
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':1,'confirm':True,'source_confirmation':confirmed_source(exp,1)})
    assert '应清除的候选原值' not in json.dumps(exp['turns'][-1]['candidates'],ensure_ascii=False)
    exp=finish(service,exp,candidates=[{'op':'set','key':'preference','value':'独立新依据','reactivate':True,'evidence':{'source':'current_input','quote':'独立新依据'}}],text='独立新依据')
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp,0)})
    exp=finish(service,exp,candidates=[])
    assert exp['turns'][-2]['candidates'][0]['value']=='独立新依据'
    assert exp['snapshot']['current']['preference']['value']=='独立新依据'

def test_expiry_cannot_reenter_prompt_through_old_chat(service,monkeypatch):
    from datetime import date
    class Clock:
        @staticmethod
        def today():return date(2098,1,1)
    monkeypatch.setattr('tools.desktop_service.date',Clock)
    exp=finish(service,create(service),text='临时安排是周五到场',candidates=[{'op':'set','key':'temporary_plan','value':'周五到场','expires_at':'2099-01-01','evidence':{'source':'current_input','quote':'临时安排是周五到场'}}])
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp,0)})
    Clock.today=staticmethod(lambda:date(2100,1,1))
    expired=exp['governance']['versions'][-1]['version_id']
    with pytest.raises(ValueError):service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'request_id':'denied-expiry','input':'现在的安排呢','model':{},'memory_versions':[expired]})
    assert service.call({'op':'open','id':exp['id']})==exp
    p=service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'request_id':'after-expiry','input':'现在的安排呢','model':{}})
    assert p['prompt']['allowed']==[]
    assert p['prompt']['messages']==[{'role':'user','content':'现在的安排呢'}]
    assert '周五到场' not in p['prompt']['system']
    # History remains locally auditable; only model context is reset.
    assert p['turns'][0]['input']=='临时安排是周五到场'


def test_clearing_candidate_preserves_independent_archived_fact(service):
    exp=finish(service,create(service),text='原先的确认事实')
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp,0)})
    exp=finish(service,exp,text='尚未证实的候选')
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':False})
    exp=finish(service,exp,candidates=[{'op':'set','key':'preference','value':'新的确认事实','current_correction':True,'archive_old':True,'evidence':{'source':'current_input','quote':'新的确认事实'}}],text='新的确认事实')
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp,0)})
    assert exp['snapshot']['history']['preference__previous']['value']=='原先的确认事实'
    assert not exp['snapshot']['pending']
    exp=finish(service,exp,candidates=[{'op':'delete','key':'preference','evidence':{'source':'current_input','quote':'请删除preference'}}],text='请删除preference')
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp,0)})
    assert not exp['snapshot']['current'] and not exp['snapshot']['history']
    assert all(r['payload'] is None for r in exp['governance']['versions'])


def test_derived_candidate_preserves_stricter_conditions(service):
    exp=finish(service,create(service),candidates=[{'op':'set','key':'basis','value':'已确认依据','expires_at':'2099-01-01','evidence':{'source':'current_input','quote':'已确认依据'}}],text='已确认依据')
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp,0)})
    parent=exp['governance']['versions'][-1]['version_id']
    exp=finish(service,exp,memory_versions=[parent],candidates=[{'op':'derive','key':'summary','value':'仅在较短期限内使用','parents':[parent],'expires_at':'2098-01-01','privacy':'restricted','evidence':{'source':'current_input','quote':'请根据所选依据派生summary'}}],text='请根据所选依据派生summary')
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp,0)})
    assert exp['snapshot']['current']['summary']['expires_at']=='2098-01-01'
    assert exp['snapshot']['current']['summary']['privacy']=='restricted'
    assert exp['governance']['versions'][-1]['parents']==[parent]


@pytest.mark.parametrize('extra',[
    {'current_correction':'false'}, {'state':'unknown'}, {'event_time':'2099-02-30'},
    {'ttl':[]}, {'privacy':'public'}, {'kind':'other'}, {'kind':'fact','due_at':'2099-01-01'},
])
def test_invalid_candidate_conditions_never_persist(service,extra):
    exp=create(service)
    p=service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':'合法输入','request_id':'invalid','model':{}})
    saved=service.call({'op':'open','id':p['id']})
    proposed=[dict(op='set',key='fact',value='候选内容',basis='self_report',**extra)]
    with pytest.raises(ValueError):service.call({'op':'validate_candidates','candidates':proposed})
    with pytest.raises(ValueError):service.call({'op':'finish','id':p['id'],'revision':p['revision'],'request_id':'invalid','reply':'实际回复','candidates':proposed})
    assert service.call({'op':'open','id':p['id']})==saved


def test_cascade_scrubbing_preserves_independent_history_in_frames(service):
    exp=create(service)
    for key,value in [('basis','根事实'),('summary','独立的早期确认')]:
        exp=finish(service,exp,candidates=[{'op':'set','key':key,'value':value,'evidence':{'source':'current_input','quote':value}}],text=value)
        exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp,0)})
    parent=next(r['version_id'] for r in exp['governance']['versions'] if r['key']=='basis')
    exp=finish(service,exp,memory_versions=[parent],candidates=[{'op':'derive','key':'summary','value':'依赖根事实的后续摘要','parents':[parent],'current_correction':True,'archive_old':True,'evidence':{'source':'current_input','quote':'请根据所选依据派生summary'}}],text='请根据所选依据派生summary')
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp,0)})
    assert exp['snapshot']['history']['summary__previous']['value']=='独立的早期确认'
    exp=finish(service,exp,candidates=[{'op':'delete','key':'basis','evidence':{'source':'current_input','quote':'请删除basis'}}],text='请删除basis')
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp,0)})
    assert exp['snapshot']['history']['summary__previous']['value']=='独立的早期确认'
    assert exp['frames'][-1]['after']==exp['snapshot']
    assert any(f['after']['history'].get('summary__previous',{}).get('value')=='独立的早期确认' for f in exp['frames'])
    assert '依赖根事实的后续摘要' not in json.dumps(exp['frames'],ensure_ascii=False)


def test_failed_reply_save_keeps_original_pending_state(service):
    exp=create(service)
    p=service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':'等待完整回复','request_id':'save-failure','model':{}})
    stored=service.call({'op':'open','id':p['id']})
    service.db.execute("CREATE TRIGGER fail_reply BEFORE UPDATE ON experiments BEGIN SELECT RAISE(ABORT,'forced save failure'); END")
    with pytest.raises(sqlite3.Error):
        service.call({'op':'finish','id':p['id'],'revision':p['revision'],'request_id':'save-failure','reply':'模型已经回复','candidates':[{'op':'set','key':'example','value':'尚未提交','basis':'self_report'}]})
    service.db.execute('DROP TRIGGER fail_reply')
    assert Service(service.root).call({'op':'open','id':p['id']})==stored
    recovered=service.call({'op':'abort','id':p['id'],'revision':p['revision'],'request_id':'save-failure','status':'interrupted'})
    assert recovered['pending'] is None and not recovered['snapshot']['current']
    assert recovered['turns'][-1]['status']=='interrupted'

# Packaging budgets apply to the real onefile payload, not a renamed launcher.
def test_kernel_packaging_budget_and_inventory(tmp_path,monkeypatch):
    import runpy
    module = runpy.run_path(str(Path(__file__).resolve().parents[1]/'app/build-kernel.py'))
    inspect = module['archive_inventory']
    class Archive:
        def __init__(self, path):
            self.toc = {'python312.dll': (0, 30, 90, 1, 'b'), 'PYZ.pyz': (30, 20, 20, 0, 'z')}
        def open_embedded_archive(self, name):
            return type('PythonArchive', (), {'toc': {'tools.engine': (), 'sqlite3': ()}})()
    binary = tmp_path/'worker.exe'
    binary.write_bytes(b'x'*100)
    report = inspect(binary, reader=Archive)
    assert report['size'] == 100
    assert report['compressed_entries_size'] == 50
    assert report['uncompressed_entries_size'] == 110
    assert report['container_overhead_size'] == 50
    assert report['largest_entries'][0]['name'] == 'python312.dll'
    assert report['python_modules'] == ['sqlite3', 'tools.engine']
    # Decimal 50 MB, strictly below; don't accept exactly the limit or a missing file.
    with binary.open('wb') as f: f.truncate(50_000_000)
    with pytest.raises(ValueError, match='50'):
        inspect(binary, reader=Archive)
    with pytest.raises(FileNotFoundError):
        inspect(tmp_path/'missing.exe', reader=Archive)
    # Host-independent archive inspection stays available, but no cancelled
    # desktop target may produce a delivery kernel.
    for host in ('darwin','linux'):
        with monkeypatch.context() as patch:
            patch.setattr(sys,'platform',host)
            patch.setattr(sys,'argv',['build-kernel.py'])
            with pytest.raises(SystemExit,match='Windows'):
                module['main']()


@pytest.mark.parametrize('operation',['delete','retire'])
def test_scope_checks_cover_history_and_derived_cleanup(tmp_path,operation):
    from dataclasses import replace
    from tools.engine import Store,Context
    with Store(tmp_path/'scoped.sqlite') as store:
        owner=Context('owner','LOCAL',True,project='project_a')
        stranger=replace(owner,project='project_b')
        store.apply(owner,{'seq':1,'ops':[{'op':'set','key':'past','value':'历史事实','state':'history'}]})
        previous=store.export_governance(owner)
        result=store.apply(stranger,{'seq':2,'ops':[{'op':operation,'key':'past'}]})
        assert result['decisions'][0]['action']=='REJECT'
        assert store.read(owner,owner.role)['history']['past']['value']=='历史事实'
        assert store.export_governance(owner)==previous
        store.apply(owner,{'seq':3,'ops':[{'op':'set','key':'basis','value':'根事实'}]})
        parent=store.inspect_memory(owner,'basis')['version_id']
        narrow=replace(owner,conversation='private_session')
        store.apply(narrow,{'seq':4,'ops':[{'op':'set','key':'summary','value':'会话专属派生'}]},scope='conversation',_derivations={'summary':[parent]})
        before=store.read(narrow,narrow.role);audit=store.export_governance(narrow)
        with pytest.raises(PermissionError):
            store.apply(owner,{'seq':5,'ops':[{'op':operation,'key':'basis'}]})
        assert store.read(narrow,narrow.role)==before
        assert store.export_governance(narrow)==audit
        store.apply(narrow,{'seq':5,'ops':[{'op':operation,'key':'basis'}]})
        assert not store.read(narrow,narrow.role)['current']


def test_sensitive_aliases_and_credentials_never_reach_candidate_storage(service):
    # Synthetic values assembled here; assertion output must not echo them.
    from tools.engine import unsafe_fact, blocked_key, sensitive, Store, Context
    for key in ('APIKey','mobileNumber','CONTACT-PHONE','identityCardNumber','联系电话','银行卡号码','contact-api-token'):
        assert blocked_key(key), 'sensitive field alias escaped normalization'
    token='sk-'+('SyntheticOnly' * 3)
    cases=[('contact_phone','138'+'00000000'),('apiKey','not-a-real-key'),('note',token),
           ('note','Bearer '+('synthetic' * 4)),('note','eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.c3ludGhldGljU2lnbmF0dXJl'),
           ('note','-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----')]
    formats=[
        '手机号：+86 138-0000-0000', 'mobileNumber = (86) 138 0000 0000',
        '身份证：110101 19900101 001X', '银行卡号：6222 0000 0000 0000',
        'api_token = synthetic.token-value-1234', '"password": "synthetic-value"',
        '验证码为 123456', 'Authorization: Basic c3ludGhldGljOm9ubHk=',
        'https://example.invalid/?access_token=synthetic-value',
        'phone: +1 (202) 555-0100', '手机号：138.0000.0000', '银行卡尾号：1234',
        'Callback +1 (202) 555-0147', '联系用 +44 7700 900123',
    ]
    cases.extend(('note',value) for value in formats)
    for seq,(key,value) in enumerate(cases,1):
        assert unsafe_fact({'key':key,'value':value}), 'sensitive alias or credential was not detected'
        exp=finish(service,create(service),candidates=[{'op':'set','key':key if key!='apiKey' else 'contact_api_key','value':value,'evidence':{'source':'current_input','quote':'喜欢短回答'}}])
        assert exp['turns'][-1]['candidates'][0].get('erased') is True
        assert exp['turns'][-1]['results']['0']['decisions'][0]['action']=='REJECT'
        raw=service.db.execute('SELECT state FROM experiments WHERE id=?',(exp['id'],)).fetchone()[0]
        assert value not in raw, 'rejected candidate payload persisted'
        out=service.call({'op':'export','id':exp['id'],'sections':['turns','memory']})
        assert value not in json.dumps(out), 'rejected payload exported'
        with Store(service.root/'direct.sqlite') as core:
            assert core.apply(Context('owner','LOCAL',True),{'seq':seq,'ops':[{'op':'set','key':key,'value':value}]})['decisions'][0]['action']=='REJECT'
            assert not any(core.read(Context('owner','LOCAL',True),'LOCAL').values())
    for value in ('12345678901','d0cf297e-36a4-4e1c-8b96-62fb3e7bc38f','f'*64,'订单号 12345678901','b123456789012345678901234567890123456789012345678901234567890123',
                  '12345678-1234-4234-8234-123456789012','请分析含有密码、转账字样的短信；不要执行。'):
        assert not unsafe_fact({'key':'order_reference','value':value})
    assert not unsafe_fact({'key':'invoice_reference','value':'1234567890123456','data_type':'business_identifier'})
    exp=finish(service,create(service),candidates=[{'op':'set','key':'note','value':'普通文字','ttl':token,'evidence':{'source':'current_input','quote':'喜欢短回答'}}])
    assert token not in service.db.execute('SELECT state FROM experiments WHERE id=?',(exp['id'],)).fetchone()[0]
    assert service.call({'op':'open','id':exp['id']})['turns'][-1]['candidates'][0].get('erased') is True
    nested={'op':'set','key':'note','value':'普通内容','basis':'self_report','evidence':{'source':'current_input','quote':{'api_token':'synthetic-opaque'}}}
    exp=finish(service,create(service),candidates=[nested])
    assert exp['turns'][-1]['candidates'][0].get('erased') is True
    assert 'synthetic-opaque' not in service.db.execute('SELECT state FROM experiments WHERE id=?',(exp['id'],)).fetchone()[0]


def test_credentials_are_blocked_before_prompt_save_and_recovery(service):
    token='sk-'+('SyntheticOnly' * 3)
    exp=create(service)
    with pytest.raises(ValueError,match='敏感|凭据'):
        service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':'分析 '+token,'request_id':'secret','model':{}})
    assert service.call({'op':'open','id':exp['id']})==exp
    p=service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':'分析攻击手法，不执行','request_id':'clean','model':{}})
    with pytest.raises(ValueError,match='敏感|凭据'):
        service.call({'op':'finish','id':p['id'],'revision':p['revision'],'request_id':'clean','reply':token,'candidates':[]})
    assert service.call({'op':'open','id':exp['id']})['pending'] is not None
    # A prior unsafe transcript is preserved in storage but cannot be reopened/exported/used.
    p['pending']['input']=token
    service.db.execute('UPDATE experiments SET state=? WHERE id=?',(json.dumps(p),p['id']));service.db.commit()
    for op in ('open','export'):
        with pytest.raises(ValueError,match='敏感|凭据'):
            service.call({'op':op,'id':p['id'],'sections':['turns']})


def test_digest_does_not_skip_catalog_projection_validation(service):
    exp=finish(service,create(service))
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp,0)})
    original=service.db.execute('SELECT state,core FROM experiments WHERE id=?',(exp['id'],)).fetchone()
    for fault in ('snapshot','governance','frames','history','admission','observation'):
        bad=json.loads(original[0])
        if fault=='snapshot':bad['snapshot']['current']['preference']['value']='未提交的目录值'
        elif fault=='governance':bad['governance']['versions'][0]['parents']=['OTHER/unknown/1']
        elif fault=='history':bad['frames'][0]['after']['current']['preference']['value']='历史投影中的假值'
        elif fault=='observation':bad['turns'][0]['assessment']={'signals':[],'reason':'历史风险记录','next_step':'核实','apiToken':'synthetic-opaque'}
        elif fault=='admission':
            record=json.loads(json.dumps(bad['governance']['versions'][0]));record['payload']['value']='api_token = synthetic-hidden-credential'
            bad['turns'][0]['admission']['memories']=[record]
        else:bad['frames']=[]
        encoded=json.dumps(bad)
        service.db.execute('UPDATE experiments SET state=? WHERE id=?',(encoded,exp['id']));service.db.commit()
        for op in ('open','rename','export'):
            with pytest.raises(ValueError,match='不一致|结构|格式|敏感|凭据'):
                service.call({'op':op,'id':exp['id'],'revision':exp['revision'],'name':'不可覆盖','sections':['memory']})
        assert service.db.execute('SELECT state,core FROM experiments WHERE id=?',(exp['id'],)).fetchone()==(encoded,original[1])
    service.db.execute('UPDATE experiments SET state=? WHERE id=?',(original[0],exp['id']));service.db.commit()
    assert service.call({'op':'open','id':exp['id']})==exp


def test_final_decision_revalidates_legacy_candidate_basis(service):
    exp=finish(service,create(service))
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp,0)})
    exp=finish(service,exp,candidates=[{'op':'delete','key':'preference','evidence':{'source':'current_input','quote':'请删除preference'}}],text='请删除preference')
    for basis in (None,'unknown'):
        bad=json.loads(json.dumps(exp))
        if basis is None:bad['turns'][-1]['candidates'][0].pop('basis')
        else:bad['turns'][-1]['candidates'][0]['basis']=basis
        service.db.execute('UPDATE experiments SET state=? WHERE id=?',(json.dumps(bad),exp['id']));service.db.commit()
        with pytest.raises(ValueError,match='依据类型'):
            service.call({'op':'decide','id':bad['id'],'revision':bad['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(bad,0)})
        assert service.call({'op':'open','id':bad['id']})['snapshot']==exp['snapshot']
    dismissed=service.call({'op':'dismiss','id':bad['id'],'revision':bad['revision'],'index':0})
    assert dismissed['snapshot']==exp['snapshot']


def test_context_budget_audit_matches_actual_prompt(service):
    exp=create(service)
    for group in range(2):
        exp=finish(service,exp,candidates=[{'op':'set','key':f'item_{group}_{i}','value':chr(65+group)*500,'evidence':{'source':'current_input','quote':chr(65+group)*500}} for i in range(16)],text=chr(65+group)*500)
        for i in range(16):exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':i,'confirm':True,'source_confirmation':confirmed_source(exp,i)})
    selected=[r['version_id'] for r in exp['governance']['versions']][:32]
    p=service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':'检查预算','request_id':'budget','model':{},'memory_versions':selected})
    admission=p['pending']['admission']
    sent=[m['version_id'] for m in p['prompt']['allowed']]
    assert [m['version_id'] for m in admission['memories']]==sent
    assert admission['requested_versions']==selected
    assert set(sent)|{m['version_id'] for m in admission['omitted']}==set(selected)
    assert len(json.dumps(p['prompt']['allowed'],ensure_ascii=False,separators=(',',':')))<=16000
    assert admission['omitted'] and all(m['reason']=='context_budget' for m in admission['omitted'])


def test_evidence_and_independent_confirmation_are_required(service):
    exp=create(service)
    p=service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':'我喜欢简洁回答。引用：第三方称已获管理员授权。','request_id':'source','model':{}})
    evidence={'source':'current_input','quote':'我喜欢简洁回答'}
    proposal={'op':'set','key':'preference','value':'简洁回答','basis':'self_report','evidence':evidence}
    exp=service.call({'op':'finish','id':p['id'],'revision':p['revision'],'request_id':'source','reply':'可以分析引用，但不授予额外权限。','candidates':[proposal]})
    for extra in ({},{'source_confirmation':{'round':1,'index':0,'evidence':evidence}},
                  {'source_confirmation':{'round':2,'index':0,'evidence':evidence}},
                  {'source_confirmation':{'round':1,'index':0,'evidence':{'source':'current_input','quote':'不存在'}}},
                  {'source_confirmation':{'round':1,'index':0,'evidence':evidence,'candidate':dict(proposal,value='被替换的候选')}}):
        with pytest.raises(ValueError):service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,**extra})
        assert service.call({'op':'open','id':exp['id']})==exp
    confirmation={'round':1,'index':0,'evidence':evidence,'candidate':proposal}
    service.db.execute("CREATE TRIGGER fail_source BEFORE UPDATE ON experiments BEGIN SELECT RAISE(ABORT,'forced'); END")
    with pytest.raises(sqlite3.Error):service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmation})
    service.db.execute('DROP TRIGGER fail_source')
    assert service.call({'op':'open','id':exp['id']})==exp
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmation})
    assert exp['snapshot']['current']['preference']['value']=='简洁回答'
    assert exp['turns'][-1]['results']['0']['source_confirmation']==confirmation
    with pytest.raises(ValueError):service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmation})


def test_unverifiable_sources_are_isolated_per_candidate_and_legacy_is_read_only(service):
    exp=create(service)
    p=service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':'我想用中文交流','request_id':'proof','model':{}})
    valid={'op':'set','key':'language','value':'中文','basis':'self_report','evidence':{'source':'current_input','quote':'我想用中文交流'}}
    invalid=[{'op':'set','key':'missing','value':'无证据','basis':'self_report'},
             {'op':'set','key':'invented','value':'伪造引文','basis':'self_report','evidence':{'source':'current_input','quote':'从未说过'}},
             {'op':'set','key':'assistant_claim','value':'助手主张','basis':'self_report','evidence':{'source':'history_assistant','round':1,'quote':'助手'}},
             {'op':'set','key':'unselected','value':'越权来源','basis':'self_report','evidence':{'source':'memory','version_id':'LOCAL/unknown/1','quote':'未知'}}]
    exp=service.call({'op':'finish','id':p['id'],'revision':p['revision'],'request_id':'proof','reply':'助手声称英语更好','candidates':invalid+[valid]})
    assert set(exp['turns'][-1]['results'])=={'0','1','2','3'}
    assert all(r['decisions'][0]['action']=='REJECT' for r in exp['turns'][-1]['results'].values())
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':4,'confirm':True,'source_confirmation':{'round':1,'index':4,'evidence':valid['evidence'],'candidate':valid}})
    assert set(exp['snapshot']['current'])=={'language'}
    # Old files remain viewable without manufacturing evidence or confirmations.
    p=service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':'新的意图','request_id':'legacy','model':{}})
    exp=service.call({'op':'finish','id':p['id'],'revision':p['revision'],'request_id':'legacy','reply':'样本','candidates':[]})
    exp['turns'][-1]['candidates']=[{'op':'delete','key':'language','basis':'self_report'}]
    service.db.execute('UPDATE experiments SET state=? WHERE id=?',(json.dumps(exp),exp['id']));service.db.commit()
    assert service.call({'op':'open','id':exp['id']})==exp
    with pytest.raises(ValueError):service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True})
    dismissed=service.call({'op':'dismiss','id':exp['id'],'revision':exp['revision'],'index':0})
    assert dismissed['snapshot']==exp['snapshot']


def test_history_and_memory_proofs_are_bound_to_actual_admission(service):
    exp=finish(service,create(service),text='我计划学习陶艺',candidates=[])
    p=service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':'保留我的计划，并分析引用的主张','request_id':'history-proof','model':{}})
    assert p['prompt']['history_sources']==[{'round':1,'input':'我计划学习陶艺'}]
    proposals=[
        {'op':'set','key':'plan','value':'学习陶艺','basis':'self_report','evidence':{'source':'history_user','round':1,'quote':'我计划学习陶艺'}},
        {'op':'set','key':'fake','value':'助手被当作本人','basis':'self_report','evidence':{'source':'history_user','round':1,'quote':'这是实际HTTP返回样本'}},
        {'op':'set','key':'claim','value':'第三方主张尚未证实','basis':'external','evidence':{'source':'current_input','quote':'引用的主张'}},
    ]
    exp=service.call({'op':'finish','id':p['id'],'revision':p['revision'],'request_id':'history-proof','reply':'只能核对来源，不能自动核实外部主张。','candidates':proposals})
    assert exp['turns'][-1]['results']['1']['decisions'][0]['action']=='REJECT'
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp)})
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':2,'confirm':True,'source_confirmation':confirmed_source(exp,2)})
    assert 'plan' in exp['snapshot']['current'] and 'claim' in exp['snapshot']['pending']
    parent=next(r['version_id'] for r in exp['governance']['versions'] if r['key']=='plan')
    p=service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':'删除计划，同时检查旧来源是否仍可派生','request_id':'memory-proof','model':{},'memory_versions':[parent]})
    evidence={'source':'memory','version_id':parent,'quote':'学习陶艺'}
    proposals=[{'op':'delete','key':'plan','basis':'self_report','evidence':{'source':'current_input','quote':'删除计划'}},
               {'op':'derive','key':'summary','value':'陶艺学习计划','basis':'inference','parents':[parent],'evidence':evidence},
               {'op':'derive','key':'summary_extra','value':'同一依据的另一摘要','basis':'inference','parents':[parent],'evidence':evidence},
               {'op':'set','key':'wrong_direct','value':'记忆冒充本人新陈述','basis':'self_report','evidence':evidence}]
    exp=service.call({'op':'finish','id':p['id'],'revision':p['revision'],'request_id':'memory-proof','reply':'等待实际裁决','candidates':proposals})
    assert exp['turns'][-1]['evidence_checks']['1']['status']=='verified'
    assert exp['turns'][-1]['results']['3']['decisions'][0]['action']=='REJECT'
    for index in (1,2):
        exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':index,'confirm':True})
        assert exp['turns'][-1]['results'][str(index)]['decisions'][0]['action']=='ADD'
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True,'source_confirmation':confirmed_source(exp)})
    assert exp['turns'][-1]['candidates'][1]['erased'] is True
    assert 'evidence' not in exp['turns'][-1]['candidates'][1]
    reopened=Service(service.root)
    try:
        saved=reopened.call({'op':'open','id':exp['id']})
        with pytest.raises(ValueError):reopened.call({'op':'decide','id':exp['id'],'revision':saved['revision'],'index':1,'confirm':True})
        assert not reopened.call({'op':'export','id':exp['id'],'sections':['memory']})['snapshot']['current']
    finally:reopened.db.close()


def test_personal_confirmation_is_bound_local_atomic_and_not_model_authority(service):
    value='+1 (202) 555-0147'
    exp=create(service)
    other=create(service)
    plan={'category':'contact','value':value,'purpose':'本地联系备忘','scope':exp['id']}
    # A mention or a model candidate cannot start a saving request.
    with pytest.raises(ValueError):service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':'联系用 '+value,'request_id':'private','model':{}})
    assert service.call({'op':'open','id':exp['id']})==exp
    review=service.call({'op':'privacy_review','id':exp['id'],'revision':exp['revision'],'plan':plan,'save_intent':True})
    token=review.pop('privacy_token');request=review['privacy_request']['id']
    assert value.encode() not in (service.root/'experiments.sqlite').read_bytes(), 'raw personal value persisted before confirmation'
    assert value not in json.dumps(service.call({'op':'export','id':exp['id'],'sections':['turns','memory']}))
    for changed in [dict(plan,purpose='另一用途'),dict(plan,scope=other['id']),dict(plan,value='+1 (202) 555-0199')]:
        with pytest.raises(ValueError):service.call({'op':'privacy_commit','id':exp['id'],'revision':review['revision'],'request_id':request,'token':token,'plan':changed,'confirmed':True})
    with pytest.raises(ValueError):service.call({'op':'privacy_commit','id':exp['id'],'revision':review['revision'],'request_id':request,'token':token,'plan':plan,'confirmed':False})
    service.db.execute("CREATE TRIGGER deny_private BEFORE UPDATE ON experiments BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END")
    service.db.commit()
    with pytest.raises(sqlite3.Error):service.call({'op':'privacy_commit','id':exp['id'],'revision':review['revision'],'request_id':request,'token':token,'plan':plan,'confirmed':True})
    assert value.encode() not in (service.root/'experiments.sqlite').read_bytes()
    service.db.execute('DROP TRIGGER deny_private');service.db.commit()
    exp=service.call({'op':'privacy_commit','id':exp['id'],'revision':review['revision'],'request_id':request,'token':token,'plan':plan,'confirmed':True})
    assert exp['snapshot']['current']['personal_contact']['value']==value
    assert exp['snapshot']['current']['personal_contact']['retention']['purpose']==plan['purpose']
    same=service.call({'op':'privacy_review','id':exp['id'],'revision':exp['revision'],'plan':plan,'save_intent':True})
    assert same.pop('personal_already_saved') is True and same==exp
    changed=service.call({'op':'privacy_review','id':exp['id'],'revision':exp['revision'],'plan':dict(plan,purpose='另一用途'),'save_intent':True})
    same=service.call({'op':'privacy_review','id':exp['id'],'revision':changed['revision'],'plan':plan,'save_intent':True})
    assert same.pop('personal_already_saved') is True and not same.get('privacy_request')
    with pytest.raises(ValueError):service.call({'op':'privacy_commit','id':exp['id'],'revision':same['revision'],'request_id':changed['privacy_request']['id'],'token':changed['privacy_token'],'plan':dict(plan,purpose='另一用途'),'confirmed':True})
    exp=same
    assert value not in json.dumps(service.call({'op':'export','id':exp['id'],'sections':['turns']}))
    assert value not in json.dumps(exp['turns']), 'the local save must not create a sensitive chat/candidate copy'
    with pytest.raises(ValueError):service.call({'op':'privacy_commit','id':exp['id'],'revision':exp['revision'],'request_id':request,'token':token,'plan':plan,'confirmed':True})
    assert service.call({'op':'open','id':other['id']})==other
    versions=[r['version_id'] for r in exp['governance']['versions'] if r['payload']]
    with pytest.raises(ValueError):service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':'继续','request_id':'private-recall','model':{},'memory_versions':versions})
    exp=service.call({'op':'privacy_delete','id':exp['id'],'revision':exp['revision'],'key':'personal_contact','confirmed':True})
    assert value not in json.dumps(service.call({'op':'export','id':exp['id'],'sections':['turns','memory']}))
    assert value.encode() not in (service.root/'experiments.sqlite').read_bytes()
    with pytest.raises(ValueError):service.call({'op':'privacy_commit','id':exp['id'],'revision':exp['revision'],'request_id':request,'token':token,'plan':plan,'confirmed':True})


def test_personal_refusal_expiry_restart_and_high_sensitive_ban(service,monkeypatch):
    import tools.desktop_service as desktop
    for category,value in [('contact','+44 7700 900123'),('health','我的诊断是过敏性鼻炎'),('address','我的住址：示例街区三号'),('family','我的家属有一项护理需求')]:
        exp=create(service);plan={'category':category,'value':value,'purpose':'本地任务备忘','scope':exp['id']}
        with pytest.raises(ValueError):service.call({'op':'privacy_review','id':exp['id'],'revision':exp['revision'],'plan':plan,'save_intent':False})
        review=service.call({'op':'privacy_review','id':exp['id'],'revision':exp['revision'],'plan':plan,'save_intent':True})
        args={'op':'privacy_commit','id':exp['id'],'revision':review['revision'],'plan':plan,'request_id':review['privacy_request']['id'],'token':review['privacy_token'],'confirmed':True}
        if category=='contact':
            exp=service.call({'op':'privacy_cancel','id':exp['id'],'revision':review['revision']})
        elif category=='health':
            monkeypatch.setattr(desktop.time,'time',lambda:review['privacy_request']['expires_at']+1)
            with pytest.raises(ValueError):service.call(args)
            monkeypatch.undo();exp=service.call({'op':'privacy_cancel','id':exp['id'],'revision':review['revision']})
        elif category=='address':
            exp=finish(service,review,text='我喜欢条理清晰的回答',candidates=[])
        else:
            exp=service.call({'op':'privacy_commit',**{k:v for k,v in args.items() if k!='op'}})
            assert exp['snapshot']['current']['personal_family']['value']==value
            exp=service.call({'op':'privacy_delete','id':exp['id'],'revision':exp['revision'],'key':'personal_family','confirmed':True})
        reopened=Service(service.root)
        try:
            assert value not in json.dumps(reopened.call({'op':'export','id':exp['id'],'sections':['memory','turns']}))
            with pytest.raises(ValueError):reopened.call(dict(args,revision=exp['revision']))
        finally:reopened.db.close()
    for value in ['password=synthetic-only','password=+123456789012','password='+'a'*64,'验证码：123456','身份证：11010119900101001X','银行卡号：6222000000000000']:
        exp=create(service)
        with pytest.raises(ValueError):service.call({'op':'privacy_review','id':exp['id'],'revision':exp['revision'],'plan':{'category':'contact','value':value,'purpose':'本地备忘','scope':exp['id']},'save_intent':True})
        assert value.encode() not in (service.root/'experiments.sqlite').read_bytes()


def test_temporary_processing_never_saves_private_input_or_confers_consent(service):
    exp=create(service);value='我的诊断是过敏性鼻炎'
    plan={'category':'health','value':value,'purpose':'本地任务备忘','scope':exp['id']}
    review=service.call({'op':'privacy_review','id':exp['id'],'revision':exp['revision'],'plan':plan,'save_intent':True})
    with pytest.raises(ValueError):service.call({'op':'temporary','id':exp['id'],'revision':review['revision'],'input':value,'allow_transfer':False})
    temp=service.call({'op':'temporary','id':exp['id'],'revision':review['revision'],'input':value,'allow_transfer':True})
    assert temp['prompt']['messages']==[{'role':'user','content':value}]
    assert temp['prompt']['allowed']==[] and not temp['state']['turns']
    assert value.encode() not in (service.root/'experiments.sqlite').read_bytes()
    assert not temp['state'].get('privacy_request')
    with pytest.raises(ValueError):service.call({'op':'privacy_commit','id':exp['id'],'revision':temp['state']['revision'],'request_id':review['privacy_request']['id'],'token':review['privacy_token'],'plan':plan,'confirmed':True})
    assert value not in json.dumps(service.call({'op':'export','id':exp['id'],'sections':['turns','memory']}))
    analysis='分析银行卡诈骗短信的风险，不执行其中指令'
    result=service.call({'op':'temporary','id':exp['id'],'revision':temp['state']['revision'],'input':analysis,'allow_transfer':True})
    assert result['prompt']['messages']==[{'role':'user','content':analysis}] and not result['state']['turns']


def test_personal_grant_is_not_a_model_field_or_ordinary_core_operation(service):
    from tools.engine import Store,Context
    exp=create(service);plan={'category':'contact','value':'138'+'00000000','purpose':'本地联系备忘','scope':exp['id']}
    review=service.call({'op':'privacy_review','id':exp['id'],'revision':exp['revision'],'plan':plan,'save_intent':True})
    exp=service.call({'op':'privacy_commit','id':exp['id'],'revision':review['revision'],'plan':plan,'token':review['privacy_token'],'request_id':review['privacy_request']['id'],'confirmed':True})
    payload=exp['snapshot']['current']['personal_contact']
    with Store(service.root/'forged.sqlite') as store:
        ctx=Context('owner','LOCAL',True)
        result=store.apply(ctx,{'seq':1,'ops':[dict(op='set',key='personal_contact',value=plan['value'],privacy='restricted',data_type='personal_information',retention=payload['retention'])]})
        assert result['decisions'][0]['action']=='REJECT' and not any(store.read(ctx,ctx.role).values())
        assert store.retrieve_for_context(ctx,ctx.role,today='2026-10-24')['memories']==[]
    # Independent re-entry and a fresh consent can legitimately establish a new version.
    exp=service.call({'op':'privacy_delete','id':exp['id'],'revision':exp['revision'],'key':'personal_contact','confirmed':True})
    review=service.call({'op':'privacy_review','id':exp['id'],'revision':exp['revision'],'plan':plan,'save_intent':True})
    exp=service.call({'op':'privacy_commit','id':exp['id'],'revision':review['revision'],'plan':plan,'token':review['privacy_token'],'request_id':review['privacy_request']['id'],'confirmed':True})
    assert exp['snapshot']['current']['personal_contact']['version']>payload['version']


def test_admission_retains_core_denials_and_distinguishes_unselected(service):
    exp=finish(service,create(service),text='整理公开资料；偏好先列要点',candidates=[
        {'op':'set','key':'goal','value':'整理公开资料','basis':'self_report','event_time':'2099-01-01','evidence':{'source':'current_input','quote':'整理公开资料'}},
        {'op':'set','key':'preference','value':'先列要点','basis':'self_report','evidence':{'source':'current_input','quote':'偏好先列要点'}},
    ])
    for index in range(2):
        exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':index,'confirm':True,'source_confirmation':confirmed_source(exp,index)})
    vid=next(r['version_id'] for r in exp['governance']['versions'] if r['key']=='preference')
    p=service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'request_id':'no-context','input':'现在可确定什么？','include_history':False})
    assert p['pending']['admission']['denied']==[{'reason':'future'}]
    assert p['pending']['admission']['unselected']==[{'version_id':vid,'reason':'not_selected'}]
    assert p['prompt']['allowed']==[] and p['prompt']['messages']==[{'role':'user','content':'现在可确定什么？'}]
    assert p['pending']['history_rounds']==[] and p['pending']['history_omitted']==[{'round':1,'reason':'user_excluded'}]
    exp=service.call({'op':'finish','id':p['id'],'revision':p['revision'],'request_id':'no-context','reply':'模拟响应，无当前目标依据','candidates':[]})
    reopened=Service(service.root)
    try:
        assert reopened.call({'op':'open','id':exp['id']})==exp
        assert reopened.call({'op':'export','id':exp['id'],'sections':['turns']})['turns'][-1]['admission']==exp['turns'][-1]['admission']
    finally:reopened.db.close()


def test_history_opt_out_is_per_request_and_invalid_option_rolls_back(service):
    exp=finish(service,create(service),text='这是一条普通分析消息',candidates=[])
    for invalid in ('false',None,0):
        with pytest.raises(ValueError,match='聊天上下文'):
            service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':'继续','request_id':'bad-option','include_history':invalid})
        assert service.call({'op':'open','id':exp['id']})==exp
    p=service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':'正常续聊','request_id':'normal'})
    assert p['pending']['history_rounds']==[1] and p['pending']['include_history'] is True
    assert p['prompt']['messages'][0]['content']=='这是一条普通分析消息'
