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
                let due = reminders::take_due(store.data_dir(), Utc::now())?;
                Ok::<_, crate::services::notes::AppError>((store.data_dir().to_path_buf(), due))
            })();

            match result {
                Ok((data_dir, reminders)) => {
                    for reminder in reminders {
                        let _ = desktop::show_main_window(&app);
                        // 通知成功送达后再标记已通知：emit 失败时保持未通知，
                        // 下轮轮询重试，避免提醒在用户看到之前就被丢弃
                        if app.emit("reminder://due", &reminder).is_ok() {
                            let _ = reminders::mark_notified(&data_dir, &reminder.id);
                        }
                    }
                }
                Err(error) => eprintln!("failed to poll reminders: {error}"),
            }
            thread::sleep(POLL_INTERVAL);
        }
    });
}
