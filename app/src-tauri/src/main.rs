#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod desktop;
mod model_api;

#[tauri::command]
fn frontend_ready(frames: u32, graphics: bool, rendered: bool) {
    eprintln!("MEMORY_LAB_READY frames={frames} webgl={graphics} rendered={rendered}");
}

#[tauri::command]
fn frontend_diagnostic(stage: String, line: u32, column: u32) {
    if matches!(
        stage.as_str(),
        "boot" | "error" | "rejection" | "initialized"
    ) {
        eprintln!("MEMORY_LAB_DIAGNOSTIC stage={stage} line={line} column={column}");
    }
}

// 不接收调用者提供的文件路径；只在原生保存面板确认后写出。
#[tauri::command]
async fn export_json(content: String) -> Result<bool, String> {
    if content.len() > 5 * 1024 * 1024 {
        return Err("导出内容超过5MB".into());
    }
    let value: serde_json::Value =
        serde_json::from_str(&content).map_err(|_| "导出不是有效JSON")?;
    let format = value.get("format").and_then(|v| v.as_str());
    if !matches!(
        format,
        Some("memory-lab.replay.v1") | Some("memory-lab.experiment.v1")
    ) || value.get("mode").and_then(|v| v.as_str()) != Some("SIMULATED")
    {
        return Err("只允许导出明确标识的本地模拟数据".into());
    }
    if format == Some("memory-lab.experiment.v1")
        && (value.get("version").and_then(|v| v.as_u64()) != Some(1)
            || value.get("engine").and_then(|v| v.as_str()) != Some("browser-deterministic.v1"))
    {
        return Err("实验导出格式不受支持".into());
    }
    let file = rfd::AsyncFileDialog::new()
        .set_title("导出本地模拟回放，非官方日志")
        .add_filter("JSON", &["json"])
        .set_file_name("memory-lab-simulated.json")
        .save_file()
        .await;
    match file {
        Some(file) => {
            if file.file_name().eq_ignore_ascii_case("log.json") {
                return Err("log.json保留给官方原始日志，请使用模拟回放文件名".into());
            }
            file.write(content.as_bytes())
                .await
                .map_err(|_| "保存失败，请选择有写入权限的位置")?;
            Ok(true)
        }
        None => Ok(false),
    }
}

fn main() {
    tauri::Builder::default()
        .manage(desktop::Runtime::default())
        .invoke_handler(tauri::generate_handler![
            frontend_ready,
            frontend_diagnostic,
            export_json,
            desktop::experiment_call,
            desktop::default_rules,
            desktop::import_rules,
            desktop::import_chat_archive,
            desktop::save_profile,
            desktop::delete_profile,
            desktop::cancel_model,
            desktop::model_request,
            desktop::export_experiment
        ])
        .on_page_load(|_, event| {
            eprintln!("MEMORY_LAB_PAGE {:?}", event.event());
        })
        .run(tauri::generate_context!())
        .expect("桌面运行失败");
}
