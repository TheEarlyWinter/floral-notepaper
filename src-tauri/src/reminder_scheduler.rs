use crate::{desktop, services::{notes::default_store, reminders}};
use chrono::Utc;
use std::{thread, time::Duration};
use tauri::{AppHandle, Emitter};

const INITIAL_DELAY: Duration = Duration::from_secs(2);
const POLL_INTERVAL: Duration = Duration::from_secs(30);

pub fn start(app: AppHandle) {
    thread::spawn(move || {
        thread::sleep(INITIAL_DELAY);
        loop {
            let result = (|| {
                let store = default_store()?;
                reminders::take_due(store.data_dir(), Utc::now())
            })();

            match result {
                Ok(reminders) => {
                    for reminder in reminders {
                        let _ = desktop::show_main_window(&app);
                        if let Err(error) = app.emit("reminder://due", &reminder) {
                            eprintln!("failed to emit reminder: {error}");
                        }
                    }
                }
                Err(error) => eprintln!("failed to poll reminders: {error}"),
            }
            thread::sleep(POLL_INTERVAL);
        }
    });
}
