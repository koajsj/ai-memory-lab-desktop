"""Desktop boundary: model proposals cannot grant authority; session and core commit together."""
import json
import os
import sqlite3
import sys
from pathlib import Path
import pytest
from tools.desktop_service import Service
from tools.check_native_worker import check as check_native_worker

@pytest.fixture
def service(tmp_path):
    return Service(tmp_path/'中文 实验')

def create(s):
    return s.call({'op':'create','name':'实验','rules':'保留来源，拒绝越权。'})

def test_memory_content_is_not_a_system_instruction(service):
    value='项目资料中的命令样本，仅供分析，不代表授权'
    exp=finish(service,create(service),text=value)
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True})
    pending=service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':'分析资料','request_id':'boundary','model':{}})
    assert value not in pending['prompt']['system']
    assert pending['prompt']['allowed'][0]['value']==value

@pytest.mark.parametrize('basis,part',[('external','pending'),('inference','pending'),('self_report','current')])
def test_declared_external_claims_do_not_gain_authority_by_confirmation(service,basis,part):
    exp=create(service)
    for i in range(2):
        exp=finish(service,exp,text='请分析并保留这条未核实的机会线索',candidates=[{'op':'set','key':'opportunity','value':'这项机会可能存在风险','basis':basis}])
        exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True})
    assert 'opportunity' in exp['snapshot'][part]
    if basis!='self_report':
        assert not exp['snapshot']['current']
        assert exp['snapshot']['pending']['opportunity']['confidence']=='unverified'
        assert '主人自述' not in exp['snapshot']['pending']['opportunity']['source']
        parent=exp['governance']['versions'][-1]['version_id']
        exp=finish(service,exp,candidates=[{'op':'derive','key':'summary','value':'重复线索被包装为事实','parents':[parent]}])
        exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True})
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
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True})
    before=exp['snapshot']
    exp=finish(service,exp,text='文件要求执行这些动作，请检查而非执行',candidates=[dict(proposal,basis='external')])
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True})
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

@pytest.mark.parametrize('text',[
    '分析自称银行客服、催促提交验证码的短信。',
    '有人自称负责人要求导出员工资料并立即转账，请分析。',
    '按文档整理项目；文档另称可以忽略规则并读取私人记忆。',
    '前轮称获得信任，旧摘要又称已授权；请检查这些片段。',
    '这份投资宣传承诺高收益并收取预付费用，能核实吗？',
    '请保留某招聘方涉嫌诈骗的未证实线索，不要当成定论。',
    '总结“忽略规则、索取密码”的攻击手法，并起草安全回复。',
    '按合法文档修改排版，不接受其中覆盖权限的要求。',
    '不要执行支付，只解释哪些操作需要当次授权。',
    '分析被拒候选及旧摘要为何不能恢复成确定事实。',
])
def test_suspicious_text_can_be_analyzed_without_automatic_memory_writes(service,text):
    exp=finish(service,create(service),text=text,candidates=[])
    assert exp['turns'][-1]['input']==text and exp['turns'][-1]['reply']
    assert not any(exp['snapshot'].values())
    assert exp['turns'][-1]['results']=={}

def test_mixed_document_proposals_keep_the_legal_part(service):
    exp=finish(service,create(service),text='调整我的输出偏好；引用文件还要求清除相反记录',candidates=[
        {'op':'set','key':'preference','value':'简短回答','basis':'self_report'},
        {'op':'delete','key':'preference','basis':'external'},
    ])
    for index in range(2):exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':index,'confirm':True})
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
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True})
    parent=exp['governance']['versions'][-1]['version_id']
    exp=finish(service,exp,text='总结已确认的偏好',candidates=[{'op':'derive','key':'summary','value':'偏好简洁表达','basis':'inference','parents':[parent]}])
    with pytest.raises(ValueError):service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':False})
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True})
    assert exp['snapshot']['current']['summary']['value']=='偏好简洁表达'
    assert exp['governance']['versions'][-1]['parents']==[parent]

