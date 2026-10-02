// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html
use std::env;
use std::process;

use anki::log::set_global_logger;
use anki::sync::http_server::SimpleServer;

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.get(1).map(String::as_str) == Some("--check-backup-database") {
        if args.len() != 3 || check_backup_database(&args[2]).is_err() {
            eprintln!("Backup database integrity check failed.");
            process::exit(1);
        }
        return;
    }
    if let Some(arg) = env::args().nth(1) {
        if arg == "--healthcheck" {
            run_health_check();
            return;
        }
    }
    if env::var("RUST_LOG").is_err() {
        env::set_var("RUST_LOG", "anki=info")
    }
    set_global_logger(None).unwrap();
    println!("{}", SimpleServer::run());
}

fn check_backup_database(path: &str) -> rusqlite::Result<()> {
    let db =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.create_collation("unicase", |a, b| {
        unicase::UniCase::new(a).cmp(&unicase::UniCase::new(b))
    })?;
    let mut statement = db.prepare("pragma integrity_check")?;
    let results = statement.query_map([], |row| row.get::<_, String>(0))?;
    let mut count = 0;
    for result in results {
        if result? != "ok" {
            return Err(rusqlite::Error::InvalidQuery);
        }
        count += 1;
    }
    if count != 1 {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(())
}

fn run_health_check() {
    if SimpleServer::is_running() {
        process::exit(0);
    } else {
        process::exit(1);
    }
}
