fn main() {
    // Release builds are allowed: they run from an external app directory given
    // by GLINT_DESKTOP_REPO (the portable launcher sets it). Debug builds keep
    // using the compile-time repository path.
    tauri_build::build();
}
