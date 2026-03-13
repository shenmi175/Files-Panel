use std::{
    collections::HashMap,
    ffi::OsString,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
};

use anyhow::{anyhow, Context, Result};
use axum::{
    body::Body,
    extract::{multipart::MultipartError, Multipart, Path as AxumPath, Query, State},
    http::{
        header::{CONTENT_DISPOSITION, CONTENT_TYPE},
        HeaderValue, StatusCode,
    },
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::{fs, process::Command, sync::RwLock};
use tower_http::{services::ServeDir, trace::TraceLayer};
use tracing::{error, info};
use uuid::Uuid;

#[derive(Clone)]
struct AppState {
    store: Arc<RwLock<ServerStore>>,
}

struct ServerStore {
    data_file: PathBuf,
    servers: HashMap<Uuid, RemoteServer>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RemoteServer {
    id: Uuid,
    name: String,
    host: String,
    port: u16,
    username: String,
    private_key_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    password: Option<String>,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
struct ServerSummary {
    id: Uuid,
    name: String,
    host: String,
    port: u16,
    username: String,
    auth_method: &'static str,
    created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
struct CreateServerRequest {
    name: String,
    host: String,
    #[serde(default = "default_ssh_port")]
    port: u16,
    username: String,
    private_key_path: Option<String>,
    password: Option<String>,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
    timestamp: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
struct ApiError {
    error: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct ResourceSnapshot {
    hostname: String,
    uptime: String,
    load_average: LoadAverage,
    memory: MemoryStats,
    root_disk: DiskStats,
}

#[derive(Debug, Serialize, Deserialize)]
struct LoadAverage {
    one: f32,
    five: f32,
    fifteen: f32,
}

#[derive(Debug, Serialize, Deserialize)]
struct MemoryStats {
    total_mb: u64,
    used_mb: u64,
    free_mb: u64,
    available_mb: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct DiskStats {
    total: String,
    used: String,
    available: String,
    used_percent: String,
    mount_point: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct FileEntry {
    name: String,
    path: String,
    file_type: String,
    size: u64,
    mode: String,
    modified_epoch: i64,
}

#[derive(Debug, Serialize, Deserialize)]
struct FileListResponse {
    current_path: String,
    entries: Vec<FileEntry>,
}

#[derive(Debug, Deserialize)]
struct FilePathQuery {
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ProbeQuery {
    command: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RenameFileRequest {
    old_path: String,
    new_path: String,
}

#[derive(Debug, Serialize)]
struct MessageResponse {
    message: String,
}

fn default_ssh_port() -> u16 {
    22
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("info,tower_http=info")
        .init();

    let data_dir = std::env::var("DATA_DIR").unwrap_or_else(|_| "./data".to_string());
    let data_file = Path::new(&data_dir).join("servers.json");
    fs::create_dir_all(&data_dir)
        .await
        .with_context(|| format!("failed to create data directory at {data_dir}"))?;

    let store = ServerStore::load(data_file).await?;
    let state = AppState {
        store: Arc::new(RwLock::new(store)),
    };

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/servers", get(list_servers).post(create_server))
        .route("/api/servers/:id/test", post(test_server))
        .route("/api/servers/:id/probe", post(probe_server))
        .route("/api/servers/:id/resources", get(get_resources))
        .route(
            "/api/servers/:id/files",
            get(list_files).delete(delete_file),
        )
        .route("/api/servers/:id/files/rename", post(rename_file))
        .route("/api/servers/:id/files/upload", post(upload_file))
        .route("/api/servers/:id/files/download", get(download_file))
        .nest_service("/", ServeDir::new("static").append_index_html_on_directories(true))
        .with_state(state)
        .layer(TraceLayer::new_for_http());

    let port = std::env::var("PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(3000);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    info!("listening on {addr}");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

impl ServerStore {
    async fn load(data_file: PathBuf) -> Result<Self> {
        let servers = match fs::read_to_string(&data_file).await {
            Ok(contents) => serde_json::from_str::<Vec<RemoteServer>>(&contents)
                .context("failed to parse server registry")?
                .into_iter()
                .map(|mut server| {
                    normalize_server_auth(&mut server);
                    (server.id, server)
                })
                .collect(),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
            Err(err) => return Err(err).context("failed to read server registry"),
        };

        Ok(Self { data_file, servers })
    }

    async fn persist(&self) -> Result<()> {
        let mut servers = self.servers.values().cloned().collect::<Vec<_>>();
        servers.sort_by(|left, right| left.created_at.cmp(&right.created_at));

        let payload = serde_json::to_string_pretty(&servers)?;
        fs::write(&self.data_file, payload)
            .await
            .context("failed to write server registry")
    }
}

impl RemoteServer {
    fn summary(&self) -> ServerSummary {
        ServerSummary {
            id: self.id,
            name: self.name.clone(),
            host: self.host.clone(),
            port: self.port,
            username: self.username.clone(),
            auth_method: if self.password.is_some() {
                "password"
            } else {
                "private_key"
            },
            created_at: self.created_at,
        }
    }
}

fn normalize_server_auth(server: &mut RemoteServer) {
    server.private_key_path = clean_optional(server.private_key_path.take());
    server.password = clean_optional(server.password.take());
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value.and_then(|item| {
        let trimmed = item.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        timestamp: Utc::now(),
    })
}

async fn list_servers(State(state): State<AppState>) -> Json<Vec<ServerSummary>> {
    let store = state.store.read().await;
    let mut servers = store
        .servers
        .values()
        .map(RemoteServer::summary)
        .collect::<Vec<_>>();
    servers.sort_by(|left, right| left.created_at.cmp(&right.created_at));
    Json(servers)
}

async fn create_server(
    State(state): State<AppState>,
    Json(request): Json<CreateServerRequest>,
) -> Result<Json<ServerSummary>, AppError> {
    let private_key_path = clean_optional(request.private_key_path);
    let password = clean_optional(request.password);

    if private_key_path.is_some() == password.is_some() {
        return Err(AppError::bad_request(
            "must provide exactly one auth method: password or private_key_path",
        ));
    }

    let server = RemoteServer {
        id: Uuid::new_v4(),
        name: request.name.trim().to_string(),
        host: request.host.trim().to_string(),
        port: request.port,
        username: request.username.trim().to_string(),
        private_key_path,
        password,
        created_at: Utc::now(),
    };

    let mut store = state.store.write().await;
    store.servers.insert(server.id, server.clone());
    store.persist().await.map_err(AppError::internal)?;

    Ok(Json(server.summary()))
}

async fn test_server(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<Uuid>,
) -> Result<Json<serde_json::Value>, AppError> {
    let server = get_server(&state, id).await?;
    let stdout = run_ssh(&server, "echo connected && uname -srmo").await?;

    Ok(Json(serde_json::json!({
        "server_id": id,
        "message": "ssh connection successful",
        "stdout": stdout.trim(),
    })))
}

async fn probe_server(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<Uuid>,
    Query(query): Query<ProbeQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let server = get_server(&state, id).await?;
    let command = query
        .command
        .unwrap_or_else(|| "echo connected && uname -srmo".to_string());
    let stdout = run_ssh(&server, &command).await?;

    Ok(Json(serde_json::json!({
        "server_id": id,
        "stdout": stdout.trim(),
    })))
}

async fn get_resources(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<Uuid>,
) -> Result<Json<ResourceSnapshot>, AppError> {
    let server = get_server(&state, id).await?;

    let script = r#"
import json
import socket
import subprocess

def sh(cmd):
    return subprocess.check_output(cmd, shell=True, text=True).strip()

mem = sh("free -m | awk 'NR==2 {print $2, $3, $4, $7}'").split()
disk = sh("df -h / | awk 'NR==2 {print $2, $3, $4, $5, $6}'").split()
load = open('/proc/loadavg', 'r', encoding='utf-8').read().split()[:3]

payload = {
    "hostname": socket.gethostname(),
    "uptime": sh("uptime -p"),
    "load_average": {
        "one": float(load[0]),
        "five": float(load[1]),
        "fifteen": float(load[2]),
    },
    "memory": {
        "total_mb": int(mem[0]),
        "used_mb": int(mem[1]),
        "free_mb": int(mem[2]),
        "available_mb": int(mem[3]),
    },
    "root_disk": {
        "total": disk[0],
        "used": disk[1],
        "available": disk[2],
        "used_percent": disk[3],
        "mount_point": disk[4],
    },
}
print(json.dumps(payload))
"#;

    let command = format!("python3 -c '{}'", escape_for_single_quotes(script));
    let stdout = run_ssh(&server, &command).await?;
    let snapshot = serde_json::from_str::<ResourceSnapshot>(&stdout)
        .map_err(|err| AppError::internal(anyhow!(err).context("invalid metrics payload")))?;

    Ok(Json(snapshot))
}

async fn list_files(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<Uuid>,
    Query(query): Query<FilePathQuery>,
) -> Result<Json<FileListResponse>, AppError> {
    let server = get_server(&state, id).await?;
    let current_path = query.path.unwrap_or_else(|| "/".to_string());
    let script = r#"
import json
import os
import stat
import sys

target = os.path.abspath(sys.argv[1])
entries = []
with os.scandir(target) as iterator:
    for entry in iterator:
        info = entry.stat(follow_symlinks=False)
        mode = stat.filemode(info.st_mode)
        if entry.is_symlink():
            file_type = "symlink"
        elif entry.is_dir(follow_symlinks=False):
            file_type = "directory"
        elif entry.is_file(follow_symlinks=False):
            file_type = "file"
        else:
            file_type = "other"
        entries.append({
            "name": entry.name,
            "path": os.path.join(target, entry.name),
            "file_type": file_type,
            "size": info.st_size,
            "mode": mode,
            "modified_epoch": int(info.st_mtime),
        })

entries.sort(key=lambda item: (item["file_type"] != "directory", item["name"].lower()))
print(json.dumps({
    "current_path": target,
    "entries": entries,
}))
"#;

    let command = format!(
        "python3 -c '{}' '{}'",
        escape_for_single_quotes(script),
        escape_for_single_quotes(&current_path)
    );
    let stdout = run_ssh(&server, &command).await?;
    let response = serde_json::from_str::<FileListResponse>(&stdout)
        .map_err(|err| AppError::internal(anyhow!(err).context("invalid file listing payload")))?;

    Ok(Json(response))
}

async fn delete_file(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<Uuid>,
    Query(query): Query<FilePathQuery>,
) -> Result<Json<MessageResponse>, AppError> {
    let server = get_server(&state, id).await?;
    let target_path = query
        .path
        .ok_or_else(|| AppError::bad_request("path is required"))?;

    let script = r#"
import os
import shutil
import sys

target = os.path.abspath(sys.argv[1])
if os.path.isdir(target) and not os.path.islink(target):
    shutil.rmtree(target)
else:
    os.remove(target)
print("deleted")
"#;

    let command = format!(
        "python3 -c '{}' '{}'",
        escape_for_single_quotes(script),
        escape_for_single_quotes(&target_path)
    );
    run_ssh(&server, &command).await?;

    Ok(Json(MessageResponse {
        message: "deleted".to_string(),
    }))
}

async fn rename_file(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<Uuid>,
    Json(request): Json<RenameFileRequest>,
) -> Result<Json<MessageResponse>, AppError> {
    let server = get_server(&state, id).await?;
    let script = r#"
import os
import sys

old_path = os.path.abspath(sys.argv[1])
new_path = os.path.abspath(sys.argv[2])
os.rename(old_path, new_path)
print("renamed")
"#;

    let command = format!(
        "python3 -c '{}' '{}' '{}'",
        escape_for_single_quotes(script),
        escape_for_single_quotes(&request.old_path),
        escape_for_single_quotes(&request.new_path)
    );
    run_ssh(&server, &command).await?;

    Ok(Json(MessageResponse {
        message: "renamed".to_string(),
    }))
}

async fn upload_file(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<Uuid>,
    Query(query): Query<FilePathQuery>,
    mut multipart: Multipart,
) -> Result<Json<MessageResponse>, AppError> {
    let server = get_server(&state, id).await?;
    let destination_dir = query.path.unwrap_or_else(|| "/tmp".to_string());
    let mut uploaded_file = false;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(AppError::multipart)?
    {
        if field.name() != Some("file") {
            continue;
        }

        let file_name = field
            .file_name()
            .map(sanitize_file_name)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| AppError::bad_request("upload requires a filename"))?;
        let bytes = field.bytes().await.map_err(AppError::multipart)?;
        let temp_path = temp_file_path(&file_name);
        fs::write(&temp_path, &bytes)
            .await
            .map_err(|err| AppError::internal(anyhow!(err).context("failed to stage upload")))?;

        let remote_path = remote_join(&destination_dir, &file_name);
        scp_to_remote(&server, &temp_path, &remote_path).await?;
        let _ = fs::remove_file(&temp_path).await;
        uploaded_file = true;
    }

    if !uploaded_file {
        return Err(AppError::bad_request("multipart field 'file' is required"));
    }

    Ok(Json(MessageResponse {
        message: "uploaded".to_string(),
    }))
}

async fn download_file(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<Uuid>,
    Query(query): Query<FilePathQuery>,
) -> Result<Response, AppError> {
    let server = get_server(&state, id).await?;
    let remote_path = query
        .path
        .ok_or_else(|| AppError::bad_request("path is required"))?;
    let file_name = remote_path
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or("download.bin");

    let temp_path = temp_file_path(file_name);
    scp_from_remote(&server, &remote_path, &temp_path).await?;
    let bytes = fs::read(&temp_path)
        .await
        .map_err(|err| AppError::internal(anyhow!(err).context("failed to read downloaded file")))?;
    let _ = fs::remove_file(&temp_path).await;

    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    let disposition = format!("attachment; filename=\"{}\"", sanitize_file_name(file_name));
    response.headers_mut().insert(
        CONTENT_DISPOSITION,
        HeaderValue::from_str(&disposition).map_err(|err| {
            AppError::internal(anyhow!(err).context("invalid content disposition"))
        })?,
    );
    Ok(response)
}

async fn get_server(state: &AppState, id: Uuid) -> Result<RemoteServer, AppError> {
    let store = state.store.read().await;
    store
        .servers
        .get(&id)
        .cloned()
        .ok_or_else(|| AppError::not_found("server not found"))
}

async fn run_ssh(server: &RemoteServer, remote_command: &str) -> Result<String, AppError> {
    let output = spawn_remote_command(server, "ssh", vec![remote_command.to_string()]).await?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        error!("ssh command failed for {}: {}", server.host, stderr);
        return Err(AppError::bad_gateway(if stderr.is_empty() {
            "ssh command failed".to_string()
        } else {
            stderr
        }));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

async fn scp_to_remote(
    server: &RemoteServer,
    local_path: &Path,
    remote_path: &str,
) -> Result<(), AppError> {
    let target = format!("{}:{}", server_target(server), quote_remote_scp_path(remote_path));
    let output = spawn_remote_command(
        server,
        "scp",
        vec![local_path.display().to_string(), target],
    )
    .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppError::bad_gateway(if stderr.is_empty() {
            "scp upload failed".to_string()
        } else {
            stderr
        }));
    }

    Ok(())
}

async fn scp_from_remote(
    server: &RemoteServer,
    remote_path: &str,
    local_path: &Path,
) -> Result<(), AppError> {
    let source = format!("{}:{}", server_target(server), quote_remote_scp_path(remote_path));
    let output = spawn_remote_command(
        server,
        "scp",
        vec![source, local_path.display().to_string()],
    )
    .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppError::bad_gateway(if stderr.is_empty() {
            "scp download failed".to_string()
        } else {
            stderr
        }));
    }

    Ok(())
}

async fn spawn_remote_command(
    server: &RemoteServer,
    program: &str,
    trailing_args: Vec<String>,
) -> Result<std::process::Output, AppError> {
    let mut command = if server.password.is_some() {
        let mut cmd = Command::new("sshpass");
        cmd.arg("-e");
        cmd
    } else {
        Command::new(program)
    };

    if let Some(password) = &server.password {
        command.env("SSHPASS", password);
        command.arg(program);
    }

    command.args(common_remote_args(server, program == "scp"));
    command.args(trailing_args);
    command.output().await.map_err(|err| {
        AppError::internal(anyhow!(err).context(format!("failed to spawn {program}")))
    })
}

fn common_remote_args(server: &RemoteServer, is_scp: bool) -> Vec<OsString> {
    let mut args = vec![
        OsString::from(if is_scp { "-P" } else { "-p" }),
        OsString::from(server.port.to_string()),
        OsString::from("-F"),
        OsString::from("/dev/null"),
        OsString::from("-o"),
        OsString::from("StrictHostKeyChecking=no"),
        OsString::from("-o"),
        OsString::from("UserKnownHostsFile=/dev/null"),
        OsString::from("-o"),
        OsString::from("LogLevel=ERROR"),
        OsString::from("-o"),
        OsString::from("ConnectTimeout=15"),
    ];

    if server.password.is_some() {
        args.push(OsString::from("-o"));
        args.push(OsString::from(
            "PreferredAuthentications=keyboard-interactive,password",
        ));
        args.push(OsString::from("-o"));
        args.push(OsString::from("PubkeyAuthentication=no"));
        args.push(OsString::from("-o"));
        args.push(OsString::from("KbdInteractiveAuthentication=yes"));
        args.push(OsString::from("-o"));
        args.push(OsString::from("NumberOfPasswordPrompts=1"));
    } else if let Some(private_key_path) = &server.private_key_path {
        args.push(OsString::from("-o"));
        args.push(OsString::from("BatchMode=yes"));
        args.push(OsString::from("-i"));
        args.push(OsString::from(private_key_path));
    }

    args.push(OsString::from(server_target(server)));
    args
}

fn server_target(server: &RemoteServer) -> String {
    format!("{}@{}", server.username, server.host)
}

fn escape_for_single_quotes(input: &str) -> String {
    input.replace('\'', "'\"'\"'")
}

fn quote_remote_scp_path(path: &str) -> String {
    format!("'{}'", escape_for_single_quotes(path))
}

fn temp_file_path(file_name: &str) -> PathBuf {
    let unique = format!("{}-{}", Uuid::new_v4(), sanitize_file_name(file_name));
    std::env::temp_dir().join(unique)
}

fn sanitize_file_name(name: &str) -> String {
    name.chars()
        .map(|ch| match ch {
            '/' | '\\' | '"' | '\'' => '_',
            _ => ch,
        })
        .collect()
}

fn remote_join(dir: &str, name: &str) -> String {
    if dir == "/" {
        format!("/{}", name)
    } else {
        format!("{}/{}", dir.trim_end_matches('/'), name)
    }
}

#[derive(Debug)]
struct AppError {
    status: StatusCode,
    message: String,
}

impl AppError {
    fn internal(error: anyhow::Error) -> Self {
        error!("{error:#}");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: "internal server error".to_string(),
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }

    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn bad_gateway(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            message: message.into(),
        }
    }

    fn multipart(error: MultipartError) -> Self {
        Self::bad_request(format!("multipart error: {error}"))
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        (self.status, Json(ApiError { error: self.message })).into_response()
    }
}
