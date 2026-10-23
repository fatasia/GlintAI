use crate::{job::ProcessJob, protocol};
use std::{
    io::{BufReader, Write},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc::{self, Receiver, RecvTimeoutError},
    thread,
    time::{Duration, Instant},
};
use url::Url;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);
const POLL: Duration = Duration::from_millis(50);
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct Service {
    child: Child,
    nonce: String,
    _job: ProcessJob,
}

fn repository() -> Result<PathBuf, String> {
    let compiled = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .ok_or("Cannot determine development repository")?;
    let repo = match std::env::var_os("GLINT_DESKTOP_REPO") {
        Some(value) => PathBuf::from(value),
        None if cfg!(debug_assertions) => compiled.to_path_buf(),
        None => {
            return Err(
                "GLINT_DESKTOP_REPO missing: release builds must point at the app directory that holds apps/web."
                    .into(),
            )
        }
    };
    // Node's ESM entry detection expects normal Windows paths, not \\?\ device paths.
    let repo = dunce::canonicalize(repo)
        .map_err(|e| format!("Cannot resolve development repository: {e}"))?;
    if !repo.join("apps/web/server/desktop-service.mjs").is_file()
        || !repo.join("apps/web/dist/index.html").is_file()
    {
        // Packaged layouts point at a bundled service + UI instead of the workspace.
        if std::env::var_os("GLINT_DESKTOP_SERVICE").is_some() {
            return Ok(repo);
        }
        return Err("Development service/UI missing. Build apps/web and run node apps/desktop/scripts/dev.mjs.".into());
    }
    Ok(repo)
}

impl Service {
    pub fn spawn(data_dir: &Path) -> Result<(Self, Receiver<Result<Url, String>>), String> {
        let repo = repository()?;
        let node = std::env::var_os("GLINT_DESKTOP_NODE").ok_or(
            "Node path missing. Use node apps/desktop/scripts/dev.mjs to resolve installed Node and tsx.")?;
        let packaged = std::env::var_os("GLINT_DESKTOP_SERVICE").map(PathBuf::from);
        let packaged = match packaged {
            Some(service) if service.is_file() => Some(service),
            Some(_) => {
                return Err("GLINT_DESKTOP_SERVICE must point at the bundled service.mjs".into())
            }
            None => None,
        };
        let tsx = if packaged.is_some() {
            None
        } else {
            Some(std::env::var("GLINT_DESKTOP_TSX").map_err(|_| {
                "tsx loader missing. Use node apps/desktop/scripts/dev.mjs after pnpm install."
            })?)
        };
        if !Path::new(&node).is_absolute() || !Path::new(&node).is_file() {
            return Err(
                "GLINT_DESKTOP_NODE must identify an installed absolute node.exe path".into(),
            );
        }
        if let Some(tsx) = tsx.as_deref() {
            let loader = Url::parse(tsx).map_err(|_| "Invalid tsx loader URL")?;
            if loader.scheme() != "file" || !loader.to_file_path().is_ok_and(|p| p.is_file()) {
                return Err(
                    "GLINT_DESKTOP_TSX must be a file URL for the installed tsx loader".into(),
                );
            }
        }
        std::fs::create_dir_all(data_dir)
            .map_err(|e| format!("Cannot create app data directory: {e}"))?;
        let nonce = uuid::Uuid::new_v4().to_string();
        let job = ProcessJob::new()
            .map_err(|e| format!("Cannot create service supervision Job Object: {e}"))?;
        let mut command = Command::new(node);
        match packaged.as_deref() {
            Some(service) => {
                command.arg(service);
            }
            None => {
                command
                    .arg("--import")
                    .arg(tsx.as_deref().ok_or("tsx loader missing")?)
                    .arg(repo.join("apps/web/server/desktop-service.mjs"));
            }
        }
        let mut child = command
            .arg(format!("--data-dir={}", data_dir.display()))
            .arg(format!("--nonce={nonce}"))
            .current_dir(repo)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Cannot start installed Node desktop service: {e}"))?;
        if let Err(error) = job.assign(&child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "Cannot supervise service process; refusing unsupervised startup: {error}"
            ));
        }
        let mut service = Self {
            child,
            nonce: nonce.clone(),
            _job: job,
        };
        let stdout = service
            .child
            .stdout
            .take()
            .ok_or("Node stdout unavailable")?;
        let stderr = service
            .child
            .stderr
            .take()
            .ok_or("Node stderr unavailable")?;
        let (tx, rx) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let _ = tx.send(protocol::read_ready(&mut reader, &nonce));
            protocol::drain(&mut reader);
        });
        thread::spawn(move || protocol::drain(&mut BufReader::new(stderr)));
        Ok((service, rx))
    }

    pub fn wait_ready(
        &mut self,
        ready: &Receiver<Result<Url, String>>,
        stop: &Receiver<()>,
    ) -> Result<Url, String> {
        let deadline = Instant::now() + STARTUP_TIMEOUT;
        loop {
            if stop.try_recv().is_ok() {
                return Err("Desktop startup cancelled".into());
            }
            if !self.running()? {
                return Err("Desktop Node service exited before readiness. Check web build and service dependencies.".into());
            }
            if Instant::now() >= deadline {
                return Err("Desktop service did not become ready within 20 seconds".into());
            }
            match ready.recv_timeout(POLL) {
                Ok(result) => return result,
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    return Err("Desktop service readiness stream closed".into())
                }
            }
        }
    }

    pub fn running(&mut self) -> Result<bool, String> {
        self.child
            .try_wait()
            .map(|status| status.is_none())
            .map_err(|e| format!("Cannot inspect desktop service process: {e}"))
    }

    pub fn monitor(&mut self, stop: &Receiver<()>) -> Result<(), String> {
        loop {
            match stop.recv_timeout(POLL) {
                Ok(()) | Err(RecvTimeoutError::Disconnected) => return Ok(()),
                Err(RecvTimeoutError::Timeout) => {}
            }
            if !self.running()? {
                return Err("Owned desktop service exited; closing native host".into());
            }
        }
    }
}

impl Drop for Service {
    fn drop(&mut self) {
        if let Some(mut stdin) = self.child.stdin.take() {
            let message = serde_json::json!({"type":"shutdown", "nonce":self.nonce});
            let _ = writeln!(stdin, "{message}");
            // Closing stdin is a second independent shutdown signal.
        }
        let deadline = Instant::now() + SHUTDOWN_TIMEOUT;
        while Instant::now() < deadline {
            if self.child.try_wait().ok().flatten().is_some() {
                return;
            }
            thread::sleep(POLL);
        }
        let _ = self.child.kill();
        // Job RAII closes immediately after this function, killing remaining descendants.
    }
}
