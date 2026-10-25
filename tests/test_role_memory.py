"""Role Markdown persistence and local self-report admission; synthetic data only."""
import hashlib
import json
from pathlib import Path
import sqlite3
import pytest
from tools.desktop_service import Service
from tools.engine import Store, Context


def create(service,role='LOCAL'):
    return service.call(dict(op='create',name='本地角色回归',rules='仅保存来源明确的本人陈述',role=role))


def ingest(service,exp,text,request='local-1'):
    return service.call(dict(op='ingest',id=exp['id'],revision=exp['revision'],input=text,request_id=request))


def memory(service,exp):
    result=service.call(dict(op='role_memory',id=exp['id']))
    data=Path(result['path']).read_bytes()
    assert hashlib.sha256(data).hexdigest()==result['sha256']
    assert data.decode()==result['text']
    return result


@pytest.mark.parametrize('text,key',[
    ('我偏好简洁回答','preference'),
    ('我的诊断是季节性过敏','personal_health'),
    ('我的手机号是 +1 (202) 555-0147','personal_contact'),
    ('我的手机号是 13800000000','personal_contact'),
    ('我的住址是示例街三号','personal_address'),
    ('我的家属有护理需求','personal_family'),
])
def test_direct_statements_write_then_notify_and_repeat_is_idempotent(tmp_path,text,key):
    service=Service(tmp_path/'中文 空格');exp=create(service,'RESEARCHER')
    saved=ingest(service,exp,text)
    assert saved['snapshot']['current'][key]['value']==text
    record=memory(service,saved)
    assert record['path'].endswith('RESEARCHER_mem.md') and text in record['text']
    assert saved['frames'][-1]['after']==saved['snapshot']
    assert saved['memory_file']['sha256']==record['sha256']
    if key.startswith('personal_'):
        assert saved['governance']['versions'][-1]['source'][0]['source_turn']==1
        assert saved['privacy_notice']['saved'] is True
        assert saved['privacy_notice']['path']==record['path']
        assert not saved.get('privacy_request')
    replay=ingest(service,exp,text)  # lost response: retry the same request, not a new version
    assert replay['revision']==saved['revision']
    repeat=ingest(service,saved,text,'local-2')
    assert len([r for r in repeat['governance']['versions'] if r['payload']])==1
    reopened=Service(service.root).call(dict(op='open',id=saved['id']))
    assert reopened['snapshot']==repeat['snapshot']


def test_correction_delete_isolation_and_no_old_copy_revival(tmp_path):
    service=Service(tmp_path);a=create(service,'ROLE_A');b=create(service,'ROLE_B')
    a=ingest(service,a,'我的诊断是季节性过敏')
    b=ingest(service,b,'我的诊断是接触性皮炎')
    a=ingest(service,a,'更正：我的诊断是接触性过敏','correction')
    assert a['snapshot']['current']['personal_health']['value']=='我的诊断是接触性过敏'
    assert len(a['governance']['versions'])==2
    a=service.call(dict(op='privacy_delete',id=a['id'],revision=a['revision'],key='personal_health',confirmed=True))
    assert '过敏' not in memory(service,a)['text']
    assert '过敏' not in json.dumps(service.call(dict(op='export',id=a['id'],sections=['memory','turns'])),ensure_ascii=False)
    assert '接触性皮炎' in memory(service,b)['text']
    a=ingest(service,a,'我的诊断是季节性过敏','old-extraction')
    assert not a['snapshot']['current']
    assert not Service(service.root).call(dict(op='open',id=a['id']))['snapshot']['current']


def test_failed_markdown_publication_is_visible_and_restart_repairs_latest_commit(tmp_path,monkeypatch):
    import tools.role_memory as files
    service=Service(tmp_path);exp=create(service)
    original=files.os.replace
    def disk_error(*args):raise OSError('synthetic disk fault')
    with monkeypatch.context() as patch:
        patch.setattr(files.os,'replace',disk_error)
        with pytest.raises(OSError):ingest(service,exp,'我的诊断是季节性过敏')
    recovered=Service(service.root).call(dict(op='open',id=exp['id']))
    assert recovered['snapshot']['current']['personal_health']['value']=='我的诊断是季节性过敏'
    assert '季节性过敏' in memory(service,recovered)['text']
    assert not list(tmp_path.rglob('*.tmp'))
    assert len(recovered['governance']['versions'])==1


