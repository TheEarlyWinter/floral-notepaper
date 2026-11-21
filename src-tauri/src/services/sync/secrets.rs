use crate::services::notes::AppError;
use keyring::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
#[cfg(test)]
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

pub const SERVICE_NAME: &str = "floral-notepaper";
pub const WEBDAV_PASSWORD_ACCOUNT: &str = "sync-webdav-password";
pub const GIT_TOKEN_ACCOUNT: &str = "sync-git-token";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncSecretKind {
    #[serde(rename = "webdav")]
    WebDavPassword,
    #[serde(rename = "git")]
    GitToken,
}

impl SyncSecretKind {
    pub fn parse(raw: &str) -> Result<Self, AppError> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "webdav" | "sync-webdav-password" | "webdav_password" | "webdavpassword" => {
                Ok(Self::WebDavPassword)
            }
            "git" | "sync-git-token" | "git_token" | "gittoken" => Ok(Self::GitToken),
            _ => Err(AppError {
                code: "syncSecretInvalidKind".into(),
                message: format!("未知的同步凭据类型: {raw}"),
                details: Default::default(),
            }),
        }
    }

    pub const fn account_name(self) -> &'static str {
        match self {
            Self::WebDavPassword => WEBDAV_PASSWORD_ACCOUNT,
            Self::GitToken => GIT_TOKEN_ACCOUNT,
        }
    }
}

fn secure_store_unavailable(error: impl std::fmt::Display) -> AppError {
    AppError {
        code: "syncSecureStoreUnavailable".into(),
        message: format!("系统安全存储不可用：{error}"),
        details: Default::default(),
    }
}

#[derive(Debug, Clone, Default)]
pub struct SecretStore {
    service: Option<&'static str>,
    #[cfg(test)]
    unavailable_for_tests: bool,
    #[cfg(test)]
    memory_for_tests: Option<Arc<Mutex<HashMap<String, String>>>>,
}

impl SecretStore {
    pub const fn new() -> Self {
        Self {
            service: Some(SERVICE_NAME),
            #[cfg(test)]
            unavailable_for_tests: false,
            #[cfg(test)]
            memory_for_tests: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn unavailable_for_tests() -> Self {
        Self {
            service: None,
            unavailable_for_tests: true,
            memory_for_tests: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn in_memory_for_tests() -> Self {
        Self {
            service: Some(SERVICE_NAME),
            unavailable_for_tests: false,
            memory_for_tests: Some(Arc::new(Mutex::new(HashMap::new()))),
        }
    }

    pub fn set_secret(&self, kind: SyncSecretKind, secret: &str) -> Result<(), AppError> {
        let trimmed = secret.trim();
        if trimmed.is_empty() {
            return Err(AppError {
                code: "syncSecretEmpty".into(),
                message: "同步凭据不能为空".into(),
                details: Default::default(),
            });
        }

        #[cfg(test)]
        if let Some(memory) = &self.memory_for_tests {
            if self.unavailable_for_tests {
                return Err(secure_store_unavailable("test secure store unavailable"));
            }
            let mut map = memory
                .lock()
                .map_err(|_| secure_store_unavailable("test lock poisoned"))?;
            map.insert(kind.account_name().to_string(), trimmed.to_string());
            return Ok(());
        }

        self.entry(kind)?
            .set_password(trimmed)
            .map_err(secure_store_unavailable)
    }

    pub fn has_secret(&self, kind: SyncSecretKind) -> Result<bool, AppError> {
        Ok(self.get_secret(kind)?.is_some())
    }

    pub fn get_secret(&self, kind: SyncSecretKind) -> Result<Option<String>, AppError> {
        #[cfg(test)]
        if let Some(memory) = &self.memory_for_tests {
            if self.unavailable_for_tests {
                return Err(secure_store_unavailable("test secure store unavailable"));
            }
            let map = memory
                .lock()
                .map_err(|_| secure_store_unavailable("test lock poisoned"))?;
            return Ok(map
                .get(kind.account_name())
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty()));
        }

        match self.entry(kind)?.get_password() {
            Ok(secret) => Ok(Some(secret.trim().to_string()).filter(|s| !s.is_empty())),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(error) => Err(secure_store_unavailable(error)),
        }
    }

    pub fn clear_secret(&self, kind: SyncSecretKind) -> Result<(), AppError> {
        #[cfg(test)]
        if let Some(memory) = &self.memory_for_tests {
            if self.unavailable_for_tests {
                return Err(secure_store_unavailable("test secure store unavailable"));
            }
            let mut map = memory
                .lock()
                .map_err(|_| secure_store_unavailable("test lock poisoned"))?;
            map.remove(kind.account_name());
            return Ok(());
        }

        match self.entry(kind)?.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(error) => Err(secure_store_unavailable(error)),
        }
    }

    fn entry(&self, kind: SyncSecretKind) -> Result<Entry, AppError> {
        #[cfg(test)]
        if self.unavailable_for_tests {
            return Err(secure_store_unavailable("test secure store unavailable"));
        }

        let service = self.service.unwrap_or(SERVICE_NAME);
        Entry::new(service, kind.account_name()).map_err(secure_store_unavailable)
    }
}
