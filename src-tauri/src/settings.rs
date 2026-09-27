//! Persisted app preferences and the runtime features they control.
//! The backend owns these so capture cannot start before an explicit opt-in.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::ring::Ring;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct Preferences {
    pub macos_system_logs: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshot {
    #[serde(flatten)]
    pub preferences: Preferences,
    pub macos_system_logs_supported: bool,
    pub load_warning: Option<String>,
}

struct Inner {
    preferences: Preferences,
    load_warning: Option<String>,
    #[cfg(target_os = "macos")]
    collector: Option<crate::system_logs::Collector>,
}

pub struct Settings {
    path: PathBuf,
    #[cfg(target_os = "macos")]
    ring: Arc<Ring>,
    inner: Mutex<Inner>,
}

impl Settings {
    /// Called inside the owner's runtime, after forwarder dispatch.
    pub fn new(ring: Arc<Ring>) -> Self {
        let dirs =
            directories::ProjectDirs::from("", "", "istoria").expect("project dirs resolvable");
        Self::at_path(dirs.config_dir().join("settings.json"), ring)
    }

    fn at_path(path: PathBuf, _ring: Arc<Ring>) -> Self {
        let (preferences, load_warning) = match load(&path) {
            Ok(preferences) => (preferences, None),
            Err(error) => {
                tracing::warn!(%error, "could not load settings; experimental features disabled");
                (Preferences::default(), Some("Saved settings could not be read. Experimental features have been turned off.".into()))
            }
        };
        #[cfg(target_os = "macos")]
        let collector = preferences
            .macos_system_logs
            .then(|| crate::system_logs::Collector::start(Arc::clone(&_ring)));
        Self {
            path,
            #[cfg(target_os = "macos")]
            ring: _ring,
            inner: Mutex::new(Inner {
                preferences,
                load_warning,
                #[cfg(target_os = "macos")]
                collector,
            }),
        }
    }

    pub async fn snapshot(&self) -> SettingsSnapshot {
        snapshot(&*self.inner.lock().await)
    }

    pub async fn update(&self, preferences: Preferences) -> Result<SettingsSnapshot, String> {
        if preferences.macos_system_logs && !cfg!(target_os = "macos") {
            return Err("System log capture is only available on macOS.".into());
        }
        // Serialize save + apply so rapid requests cannot leak collectors or
        // leave the persisted preference out of step with the running feature.
        let mut inner = self.inner.lock().await;
        save(&self.path, &preferences).map_err(|e| format!("Could not save settings: {e}"))?;
        #[cfg(target_os = "macos")]
        if preferences.macos_system_logs {
            if inner.collector.is_none() {
                inner.collector =
                    Some(crate::system_logs::Collector::start(Arc::clone(&self.ring)));
            }
        } else if let Some(collector) = inner.collector.take() {
            // A successful response means the subprocess has stopped and no
            // more events can arrive from this collector.
            collector.stop().await;
        }
        inner.preferences = preferences;
        inner.load_warning = None;
        Ok(snapshot(&inner))
    }

    pub async fn shutdown(&self) {
        #[cfg(target_os = "macos")]
        if let Some(collector) = self.inner.lock().await.collector.take() {
            collector.stop().await;
        }
    }
}

fn snapshot(inner: &Inner) -> SettingsSnapshot {
    SettingsSnapshot {
        preferences: inner.preferences.clone(),
        macos_system_logs_supported: cfg!(target_os = "macos"),
        load_warning: inner.load_warning.clone(),
    }
}

fn load(path: &Path) -> Result<Preferences, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Preferences::default()),
        Err(error) => Err(error.to_string()),
    }
}

fn save(path: &Path, preferences: &Preferences) -> std::io::Result<()> {
    use std::io::Write;
    let parent = path.parent().expect("settings path has a parent");
    std::fs::create_dir_all(parent)?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temporary = parent.join(format!(".settings-{}-{nonce}.tmp", std::process::id()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let result = (|| {
        file.write_all(&serde_json::to_vec_pretty(preferences)?)?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("istoria-settings-{}-{nonce}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[tokio::test]
    async fn missing_and_corrupt_settings_never_enable_capture() {
        let dir = temp_dir();
        let path = dir.join("settings.json");
        for contents in [
            None,
            Some("{}"),
            Some("{broken"),
            Some("{\"macosSystemLogs\":\"true\"}"),
        ] {
            if let Some(contents) = contents {
                std::fs::write(&path, contents).unwrap();
            }
            let settings = Settings::at_path(path.clone(), Arc::new(Ring::new(10)));
            assert!(!settings.snapshot().await.preferences.macos_system_logs);
            #[cfg(target_os = "macos")]
            assert!(settings.inner.lock().await.collector.is_none());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn failed_save_leaves_previous_preference_untouched() {
        let dir = temp_dir();
        let path = dir.join("settings.json");
        let settings = Settings::at_path(path.clone(), Arc::new(Ring::new(10)));
        std::fs::create_dir(&path).unwrap(); // rename onto a directory must fail
        assert!(settings
            .update(Preferences {
                macos_system_logs: true
            })
            .await
            .is_err());
        assert!(!settings.snapshot().await.preferences.macos_system_logs);
        #[cfg(target_os = "macos")]
        assert!(settings.inner.lock().await.collector.is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn opt_in_persists_and_opt_out_stops_capture() {
        let dir = temp_dir();
        let path = dir.join("settings.json");
        let ring = Arc::new(Ring::new(10));
        let settings = Settings::at_path(path.clone(), Arc::clone(&ring));
        settings
            .update(Preferences {
                macos_system_logs: true,
            })
            .await
            .unwrap();
        assert!(load(&path).unwrap().macos_system_logs);
        assert!(settings.inner.lock().await.collector.is_some());
        settings.shutdown().await;
        let restarted = Settings::at_path(path.clone(), ring);
        assert!(restarted.inner.lock().await.collector.is_some());
        restarted.update(Preferences::default()).await.unwrap();
        assert!(restarted.inner.lock().await.collector.is_none());
        assert!(!load(&path).unwrap().macos_system_logs);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
