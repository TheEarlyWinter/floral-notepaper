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
                Ok((_data_dir, reminders)) => {
                    for reminder in reminders {
                        // 送达确认制：窗口唤起与事件发送都不在此处标记已通知，
                        // 是否真正送达以“前端 ack”为唯一确认。未 ack 的提醒下轮
                        // 轮询重新投递（含窗口/页面未就绪时丢失的事件），避免
                        // 提醒在用户看到之前就被静默丢弃。
                        let _ = desktop::show_main_window(&app);
                        let _ = app.emit("reminder://due", &reminder);
                    }
                }
                Err(error) => eprintln!("failed to poll reminders: {error}"),
            }
            thread::sleep(POLL_INTERVAL);
        }
    });
}