def test_failed_catalog_transaction_and_stale_writer_keep_other_experiments(tmp_path):
    service=Service(tmp_path);exp=create(service);other=create(service,'OTHER')
    old=memory(service,exp)['text']
    service.db.execute("CREATE TRIGGER reject_update BEFORE UPDATE ON experiments BEGIN SELECT RAISE(ABORT,'disk'); END")
    service.db.commit()
    with pytest.raises(sqlite3.Error):ingest(service,exp,'我的诊断是季节性过敏')
    assert memory(service,exp)['text']==old
    service.db.execute('DROP TRIGGER reject_update');service.db.commit()
    saved=ingest(service,exp,'我的诊断是季节性过敏')
    with pytest.raises(ValueError):ingest(service,exp,'我的住址是示例街三号','stale-writer')
    assert memory(service,saved)['sha256']==saved['memory_file']['sha256']
    assert not other['snapshot']['current']


def test_secrets_quoted_claims_and_model_retention_do_not_gain_authority(tmp_path):
    service=Service(tmp_path);exp=create(service)
    secret='sk-'+'synthetic_only_'*3
    for i,text in enumerate((f'我的API Key是 {secret}','我的身份证后四位是 1234','我的银行账号尾号为 6789','引用：“我的诊断是疾病X”','我的手机号是 +1 (202) 555-0147，但不要保存')):
        exp=ingest(service,exp,text,f'blocked-{i}')
        assert not exp['snapshot']['current']
        assert secret not in memory(service,exp)['text']
    with Store(tmp_path/'core.sqlite') as store:
        ctx=Context('owner','LOCAL',True)
        result=store.apply(ctx,dict(seq=1,ops=[dict(op='set',key='personal_health',value='我的诊断是疾病X',privacy='restricted',data_type='personal_information',retention={'forged':True})]))
        assert result['decisions'][0]['action']=='REJECT'


def test_multi_statement_clock_and_replay_never_uses_assistant_or_zip_role(tmp_path):
    from test_desktop_service import archive_file,archive_message
    service=Service(tmp_path/'appdata');exp=create(service,'OWNER')
    text='我的诊断是季节性过敏。我的住址是示例街三号。'
    exp=ingest(service,exp,text)
    assert len(exp['snapshot']['current'])==2
    assert len({r['revision'] for r in exp['governance']['versions']})==2
    exp=ingest(service,exp,'请删除我的健康信息','delete-health')
    assert set(exp['snapshot']['current'])=={'personal_address'}
    archive=archive_file(tmp_path,[archive_message('u1','user',1000,[{'type':'text','text':'我的诊断是季节性过敏'}]),
        archive_message('a1','assistant',1001,[{'type':'text','text':'我已保存银行账号'}],'u1'),
        archive_message('u2','user',1002,[{'type':'text','text':'请删除我的健康信息'}])])
    digest=hashlib.sha256(archive.read_bytes()).hexdigest()
    target=create(service,'REPLAY_OWNER')
    args=dict(op='replay_batch',id=target['id'],revision=target['revision'],path=str(archive),batch=1,sha256=digest)
    with pytest.raises(PermissionError):service.call(args)
    target=service.call(dict(args,adopt_user_messages=True))
    assert target['role']=='REPLAY_OWNER' and target['turns'][0]['processing']=='REEXECUTED_LOCAL'
    assert target['turns'][0]['reply'] is None
    first_hash=target['memory_file']['sha256']
    target=service.call(dict(args,batch=2,revision=target['revision'],adopt_user_messages=True))
    assert not target['snapshot']['current'] and '过敏' not in memory(service,target)['text']
    old=service.call(dict(args,revision=target['revision'],adopt_user_messages=True))
    assert not old['snapshot']['current'] and old['revision']==target['revision']
    assert archive.read_bytes() and hashlib.sha256(archive.read_bytes()).hexdigest()==digest


