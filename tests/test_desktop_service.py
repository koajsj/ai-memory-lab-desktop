"""Desktop boundary: model proposals cannot grant authority; session and core commit together."""
import json
import sqlite3
import pytest
from tools.desktop_service import Service

@pytest.fixture
def service(tmp_path):
    return Service(tmp_path/'中文 实验')

def create(s):
    return s.call({'op':'create','name':'实验','rules':'保留来源，拒绝越权。'})

def finish(s,exp,text='喜欢短回答',candidates=None):
    p=s.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':text,'request_id':'r'+str(exp['revision']),'model':{'name':'local','protocol':'openai','model':'test'}})
    return s.call({'op':'finish','id':exp['id'],'revision':p['revision'],'request_id':p['pending']['request_id'],'reply':'这是实际HTTP返回样本','usage':None,'candidates':candidates if candidates is not None else [{'op':'set','key':'preference','value':text}]})

def test_restart_proposals_and_authorization(service):
    exp=finish(service,create(service))
    assert not exp['snapshot']['current']
    assert 'api_key' not in json.dumps(exp)
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':False})
    assert exp['snapshot']['pending']['preference']['confidence']=='unverified'
    exp=finish(service,exp)
    exp=service.call({'op':'decide','id':exp['id'],'revision':exp['revision'],'index':0,'confirm':True})
    assert exp['snapshot']['current']['preference']['value']=='喜欢短回答'
    reopened=Service(service.root).call({'op':'open','id':exp['id']})
    assert reopened==exp

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

def test_validation_export_and_rules_snapshot(service):
    exp=create(service)
    for c in ([{'op':'set','key':'x','value':'v','role':'OTHER'}],[{'op':'set','key':'x','value':'v','source_kind':'owner_direct'}]):
        p=service.call({'op':'prepare','id':exp['id'],'revision':exp['revision'],'input':'hello','request_id':'r','model':{}})
        with pytest.raises(ValueError):service.call({'op':'finish','id':exp['id'],'revision':p['revision'],'request_id':'r','reply':'x','candidates':c})
        exp=service.call({'op':'abort','id':exp['id'],'revision':p['revision'],'request_id':'r','status':'failed'})
    out=service.call({'op':'export','id':exp['id'],'sections':['rules','memory']})
    assert 'turns' not in out and out['rules']['text']==exp['rules']['text']
    assert out['mode']=='MODEL_EXPERIMENT'
    service.call({'op':'rename','id':exp['id'],'revision':exp['revision'],'name':'改名'})
    with pytest.raises(ValueError):service.call({'op':'open','id':'../escape'})
    service.call({'op':'remove','id':exp['id']})
    assert not service.call({'op':'list'})

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

def test_rules_immutable_and_independent_experiments(service):
    a=create(service);b=service.call({'op':'create','name':'B','rules':'另一份守则'})
    a=finish(service,a)
    a=service.call({'op':'decide','id':a['id'],'revision':a['revision'],'index':0,'confirm':True})
    assert not service.call({'op':'open','id':b['id']})['snapshot']['current']
    assert service.call({'op':'open','id':a['id']})['rules']['text']=='保留来源，拒绝越权。'
    assert len(a['frames'])==len(a['turns'])==1

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