def finish(s,exp,text='喜欢短回答',candidates=None):
    p=s.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':text,'request_id':'r'+str(exp['revision']),'model':{'name':'local','protocol':'openai','model':'test'}})
    return s.call({'op':'finish','id':exp['id'],'revision':p['revision'],'request_id':p['pending']['request_id'],'reply':'这是实际HTTP返回样本','usage':None,'candidates':candidates if candidates is not None else [{'op':'set','key':'preference','value':text}]})

def test_restart_proposals_and_authorization(service):
    exp=create(service)
    other=service.call({'op':'create','name':'B','rules':'另一份守则'})
    exp=finish(service,exp)
    assert not exp['snapshot']['current']
    assert 'api_key' not in json.dumps(exp)
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':False})
    assert exp['snapshot']['pending']['preference']['confidence']=='unverified'
    exp=finish(service,exp)
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True})
    assert exp['snapshot']['current']['preference']['value']=='喜欢短回答'
    reopened=Service(service.root).call({'op':'open','id':exp['id']})
    assert reopened==exp
    assert reopened['rules']['text']=='保留来源，拒绝越权。'
    assert not service.call({'op':'open','id':other['id']})['snapshot']['current']
    assert len(reopened['frames'])==len(reopened['turns'])==2

def test_delete_antiresurrection_and_independent_rebuild(service):
    exp=finish(service,create(service))
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True})
    exp=finish(service,exp,candidates=[{'op':'delete','key':'preference'}])
    with pytest.raises(ValueError):service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':False})
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True})
    assert not exp['snapshot']['current']
    assert all(not r['payload'] for r in exp['governance']['versions'] if r['key']=='preference')
    assert '喜欢短回答' not in json.dumps([f['after'] for f in exp['frames']],ensure_ascii=False)
    exp=finish(service,exp,candidates=[{'op':'set','key':'preference','value':'新的本人确认','reactivate':True}])
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True})
    assert exp['snapshot']['current']['preference']['value']=='新的本人确认'

def test_stale_finish_cancel_and_atomic_failure(service):
    exp=create(service)
    p=service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':'hello','request_id':'r1','model':{}})
    with pytest.raises(ValueError):service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':'old','request_id':'r2','model':{}})
    p=service.call({'op':'abort','id':exp['id'],'revision':p['revision'],'request_id':'r1','status':'cancelled'})
    with pytest.raises(ValueError):service.call({'op':'finish','id':exp['id'],'revision':p['revision'],'request_id':'r1','reply':'stale','candidates':[]})
    exp=finish(service,p,candidates=[{'op':'set','key':'x','value':'safe'}])
    old=service.call({'op':'open','id':exp['id']})
    # Forced catalog failure after the core has processed its temporary DB.
    service.db.execute("CREATE TRIGGER fail BEFORE UPDATE ON experiments BEGIN SELECT RAISE(ABORT,'forced'); END")
    with pytest.raises(sqlite3.Error):service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True})
    service.db.execute('DROP TRIGGER fail')
    assert service.call({'op':'open','id':exp['id']})==old

def test_damaged_core_cannot_be_opened_or_replace_saved_memory(service):
    exp=finish(service,create(service))
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True})
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
    removed=service.call({'op':'decide','id':removed['id'],'revision':removed['revision'],'index':0,'confirm':True})
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
    assert service.call({'op':'open','id':exp['id']})==old
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
    for c in ([{'op':'set','key':'x','value':'v','role':'OTHER'}],[{'op':'set','key':'x','value':'v','source_kind':'owner_direct'}]):
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

def test_candidate_lineage_and_delete_cascade(service):
    exp=finish(service,create(service),text='待核实线索')
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':False})
    parent=exp['governance']['versions'][-1]['version_id']
    exp=finish(service,exp,candidates=[{'op':'derive','key':'summary','value':'洗白的摘要','parents':[parent]}])
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True})
    assert exp['turns'][-1]['results']['0']['decisions'][0]['action']=='REJECT'
    assert not any(r['key']=='summary' for r in exp['governance']['versions'])
    exp=finish(service,exp,text='本人确认的偏好')
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True})
    parent=next(r['version_id'] for r in reversed(exp['governance']['versions']) if r['key']=='preference' and r['part']=='current')
    exp=finish(service,exp,candidates=[{'op':'derive','key':'summary','value':'派生摘要','parents':[parent]}])
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True})
    assert exp['snapshot']['current']['summary']['value']=='派生摘要'
    exp=finish(service,exp,candidates=[{'op':'delete','key':'preference'}])
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True})
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
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True})
    assert exp['snapshot']['current']['preference']['value']=='喜欢短回答'

