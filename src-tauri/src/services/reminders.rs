use crate::{json_io::write_json_atomic, services::notes::AppError};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path, sync::{Mutex, OnceLock}};
use uuid::Uuid;

static REMINDER_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    pub id: String,
    pub note_id: String,
    pub message: String,
    pub remind_at: DateTime<Utc>,
    #[serde(default)]
    pub notified: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ReminderFile {
    #[serde(default)]
    reminders: Vec<Reminder>,
}

fn path(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join("reminders.json")
}

fn load(data_dir: &Path) -> Result<ReminderFile, AppError> {
    let file_path = path(data_dir);
    if !file_path.exists() {
        return Ok(ReminderFile::default());
    }
    Ok(serde_json::from_str(&fs::read_to_string(file_path)?)?)
}

fn save(data_dir: &Path, file: &ReminderFile) -> Result<(), AppError> {
    write_json_atomic(&path(data_dir), file)
}

fn lock() -> Result<std::sync::MutexGuard<'static, ()>, AppError> {
    REMINDER_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| AppError { code: "reminderLock".into(), message: "提醒存储锁已中毒，请重启应用后重试".into(), details: Default::default() })
}

pub fn list(data_dir: &Path) -> Result<Vec<Reminder>, AppError> {
    let mut reminders = load(data_dir)?.reminders;
    reminders.sort_by_key(|reminder| reminder.remind_at);
    Ok(reminders)
}

pub fn create(data_dir: &Path, note_id: String, message: String, remind_at: DateTime<Utc>) -> Result<Reminder, AppError> {
    let _guard = lock()?;
    let mut file = load(data_dir)?;
    let reminder = Reminder { id: Uuid::new_v4().to_string(), note_id, message, remind_at, notified: false };
    file.reminders.push(reminder.clone());
    save(data_dir, &file)?;
    Ok(reminder)
}

pub fn delete(data_dir: &Path, id: &str) -> Result<(), AppError> {
    let _guard = lock()?;
    let mut file = load(data_dir)?;
    file.reminders.retain(|reminder| reminder.id != id);
    save(data_dir, &file)
}

pub fn take_due(data_dir: &Path, now: DateTime<Utc>) -> Result<Vec<Reminder>, AppError> {
    let _guard = lock()?;
    let mut file = load(data_dir)?;
    let due = file.reminders.iter_mut().filter_map(|reminder| {
        if !reminder.notified && reminder.remind_at <= now {
            reminder.notified = true;
            Some(reminder.clone())
        } else { None }
    }).collect::<Vec<_>>();
    if !due.is_empty() { save(data_dir, &file)?; }
    Ok(due)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn temp_data_dir() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("floral-reminders-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).expect("create temporary reminder directory");
        path
    }

    #[test]
    fn due_reminders_are_persisted_as_notified_and_only_fire_once() {
        let data_dir = temp_data_dir();
        let now = Utc::now();
        let created = create(
            &data_dir,
            "note-a".into(),
            "复习第三章".into(),
            now - Duration::minutes(1),
        )
        .expect("create reminder");

        let due = take_due(&data_dir, now).expect("take due reminder");
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].id, created.id);
        assert!(due[0].notified);
        assert!(take_due(&data_dir, now).expect("take due again").is_empty());
        assert!(list(&data_dir).expect("list reminders")[0].notified);

        let _ = fs::remove_dir_all(data_dir);
    }

    #[test]
    fn deleted_reminders_do_not_reappear() {
        let data_dir = temp_data_dir();
        let reminder = create(
            &data_dir,
            "note-a".into(),
            "明天整理笔记".into(),
            Utc::now() + Duration::days(1),
        )
        .expect("create reminder");

        delete(&data_dir, &reminder.id).expect("delete reminder");
        assert!(list(&data_dir).expect("list reminders").is_empty());

        let _ = fs::remove_dir_all(data_dir);
    }
}
