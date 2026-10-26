//! The one owner of every MSFS model conversion, for the host window and remote browsers alike.
//!
//! `ConversionOwner` builds the converter's arguments, names its output, bounds how many
//! converters run at once (two in all, one of them for remote browsers, one in flight per remote
//! device, eight remote requests waiting), shares one job among every caller asking for the same
//! output file, kills a converter running past `RUN_DEADLINE` with its whole process tree, and
//! reports success only for an output file that passes the cache scan's GLB check.

use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use futures_util::future::BoxFuture;
use tauri::Manager;
use tokio::io::AsyncReadExt;
use tokio::sync::{watch, Notify, OwnedSemaphorePermit, Semaphore};

#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

use crate::msfs::SourceModelInfo;
use crate::{to_extended_length_path, CONVERTER_BIN};

/// Converter processes running at once, host and remote together.
pub const MAX_CONVERTERS: usize = 2;
/// Converter processes running at once for remote browsers.
pub const MAX_REMOTE_CONVERTERS: usize = 1;
/// Remote requests that may wait for a converter; one more is refused at once.
pub const MAX_REMOTE_WAITING: usize = 8;
/// How long one converter may run before its process tree is killed.
pub const RUN_DEADLINE: Duration = Duration::from_secs(5 * 60);
/// How long a remote request may wait for a converter before it is refused.
pub const QUEUE_DEADLINE: Duration = Duration::from_secs(2 * 60);

/// Who asks for a conversion: the host window, or a remote browser at an address.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Caller {
    Host,
    Remote(IpAddr),
}

/// One livery to convert, as the model index describes it.
#[derive(Debug, Clone)]
pub struct ConversionRequest {
    /// The aircraft folder the converter reads (its name decides the output's source prefix)
    pub source_path: String,
    /// The livery title (`aircraft.cfg` title), also the output name's second half
    pub livery_title: String,
    /// The glTF the index resolved for the livery, or empty
    pub gltf_path: String,
    /// The texture folders the index resolved for the livery, in lookup order
    pub texture_dirs: Vec<String>,
    /// `full`, `2k`, `1k` or `512`
    pub texture_scale: String,
    /// The cache folder the GLB is written to
    pub output_dir: PathBuf,
}

impl ConversionRequest {
    /// The request converting `entry` into `output_dir` at `texture_scale`.
    pub fn from_index_entry(
        entry: &SourceModelInfo,
        output_dir: PathBuf,
        texture_scale: &str,
    ) -> Self {
        ConversionRequest {
            source_path: entry.aircraft_folder_path.clone(),
            livery_title: entry.model_name.clone(),
            gltf_path: entry.gltf_path.clone(),
            texture_dirs: entry.texture_dirs.clone(),
            texture_scale: texture_scale.to_string(),
            output_dir,
        }
    }

    /// The file name the converter writes for this request.
    pub fn output_file_name(&self) -> String {
        let folder_name = Path::new(&self.source_path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        output_file_name(&folder_name, &self.livery_title)
    }
}

/// The name the converter gives a livery's GLB: `{source}_{livery title}.glb`, the source being
/// `fsltl` for an aircraft folder whose name starts with `fsltl` (any case) and `aig` otherwise.
pub fn output_file_name(folder_name: &str, livery_title: &str) -> String {
    let source_type = if folder_name.to_lowercase().starts_with("fsltl") {
        "fsltl"
    } else {
        "aig"
    };
    format!("{source_type}_{livery_title}.glb")
}

/// The converter's arguments for `request`: `--no-discovery` whenever the index resolved the glTF,
/// the texture folders and the livery title, every path in extended-length form.
pub fn converter_args(request: &ConversionRequest) -> Vec<String> {
    let mut args = vec![
        "--source".to_string(),
        to_extended_length_path(&request.source_path),
        "--output".to_string(),
        to_extended_length_path(&request.output_dir.to_string_lossy()),
        "--texture-scale".to_string(),
        request.texture_scale.clone(),
    ];
    if !request.livery_title.is_empty() {
        args.extend(["--liveries".to_string(), request.livery_title.clone()]);
    }
    let no_discovery = !request.gltf_path.is_empty()
        && !request.texture_dirs.is_empty()
        && !request.livery_title.is_empty();
    if no_discovery {
        args.push("--no-discovery".to_string());
    }
    if !request.gltf_path.is_empty() {
        args.extend([
            "--gltf-path".to_string(),
            to_extended_length_path(&request.gltf_path),
        ]);
    }
    if !request.texture_dirs.is_empty() {
        let dirs: Vec<String> = request
            .texture_dirs
            .iter()
            .map(|dir| to_extended_length_path(dir))
            .collect();
        args.extend(["--texture-dirs".to_string(), dirs.join(",")]);
    }
    args
}

/// Where the bundled converter may be, in lookup order: the installed resources, the dev tree
/// beside this crate, then two paths relative to the working folder.
fn converter_candidates(resource_dir: &Path) -> [PathBuf; 4] {
    [
        resource_dir.join("resources").join(CONVERTER_BIN),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(CONVERTER_BIN),
        PathBuf::from("src-tauri/resources").join(CONVERTER_BIN),
        PathBuf::from(CONVERTER_BIN),
    ]
}

/// The bundled converter executable: the first of `converter_candidates` that exists.
pub fn find_converter(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Failed to get resource directory: {}", e))?;
    let candidates = converter_candidates(&resource_dir);
    candidates
        .iter()
        .find(|path| path.exists())
        .cloned()
        .ok_or_else(|| {
            format!(
                "Converter executable not found. Tried: {:?}. Run 'pnpm run build:converter' first.",
                candidates
                    .iter()
                    .map(|path| path.display().to_string())
                    .collect::<Vec<_>>()
            )
        })
}

/// A conversion that wrote its GLB.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Converted {
    /// The GLB under the request's output folder
    pub output_path: PathBuf,
    /// The GLB's file name
    pub file_name: String,
}

