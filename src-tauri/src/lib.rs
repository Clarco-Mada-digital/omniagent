use serde::{Deserialize, Serialize};
use reqwest::Client;
use futures_util::StreamExt;
use tauri::{AppHandle, Emitter, Manager};
use std::fs;
use std::path::PathBuf;
use std::collections::HashMap;

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

#[derive(Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    role: String,
    content: String,
    agent_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppConfig {
    pub openai_api_key: Option<String>,
    pub anthropic_api_key: Option<String>,
    pub gemini_api_key: Option<String>,
    pub openrouter_api_key: Option<String>,
    pub default_provider: String, // "ollama" | "openai" | "anthropic" | "gemini" | "openrouter"
    pub favorites: Option<Vec<String>>,
    pub custom_shortcuts: Option<HashMap<String, String>>,
    pub preferred_models: Option<HashMap<String, String>>,
    pub font_family: Option<String>,
    pub font_size: Option<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        AppConfig {
            openai_api_key: None,
            anthropic_api_key: None,
            gemini_api_key: None,
            openrouter_api_key: None,
            default_provider: "ollama".to_string(),
            favorites: Some(Vec::new()),
            custom_shortcuts: Some(HashMap::new()),
            preferred_models: Some(HashMap::new()),
            font_family: Some("'Inter', sans-serif".to_string()),
            font_size: Some("15px".to_string()),
        }
    }
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
            app.emit("ollama-chunk", StreamPayload { chunk: "... [Arrêté]".to_string(), done: true }).ok();
            break;
        }
        let bytes = item.map_err(|e| e.to_string())?;
        for line in String::from_utf8_lossy(&bytes).lines() {
            if let Ok(chunk) = serde_json::from_str::<OllamaChunk>(line) {
                app.emit("ollama-chunk", StreamPayload { chunk: chunk.response, done: chunk.done })
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
    while let Some(item) = stream.next().await {
        if state.stop_flag.load(Ordering::Relaxed) {
            app.emit("ollama-chunk", StreamPayload { chunk: "... [Arrêté]".to_string(), done: true }).ok();
            break;
        }
        let bytes = item.map_err(|e| e.to_string())?;
        let text_chunk = String::from_utf8_lossy(&bytes);
        
        for line in text_chunk.lines() {
            let line = line.trim();
            if line.starts_with("data: ") {
                let data = &line["data: ".len()..];
                if data == "[DONE]" {
                    app.emit("ollama-chunk", StreamPayload { chunk: "".to_string(), done: true })
                        .map_err(|e| e.to_string())?;
                    break;
                }
                if let Ok(chunk) = serde_json::from_str::<OpenAIChunk>(data) {
                    if let Some(choice) = chunk.choices.first() {
                        let text = choice.delta.content.clone().unwrap_or_default();
                        let done = choice.finish_reason.is_some();
                        if !text.is_empty() || done {
                            app.emit("ollama-chunk", StreamPayload { chunk: text, done })
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
    fs::write(path, serde_json::to_string(&messages).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn load_history(app: AppHandle) -> Result<Vec<ChatMessage>, String> {
    let path = get_history_path(&app);
    if !path.exists() { return Ok(Vec::new()); }
    serde_json::from_str(&fs::read_to_string(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
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
            let body = res.text().await.unwrap_or_default();
            return Err(format!("Erreur OpenAI: {} - {}", res.status(), body));
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
            let body = res.text().await.unwrap_or_default();
            return Err(format!("Erreur Gemini Image: {} - {}", res.status(), body));
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
            let body = res.text().await.unwrap_or_default();
            return Err(format!("Erreur OpenRouter Image: {} - {}", res.status(), body));
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