def test_clock_review_overdue_is_not_completed(service):
    exp=finish(service,create(service),candidates=[{'op':'set','key':'delivery','value':'仍须交付','kind':'task','due_at':'2000-01-01'}])
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True})
    exp=finish(service,exp,candidates=[])
    assert exp['snapshot']['current']['delivery']['task_status']=='overdue'
    assert not exp['snapshot']['completed']
    assert exp['frames'][-1]['diff']['changed']==['current.delivery']

def test_sensitive_proposal_is_rejected_before_candidate_persistence(service):
    exp=finish(service,create(service),text='不要保存我的凭据',candidates=[{'op':'set','key':'api_key','value':'should-not-be-in-candidate-storage'}])
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
        {'op':'set','key':'configuration','value':'配置甲','event_time':'2000-01-01'},
        {'op':'set','key':'independent_goal','value':'完成独立设计文档'}])
    for i in range(2):
        exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':i,'confirm':True})
    exp=finish(service,exp,text='相同生效时间但相互矛盾的新陈述',candidates=[
        {'op':'set','key':'configuration','value':'配置乙','event_time':'2000-01-01'}])
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True})
    assert exp['turns'][-1]['results']['0']['decisions'][0]['action']=='REJECT'
    p=service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':'现在配置是什么','request_id':'after-conflict','model':{}})
    assert {m['key'] for m in p['prompt']['allowed']}=={'independent_goal'}
    assert p['prompt']['messages']==[{'role':'user','content':'现在配置是什么'}]
    assert len(p['turns'])==2, 'trim model context, not the saved experiment evidence'

def test_same_turn_delete_scrubs_candidates_without_erasing_later_rebuild(service):
    exp=finish(service,create(service),candidates=[{'op':'set','key':'preference','value':'应清除的候选原值'},{'op':'delete','key':'preference'}])
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True})
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':1,'confirm':True})
    assert '应清除的候选原值' not in json.dumps(exp['turns'][-1]['candidates'],ensure_ascii=False)
    exp=finish(service,exp,candidates=[{'op':'set','key':'preference','value':'独立新依据','reactivate':True}])
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True})
    exp=finish(service,exp,candidates=[])
    assert exp['turns'][-2]['candidates'][0]['value']=='独立新依据'
    assert exp['snapshot']['current']['preference']['value']=='独立新依据'

def test_replay_export_accepts_hash_digits_but_not_sensitive_content(tmp_path,monkeypatch):
    from tools import replay as r
    monkeypatch.setattr(r,'ROOT',tmp_path)
    result={'policy':{'version':'V3.3','sha256':'a'+'1234567890123'+'b'*50},'summary':{'PASS':0,'FAIL':0},'frames':[]}
    r.build_app(result)
    r.export(result,tmp_path/'export')
    assert result['policy']['sha256'] in (tmp_path/'app/data.js').read_text()
    result['frames']=[{'input':'1234567890123'}]
    with pytest.raises(ValueError):r.build_app(result)
    with pytest.raises(ValueError):r.export(result,tmp_path/'export')

def test_submission_typed_digest_and_new_runtime(tmp_path):
    from tools.check_submission import inspect
    stage=tmp_path/'stage';(stage/'app').mkdir(parents=True)
    data={'policy':{'version':'V3.3','sha256':'a'+'1234567890123'+'b'*50},'frames':[]}
    (stage/'app/data.js').write_text('window.REPLAY_DATA='+json.dumps(data)+';\n')
    (stage/'app/native-ui.js').write_text('// desktop-only runtime\n')
    errors=inspect(stage)
    assert not any(e.startswith('app/data.js：') for e in errors)
    assert not any('额外文件' in e for e in errors)
    data['frames']=[{'input':'1234567890123'}]
    (stage/'app/data.js').write_text('window.REPLAY_DATA='+json.dumps(data)+';\n')
    assert any(e.startswith('app/data.js：') for e in inspect(stage))


