use serde::{Deserialize, Serialize};
use reqwest::Client;
use futures_util::StreamExt;
use tauri::{AppHandle, Emitter, Manager};
use std::fs;
use std::path::PathBuf;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;

// ─── Data Structures ──────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct OllamaRequest {
    model: String,
    prompt: String,
    images: Option<Vec<String>>,
    stream: bool,
}

#[derive(Serialize, Deserialize)]
struct OllamaChunk {
    response: String,
    done: bool,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct StreamPayload {
    pub request_id: String,
    pub chunk: String,
    pub done: bool,
}

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub struct AppState {
    pub stop_flag: Arc<AtomicBool>,
    pub client: Client,
}

#[tauri::command]
fn stop_generation(state: tauri::State<'_, AppState>) {
    state.stop_flag.store(true, Ordering::Relaxed);
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    pub agent_id: String,
    pub images: Option<Vec<String>>,
    pub cmd_used: Option<String>,
    pub sources: Option<Vec<String>>,
    #[serde(rename = "type")]
    pub msg_type: Option<String>,
    pub local_path: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppConfig {
    pub openai_api_key: Option<String>,
    pub anthropic_api_key: Option<String>,
    pub gemini_api_key: Option<String>,
    pub openrouter_api_key: Option<String>,
    pub ollama_url: Option<String>,
    pub lmstudio_url: Option<String>,
    pub default_provider: String, // "ollama" | "openai" | "anthropic" | "gemini" | "openrouter" | "lmstudio"
    pub favorites: Option<Vec<String>>,
    pub custom_shortcuts: Option<HashMap<String, String>>,
    pub preferred_models: Option<HashMap<String, String>>,
    pub font_family: Option<String>,
    pub font_size: Option<String>,
    pub mcp_servers: Option<Vec<McpServerConfig>>,
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            openai_api_key: None,
            anthropic_api_key: None,
            gemini_api_key: None,
            openrouter_api_key: None,
            ollama_url: Some("http://localhost:11434".to_string()),
            lmstudio_url: Some("http://localhost:1234".to_string()),
            default_provider: "ollama".to_string(),
            favorites: Some(Vec::new()),
            custom_shortcuts: Some(HashMap::new()),
            preferred_models: Some(HashMap::new()),
            font_family: Some("'Inter', sans-serif".to_string()),
            font_size: Some("15px".to_string()),
            mcp_servers: Some(Vec::new()),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    pub command: String,
    pub args: Option<Vec<String>>,
    pub env: Option<HashMap<String, String>>,
    pub enabled: Option<bool>,
    pub permissions: Option<McpPermissions>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct McpPermissions {
    pub tools: Option<bool>,
    pub resources: Option<bool>,
    pub prompts: Option<bool>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct McpToolDescriptor {
    pub server_id: String,
    pub server_name: String,
    pub name: String,
    pub description: Option<String>,
    pub input_schema: serde_json::Value,
}

fn mcp_enabled_servers(config: &AppConfig) -> Vec<McpServerConfig> {
    config
        .mcp_servers
        .clone()
        .unwrap_or_default()
        .into_iter()
        .filter(|s| s.enabled.unwrap_or(true))
        .collect()
}

fn mcp_tools_allowed(server: &McpServerConfig) -> bool {
    server.permissions.as_ref().and_then(|p| p.tools).unwrap_or(true)
}

fn mcp_resources_allowed(server: &McpServerConfig) -> bool {
    server.permissions.as_ref().and_then(|p| p.resources).unwrap_or(true)
}

fn mcp_prompts_allowed(server: &McpServerConfig) -> bool {
    server.permissions.as_ref().and_then(|p| p.prompts).unwrap_or(true)
}

fn is_filesystem_server(server: &McpServerConfig) -> bool {
    if server.name.to_lowercase().contains("filesystem") || server.id.to_lowercase().contains("filesystem") {
        return true;
    }
    let args = server.args.clone().unwrap_or_default();
    args.iter().any(|a| a.contains("@modelcontextprotocol/server-filesystem"))
}

fn filesystem_root_from_server(server: &McpServerConfig) -> PathBuf {
    let args = server.args.clone().unwrap_or_default();
    args.last()
        .map(PathBuf::from)
        .filter(|p| p.exists())
        .unwrap_or_else(|| PathBuf::from("."))
}

fn filesystem_list_directory(root: &PathBuf, path: Option<String>) -> Result<serde_json::Value, String> {
    let rel = path.unwrap_or_default();
    let mut target = root.clone();
    if !rel.is_empty() {
        target.push(rel);
    }
    if !target.exists() {
        return Err("Chemin introuvable.".to_string());
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(target).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        entries.push(serde_json::json!({
            "name": entry.file_name().to_string_lossy(),
            "path": entry.path().to_string_lossy(),
            "type": if meta.is_dir() { "directory" } else { "file" },
            "size": meta.len()
        }));
    }
    Ok(serde_json::json!({ "entries": entries }))
}

fn filesystem_read_file(root: &PathBuf, path: String) -> Result<serde_json::Value, String> {
    let mut target = root.clone();
    target.push(path);
    let content = fs::read_to_string(&target).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "content": content }))
}

fn mcp_send_message(
    stdin: &mut std::process::ChildStdin,
    message: &serde_json::Value,
) -> Result<(), String> {
    let body = serde_json::to_vec(message).map_err(|e| e.to_string())?;
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    stdin.write_all(header.as_bytes()).map_err(|e| e.to_string())?;
    stdin.write_all(&body).map_err(|e| e.to_string())?;
    stdin.flush().map_err(|e| e.to_string())?;
    Ok(())
}

fn mcp_read_message(stdout: &mut std::process::ChildStdout) -> Result<serde_json::Value, String> {
    let mut header = Vec::new();
    let mut buf = [0u8; 1];
    loop {
        stdout.read_exact(&mut buf).map_err(|e| e.to_string())?;
        header.push(buf[0]);
        if header.ends_with(b"\r\n\r\n") {
            break;
        }
        if header.len() > 8192 {
            return Err("En-tête MCP trop long.".to_string());
        }
    }

    let header_str = String::from_utf8(header).map_err(|e| e.to_string())?;
    let mut content_length = None;
    for line in header_str.lines() {
        if let Some(v) = line.strip_prefix("Content-Length:") {
            content_length = v.trim().parse::<usize>().ok();
        }
    }
    let len = content_length.ok_or_else(|| "Content-Length manquant.".to_string())?;
    let mut body = vec![0u8; len];
    stdout.read_exact(&mut body).map_err(|e| e.to_string())?;
    serde_json::from_slice(&body).map_err(|e| e.to_string())
}

fn mcp_request(
    server: &McpServerConfig,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let server = server.clone();
    let server_name = server.name.clone();
    let method = method.to_string();
    let (tx, rx) = mpsc::channel();

    std::thread::spawn(move || {
        let result = (|| -> Result<serde_json::Value, String> {
            let mut command = Command::new(&server.command);
            let mut args = server.args.clone().unwrap_or_default();
            if server.command == "npx" && !args.iter().any(|a| a == "--yes" || a == "-y") {
                args.insert(0, "--yes".to_string());
            }

            let mut child = command
                .args(args)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .envs(server.env.clone().unwrap_or_default())
                .spawn()
                .map_err(|e| format!("Impossible de lancer MCP {}: {}", server.name, e))?;

            let mut stdin = child.stdin.take().ok_or("stdin MCP indisponible")?;
            let mut stdout = child.stdout.take().ok_or("stdout MCP indisponible")?;

            let init = serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "clientInfo": { "name": "OmniAgent", "version": env!("CARGO_PKG_VERSION") },
                    "capabilities": { "tools": {} }
                }
            });
            mcp_send_message(&mut stdin, &init)?;
            let _ = mcp_read_message(&mut stdout)?;
            let initialized = serde_json::json!({
                "jsonrpc": "2.0",
                "method": "notifications/initialized"
            });
            mcp_send_message(&mut stdin, &initialized)?;

            let request = serde_json::json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": method,
                "params": params
            });
            mcp_send_message(&mut stdin, &request)?;
            let response = mcp_read_message(&mut stdout)?;
            let _ = child.kill();
            Ok(response)
        })();
        let _ = tx.send(result);
    });

    rx.recv_timeout(std::time::Duration::from_secs(20))
        .map_err(|_| format!("Timeout MCP sur le serveur '{}'.", server_name))?
}