/// Why a remote request was refused without converting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// The device already has a conversion in flight
    DeviceBusy,
    /// `MAX_REMOTE_WAITING` remote requests are already waiting
    QueueFull,
    /// No converter came free within `QUEUE_DEADLINE`
    QueueTimeout,
}

/// Why a conversion produced no GLB.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConversionError {
    /// The converter could not start, failed, or wrote no complete GLB
    Failed(String),
    /// The converter ran past `RUN_DEADLINE` and was killed
    TimedOut,
    /// A remote request was refused (see `Refusal`)
    Refused(Refusal),
}

impl std::fmt::Display for ConversionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConversionError::Failed(message) => f.write_str(message),
            ConversionError::TimedOut => f.write_str("timed out"),
            ConversionError::Refused(_) => f.write_str("busy"),
        }
    }
}

/// What a converter process left when it exited.
#[derive(Debug, Clone)]
pub struct ProcessExit {
    pub success: bool,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// A running converter.
pub trait ConverterProcess: Send {
    /// Waits for the converter to exit and collects its output.
    fn wait(&mut self) -> BoxFuture<'_, Result<ProcessExit, String>>;
    /// Kills the converter with every process it started and waits until they are gone.
    fn kill_tree(&mut self) -> BoxFuture<'_, ()>;
}

/// Starts converters: the real one spawns `fsltl_converter`, a test one waits on its test.
pub trait ConverterRunner: Send + Sync {
    fn spawn(&self, request: &ConversionRequest) -> Result<Box<dyn ConverterProcess>, String>;
}

/// The one owner of every model conversion (see the module docs).
#[derive(Clone)]
pub struct ConversionOwner {
    inner: Arc<Inner>,
}

type JobResult = Result<Converted, ConversionError>;
type JobReceiver = watch::Receiver<Option<JobResult>>;

struct Inner {
    runner: Arc<dyn ConverterRunner>,
    /// `MAX_CONVERTERS` permits, one per running converter
    global: Arc<Semaphore>,
    /// `MAX_REMOTE_CONVERTERS` permits, taken by a remote job before its global one
    remote: Arc<Semaphore>,
    state: Mutex<OwnerState>,
}

#[derive(Default)]
struct OwnerState {
    /// The job converting each canonical output path, until it ends
    jobs: HashMap<PathBuf, JobHandle>,
    /// Remote devices with a request in flight
    remote_devices: HashSet<IpAddr>,
    /// Remote jobs waiting for their permits
    remote_waiting: usize,
}

/// A running job as callers joining it see it.
struct JobHandle {
    receiver: JobReceiver,
    /// Told when a host joins, so a remote job still waiting for permits becomes a host job
    promote: Arc<Notify>,
}

impl Inner {
    fn state(&self) -> MutexGuard<'_, OwnerState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl ConversionOwner {
    /// An owner starting its converters through `runner`.
    pub fn new(runner: Arc<dyn ConverterRunner>) -> Self {
        ConversionOwner {
            inner: Arc::new(Inner {
                runner,
                global: Arc::new(Semaphore::new(MAX_CONVERTERS)),
                remote: Arc::new(Semaphore::new(MAX_REMOTE_CONVERTERS)),
                state: Mutex::new(OwnerState::default()),
            }),
        }
    }

    /// Converts `request` for `caller`, joining the job already converting the same output file.
    /// The job runs on the owner's own task, so this future going away cancels nothing. The host
    /// is never refused: a host that joined a remote job just as it was refused starts again.
    pub async fn convert(&self, request: ConversionRequest, caller: Caller) -> JobResult {
        let (key, converted) = output_paths(&request).map_err(ConversionError::Failed)?;
        loop {
            let result = self
                .attend(key.clone(), converted.clone(), request.clone(), caller)
                .await;
            match result {
                Err(ConversionError::Refused(_)) if caller == Caller::Host => continue,
                other => return other,
            }
        }
    }