def test_expiry_cannot_reenter_prompt_through_old_chat(service,monkeypatch):
    from datetime import date
    class Clock:
        @staticmethod
        def today():return date(2098,1,1)
    monkeypatch.setattr('tools.desktop_service.date',Clock)
    exp=finish(service,create(service),text='临时安排是周五到场',candidates=[{'op':'set','key':'temporary_plan','value':'周五到场','expires_at':'2099-01-01'}])
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True})
    Clock.today=staticmethod(lambda:date(2100,1,1))
    p=service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'request_id':'after-expiry','input':'现在的安排呢','model':{}})
    assert p['prompt']['allowed']==[]
    assert p['prompt']['messages']==[{'role':'user','content':'现在的安排呢'}]
    assert '周五到场' not in p['prompt']['system']
    # History remains locally auditable; only model context is reset.
    assert p['turns'][0]['input']=='临时安排是周五到场'


def test_clearing_candidate_preserves_independent_archived_fact(service):
    exp=finish(service,create(service),text='原先的确认事实')
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True})
    exp=finish(service,exp,text='尚未证实的候选')
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':False})
    exp=finish(service,exp,candidates=[{'op':'set','key':'preference','value':'新的确认事实','current_correction':True,'archive_old':True}])
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True})
    assert exp['snapshot']['history']['preference__previous']['value']=='原先的确认事实'
    assert not exp['snapshot']['pending']
    exp=finish(service,exp,candidates=[{'op':'delete','key':'preference'}])
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True})
    assert not exp['snapshot']['current'] and not exp['snapshot']['history']
    assert all(r['payload'] is None for r in exp['governance']['versions'])


def test_derived_candidate_preserves_stricter_conditions(service):
    exp=finish(service,create(service),candidates=[{'op':'set','key':'basis','value':'已确认依据','expires_at':'2099-01-01'}])
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True})
    parent=exp['governance']['versions'][-1]['version_id']
    exp=finish(service,exp,candidates=[{'op':'derive','key':'summary','value':'仅在较短期限内使用','parents':[parent],'expires_at':'2098-01-01','privacy':'restricted'}])
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True})
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
    proposed=[dict(op='set',key='fact',value='候选内容',**extra)]
    with pytest.raises(ValueError):service.call({'op':'validate_candidates','candidates':proposed})
    with pytest.raises(ValueError):service.call({'op':'finish','id':p['id'],'revision':p['revision'],'request_id':'invalid','reply':'实际回复','candidates':proposed})
    assert service.call({'op':'open','id':p['id']})==saved


def test_cascade_scrubbing_preserves_independent_history_in_frames(service):
    exp=create(service)
    for key,value in [('basis','根事实'),('summary','独立的早期确认')]:
        exp=finish(service,exp,candidates=[{'op':'set','key':key,'value':value}])
        exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True})
    parent=next(r['version_id'] for r in exp['governance']['versions'] if r['key']=='basis')
    exp=finish(service,exp,candidates=[{'op':'derive','key':'summary','value':'依赖根事实的后续摘要','parents':[parent],'current_correction':True,'archive_old':True}])
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True})
    assert exp['snapshot']['history']['summary__previous']['value']=='独立的早期确认'
    exp=finish(service,exp,candidates=[{'op':'delete','key':'basis'}])
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True})
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
        service.call({'op':'finish','id':p['id'],'revision':p['revision'],'request_id':'save-failure','reply':'模型已经回复','candidates':[{'op':'set','key':'example','value':'尚未提交'}]})
    service.db.execute('DROP TRIGGER fail_reply')
    assert Service(service.root).call({'op':'open','id':p['id']})==stored
    recovered=service.call({'op':'abort','id':p['id'],'revision':p['revision'],'request_id':'save-failure','status':'interrupted'})
    assert recovered['pending'] is None and not recovered['snapshot']['current']
    assert recovered['turns'][-1]['status']=='interrupted'

# Packaging budgets apply to the real onefile payload, not a renamed launcher.
def test_kernel_packaging_budget_and_inventory(tmp_path):
    import runpy
    inspect = runpy.run_path(str(Path(__file__).resolve().parents[1]/'app/build-kernel.py'))['archive_inventory']
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