#[tauri::command]
fn test_mcp_server(app: AppHandle, server_id: String) -> Result<serde_json::Value, String> {
    let config = load_config(app);
    let server = mcp_enabled_servers(&config)
        .into_iter()
        .find(|s| s.id == server_id)
        .ok_or_else(|| format!("Serveur MCP '{}' introuvable.", server_id))?;

    if is_filesystem_server(&server) {
        return Ok(serde_json::json!({
            "server_id": server.id,
            "server_name": server.name,
            "ok": true,
            "tools_count": 2,
            "mode": "native-filesystem"
        }));
    }

    let response = mcp_request(&server, "tools/list", serde_json::json!({}))?;
    let tools = response["result"]["tools"].as_array().map(|a| a.len()).unwrap_or(0);
    Ok(serde_json::json!({
        "server_id": server.id,
        "server_name": server.name,
        "ok": true,
        "tools_count": tools
    }))
}

#[tauri::command]
fn list_mcp_servers(app: AppHandle) -> Result<Vec<McpServerConfig>, String> {
    let config = load_config(app);
    Ok(config.mcp_servers.unwrap_or_default())
}

#[tauri::command]
fn save_mcp_servers(app: AppHandle, servers: Vec<McpServerConfig>) -> Result<(), String> {
    let mut config = load_config(app.clone());
    config.mcp_servers = Some(servers);
    save_config(app, config)
}