    /// Joins or starts the job for `key` and waits for its result.
    async fn attend(
        &self,
        key: PathBuf,
        converted: Converted,
        request: ConversionRequest,
        caller: Caller,
    ) -> JobResult {
        let (mut receiver, _device) = self.enter(key, converted, request, caller)?;
        let result = match receiver.wait_for(Option::is_some).await {
            Ok(result) => result.clone(),
            Err(_) => None,
        };
        result.unwrap_or_else(|| {
            Err(ConversionError::Failed(
                "The conversion task ended without a result".to_string(),
            ))
        })
    }

    /// Joins the job for `key`, or starts one, refusing a remote over its limits. Runs without
    /// awaiting, so two callers for one output can never both start a job.
    fn enter(
        &self,
        key: PathBuf,
        converted: Converted,
        request: ConversionRequest,
        caller: Caller,
    ) -> Result<(JobReceiver, Option<DeviceSlot>), ConversionError> {
        let mut state = self.inner.state();
        let device = match caller {
            Caller::Remote(ip) if state.remote_devices.contains(&ip) => {
                return Err(ConversionError::Refused(Refusal::DeviceBusy));
            }
            Caller::Remote(ip) => Some(ip),
            Caller::Host => None,
        };
        if let Some(job) = state.jobs.get(&key) {
            let receiver = job.receiver.clone();
            if caller == Caller::Host {
                // Stored when the job is not waiting yet; ignored once it holds its permits.
                job.promote.notify_one();
            }
            let slot = device.map(|ip| self.hold_device(&mut state, ip));
            return Ok((receiver, slot));
        }
        let remote = device.is_some();
        if remote && state.remote_waiting >= MAX_REMOTE_WAITING {
            return Err(ConversionError::Refused(Refusal::QueueFull));
        }
        let (sender, receiver) = watch::channel(None);
        let promote = Arc::new(Notify::new());
        state.jobs.insert(
            key.clone(),
            JobHandle {
                receiver: receiver.clone(),
                promote: Arc::clone(&promote),
            },
        );
        if remote {
            state.remote_waiting += 1;
        }
        let slot = device.map(|ip| self.hold_device(&mut state, ip));
        drop(state);

        let entry = JobEntry {
            inner: Arc::clone(&self.inner),
            key,
            waiting: remote,
        };
        tokio::spawn(run_job(entry, promote, converted, request, sender));
        Ok((receiver, slot))
    }

