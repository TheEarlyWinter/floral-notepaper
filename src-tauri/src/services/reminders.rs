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
    match serde_json::from_str(&fs::read_to_string(&file_path)?) {
        Ok(file) => Ok(file),
        Err(_) => {
            // 损坏自愈：保留坏文件副本并重置为空，避免提醒功能永久不可用
            let backup_path = file_path.with_file_name(format!(
                "reminders.json.corrupt-{}",
                Utc::now().format("%Y%m%d%H%M%S")
            ));
            let _ = fs::rename(&file_path, &backup_path);
            Ok(ReminderFile::default())
        }
    }
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

/// 持提醒锁执行闭包（供需要跨锁协调的路径使用，如备份恢复）。
pub(crate) fn with_lock<T>(f: impl FnOnce() -> Result<T, AppError>) -> Result<T, AppError> {
    let _guard = lock()?;
    f()
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

/// Remove reminders whose target note no longer exists, so the scheduler does
/// not keep retrying a delivery that can never open its destination.
pub fn delete_for_note(data_dir: &Path, note_id: &str) -> Result<(), AppError> {
    let _guard = lock()?;
    let mut file = load(data_dir)?;
    let original_len = file.reminders.len();
    file.reminders
        .retain(|reminder| reminder.note_id != note_id);
    if file.reminders.len() != original_len {
        save(data_dir, &file)?;
    }
    Ok(())
}

pub fn take_due(data_dir: &Path, now: DateTime<Utc>) -> Result<Vec<Reminder>, AppError> {
    let _guard = lock()?;
    let file = load(data_dir)?;
    // 只取出到期且未确认送达的提醒，不在此处标记：送达以“前端 ack”为
    // 唯一确认（reminders_ack → mark_notified），未确认的提醒由调度器
    // 每轮轮询重复投递。语义为“至少一次”投递：重复提醒优于静默丢失；
    // 单调度线程下不会并发取到同一提醒。
    Ok(file
        .reminders
        .into_iter()
        .filter(|reminder| !reminder.notified && reminder.remind_at <= now)
        .collect())
}

pub fn mark_notified(data_dir: &Path, id: &str) -> Result<(), AppError> {
    let _guard = lock()?;
    let mut file = load(data_dir)?;
    let mut changed = false;
    for reminder in &mut file.reminders {
        if reminder.id == id && !reminder.notified {
            reminder.notified = true;
            changed = true;
        }
    }
    if changed {
        save(data_dir, &file)?;
    }
    Ok(())
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

        // 通知送达前仍会返回到期提醒（不标记）
        let due = take_due(&data_dir, now).expect("take due reminder");
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].id, created.id);
        assert!(!due[0].notified);
        let due_again = take_due(&data_dir, now).expect("take due again");
        assert_eq!(due_again.len(), 1);

        // 确认已通知后不再返回
        mark_notified(&data_dir, &created.id).expect("mark notified");
        assert!(take_due(&data_dir, now).expect("take due after notified").is_empty());
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

    #[test]
    fn deleting_a_note_removes_all_of_its_reminders() {
        let data_dir = temp_data_dir();
        create(
            &data_dir,
            "note-a".into(),
            "旧笔记提醒".into(),
            Utc::now() + Duration::days(1),
        )
        .expect("create first reminder");
        let kept = create(
            &data_dir,
            "note-b".into(),
            "保留的提醒".into(),
            Utc::now() + Duration::days(1),
        )
        .expect("create second reminder");

        delete_for_note(&data_dir, "note-a").expect("delete note reminders");
        let remaining = list(&data_dir).expect("list reminders");
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, kept.id);

        let _ = fs::remove_dir_all(data_dir);
    }
}