#[tauri::command]
fn list_mcp_tools(app: AppHandle) -> Result<Vec<McpToolDescriptor>, String> {
    let config = load_config(app);
    let mut tools = Vec::new();
    for server in mcp_enabled_servers(&config) {
        if !mcp_tools_allowed(&server) {
            continue;
        }
        if is_filesystem_server(&server) {
            tools.push(McpToolDescriptor {
                server_id: server.id.clone(),
                server_name: server.name.clone(),
                name: "list_directory".to_string(),
                description: Some("Liste le contenu d'un dossier à partir de la racine autorisée.".to_string()),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Chemin relatif depuis la racine configurée." }
                    }
                }),
            });
            tools.push(McpToolDescriptor {
                server_id: server.id.clone(),
                server_name: server.name.clone(),
                name: "read_file".to_string(),
                description: Some("Lit un fichier à partir de la racine autorisée.".to_string()),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "Chemin relatif du fichier." }
                    }
                }),
            });
            continue;
        }
        let response = mcp_request(&server, "tools/list", serde_json::json!({}))?;
        let items = response["result"]["tools"].as_array().cloned().unwrap_or_default();
        for tool in items {
            tools.push(McpToolDescriptor {
                server_id: server.id.clone(),
                server_name: server.name.clone(),
                name: tool["name"].as_str().unwrap_or_default().to_string(),
                description: tool["description"].as_str().map(|s| s.to_string()),
                input_schema: tool["inputSchema"].clone(),
            });
        }
    }
    Ok(tools)
}

#[tauri::command]
fn list_mcp_server_status(app: AppHandle, server_id: String) -> Result<serde_json::Value, String> {
    let config = load_config(app);
    let server = mcp_enabled_servers(&config)
        .into_iter()
        .find(|s| s.id == server_id)
        .ok_or_else(|| format!("Serveur MCP '{}' introuvable.", server_id))?;

    Ok(serde_json::json!({
        "id": server.id,
        "name": server.name,
        "tools": mcp_tools_allowed(&server),
        "resources": mcp_resources_allowed(&server),
        "prompts": mcp_prompts_allowed(&server)
    }))
}

#[tauri::command]
fn run_mcp_tool(
    app: AppHandle,
    server_id: String,
    tool_name: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let config = load_config(app);
    let server = mcp_enabled_servers(&config)
        .into_iter()
        .find(|s| s.id == server_id)
        .ok_or_else(|| format!("Serveur MCP '{}' introuvable.", server_id))?;
    if !mcp_tools_allowed(&server) {
        return Err(format!("Les outils sont désactivés pour le serveur MCP '{}'.", server.name));
    }

    if is_filesystem_server(&server) {
        let root = filesystem_root_from_server(&server);
        match tool_name.as_str() {
            "list_directory" => {
                let path = args["path"].as_str().map(|s| s.to_string());
                return filesystem_list_directory(&root, path);
            }
            "read_file" => {
                let path = args["path"].as_str().unwrap_or("").to_string();
                return filesystem_read_file(&root, path);
            }
            _ => return Err(format!("Outil filesystem inconnu: {}", tool_name)),
        }
    }

    let response = mcp_request(&server, "tools/call", serde_json::json!({
        "name": tool_name,
        "arguments": args
    }))?;
    Ok(response)
}

