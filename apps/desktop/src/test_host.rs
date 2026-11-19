//! Isolated, opt-in native regression host. Release builds never read these variables.
use std::path::PathBuf;

pub struct TestHost {
    pub directory: PathBuf,
    pub debugging_port: u16,
}

#[cfg(debug_assertions)]
pub fn configuration() -> Result<Option<TestHost>, String> {
    let directory = std::env::var_os("GLINT_DESKTOP_TEST_DATA_DIR");
    let port = std::env::var("GLINT_DESKTOP_TEST_CDP_PORT").ok();
    match (directory, port) {
        (None, None) => Ok(None),
        (Some(directory), Some(port)) => {
            let directory = PathBuf::from(directory);
            let debugging_port = port.parse::<u16>().map_err(|_| "Invalid native test port")?;
            if !directory.is_absolute() || debugging_port < 1024 {
                return Err("Native tests require an absolute isolated directory and an unprivileged port".into());
            }
            Ok(Some(TestHost { directory, debugging_port }))
        }
        _ => Err("Native test directory and CDP port must be configured together".into()),
    }
}

#[cfg(not(debug_assertions))]
pub fn configuration() -> Result<Option<TestHost>, String> { Ok(None) }
