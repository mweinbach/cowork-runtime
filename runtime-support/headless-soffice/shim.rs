use std::env;
use std::process::{exit, Command};

fn main() {
    let executable = match env::current_exe() {
        Ok(value) => value,
        Err(error) => {
            eprintln!("[cowork-soffice] could not resolve launcher path: {error}");
            exit(127);
        }
    };
    let runtime_root = match executable
        .parent()
        .and_then(|bin| bin.parent())
        .and_then(|dependencies| dependencies.parent())
    {
        Some(value) => value,
        None => {
            eprintln!("[cowork-soffice] launcher is not inside dependencies/bin");
            exit(127);
        }
    };
    let node = runtime_root.join("dependencies/node/bin/node.exe");
    let launcher = runtime_root.join("cowork/headless-soffice/launcher.mjs");
    let status = Command::new(node)
        .arg(launcher)
        .args(env::args_os().skip(1))
        .status();

    match status {
        Ok(value) => exit(value.code().unwrap_or(1)),
        Err(error) => {
            eprintln!("[cowork-soffice] could not start the managed launcher: {error}");
            exit(127);
        }
    }
}
