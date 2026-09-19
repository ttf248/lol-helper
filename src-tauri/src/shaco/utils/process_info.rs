use crate::shaco::error::ProcessInfoError;
use base64::{engine::general_purpose, Engine};
use sysinfo::{ProcessExt, System, SystemExt};

#[cfg(target_os = "windows")]
const TARGET_PROCESS: &str = "LeagueClientUx.exe";
// #[cfg(target_os = "linux")]
// const TARGET_PROCESS: &str = "LeagueClientUx.";
// #[cfg(target_os = "macos")]
// const TARGET_PROCESS: &str = "LeagueClientUx";

pub struct AuthResponse {
    pub token: String,
    pub port: String,
    pub region: String, // 即 rso_platform_id
}

pub(crate) fn get_auth_info() -> Result<AuthResponse, ProcessInfoError> {
    let mut sys = System::new_all();

    sys.refresh_processes();

    let args = sys
        .processes()
        .values()
        .find(|p| p.name() == TARGET_PROCESS)
        .map(|p| p.cmd())
        .ok_or_else(|| {
            tracing::warn!(
                target = "lcu.auth",
                "lcu.auth process not found (LeagueClientUx.exe)"
            );
            ProcessInfoError::ProcessNotAvailable
        })?;

    let port = args
        .iter()
        .find(|arg| arg.starts_with("--app-port="))
        .map(|arg| arg.strip_prefix("--app-port=").unwrap().to_string())
        .ok_or_else(|| {
            tracing::warn!(
                target = "lcu.auth",
                "lcu.auth --app-port not present in process args"
            );
            ProcessInfoError::PortNotFound
        })?;
    let auth_token = args
        .iter()
        .find(|arg| arg.starts_with("--remoting-auth-token="))
        .map(|arg| {
            arg.strip_prefix("--remoting-auth-token=")
                .unwrap()
                .to_string()
        })
        .ok_or_else(|| {
            tracing::warn!(
                target = "lcu.auth",
                "lcu.auth --remoting-auth-token not present in process args"
            );
            ProcessInfoError::AuthTokenNotFound
        })?;

    let rso_platform_id = args
        .iter()
        .find(|arg| arg.starts_with("--rso_platform_id="))
        .map(|arg| arg.strip_prefix("--rso_platform_id=").unwrap().to_string())
        .ok_or_else(|| {
            tracing::warn!(
                target = "lcu.auth",
                "lcu.auth --rso_platform_id not present in process args"
            );
            ProcessInfoError::PlatformIdNotFound
        })?;

    let token_b64 = general_purpose::STANDARD.encode(format!("riot:{}", auth_token));
    tracing::info!(
        target = "lcu.auth",
        port_len = port.len(),
        region = %rso_platform_id,
        token_len = token_b64.len(),
        "lcu.auth parsed"
    );
    Ok(AuthResponse {
        token: token_b64,
        port,
        region: rso_platform_id,
    })
}