// ─── Path Helpers ──────────────────────────────────────────────────────────────

fn get_data_dir(app: &AppHandle) -> PathBuf {
    let path = app.path().app_data_dir().expect("Failed to get app data dir");
    if !path.exists() {
        fs::create_dir_all(&path).unwrap();
    }
    path
}

fn get_history_path(app: &AppHandle) -> PathBuf {
    let mut p = get_data_dir(app);
    p.push("history.json");
    p
}

fn get_config_path(app: &AppHandle) -> PathBuf {
    let mut p = get_data_dir(app);
    p.push("config.json");
    p
}

fn get_gallery_dir(app: &AppHandle) -> PathBuf {
    let mut p = get_data_dir(app);
    p.push("gallery");
    if !p.exists() {
        fs::create_dir_all(&p).unwrap();
    }
    p
}

#[tauri::command]
fn get_desktop_dir(app: AppHandle) -> Result<String, String> {
    let path = app.path().desktop_dir().map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

// ─── Ollama Commands ───────────────────────────────────────────────────────────

#[tauri::command]
async fn list_ollama_models(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    let res = state.client.get("http://localhost:11434/api/tags")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    
    let json: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let mut models = Vec::new();
    if let Some(models_array) = json["models"].as_array() {
        for m in models_array {
            if let Some(name) = m["name"].as_str() {
                models.push(name.to_string());
            }
        }
    }
    Ok(models)
}

#[tauri::command]
async fn check_ollama(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    Ok(state.client.get("http://localhost:11434")
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false))
}

