// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let mut all_args: Vec<String> = std::env::args().collect();
    let _ = all_args.remove(0); // skip binary name

    if all_args.first().map(String::as_str) == Some("--update-helper") {
        let exit_code = floral_notepaper_lib::updater::helper::run_cli(
            all_args.into_iter().skip(1).map(|s| s.to_string()),
        );
        std::process::exit(exit_code.as_i32());
    }

    if all_args.first().map(String::as_str) == Some("--cli") {
        floral_notepaper_lib::cli::run_cli(all_args.into_iter().skip(1));
        return;
    }

    floral_notepaper_lib::try_exit_for_cli_version_or_help();
    floral_notepaper_lib::run()
}
