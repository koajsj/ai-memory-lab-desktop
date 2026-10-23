//! Desktop integration: fixed Python worker, app-owned SQLite, native network and OS secrets.
use crate::model_api::{self, Message, Profile, Reply};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, Manager};
use tokio::sync::watch;

#[derive(Default)]
pub struct Runtime {
    keys: Mutex<HashMap<String, String>>,
    profiles: tokio::sync::Mutex<()>,
    requests: Mutex<HashMap<String, watch::Sender<bool>>>,
}
fn identifier(s: &str) -> Result<(), String> {
    if s.len() != 32 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("标识无效".into());
    }
    Ok(())
}
fn credential(id: &str) -> Result<keyring::Entry, String> {
    identifier(id)?;
    keyring::Entry::new("AI Memory Lab", id).map_err(|_| "系统凭据存储不可用".into())
}
fn worker(root: PathBuf, q: Value) -> Result<Value, String> {
    let mut cmd;
    if cfg!(debug_assertions) {
        cmd = Command::new(std::env::var("MEMORY_LAB_PYTHON").unwrap_or_else(|_| {
            if cfg!(windows) {
                "python".into()
            } else {
                "python3".into()
            }
        }));
        cmd.args(["-B", "-m", "tools.desktop_service"]);
        cmd.current_dir(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."));
    } else {
        let binary = std::env::current_exe()
            .map_err(|_| "无法定位程序")?
            .parent()
            .ok_or("程序目录无效")?
            .join(if cfg!(windows) {
                "memory-kernel.exe"
            } else {
                "memory-kernel"
            });
        if !binary.is_file() {
            return Err("安装缺少治理内核，请使用包含memory-kernel的完整安装器".into());
        }
        cmd = Command::new(binary);
    }
    cmd.arg(root);
    run_worker_command(cmd, q, Duration::from_secs(30))
}
fn terminate_worker(child: &mut Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // PyInstaller --onefile uses a child process. Terminate the whole tree
        // so a timed-out child cannot keep SQLite or inherited pipes open.
        if let Some(system_root) = std::env::var_os("SystemRoot").map(PathBuf::from).filter(|p| p.is_absolute()) {
            let _ = Command::new(system_root.join("System32/taskkill.exe"))
                .args(["/PID", &child.id().to_string(), "/T", "/F"])
                .creation_flags(0x08000000)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}
fn run_worker_command(mut cmd: Command, q: Value, timeout: Duration) -> Result<Value, String> {
    let input = serde_json::to_vec(&q).map_err(|_| "请求无效")?;
    if input.len() > 8 * 1024 * 1024 {
        return Err("请求过大".into());
    }
    cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let mut child = cmd
        .spawn()
        .map_err(|_| "治理内核无法启动；开发环境请设置MEMORY_LAB_PYTHON")?;
    let mut stdin = child.stdin.take().ok_or("内核输入不可用")?;
    let stdout = child.stdout.take().ok_or("内核输出不可用")?;
    // The worker may stop reading stdin. Keep the write inside the same deadline
    // as process execution so a full OS pipe cannot strand the caller forever.
    let writer = std::thread::spawn(move || stdin.write_all(&input));
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut stdout = stdout;
        let mut chunk = [0; 8192];
        let mut oversized = false;
        loop {
            let count = stdout.read(&mut chunk)?;
            if count == 0 { break; }
            if bytes.len() + count > 16 * 1024 * 1024 { oversized = true; }
            if !oversized { bytes.extend_from_slice(&chunk[..count]); }
        }
        Ok::<_, std::io::Error>((bytes, oversized))
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if start.elapsed() <= timeout => std::thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                terminate_worker(&mut child);
                // Do not join an inherited pipe held by an unresponsive child.
                return Err("治理内核超时；请重新打开实验确认保存状态".into());
            }
            Err(_) => {
                terminate_worker(&mut child);
                return Err("内核状态读取失败".into());
            }
        }
    };
    // A process can exit while its child still holds an inherited pipe open.
    // Both IO tasks share the process deadline; join only after they finish.
    while !writer.is_finished() || !reader.is_finished() {
        if start.elapsed() > timeout {
            terminate_worker(&mut child);
            return Err("治理内核超时；请重新打开实验确认保存状态".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let write_result = writer.join().map_err(|_| "内核输入任务失败")?;
    let (bytes, oversized) = reader
        .join()
        .map_err(|_| "内核读取失败")?
        .map_err(|_| "内核输出读取失败")?;
    if oversized {
        return Err("实验过大，请导出并新建实验".into());
    }
    let out: Value = serde_json::from_slice(&bytes).map_err(|_| {
        if status.success() { "内核输出格式无效".into() }
        else { format!("治理内核异常退出（退出码 {:?}）；未返回有效结果", status.code()) }
    })?;
    if !status.success() && out["ok"] == true {
        return Err(format!("治理内核异常退出（退出码 {:?}）；结果未确认", status.code()));
    }
    if write_result.is_err() && status.success() {
        return Err("内核输入失败；结果未确认".into());
    }
    if out["ok"] != true {
        let message = out["error"].as_str().unwrap_or("");
        let safe = if matches!(message, "实验达到8MB容量，请导出后新建" | "实验操作失败：输入、状态版本或存储异常；原数据未被部分提交。") {
            message.into()
        } else { "治理操作失败；内核未返回可识别的错误".into() };
        return Err(if status.success() { safe } else { format!("治理内核退出码 {:?}；{safe}", status.code()) });
    }
    Ok(out["result"].clone())
}
async fn service(app: &tauri::AppHandle, q: Value) -> Result<Value, String> {
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "数据目录不可用")?;
    tauri::async_runtime::spawn_blocking(move || worker(root, q))
        .await
        .map_err(|_| String::from("内核任务失败"))?
}
#[tauri::command]
pub async fn experiment_call(app: tauri::AppHandle, request: Value) -> Result<Value, String> {
    if !matches!(
        request["op"].as_str(),
        Some(
            "validate_candidates"
                | "list"
                | "create"
                | "open"
                | "rename"
                | "remove"
                | "prepare"
                | "finish"
                | "abort"
                | "decide"
                | "dismiss"
                | "export"
                | "profiles"
        )
    ) {
        return Err("操作未授权".into());
    }
    service(&app, request).await
}
#[tauri::command]
pub fn default_rules() -> String {
    include_str!("../../../memory-rules.md").into()
}
#[tauri::command]
pub async fn import_rules() -> Result<Option<String>, String> {
    let selected = rfd::AsyncFileDialog::new()
        .set_title("导入本实验的记忆守则")
        .add_filter("Markdown", &["md", "txt"])
        .pick_file()
        .await;
    if let Some(file) = selected {
        let bytes = file.read().await;
        if bytes.len() > 400000 {
            return Err("守则超过400KB".into());
        }
        let text = String::from_utf8(bytes).map_err(|_| "守则必须为UTF-8")?;
        if text.trim().is_empty() {
            return Err("守则为空".into());
        }
        Ok(Some(text))
    } else {
        Ok(None)
    }
}
// Credentials and SQLite cannot share a transaction. Restore the previous secret
// if the catalog write fails, and serialize reads with configuration changes.
async fn commit_profile(
    write_secret: impl FnOnce() -> Result<(), String>,
    restore_secret: impl FnOnce() -> Result<(), String>,
    write_catalog: impl std::future::Future<Output = Result<(), String>>,
) -> Result<(), String> {
    write_secret()?;
    if let Err(error) = write_catalog.await {
        restore_secret().map_err(|_| format!("{error}；系统凭据回滚失败，请重新配置此模型"))?;
        return Err(error);
    }
    Ok(())
}
fn remove_secret(entry: &keyring::Entry) -> Result<(), String> {
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("系统凭据删除失败".into()),
    }
}
#[tauri::command]
pub async fn save_profile(
    app: tauri::AppHandle,
    state: tauri::State<'_, Runtime>,
    id: String,
    profile: Profile,
    key: Option<String>,
    persist: bool,
) -> Result<(), String> {
    identifier(&id)?;
    model_api::request(&profile, key.as_deref().unwrap_or(""), "", &[], false)?;
    let _gate = state.profiles.lock().await;
    // A fresh temporary configuration works even if the OS keychain is unavailable.
    let rows = service(&app, json!({"op":"profiles"})).await?;
    let exists = rows
        .as_array()
        .ok_or("模型配置列表无效")?
        .iter()
        .any(|p| p["id"] == id);
    // None edits metadata only; an explicit string replaces the credential.
    // In particular, a blank field in the editor must not erase a saved key.
    let Some(key) = key else {
        if !exists {
            return Err("模型配置不存在，不能保留旧凭据".into());
        }
        service(&app, json!({"op":"profile_save","id":id,"profile":profile})).await?;
        return Ok(());
    };
    if persist && key.is_empty() {
        return Err("保存凭据前请填入API Key".into());
    }
    let entry = if persist || exists {
        Some(credential(&id)?)
    } else {
        None
    };
    let previous = match &entry {
        Some(e) => match e.get_password() {
            Ok(key) => Some(key),
            Err(keyring::Error::NoEntry) => None,
            Err(_) => return Err("旧系统凭据读取失败；配置未修改".into()),
        },
        None => None,
    };
    commit_profile(
        || match &entry {
            Some(e) if persist => e.set_password(&key).map_err(|_| "系统凭据保存失败".into()),
            Some(e) => remove_secret(e),
            None => Ok(()),
        },
        || match (&entry, &previous) {
            (Some(e), Some(old)) => e.set_password(old).map_err(|_| "系统凭据恢复失败".into()),
            (Some(e), None) => remove_secret(e),
            _ => Ok(()),
        },
        async {
            service(&app, json!({"op":"profile_save","id":id,"profile":profile}))
                .await
                .map(|_| ())
        },
    )
    .await?;
    state
        .keys
        .lock()
        .map_err(|_| "凭据状态不可用")?
        .insert(id, key);
    Ok(())
}
#[tauri::command]
pub async fn delete_profile(
    app: tauri::AppHandle,
    state: tauri::State<'_, Runtime>,
    id: String,
) -> Result<(), String> {
    let _gate = state.profiles.lock().await;
    let entry = credential(&id)?;
    let previous = match entry.get_password() {
        Ok(key) => Some(key),
        Err(keyring::Error::NoEntry) => None,
        Err(_) => return Err("系统凭据读取失败；配置未删除".into()),
    };
    commit_profile(
        || remove_secret(&entry),
        || match &previous {
            Some(key) => entry
                .set_password(key)
                .map_err(|_| "系统凭据恢复失败".into()),
            None => Ok(()),
        },
        async {
            service(&app, json!({"op":"profile_delete","id":id}))
                .await
                .map(|_| ())
        },
    )
    .await?;
    state.keys.lock().map_err(|_| "凭据状态不可用")?.remove(&id);
    Ok(())
}
#[tauri::command]
pub fn cancel_model(state: tauri::State<'_, Runtime>, request_id: String) -> Result<(), String> {
    if request_id.len() > 100 {
        return Err("请求标识过长".into());
    }
    let mut requests = state.requests.lock().map_err(|_| "请求状态不可用")?;
    if let Some(tx) = requests.get(&request_id) {
        let _ = tx.send(true);
    } else {
        if requests.len() > 64 {
            requests.retain(|_, tx| !*tx.borrow());
        }
        let (tx, _) = watch::channel(true);
        requests.insert(request_id, tx);
    }
    Ok(())
}
#[tauri::command]
pub async fn model_request(
    app: tauri::AppHandle,
    state: tauri::State<'_, Runtime>,
    id: String,
    request_id: String,
    system: String,
    messages: Vec<Message>,
    stream: bool,
    on_delta: Channel<String>,
) -> Result<Reply, String> {
    identifier(&id)?;
    if request_id.len() > 100 {
        return Err("请求标识过长".into());
    }
    let (tx, rx) = watch::channel(false);
    {
        let mut requests = state.requests.lock().map_err(|_| "请求状态不可用")?;
        if requests.get(&request_id).is_some_and(|t| *t.borrow()) {
            requests.remove(&request_id);
            return Err("请求已取消".into());
        }
        if requests.values().any(|t| !*t.borrow()) {
            return Err("已有模型请求，请先取消或等待".into());
        }
        requests.insert(request_id.clone(), tx);
    }
    let result=async {
 let gate=state.profiles.lock().await;
 let rows=service(&app,json!({"op":"profiles"})).await?;
 let row=rows.as_array().and_then(|a|a.iter().find(|p|p["id"]==id)).ok_or("模型配置不存在")?;
 let profile:Profile=serde_json::from_value(json!({"name":row["name"],"protocol":row["protocol"],"base_url":row["base_url"],"model":row["model"]})).map_err(|_|"模型配置无效")?;
 let key=state.keys.lock().map_err(|_|"凭据状态不可用")?.get(&id).cloned();
 let key=match key {Some(k)=>k,None=>match credential(&id)?.get_password(){Ok(k)=>k,Err(keyring::Error::NoEntry)=>String::new(),Err(_)=>return Err("系统凭据读取失败，请重新配置临时Key".into())}};
 drop(gate);
 // Do not emit raw deltas that could echo the credential. Buffer a key-length tail.
 let mut tail=String::new();let mut result=model_api::run(&profile,&key,&system,&messages,stream,|piece|{
    tail.push_str(piece);if !key.is_empty(){tail=tail.replace(&key,"[凭据已遮去]");}
    let keep=key.len();if tail.len()>keep {let mut cut=tail.len()-keep;while cut>0&&!tail.is_char_boundary(cut){cut-=1;}if cut>0{let text=tail[..cut].to_string();tail.drain(..cut);let _=on_delta.send(text);}}
 },rx).await;
 if let Ok(reply)=&mut result {if !key.is_empty(){reply.text=reply.text.replace(&key,"[凭据已遮去]");}let _=on_delta.send(tail);}result
 }.await;
    state
        .requests
        .lock()
        .map_err(|_| "请求状态不可用")?
        .remove(&request_id);
    result
}
#[tauri::command]
pub async fn export_experiment(
    app: tauri::AppHandle,
    id: String,
    sections: Vec<String>,
) -> Result<bool, String> {
    let result = service(&app, json!({"op":"export","id":id,"sections":sections})).await?;
    let bytes = serde_json::to_vec_pretty(&result).map_err(|_| "导出编码失败")?;
    if let Some(file) = rfd::AsyncFileDialog::new()
        .set_title("导出所选实验数据（包含对话时可能含个人信息）")
        .add_filter("JSON", &["json"])
        .set_file_name("memory-lab-model-experiment.json")
        .save_file()
        .await
    {
        if file.file_name().eq_ignore_ascii_case("log.json") {
            return Err("请勿使用官方日志文件名log.json".into());
        }
        file.write(&bytes).await.map_err(|_| "导出写入失败")?;
        Ok(true)
    } else {
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn blocked_worker_input_obeys_deadline() {
        let mut command = if cfg!(windows) {
            let mut c = Command::new("powershell.exe");
            c.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 20"]);
            c
        } else {
            let mut c = Command::new("/bin/sleep");
            c.arg("20");
            c
        };
        command.current_dir(std::env::temp_dir());
        let started = Instant::now();
        let result = run_worker_command(command, json!({"padding":"x".repeat(4 * 1024 * 1024)}), Duration::from_millis(400));
        assert!(result.unwrap_err().contains("超时"));
        assert!(started.elapsed() < Duration::from_secs(10));
    }
    #[cfg(unix)]
    #[test]
    fn exited_worker_with_inherited_output_obeys_deadline() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 2 &"]);
        let started = Instant::now();
        let error = run_worker_command(command, json!({"op":"list"}), Duration::from_millis(150)).unwrap_err();
        assert!(error.contains("超时"));
        assert!(started.elapsed() < Duration::from_secs(1));
    }
    #[test]
    fn failed_worker_exit_is_not_reported_as_valid_json() {
        let mut command = if cfg!(windows) {
            let mut c = Command::new("cmd.exe");
            c.args(["/C", "exit 7"]);
            c
        } else {
            let mut c = Command::new("/bin/sh");
            c.args(["-c", "exit 7"]);
            c
        };
        command.current_dir(std::env::temp_dir());
        let error = run_worker_command(command, json!({"op":"list"}), Duration::from_secs(5)).unwrap_err();
        assert!(error.contains("退出码 Some(7)"));
    }
    #[tokio::test]
    async fn failed_profile_commit_restores_previous_credential() {
        let secret = std::cell::Cell::new("previous");
        let error = commit_profile(
            || {
                secret.set("replacement");
                Ok(())
            },
            || {
                secret.set("previous");
                Ok(())
            },
            async { Err("catalog failure".to_string()) },
        )
        .await
        .unwrap_err();
        assert_eq!(secret.get(), "previous");
        assert_eq!(error, "catalog failure");
    }
    #[cfg(windows)]
    #[test]
    fn windows_credential_manager_roundtrip_and_cleanup() {
        // Synthetic test value and unique ID; never read or overwrite a user's entry.
        let id = format!(
            "{:032x}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let entry = credential(&id).unwrap();
        struct Cleanup(keyring::Entry);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = self.0.delete_credential();
            }
        }
        let cleanup = Cleanup(entry);
        cleanup.0.set_password("synthetic-first-value").unwrap();
        assert_eq!(cleanup.0.get_password().unwrap(), "synthetic-first-value");
        cleanup.0.set_password("synthetic-updated-value").unwrap();
        assert_eq!(cleanup.0.get_password().unwrap(), "synthetic-updated-value");
        cleanup.0.delete_credential().unwrap();
        assert!(matches!(
            cleanup.0.get_password(),
            Err(keyring::Error::NoEntry)
        ));
    }
    #[test]
    fn actual_worker_utf8_save_reopen_and_no_secret_metadata() {
        let base = std::env::temp_dir().join(format!(
            "memory-native-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&base).unwrap();
        let root = std::fs::canonicalize(&base).unwrap();
        let exp = worker(
            root.clone(),
            json!({"op":"create","name":"中文 实验","rules":"规则：保留来源"}),
        )
        .unwrap();
        assert_eq!(exp["name"], "中文 实验");
        let reopened = worker(root.clone(), json!({"op":"open","id":exp["id"]})).unwrap();
        assert_eq!(exp, reopened);
        assert!(worker(root.clone(),json!({"op":"profile_save","id":"a".repeat(32),"profile":{"name":"x","api_key":"never-store"}})).is_err());
        let _ = std::fs::remove_dir_all(base);
    }
}
