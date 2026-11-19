#[cfg(windows)]
fn main() -> std::io::Result<()> {
    use glint_secure_assets::{Publish, SecureAssets};
    use std::io::{self, Read, Write};
    use std::path::Path;

    const LIMIT: usize = 32 * 1024 * 1024;
    fn number(reader: &mut impl Read) -> io::Result<u32> {
        let mut bytes = [0; 4];
        reader.read_exact(&mut bytes)?;
        Ok(u32::from_le_bytes(bytes))
    }
    fn response(writer: &mut impl Write, status: u8, bytes: &[u8]) -> io::Result<()> {
        writer.write_all(&[status])?;
        writer.write_all(&(bytes.len() as u32).to_le_bytes())?;
        writer.write_all(bytes)?;
        writer.flush()
    }
    // This bridge provides handle-relative I/O, not authenticated sessions or ACL isolation.
    // It is deliberately never a production authorization signal.
    let mut args = std::env::args_os();
    let _ = args.next();
    let root = args
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing root"))?;
    if args.next().is_some() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "unexpected arguments",
        ));
    }
    let assets = SecureAssets::open(Path::new(&root))?;
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut input = stdin.lock();
    let mut output = stdout.lock();
    response(&mut output, 0, b"glint-secure-assets-v1")?;
    loop {
        let mut op = [0];
        match input.read_exact(&mut op) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(e) => return Err(e),
        }
        let name_len = number(&mut input)? as usize;
        let data_len = number(&mut input)? as usize;
        if name_len == 0
            || name_len > 1024
            || data_len > LIMIT
            || !matches!(op[0], 1 | 2)
            || (op[0] == 1 && data_len != 0)
        {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "invalid frame"));
        }
        let mut name = vec![0; name_len];
        input.read_exact(&mut name)?;
        let mut data = vec![0; data_len];
        input.read_exact(&mut data)?;
        let result = std::str::from_utf8(&name)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid name"))
            .and_then(|name| {
                if op[0] == 1 {
                    assets.read(name)
                } else {
                    assets.publish(name, &data).map(|value| match value {
                        Publish::Created => b"created".to_vec(),
                        Publish::AlreadyIdentical => b"identical".to_vec(),
                    })
                }
            });
        match result {
            Ok(bytes) => response(&mut output, 0, &bytes)?,
            Err(error) => {
                let status = match error.kind() {
                    io::ErrorKind::NotFound => 1,
                    io::ErrorKind::AlreadyExists => 2,
                    _ => 3,
                };
                response(&mut output, status, b"asset operation rejected")?;
            }
        }
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("secure assets bridge requires Windows");
    std::process::exit(1);
}