    fn hold_device(&self, state: &mut OwnerState, ip: IpAddr) -> DeviceSlot {
        state.remote_devices.insert(ip);
        DeviceSlot {
            inner: Arc::clone(&self.inner),
            ip,
        }
    }
}

/// A remote device's place in flight, given up when its request ends.
struct DeviceSlot {
    inner: Arc<Inner>,
    ip: IpAddr,
}

impl Drop for DeviceSlot {
    fn drop(&mut self) {
        self.inner.state().remote_devices.remove(&self.ip);
    }
}

/// A job's in-flight entry (and its place among the waiting remotes), removed when the job ends.
struct JobEntry {
    inner: Arc<Inner>,
    key: PathBuf,
    waiting: bool,
}

impl JobEntry {
    fn stop_waiting(&mut self) {
        if self.waiting {
            self.waiting = false;
            self.inner.state().remote_waiting -= 1;
        }
    }
}

impl Drop for JobEntry {
    fn drop(&mut self) {
        self.stop_waiting();
        self.inner.state().jobs.remove(&self.key);
    }
}

/// The in-flight key (the cache folder canonicalized, joined with the output name) and the GLB
/// a success reports, creating the cache folder when missing.
fn output_paths(request: &ConversionRequest) -> Result<(PathBuf, Converted), String> {
    std::fs::create_dir_all(&request.output_dir).map_err(|e| {
        format!(
            "Failed to create output directory {}: {}",
            request.output_dir.display(),
            e
        )
    })?;
    let canonical = request.output_dir.canonicalize().map_err(|e| {
        format!(
            "Failed to resolve output directory {}: {}",
            request.output_dir.display(),
            e
        )
    })?;
    let file_name = request.output_file_name();
    let converted = Converted {
        output_path: request.output_dir.join(&file_name),
        file_name: file_name.clone(),
    };
    Ok((canonical.join(file_name), converted))
}

/// Runs one job to its end: permits, converter, verification. The permits are released once the
/// converter's tree is gone, then the in-flight entry, then the waiters hear the result.
async fn run_job(
    mut entry: JobEntry,
    promote: Arc<Notify>,
    converted: Converted,
    request: ConversionRequest,
    sender: watch::Sender<Option<JobResult>>,
) {
    let inner = Arc::clone(&entry.inner);
    let result = match acquire_permits(&mut entry, &promote).await {
        Ok(permits) => {
            entry.stop_waiting();
            let verify_path = entry.key.clone();
            let result = execute(inner.runner.as_ref(), &request, &verify_path, converted).await;
            drop(permits);
            result
        }
        Err(refusal) => {
            tracing::warn!(
                "[Conversion] Refused {:?} for a remote client: {:?}",
                request.livery_title,
                refusal
            );
            Err(ConversionError::Refused(refusal))
        }
    };
    drop(entry);
    sender.send_replace(Some(result));
}

/// A host job takes one global permit, waiting as long as it must. A remote job (one still
/// counted among the waiting) takes the remote permit and then a global one, so the host always
/// keeps one, within `QUEUE_DEADLINE`; a host joining it first, or at the deadline itself, makes
/// it a host job, which leaves the waiting count and takes one global permit with no deadline.
async fn acquire_permits(
    entry: &mut JobEntry,
    promote: &Notify,
) -> Result<Vec<OwnedSemaphorePermit>, Refusal> {
    let inner = Arc::clone(&entry.inner);
    if !entry.waiting {
        return Ok(vec![acquire(&inner.global).await]);
    }
    let remote_permits = async {
        let remote_permit = acquire(&inner.remote).await;
        let global_permit = acquire(&inner.global).await;
        vec![remote_permit, global_permit]
    };
    tokio::select! {
        biased;
        () = promote.notified() => {
            entry.stop_waiting();
            Ok(vec![acquire(&inner.global).await])
        }
        permits = remote_permits => Ok(permits),
        () = tokio::time::sleep(QUEUE_DEADLINE) => Err(Refusal::QueueTimeout),
    }
}

async fn acquire(semaphore: &Arc<Semaphore>) -> OwnedSemaphorePermit {
    Arc::clone(semaphore)
        .acquire_owned()
        .await
        .expect("the owner never closes its semaphores")
}

/// Starts the converter and waits for it within `RUN_DEADLINE`; success needs a GLB at
/// `verify_path` that passes the cache scan's check, also after a kill.
async fn execute(
    runner: &dyn ConverterRunner,
    request: &ConversionRequest,
    verify_path: &Path,
    converted: Converted,
) -> JobResult {
    let mut process = runner.spawn(request).map_err(ConversionError::Failed)?;
    let waited = tokio::time::timeout(RUN_DEADLINE, process.wait()).await;
    match waited {
        Ok(Ok(exit)) => finish_exit(exit, verify_path, converted),
        Ok(Err(e)) => {
            process.kill_tree().await;
            Err(ConversionError::Failed(e))
        }
        Err(_) => {
            tracing::warn!(
                "[Conversion] {:?} ran past {} s; killed its process tree",
                request.livery_title,
                RUN_DEADLINE.as_secs()
            );
            process.kill_tree().await;
            if crate::msfs::is_accepted_glb(verify_path) {
                Ok(converted)
            } else {
                Err(ConversionError::TimedOut)
            }
        }
    }
}

fn finish_exit(exit: ProcessExit, verify_path: &Path, converted: Converted) -> JobResult {
    if !exit.stderr.is_empty() {
        tracing::info!("[MSFSConvert] stderr: {}", exit.stderr);
    }
    if !exit.stdout.is_empty() {
        tracing::info!("[MSFSConvert] stdout: {}", exit.stdout);
    }
    if !exit.success {
        let message = if !exit.stderr.is_empty() {
            exit.stderr
        } else if !exit.stdout.is_empty() {
            exit.stdout
        } else {
            format!("Conversion failed with exit code: {:?}", exit.code)
        };
        return Err(ConversionError::Failed(message));
    }
    if crate::msfs::is_accepted_glb(verify_path) {
        Ok(converted)
    } else {
        Err(ConversionError::Failed(format!(
            "The converter exited without writing a complete GLB at {}",
            verify_path.display()
        )))
    }
}

// =============================================================================
// THE REAL CONVERTER
// =============================================================================

/// Starts the bundled `fsltl_converter`, each in a job object that takes its whole tree down.
pub struct BundledConverter {
    app: tauri::AppHandle,
}

impl BundledConverter {
    pub fn new(app: tauri::AppHandle) -> Self {
        BundledConverter { app }
    }
}

impl ConverterRunner for BundledConverter {
    fn spawn(&self, request: &ConversionRequest) -> Result<Box<dyn ConverterProcess>, String> {
        let converter = find_converter(&self.app)?;
        let mut command = tokio::process::Command::new(&converter);
        command
            .args(converter_args(request))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        let mut child = command
            .spawn()
            .map_err(|e| format!("Failed to execute converter {}: {}", converter.display(), e))?;

        #[cfg(windows)]
        let job = match adopt_into_job(&child) {
            Ok(job) => job,
            Err(e) => {
                if let Err(kill) = child.start_kill() {
                    tracing::warn!("[Conversion] Could not kill the converter: {}", kill);
                }
                return Err(e);
            }
        };
        let stdout = child.stdout.take().map(read_pipe);
        let stderr = child.stderr.take().map(read_pipe);
        Ok(Box::new(BundledProcess {
            child,
            #[cfg(windows)]
            job,
            stdout,
            stderr,
        }))
    }
}

/// Hides the converter's console window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(windows)]
fn adopt_into_job(child: &tokio::process::Child) -> Result<JobObject, String> {
    let handle = child
        .raw_handle()
        .ok_or("The converter exited before it could join a job object")?;
    let job = JobObject::kill_on_close()?;
    job.assign(handle)?;
    Ok(job)
}

fn read_pipe<R>(mut pipe: R) -> tokio::task::JoinHandle<String>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut bytes = Vec::new();
        if let Err(e) = pipe.read_to_end(&mut bytes).await {
            tracing::warn!("[Conversion] Reading converter output failed: {}", e);
        }
        String::from_utf8_lossy(&bytes).into_owned()
    })
}