#[tauri::command]
async fn ask_ollama_stream(
    app: AppHandle, 
    state: tauri::State<'_, AppState>,
    request_id: String,
    model: String, 
    prompt: String, 
    images: Option<Vec<String>>
) -> Result<(), String> {
    state.stop_flag.store(false, Ordering::Relaxed);
    let res = state.client
        .post("http://localhost:11434/api/generate")
        .json(&OllamaRequest { model: model.clone(), prompt, images, stream: true })
        .send()
        .await
        .map_err(|e| format!("Connexion Ollama échouée: {}", e))?;

    if !res.status().is_success() {
        if res.status() == 404 {
            return Err(format!("Le modèle '{}' n'est pas installé. Lancez 'ollama pull {}' dans votre terminal.", model, model));
        }
        return Err(format!("Ollama erreur: {}", res.status()));
    }

    let mut stream = res.bytes_stream();
    while let Some(item) = stream.next().await {
        if state.stop_flag.load(Ordering::Relaxed) {
            app.emit("ollama-chunk", StreamPayload { request_id: request_id.clone(), chunk: "... [Arrêté]".to_string(), done: true }).ok();
            break;
        }
        let bytes = item.map_err(|e| e.to_string())?;
        for line in String::from_utf8_lossy(&bytes).lines() {
            if let Ok(chunk) = serde_json::from_str::<OllamaChunk>(line) {
                app.emit("ollama-chunk", StreamPayload { request_id: request_id.clone(), chunk: chunk.response, done: chunk.done })
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

// ─── Cloud Commands (OpenAI-compatible) ────────────────────────────────────────

#[derive(Serialize)]
struct OpenAIMessage {
    role: String,
    content: serde_json::Value,
}

#[derive(Serialize)]
struct OpenAIRequest {
    model: String,
    messages: Vec<OpenAIMessage>,
    stream: bool,
    max_tokens: Option<u32>,
}

#[derive(Deserialize)]
struct OpenAIDelta {
    content: Option<String>,
}

#[derive(Deserialize)]
struct OpenAIChoice {
    delta: OpenAIDelta,
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
struct OpenAIChunk {
    choices: Vec<OpenAIChoice>,
}

#[tauri::command]
async fn ask_cloud_stream(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    request_id: String,
    provider: String,
    api_key: String,
    model: String,
    system_prompt: String,
    user_message: String,
    images: Option<Vec<String>>,
) -> Result<(), String> {
    state.stop_flag.store(false, Ordering::Relaxed);
    let client = Client::new();
    
    let url = match provider.as_str() {
        "openai" => "https://api.openai.com/v1/chat/completions",
        "gemini" => "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        "openrouter" => "https://openrouter.ai/api/v1/chat/completions",
        _ => "https://api.openai.com/v1/chat/completions",
    };

    let mut user_content = Vec::new();
    user_content.push(serde_json::json!({
        "type": "text",
        "text": user_message
    }));

    if let Some(imgs) = images {
        for img in imgs {
            user_content.push(serde_json::json!({
                "type": "image_url",
                "image_url": {
                    "url": format!("data:image/jpeg;base64,{}", img)
                }
            }));
        }
    }

    let messages = vec![
        OpenAIMessage { 
            role: "system".to_string(), 
            content: serde_json::Value::String(system_prompt) 
        },
        OpenAIMessage { 
            role: "user".to_string(), 
            content: serde_json::Value::Array(user_content) 
        },
    ];

    let mut request = client
        .post(url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json");

    if provider == "openrouter" {
        request = request.header("HTTP-Referer", "https://github.com/omniagent");
        request = request.header("X-Title", "OmniAgent");
    }

    let res = request
        .json(&OpenAIRequest { 
            model, 
            messages, 
            stream: true,
            max_tokens: Some(2000) 
        })
        .send()
        .await
        .map_err(|e| format!("Connexion {} échouée: {}", provider, e))?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("{} erreur {}: {}", provider, status, body));
    }

    let mut stream = res.bytes_stream();
    let mut is_done = false;
    while let Some(item) = stream.next().await {
        if is_done { break; }
        if state.stop_flag.load(Ordering::Relaxed) {
            app.emit("ollama-chunk", StreamPayload { request_id: request_id.clone(), chunk: "... [Arrêté]".to_string(), done: true }).ok();
            break;
        }
        let bytes = item.map_err(|e| e.to_string())?;
        let text_chunk = String::from_utf8_lossy(&bytes);
        
        for line in text_chunk.lines() {
            let line = line.trim();
            if line.starts_with("data: ") {
                let data = &line["data: ".len()..];
                if data == "[DONE]" {
                    is_done = true;
                    app.emit("ollama-chunk", StreamPayload { request_id: request_id.clone(), chunk: "".to_string(), done: true })
                        .map_err(|e| e.to_string())?;
                    break;
                }
                if let Ok(chunk) = serde_json::from_str::<OpenAIChunk>(data) {
                    if let Some(choice) = chunk.choices.first() {
                        let text = choice.delta.content.clone().unwrap_or_default();
                        let done = choice.finish_reason.is_some();
                        if done { is_done = true; }
                        if !text.is_empty() || done {
                            app.emit("ollama-chunk", StreamPayload { request_id: request_id.clone(), chunk: text, done })
                                .map_err(|e| e.to_string())?;
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

// ─── History Commands ──────────────────────────────────────────────────────────

#[tauri::command]
fn save_history(app: AppHandle, messages: Vec<ChatMessage>) -> Result<(), String> {
    let path = get_history_path(&app);
    println!("Sauvegarde de l'historique vers: {:?}", path);
    fs::write(&path, serde_json::to_string(&messages).map_err(|e| e.to_string())?)
        .map_err(|e| {
            let err = format!("Erreur d'écriture historique: {}", e);
            eprintln!("{}", err);
            err
        })
}

#[tauri::command]
fn load_history(app: AppHandle) -> Result<Vec<ChatMessage>, String> {
    let path = get_history_path(&app);
    println!("Chargement de l'historique depuis: {:?}", path);
    if !path.exists() { 
        println!("Le fichier d'historique n'existe pas encore.");
        return Ok(Vec::new()); 
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let messages: Vec<ChatMessage> = serde_json::from_str(&content).map_err(|e| {
        let err = format!("Erreur désérialisation historique: {}. Contenu: {}", e, content);
        eprintln!("{}", err);
        err
    })?;
    println!("{} messages chargés avec succès.", messages.len());
    Ok(messages)
}

// ─── Config Commands ───────────────────────────────────────────────────────────

#[tauri::command]
fn save_config(app: AppHandle, config: AppConfig) -> Result<(), String> {
    let path = get_config_path(&app);
    fs::write(path, serde_json::to_string(&config).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn load_config(app: AppHandle) -> AppConfig {
    let path = get_config_path(&app);
    if !path.exists() { return AppConfig::default(); }
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

// ─── Export Command ────────────────────────────────────────────────────────────

#[tauri::command]
fn export_conversation(
    app: AppHandle,
    agent_id: String,
    agent_name: String,
    format: String, // "markdown" | "txt"
) -> Result<String, String> {
    use std::time::{SystemTime, UNIX_EPOCH};

    let path = get_history_path(&app);
    if !path.exists() { return Err("Aucun historique trouvé.".to_string()); }

    let all: Vec<ChatMessage> = serde_json::from_str(
        &fs::read_to_string(&path).map_err(|e| e.to_string())?
    ).map_err(|e| e.to_string())?;

    let messages: Vec<&ChatMessage> = all.iter().filter(|m| m.agent_id == agent_id).collect();
    if messages.is_empty() { return Err("Aucun message pour cet agent.".to_string()); }

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();

    let content = if format == "markdown" {
        let mut md = format!("# Conversation avec {}\n\n", agent_name);
        for msg in &messages {
            if msg.role == "user" {
                md.push_str(&format!("**Vous :** {}\n\n", msg.content));
            } else {
                md.push_str(&format!("**{} :** {}\n\n", agent_name, msg.content));
            }
        }
        md
    } else {
        messages.iter().map(|m| {
            if m.role == "user" { format!("Vous: {}\n", m.content) }
            else { format!("{}: {}\n", agent_name, m.content) }
        }).collect()
    };

    let ext = if format == "markdown" { "md" } else { "txt" };
    let filename = format!("omniagent_{}_{}.{}", agent_id, timestamp, ext);
    let mut export_path = app.path().download_dir().map_err(|e| e.to_string())?;
    export_path.push(&filename);

    fs::write(&export_path, content).map_err(|e| e.to_string())?;
    Ok(export_path.to_string_lossy().to_string())
}

#[derive(Serialize)]
struct FileContext {
    name: String,
    path: String,
    content: String,
}

#[tauri::command]
async fn index_directory(path: String) -> Result<Vec<FileContext>, String> {
    use walkdir::WalkDir;
    let mut files = Vec::new();
    let supported_exts = ["txt", "md", "js", "ts", "py", "rs", "html", "css", "json", "c", "cpp", "h"];

    for entry in WalkDir::new(&path).max_depth(3).into_iter().filter_map(|e| e.ok()) {
        let path_buf = entry.path();
        if path_buf.is_file() {
            let ext = path_buf.extension().and_then(|e| e.to_str()).unwrap_or("");
            if supported_exts.contains(&ext) {
                if let Ok(content) = fs::read_to_string(path_buf) {
                    // Limiter la taille par fichier pour le moment (ex: 50KB)
                    if content.len() < 50000 {
                        files.push(FileContext {
                            name: path_buf.file_name().unwrap_or_default().to_string_lossy().to_string(),
                            path: path_buf.to_string_lossy().to_string(),
                            content,
                        });
                    }
                }
            }
        }
        // Limite de sécurité : 100 fichiers max pour l'indexation initiale
        if files.len() > 100 { break; }
    }
    Ok(files)
}

#[derive(Deserialize)]
struct OpenAIImageResponse {
    data: Vec<OpenAIImageData>,
}

#[derive(Deserialize)]
struct OpenAIImageData {
    url: String,
}

#[tauri::command]
async fn generate_image(
    provider: String,
    api_key: String,
    prompt: String,
    size: Option<String>,
) -> Result<String, String> {
    let client = Client::new();
    
    if provider == "openai" {
        let res = client
            .post("https://api.openai.com/v1/images/generations")
            .header("Authorization", format!("Bearer {}", api_key))
            .json(&serde_json::json!({
                "model": "dall-e-3",
                "prompt": prompt,
                "n": 1,
                "size": size.unwrap_or_else(|| "1024x1024".to_string())
            }))
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(format!("Erreur OpenAI: {} - {}", status, body));
        }

        let json: OpenAIImageResponse = res.json().await.map_err(|e| e.to_string())?;
        return Ok(json.data[0].url.clone());
    } else if provider == "gemini" {
        // Gemini via OpenAI compatibility layer
        let res = client
            .post("https://generativelanguage.googleapis.com/v1beta/openai/images/generations")
            .header("Authorization", format!("Bearer {}", api_key))
            .json(&serde_json::json!({
                "model": "imagen-3.0-generate-001", // Placeholder, Gemini support varies
                "prompt": prompt,
                "n": 1,
                "size": size.unwrap_or_else(|| "1024x1024".to_string())
            }))
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(format!("Erreur Gemini Image: {} - {}", status, body));
        }

        let json: OpenAIImageResponse = res.json().await.map_err(|e| e.to_string())?;
        return Ok(json.data[0].url.clone());
    } else if provider == "openrouter" {
        // OpenRouter uses chat/completions for image generation with modalities
        let res = client
            .post("https://openrouter.ai/api/v1/chat/completions")
            .header("Authorization", format!("Bearer {}", api_key))
            .json(&serde_json::json!({
                "model": "openai/dall-e-3", // OpenRouter proxying DALL-E or others
                "messages": [{ "role": "user", "content": prompt }],
                "modalities": ["image"]
            }))
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            return Err(format!("Erreur OpenRouter Image: {} - {}", status, body));
        }

        // OpenRouter might return a different format or proxy OpenAI
        let json: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
        
        // Try OpenAI format first
        if let Some(url) = json["data"][0]["url"].as_str() {
            return Ok(url.to_string());
        }
        
        // Try multimodal response format
        if let Some(content) = json["choices"][0]["message"]["content"].as_str() {
             // If it's a URL in text or markdown
             return Ok(content.to_string());
        }

        return Err("Format de réponse d'image inconnu.".to_string());
    }

    Err(format!("Le fournisseur '{}' ne supporte pas encore la génération d'images.", provider))
}

#[tauri::command]
async fn save_image_to_gallery(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    url: String,
) -> Result<String, String> {
    let res = state.client.get(&url).send().await.map_err(|e| e.to_string())?;
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;

    let gallery_dir = get_gallery_dir(&app);
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
    
    let filename = format!("art_{}.png", timestamp);
    let mut file_path = gallery_dir.clone();
    file_path.push(&filename);

    fs::write(&file_path, bytes).map_err(|e| e.to_string())?;
    
    Ok(file_path.to_string_lossy().to_string())
}

#[tauri::command]
fn list_gallery_images(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let gallery_dir = get_gallery_dir(&app);
    let mut images = Vec::new();
    if let Ok(entries) = fs::read_dir(gallery_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            if let Some(path) = entry.path().to_str() {
                images.push(path.to_string());
            }
        }
    }
    images.sort_by(|a, b| b.cmp(a)); // Plus récents en premier
    Ok(images)
}

#[tauri::command]
fn delete_gallery_image(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let gallery_dir = get_gallery_dir(&app);
    let file_path = std::path::PathBuf::from(&path);
    
    // Sécurité : s'assurer que le fichier est bien dans le dossier gallery
    if !file_path.starts_with(&gallery_dir) {
        return Err("Accès non autorisé.".to_string());
    }
    
    if file_path.exists() {
        std::fs::remove_file(file_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn read_file_content(path: String) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| format!("Impossible de lire le fichier: {}", e))
}

#[tauri::command]
async fn read_file_base64(path: String) -> Result<String, String> {
    use base64::{Engine as _, engine::general_purpose};
    let bytes = fs::read(path).map_err(|e| format!("Erreur lecture binaire: {}", e))?;
    Ok(general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
fn list_plugins(app: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let mut plugins = Vec::new();
    let plugins_dir = app.path().app_data_dir().unwrap_or_default().join("plugins");
    
    // Si on est en dev, le dossier est à la racine du projet
    let dev_plugins_dir = std::path::PathBuf::from("plugins");
    let target_dir = if dev_plugins_dir.exists() { dev_plugins_dir } else { plugins_dir };

    if !target_dir.exists() {
        return Ok(plugins);
    }

    if let Ok(entries) = std::fs::read_dir(target_dir) {
        for entry in entries.flatten() {
            let manifest_path = entry.path().join("manifest.json");
            if manifest_path.exists() {
                if let Ok(content) = std::fs::read_to_string(manifest_path) {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) {
                        plugins.push(json);
                    }
                }
            }
        }
    }
    Ok(plugins)
}

#[tauri::command]
async fn run_plugin_tool(
    plugin_id: String,
    tool_name: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if plugin_id == "calculator" && tool_name == "calculate" {
        let expression = args["expression"].as_str().unwrap_or("");
        if expression.chars().any(|c| !c.is_numeric() && !"+-*/(). ".contains(c)) {
            return Err("Expression invalide ou dangereuse.".to_string());
        }
        let output = std::process::Command::new("node")
            .arg("plugins/calculator/index.js")
            .arg(expression)
            .output()
            .map_err(|e| format!("Erreur d'exécution: {}", e))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let json: serde_json::Value = serde_json::from_str(&stdout).map_err(|e| e.to_string())?;
        return Ok(json);
    } else if plugin_id == "websearch" && tool_name == "search" {
        let query = args["query"].as_str().unwrap_or("");
        let output = std::process::Command::new("node")
            .arg("plugins/websearch/index.js")
            .arg(query)
            .output()
            .map_err(|e| format!("Erreur d'exécution: {}", e))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let json: serde_json::Value = serde_json::from_str(&stdout).map_err(|e| e.to_string())?;
        return Ok(json);
    }
    Err(format!("Outil '{}' pour le plugin '{}' non trouvé.", tool_name, plugin_id))
}

// ─── App Entry Point ───────────────────────────────────────────────────────────

#[tauri::command]
async fn ask_lmstudio_stream(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    request_id: String,
    model: String,
    prompt: String,
) -> Result<(), String> {
    state.stop_flag.store(false, Ordering::Relaxed);
    
    let config = load_config(app.clone());
    let base_url = config.lmstudio_url.unwrap_or_else(|| "http://localhost:1234".to_string());
    let url = format!("{}/v1/chat/completions", base_url.trim_end_matches('/'));

    let res = state.client
        .post(&url)
        .json(&serde_json::json!({
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": true
        }))
        .send()
        .await
        .map_err(|e| format!("Connexion LM Studio échouée sur {}: {}", url, e))?;

    if !res.status().is_success() {
        return Err(format!("LM Studio erreur {}: {}", res.status(), res.text().await.unwrap_or_default()));
    }

    let mut stream = res.bytes_stream();
    while let Some(item) = stream.next().await {
        if state.stop_flag.load(Ordering::Relaxed) { break; }
        
        let bytes = item.map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&bytes);
        
        for line in text.lines() {
            if line.starts_with("data: ") {
                let data = &line[6..];
                if data == "[DONE]" { break; }
                
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Some(content) = json["choices"][0]["delta"]["content"].as_str() {
                        app.emit("stream-response", StreamPayload {
                            request_id: request_id.clone(),
                            chunk: content.to_string(),
                            done: false,
                        }).map_err(|e| e.to_string())?;
                    }
                }
            }
        }
    }
    
    app.emit("stream-response", StreamPayload {
        request_id: request_id.clone(),
        chunk: "".to_string(),
        done: true,
    }).map_err(|e| e.to_string())?;
    
    app.emit("stream-finished", request_id).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn list_lmstudio_models(app: AppHandle, state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    let config = load_config(app);
    let base_url = config.lmstudio_url.unwrap_or_else(|| "http://localhost:1234".to_string());
    let url = format!("{}/v1/models", base_url.trim_end_matches('/'));

    let res = state.client.get(&url)
        .send()
        .await
        .map_err(|e| format!("Impossible de lister les modèles LM Studio sur {}: {}", url, e))?;
    
    let json: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let mut models = Vec::new();
    if let Some(models_array) = json["data"].as_array() {
        for m in models_array {
            if let Some(id) = m["id"].as_str() {
                models.push(id.to_string());
            }
        }
    }
    Ok(models)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState { 
            stop_flag: Arc::new(AtomicBool::new(false)),
            client: Client::new(),
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            check_ollama,
            list_lmstudio_models,
            ask_lmstudio_stream,
            list_ollama_models,
            ask_ollama_stream,
            ask_cloud_stream,
            save_history,
            load_history,
            save_config,
            load_config,
            export_conversation,
            read_file_content,
            read_file_base64,
            stop_generation,
            index_directory,
            generate_image,
            save_image_to_gallery,
            list_gallery_images,
            delete_gallery_image,
            list_plugins,
            run_plugin_tool,
            list_mcp_servers,
            save_mcp_servers,
            test_mcp_server,
            list_mcp_server_status,
            get_desktop_dir,
            list_mcp_tools,
            run_mcp_tool,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