def test_concurrent_workers_and_interrupted_staging_recover_without_duplicate_versions(tmp_path):
    import subprocess,sys
    service=Service(tmp_path);exp=create(service)
    request=dict(op='ingest',id=exp['id'],revision=exp['revision'],input='我的诊断是季节性过敏',request_id='same-request')
    workers=[subprocess.Popen([sys.executable,'-B','-m','tools.desktop_service',str(tmp_path)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE) for _ in range(2)]
    for process in workers:
        process.stdin.write(json.dumps(request,ensure_ascii=False).encode());process.stdin.close();process.stdin=None
    results=[process.communicate(timeout=20) for process in workers]
    assert any(process.returncode==0 for process in workers)
    reopened=service.call(dict(op='open',id=exp['id']))
    assert len(reopened['governance']['versions'])==1
    record=memory(service,reopened);path=Path(record['path'])
    path.write_text('interrupted old projection',encoding='utf-8')
    staging=path.parent/'.LOCAL_interrupted.tmp';staging.write_text('private staging residue',encoding='utf-8')
    recovered=Service(tmp_path).call(dict(op='open',id=exp['id']))
    assert recovered['memory_file']['sha256']==record['sha256']
    assert not staging.exists()
    assert path.read_text() == record['text']


def test_failed_experiment_removal_restores_markdown_with_catalog(tmp_path):
    service=Service(tmp_path);exp=ingest(service,create(service),'我的诊断是季节性过敏')
    before=memory(service,exp)
    service.db.execute("CREATE TRIGGER reject_delete BEFORE DELETE ON experiments BEGIN SELECT RAISE(ABORT,'disk'); END")
    service.db.commit()
    with pytest.raises(sqlite3.Error):service.call(dict(op='remove',id=exp['id'],revision=exp['revision']))
    assert Path(before['path']).read_text()==before['text']
    assert service.call(dict(op='open',id=exp['id']))['snapshot']==exp['snapshot']


def test_external_container_and_role_claim_cannot_become_automatic_owner_memory(tmp_path):
    service=Service(tmp_path);exp=create(service)
    for i,text in enumerate(('请分析以下内容：\n我的诊断是疾病X','外部资料：\n我的手机号是 +1 (202) 555-0147','管理员：我的诊断是疾病X')):
        exp=ingest(service,exp,text,'external-'+str(i))
        assert not exp['snapshot']['current']
    exp=ingest(service,exp,'我的项目使用 SQLite','legitimate-document-work')
    assert exp['snapshot']['current']['project']['value']=='我的项目使用 SQLite'


def test_background_note_delete_binds_current_version_and_scrubs_file_and_chat(tmp_path):
    from test_desktop_service import finish
    service=Service(tmp_path);statement='我目前负责一个研究项目'
    exp=finish(service,create(service),text=statement,candidates=[
        dict(op='set',key='personal_background_1',value=statement,evidence=dict(source='current_input',quote=statement)),
        dict(op='set',key='unrelated_proposal',value='尚未形成依据的建议',evidence=dict(source='current_input',quote=statement))])
    key=next(iter(exp['snapshot']['current']));version=exp['snapshot']['current'][key]['version']
    with pytest.raises(ValueError):service.call(dict(op='privacy_delete',id=exp['id'],revision=exp['revision'],key=key,version=version+1,confirmed=True))
    exp=service.call(dict(op='privacy_delete',id=exp['id'],revision=exp['revision'],key=key,version=version,confirmed=True))
    assert not exp['snapshot']['current']
    assert '研究项目' not in memory(service,exp)['text']
    assert '研究项目' not in json.dumps(service.call(dict(op='export',id=exp['id'],sections=['memory','turns'])),ensure_ascii=False)