async fn collect_pipe(pipe: &mut Option<tokio::task::JoinHandle<String>>) -> String {
    match pipe.take() {
        Some(task) => task.await.unwrap_or_else(|e| {
            tracing::warn!("[Conversion] Collecting converter output failed: {}", e);
            String::new()
        }),
        None => String::new(),
    }
}

struct BundledProcess {
    child: tokio::process::Child,
    #[cfg(windows)]
    job: JobObject,
    stdout: Option<tokio::task::JoinHandle<String>>,
    stderr: Option<tokio::task::JoinHandle<String>>,
}

impl ConverterProcess for BundledProcess {
    fn wait(&mut self) -> BoxFuture<'_, Result<ProcessExit, String>> {
        Box::pin(async move {
            let status = self
                .child
                .wait()
                .await
                .map_err(|e| format!("Failed to wait for the converter: {}", e))?;
            let stdout = collect_pipe(&mut self.stdout).await;
            let stderr = collect_pipe(&mut self.stderr).await;
            Ok(ProcessExit {
                success: status.success(),
                code: status.code(),
                stdout,
                stderr,
            })
        })
    }

    fn kill_tree(&mut self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            #[cfg(windows)]
            self.job.terminate();
            #[cfg(not(windows))]
            if let Err(e) = self.child.start_kill() {
                tracing::warn!("[Conversion] Could not kill the converter: {}", e);
            }
            if let Err(e) = self.child.wait().await {
                tracing::warn!(
                    "[Conversion] Waiting for the killed converter failed: {}",
                    e
                );
            }
        })
    }
}

// =============================================================================
// WINDOWS JOB OBJECT
// =============================================================================

/// A Windows job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`: closing it (dropping this)
/// ends every process in it, the converter and everything it started.
#[cfg(windows)]
pub(crate) struct JobObject(HANDLE);

// A job handle is a kernel object handle, usable from any thread.
#[cfg(windows)]
unsafe impl Send for JobObject {}
#[cfg(windows)]
unsafe impl Sync for JobObject {}

#[cfg(windows)]
impl JobObject {
    /// A new job whose processes all end when its handle closes.
    pub(crate) fn kill_on_close() -> Result<Self, String> {
        // SAFETY: null attributes and name create an unnamed job with default security.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err("Failed to create job object".to_string());
        }
        let job = JobObject(handle);
        // SAFETY: a zeroed JOBOBJECT_EXTENDED_LIMIT_INFORMATION is a valid "no limits" value.
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: `info` is the structure the information class names, with its exact size.
        let configured = unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            return Err("Failed to configure job object".to_string());
        }
        Ok(job)
    }

    /// Puts the process behind `process` (a live process handle) in this job.
    pub(crate) fn assign(&self, process: std::os::windows::io::RawHandle) -> Result<(), String> {
        // SAFETY: both handles are open: the job is ours, the process handle the caller's.
        let assigned = unsafe { AssignProcessToJobObject(self.0, process) };
        if assigned == 0 {
            return Err("Failed to assign process to job object".to_string());
        }
        Ok(())
    }

    /// Ends every process in the job now.
    fn terminate(&self) {
        // SAFETY: the job handle is open until drop.
        if unsafe { TerminateJobObject(self.0, 1) } == 0 {
            tracing::warn!("[Conversion] Terminating the converter's job object failed");
        }
    }
}

