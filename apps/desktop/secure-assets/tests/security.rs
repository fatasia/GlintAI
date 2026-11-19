#![cfg(windows)]
use glint_secure_assets::{Publish, SecureAssets};
use std::{
    fs, io,
    path::PathBuf,
    process::Command,
    sync::{Arc, Barrier},
    thread,
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("glint-secure-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn rejects_volume_root_and_non_local_paths() {
    assert!(SecureAssets::open(std::path::Path::new("C:\\")).is_err());
    assert!(SecureAssets::open(std::path::Path::new("\\\\localhost\\share\\assets")).is_err());
    assert!(SecureAssets::open(std::path::Path::new("relative\\assets")).is_err());
}

#[test]
fn publish_read_conflict_and_invalid_names() {
    let f = Fixture::new();
    let assets = SecureAssets::open(&f.0).unwrap();
    assert_eq!(
        assets.publish("photo.png", b"original").unwrap(),
        Publish::Created
    );
    assert_eq!(assets.read("photo.png").unwrap(), b"original");
    assert_eq!(
        assets.publish("photo.png", b"original").unwrap(),
        Publish::AlreadyIdentical
    );
    assert_eq!(
        assets
            .publish("photo.png", b"different")
            .unwrap_err()
            .kind(),
        io::ErrorKind::AlreadyExists
    );
    assert_eq!(fs::read(f.0.join("photo.png")).unwrap(), b"original");
    for name in [
        "../x.png",
        "a/b.png",
        "C:x.png",
        "x.png:stream",
        "CON.png",
        "foo.txt",
        "",
        ".png",
    ] {
        assert!(assets.read(name).is_err(), "{name}");
        assert!(assets.publish(name, b"x").is_err(), "{name}");
    }
    assert!(assets.publish("empty.png", b"").is_err());
    assert!(assets
        .publish("large.png", &vec![1; 32 * 1024 * 1024 + 1])
        .is_err());
    assert_eq!(fs::read_dir(&f.0).unwrap().count(), 1);
}

#[test]
fn competing_publishers_never_overwrite() {
    let f = Fixture::new();
    let barrier = Arc::new(Barrier::new(3));
    let mut workers = Vec::new();
    for payload in [b"first".as_slice(), b"second".as_slice()] {
        let root = f.0.clone();
        let barrier = barrier.clone();
        workers.push(thread::spawn(move || {
            let assets = SecureAssets::open(&root).unwrap();
            barrier.wait();
            assets.publish("race.png", payload)
        }));
    }
    barrier.wait();
    let results: Vec<_> = workers.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, Ok(Publish::Created)))
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|r| matches!(r, Err(e) if e.kind() == io::ErrorKind::AlreadyExists))
            .count(),
        1
    );
    let bytes = fs::read(f.0.join("race.png")).unwrap();
    assert!(bytes == b"first" || bytes == b"second");
    assert_eq!(fs::read_dir(&f.0).unwrap().count(), 1);
}

#[test]
fn directory_and_ancestor_swap_are_blocked() {
    let f = Fixture::new();
    let parent = f.0.join("parent");
    let root = parent.join("assets");
    fs::create_dir_all(&root).unwrap();
    let outside = f.0.join("outside");
    fs::create_dir(&outside).unwrap();
    let assets = SecureAssets::open(&root).unwrap();
    assert!(fs::rename(&root, parent.join("moved")).is_err());
    assert!(fs::rename(&parent, f.0.join("moved-parent")).is_err());
    assets.publish("inside.png", b"safe").unwrap();
    assert!(!outside.join("inside.png").exists());
    drop(assets);
    fs::rename(&root, parent.join("moved")).unwrap();
}

#[test]
fn rejects_junctions_and_hard_links() {
    let f = Fixture::new();
    let root = f.0.join("assets");
    let outside = f.0.join("outside");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("secret.png"), b"secret").unwrap();
    let junction = root.join("junction");
    let status = Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&junction)
        .arg(&outside)
        .status()
        .unwrap();
    assert!(status.success(), "junction creation failed");
    assert!(SecureAssets::open(&junction).is_err());
    assert!(SecureAssets::open(&junction.join("nested")).is_err());
    let junction_asset = root.join("escape.png");
    let status = Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(&junction_asset)
        .arg(&outside)
        .status()
        .unwrap();
    assert!(status.success());
    fs::hard_link(outside.join("secret.png"), root.join("linked.png")).unwrap();
    let assets = SecureAssets::open(&root).unwrap();
    assert!(assets.read("linked.png").is_err());
    assert!(assets.read("escape.png").is_err());
    assert!(assets.publish("escape.png", b"evil").is_err());
    assert!(!outside.join("escape.png").exists());
    assert!(assets.publish("linked.png", b"secret").is_err());
    assert_eq!(fs::read(outside.join("secret.png")).unwrap(), b"secret");
    drop(assets);
    fs::remove_dir(&junction).unwrap();
    fs::remove_dir(&junction_asset).unwrap();
}