#[cfg(windows)]
impl Drop for JobObject {
    fn drop(&mut self) {
        // SAFETY: the handle is open and closed only here.
        unsafe { CloseHandle(self.0) };
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::{mpsc, oneshot};

    /// Far past every owner deadline, on the paused test clock.
    const HANG_GUARD: Duration = Duration::from_secs(60 * 60);

    /// How a fake converter ends when its test says so.
    #[derive(Debug, Clone, Copy)]
    pub(crate) struct FakeExit {
        pub success: bool,
        pub write_glb: bool,
    }

    /// One fake converter the owner started: finish it, or watch for its kill.
    pub(crate) struct Spawned {
        pub title: String,
        pub finish: oneshot::Sender<FakeExit>,
        pub killed: oneshot::Receiver<()>,
    }

    /// The test's side of a `FakeRunner`.
    pub(crate) struct FakeControl {
        spawned: mpsc::UnboundedReceiver<Spawned>,
        count: Arc<AtomicUsize>,
    }

    impl FakeControl {
        /// The next converter the owner starts.
        /// The guard runs on the paused test clock, which jumps ahead whenever every task waits,
        /// so a converter that never starts fails the test as hung instead of stalling it.
        pub(crate) async fn next_spawn(&mut self) -> Spawned {
            tokio::time::timeout(HANG_GUARD, self.spawned.recv())
                .await
                .expect("hung: no converter started")
                .expect("the runner is alive")
        }

        /// How many converters the owner has started.
        pub(crate) fn spawn_count(&self) -> usize {
            self.count.load(Ordering::SeqCst)
        }
    }

    /// A runner whose converters exit only when the test finishes them.
    pub(crate) struct FakeRunner {
        spawned: mpsc::UnboundedSender<Spawned>,
        count: Arc<AtomicUsize>,
    }

    impl FakeRunner {
        pub(crate) fn new() -> (Arc<FakeRunner>, FakeControl) {
            let (tx, rx) = mpsc::unbounded_channel();
            let count = Arc::new(AtomicUsize::new(0));
            let runner = FakeRunner {
                spawned: tx,
                count: Arc::clone(&count),
            };
            (Arc::new(runner), FakeControl { spawned: rx, count })
        }
    }

    impl ConverterRunner for FakeRunner {
        fn spawn(&self, request: &ConversionRequest) -> Result<Box<dyn ConverterProcess>, String> {
            self.count.fetch_add(1, Ordering::SeqCst);
            let (finish_tx, finish_rx) = oneshot::channel();
            let (killed_tx, killed_rx) = oneshot::channel();
            self.spawned
                .send(Spawned {
                    title: request.livery_title.clone(),
                    finish: finish_tx,
                    killed: killed_rx,
                })
                .map_err(|_| "the test stopped listening".to_string())?;
            Ok(Box::new(FakeProcess {
                finish: finish_rx,
                killed: Some(killed_tx),
                output: request.output_dir.join(request.output_file_name()),
            }))
        }
    }

    struct FakeProcess {
        finish: oneshot::Receiver<FakeExit>,
        killed: Option<oneshot::Sender<()>>,
        output: PathBuf,
    }

    impl ConverterProcess for FakeProcess {
        fn wait(&mut self) -> BoxFuture<'_, Result<ProcessExit, String>> {
            Box::pin(async move {
                let Ok(exit) = (&mut self.finish).await else {
                    return std::future::pending().await;
                };
                if exit.write_glb {
                    write_glb(&self.output);
                }
                Ok(ProcessExit {
                    success: exit.success,
                    code: Some(if exit.success { 0 } else { 1 }),
                    stdout: String::new(),
                    stderr: if exit.success {
                        String::new()
                    } else {
                        "fake converter failed".to_string()
                    },
                })
            })
        }

        fn kill_tree(&mut self) -> BoxFuture<'_, ()> {
            Box::pin(async move {
                if let Some(killed) = self.killed.take() {
                    // The test may have stopped watching for the kill; nothing to report then.
                    let _ = killed.send(());
                }
            })
        }
    }

    /// Writes the smallest GLB the cache scan accepts: a 12-byte header declaring 12 bytes.
    pub(crate) fn write_glb(path: &Path) {
        let mut header = Vec::with_capacity(12);
        header.extend_from_slice(b"glTF");
        header.extend_from_slice(&2u32.to_le_bytes());
        header.extend_from_slice(&12u32.to_le_bytes());
        std::fs::write(path, header).expect("write test GLB");
    }

    /// A folder under the system temp folder, removed when dropped.
    pub(crate) struct TempDir(pub PathBuf);

    impl TempDir {
        pub(crate) fn new(label: &str) -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let dir = std::env::temp_dir().join(format!(
                "tc3d-conversion-{label}-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            ));
            std::fs::create_dir_all(&dir).expect("create temp dir");
            TempDir(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            if let Err(e) = std::fs::remove_dir_all(&self.0) {
                eprintln!("could not remove {}: {e}", self.0.display());
            }
        }
    }

    /// A request for livery `title` of an FSLTL Boeing 737, written into `dir`.
    pub(crate) fn request(dir: &Path, title: &str) -> ConversionRequest {
        let folder = "C:/Community/fsltl-traffic-base/SimObjects/Airplanes/FSLTL_B738_ZZZZ";
        ConversionRequest {
            source_path: folder.to_string(),
            livery_title: title.to_string(),
            gltf_path: format!("{folder}/model/B738.gltf"),
            texture_dirs: vec![format!("{folder}/texture.AAL")],
            texture_scale: "1k".to_string(),
            output_dir: dir.to_path_buf(),
        }
    }

    /// Starts `request` for `caller` on its own task.
    pub(crate) fn start(
        owner: &ConversionOwner,
        request: ConversionRequest,
        caller: Caller,
    ) -> tokio::task::JoinHandle<Result<Converted, ConversionError>> {
        let owner = owner.clone();
        tokio::spawn(async move { owner.convert(request, caller).await })
    }

    /// Lets every task run until it waits on something only the test or a deadline can end.
    pub(crate) async fn settle() {
        tokio::time::sleep(Duration::from_secs(1)).await;
    }

    pub(crate) fn remote(last: u8) -> Caller {
        Caller::Remote(IpAddr::from([192, 168, 1, last]))
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    const DONE: FakeExit = FakeExit {
        success: true,
        write_glb: true,
    };

    fn owner() -> (ConversionOwner, FakeControl) {
        let (runner, control) = FakeRunner::new();
        (ConversionOwner::new(runner), control)
    }

    #[tokio::test(start_paused = true)]
    async fn a_third_host_job_waits_until_one_of_two_running_ends() {
        let dir = TempDir::new("third-host");
        let (owner, mut control) = owner();
        let first = start(&owner, request(&dir.0, "One"), Caller::Host);
        let first_spawn = control.next_spawn().await;
        let _second = start(&owner, request(&dir.0, "Two"), Caller::Host);
        let _second_spawn = control.next_spawn().await;
        let third = start(&owner, request(&dir.0, "Three"), Caller::Host);
        settle().await;
        assert_eq!(control.spawn_count(), 2, "a third converter started");

        first_spawn.finish.send(DONE).expect("first is waiting");
        assert!(first.await.expect("first task").is_ok());
        let third_spawn = control.next_spawn().await;
        assert_eq!(third_spawn.title, "Three");
        third_spawn.finish.send(DONE).expect("third is waiting");
        assert!(third.await.expect("third task").is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn callers_for_one_output_share_one_job_that_outlives_the_first() {
        let dir = TempDir::new("shared");
        let (owner, mut control) = owner();
        let first = start(&owner, request(&dir.0, "Shared"), Caller::Host);
        let spawned = control.next_spawn().await;
        let second = start(&owner, request(&dir.0, "Shared"), remote(2));
        settle().await;
        first.abort();
        settle().await;

        spawned
            .finish
            .send(DONE)
            .expect("the job outlived its first caller");
        let converted = second.await.expect("second task").expect("converted");
        assert_eq!(converted.file_name, "fsltl_Shared.glb");
        assert_eq!(converted.output_path, dir.0.join("fsltl_Shared.glb"));
        assert_eq!(
            control.spawn_count(),
            1,
            "the second caller started its own job"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_job_past_the_run_deadline_is_killed_and_frees_its_permit() {
        let dir = TempDir::new("deadline");
        let (owner, mut control) = owner();
        let first = start(&owner, request(&dir.0, "Slow"), Caller::Host);
        let spawned = control.next_spawn().await;
        let joined = start(&owner, request(&dir.0, "Slow"), Caller::Host);

        assert_eq!(first.await.expect("task"), Err(ConversionError::TimedOut));
        assert_eq!(joined.await.expect("task"), Err(ConversionError::TimedOut));
        spawned
            .killed
            .await
            .expect("the runner was told to kill the tree");

        let a = start(&owner, request(&dir.0, "After A"), Caller::Host);
        let b = start(&owner, request(&dir.0, "After B"), Caller::Host);
        for _ in 0..2 {
            control
                .next_spawn()
                .await
                .finish
                .send(DONE)
                .expect("waiting");
        }
        assert!(a.await.expect("task").is_ok());
        assert!(b.await.expect("task").is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn a_second_remote_waits_while_a_host_job_still_starts() {
        let dir = TempDir::new("remote-share");
        let (owner, mut control) = owner();
        let _a = start(&owner, request(&dir.0, "Remote A"), remote(2));
        assert_eq!(control.next_spawn().await.title, "Remote A");
        let _b = start(&owner, request(&dir.0, "Remote B"), remote(3));
        settle().await;
        let _host = start(&owner, request(&dir.0, "Host"), Caller::Host);
        assert_eq!(control.next_spawn().await.title, "Host");
        settle().await;
        assert_eq!(control.spawn_count(), 2, "the second remote started");
    }

    #[tokio::test(start_paused = true)]
    async fn a_second_request_in_flight_from_one_device_is_refused() {
        let dir = TempDir::new("device");
        let (owner, mut control) = owner();
        let _a = start(&owner, request(&dir.0, "A"), remote(2));
        control.next_spawn().await;
        let refused = owner.convert(request(&dir.0, "B"), remote(2)).await;
        assert_eq!(refused, Err(ConversionError::Refused(Refusal::DeviceBusy)));
    }

    #[tokio::test(start_paused = true)]
    async fn the_ninth_waiting_remote_is_refused() {
        let dir = TempDir::new("queue");
        let (owner, mut control) = owner();
        let _running = start(&owner, request(&dir.0, "Running"), remote(1));
        control.next_spawn().await;
        let waiting: Vec<_> = (2..=9)
            .map(|last| {
                start(
                    &owner,
                    request(&dir.0, &format!("Wait {last}")),
                    remote(last),
                )
            })
            .collect();
        settle().await;
        assert!(
            waiting.iter().all(|job| !job.is_finished()),
            "one of the first eight waiting remotes was refused"
        );
        let refused = owner.convert(request(&dir.0, "Ninth"), remote(10)).await;
        assert_eq!(refused, Err(ConversionError::Refused(Refusal::QueueFull)));
    }

    #[tokio::test(start_paused = true)]
    async fn a_remote_waiting_past_the_queue_deadline_is_refused() {
        let dir = TempDir::new("queue-deadline");
        let (owner, mut control) = owner();
        let _running = start(&owner, request(&dir.0, "Running"), remote(1));
        let spawned = control.next_spawn().await;
        // The owner rules a two-minute wait; the literal keeps a changed constant from passing.
        let two_minutes = Duration::from_secs(2 * 60);
        let queued_at = tokio::time::Instant::now();
        let waiting = start(&owner, request(&dir.0, "Waiting"), remote(2));

        tokio::time::sleep(two_minutes - Duration::from_secs(1)).await;
        assert!(!waiting.is_finished(), "refused before the queue deadline");
        assert_eq!(
            waiting.await.expect("task"),
            Err(ConversionError::Refused(Refusal::QueueTimeout))
        );
        assert_eq!(queued_at.elapsed(), two_minutes, "refused at another time");
        assert_eq!(control.spawn_count(), 1);
        assert!(!spawned.finish.is_closed(), "the running job was ended");
    }

    #[tokio::test(start_paused = true)]
    async fn a_host_joining_a_queued_remote_job_starts_it_on_a_free_global_permit() {
        let dir = TempDir::new("host-promotes");
        let (owner, mut control) = owner();
        let _running = start(&owner, request(&dir.0, "Running"), remote(1));
        let running = control.next_spawn().await;
        let queued = start(&owner, request(&dir.0, "M"), remote(2));
        settle().await;
        let host = start(&owner, request(&dir.0, "M"), Caller::Host);

        let promoted = control.next_spawn().await;
        assert_eq!(promoted.title, "M");
        assert!(!running.finish.is_closed(), "remote 1 stopped converting");
        tokio::time::sleep(QUEUE_DEADLINE + Duration::from_secs(1)).await;
        promoted.finish.send(DONE).expect("M is waiting");

        assert!(
            host.await.expect("host task").is_ok(),
            "the host was refused"
        );
        assert!(queued.await.expect("remote task").is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn host_joining_at_the_remote_deadline_is_never_refused() {
        // A tie between the deadline and the join resolves at random, so one round can pass by luck.
        for round in 0..16 {
            let dir = TempDir::new("host-at-deadline");
            let (owner, mut control) = owner();
            let _running = start(&owner, request(&dir.0, "Running"), remote(1));
            let _running_spawn = control.next_spawn().await;
            let _queued = start(&owner, request(&dir.0, "M"), remote(2));
            tokio::time::sleep(QUEUE_DEADLINE).await;

            let mut host = std::pin::pin!(owner.convert(request(&dir.0, "M"), Caller::Host));
            let first = tokio::select! {
                biased;
                result = host.as_mut() => Err(result),
                spawned = control.next_spawn() => Ok(spawned),
            };
            let result = match first {
                Ok(spawned) => {
                    assert_eq!(spawned.title, "M");
                    spawned.finish.send(DONE).expect("M is waiting");
                    host.await
                }
                Err(result) => result,
            };
            assert_eq!(
                result.map(|converted| converted.file_name),
                Ok("fsltl_M.glb".to_string()),
                "round {round}: the host joining at the deadline did not convert"
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn exit_zero_without_an_output_file_is_a_failure() {
        let dir = TempDir::new("no-output");
        let (owner, mut control) = owner();
        let job = start(&owner, request(&dir.0, "Nothing"), Caller::Host);
        let exit = FakeExit {
            success: true,
            write_glb: false,
        };
        control
            .next_spawn()
            .await
            .finish
            .send(exit)
            .expect("waiting");
        assert!(matches!(
            job.await.expect("task"),
            Err(ConversionError::Failed(_))
        ));
    }

    #[test]
    fn the_output_name_is_the_one_the_converter_writes() {
        let dir = PathBuf::from("C:/cache");
        let fsltl = request(&dir, "FSLTL B738 American Airlines");
        assert_eq!(
            fsltl.output_file_name(),
            "fsltl_FSLTL B738 American Airlines.glb"
        );
        assert_eq!(
            output_file_name("AIGAIM_Airbus_A320-200_CFM", "Lufthansa D-AIZA"),
            "aig_Lufthansa D-AIZA.glb"
        );
        assert_eq!(output_file_name("fsltl_lower", "X"), "fsltl_X.glb");
    }
}
