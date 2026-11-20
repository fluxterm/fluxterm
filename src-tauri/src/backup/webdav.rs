//! WebDAV 仅上传备份，不提供远端文件浏览与下载。
use std::time::Duration;

use super::{BackupError, Result, Settings};
use reqwest::{Client, Method, RequestBuilder, StatusCode, Url};

/// WebDAV 专用客户端默认忽略证书校验，并禁止重定向。
pub fn client() -> Result<Client> {
    Ok(Client::builder()
        .danger_accept_invalid_certs(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(1800))
        .build()?)
}

/// 从完整服务地址解析目标目录，保留协议与已编码的路径。
pub fn target_directory(settings: &Settings) -> Result<Url> {
    if settings.url.trim().is_empty() {
        return Err(BackupError::new(
            "backup_webdav_url_required",
            "The WebDAV server URL is required",
        ));
    }
    let mut base = Url::parse(settings.url.trim())
        .map_err(|_| BackupError::new("backup_webdav_url_invalid", "Invalid WebDAV server URL"))?;
    if !matches!(base.scheme(), "http" | "https")
        || base.host_str().is_none()
        || !base.username().is_empty()
        || base.password().is_some()
        || base.query().is_some()
        || base.fragment().is_some()
    {
        return Err(BackupError::new(
            "backup_webdav_url_invalid",
            "Use an HTTP(S) URL without embedded credentials, query parameters or fragments",
        ));
    }
    if !base.path().ends_with('/') {
        let path = format!("{}/", base.path());
        base.set_path(&path);
    }
    Ok(base)
}

/// 按用户输入选择 Basic 认证或匿名访问。
pub fn authenticate(
    request: RequestBuilder,
    settings: &Settings,
    password: &str,
) -> RequestBuilder {
    if settings.username.is_empty() && password.is_empty() {
        request
    } else {
        request.basic_auth(&settings.username, Some(password))
    }
}

/// 将状态码映射成不含地址或认证信息的错误。
pub fn status(status: StatusCode) -> Result<()> {
    if status.is_success() {
        return Ok(());
    }
    let (code, message) = match status.as_u16() {
        401 => ("backup_auth_failed", "WebDAV authentication failed"),
        403 | 405 | 409 | 507 => (
            "backup_directory_unwritable",
            "The WebDAV directory is not writable or has insufficient space",
        ),
        300..=399 => (
            "backup_redirect_refused",
            "WebDAV redirects are not followed; use the final server URL",
        ),
        _ => ("backup_upload_failed", "The WebDAV request failed"),
    };
    Err(BackupError::new(code, message))
}

/// 只读查找目标及缺失目录；认证或权限失败时立即停止。
async fn missing_directories(
    client: &Client,
    settings: &Settings,
    password: &str,
) -> Result<(Url, Vec<Url>)> {
    let target = target_directory(settings)?;
    let mut current = target.clone();
    let mut missing = Vec::new();
    while !directory_exists(client, settings, password, &current).await? {
        let path = current.path().trim_end_matches('/');
        if path.is_empty() {
            return Err(BackupError::new(
                "backup_directory_unwritable",
                "No existing WebDAV parent collection was found",
            ));
        }
        let parent = path
            .rfind('/')
            .ok_or_else(|| BackupError::invalid("Invalid WebDAV parent path"))?;
        let parent_path = path[..=parent].to_string();
        missing.push(current.clone());
        current.set_path(&parent_path);
    }
    Ok((target, missing))
}

/// 仅检查连接与现存父目录，不修改远端内容。
pub async fn test_connection(client: &Client, settings: &Settings, password: &str) -> Result<()> {
    missing_directories(client, settings, password).await?;
    Ok(())
}

/// 上传前从最近的现存集合开始逐层创建缺失目录。
pub async fn ensure_directory(client: &Client, settings: &Settings, password: &str) -> Result<Url> {
    let (target, missing) = missing_directories(client, settings, password).await?;
    for directory in missing.into_iter().rev() {
        let response = authenticate(
            client
                .request(
                    Method::from_bytes(b"MKCOL")
                        .map_err(|_| BackupError::invalid("Invalid HTTP method"))?,
                    directory.clone(),
                )
                .timeout(Duration::from_secs(30)),
            settings,
            password,
        )
        .send()
        .await?;
        if response.status() == StatusCode::METHOD_NOT_ALLOWED {
            // 其他客户端可能已创建目录，必须重新检查集合后才能继续。
            if !directory_exists(client, settings, password, &directory).await? {
                status(StatusCode::METHOD_NOT_ALLOWED)?;
            }
        } else {
            status(response.status())?;
        }
    }
    Ok(target)
}

/// 仅将 404 视为不存在；认证和权限错误直接返回，避免误创建目录。
async fn directory_exists(
    client: &Client,
    settings: &Settings,
    password: &str,
    url: &Url,
) -> Result<bool> {
    let response = authenticate(
        client
            .request(
                Method::from_bytes(b"PROPFIND")
                    .map_err(|_| BackupError::invalid("Invalid HTTP method"))?,
                url.clone(),
            )
            .header("Depth", "0")
            .timeout(Duration::from_secs(30)),
        settings,
        password,
    )
    .send()
    .await?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(false);
    }
    status(response.status())?;
    validate_collection(response).await?;
    Ok(true)
}

/// 检查 DAV 属性响应，拒绝 HTML 登录页、普通文件和属性级权限失败。
async fn validate_collection(mut response: reqwest::Response) -> Result<()> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if body.len() + chunk.len() > 1024 * 1024 {
            return Err(BackupError::invalid(
                "The WebDAV directory response exceeds the size limit",
            ));
        }
        body.extend_from_slice(&chunk);
    }
    let mut reader = quick_xml::Reader::from_reader(body.as_slice());
    let mut collection = false;
    let mut property_ok = false;
    let mut valid = false;
    let mut in_status = false;
    loop {
        match reader.read_event() {
            Ok(quick_xml::events::Event::Start(element)) => match element.local_name().as_ref() {
                b"propstat" => {
                    collection = false;
                    property_ok = false;
                }
                b"collection" => collection = true,
                b"status" => in_status = true,
                _ => {}
            },
            Ok(quick_xml::events::Event::Empty(element))
                if element.local_name().as_ref() == b"collection" =>
            {
                collection = true
            }
            Ok(quick_xml::events::Event::Text(text)) if in_status => {
                property_ok = text
                    .decode()
                    .map_err(|_| BackupError::invalid("Invalid WebDAV response encoding"))?
                    .split_whitespace()
                    .nth(1)
                    == Some("200");
            }
            Ok(quick_xml::events::Event::End(element)) => match element.local_name().as_ref() {
                b"status" => in_status = false,
                b"propstat" => valid |= collection && property_ok,
                _ => {}
            },
            Ok(quick_xml::events::Event::Eof) => break,
            Err(_) => return Err(BackupError::invalid("Invalid WebDAV directory response")),
            _ => {}
        }
    }
    if !valid {
        return Err(BackupError::new(
            "backup_directory_unwritable",
            "The WebDAV target is not an accessible collection",
        ));
    }
    Ok(())
}

/// 流式上传已完成归档；仅实际 PUT 成功后返回成功。
pub async fn upload(
    client: &Client,
    settings: &Settings,
    password: &str,
    path: &std::path::Path,
    name: &str,
) -> Result<()> {
    let mut url = ensure_directory(client, settings, password).await?;
    url.path_segments_mut()
        .map_err(|_| BackupError::invalid("Invalid upload path"))?
        .pop_if_empty()
        .push(name);
    let file = tokio::fs::File::open(path).await?;
    let size = file.metadata().await?.len();
    let response = authenticate(
        client
            .put(url)
            .header("Content-Type", "application/zip")
            .header("Content-Length", size)
            .body(reqwest::Body::from(file)),
        settings,
        password,
    )
    .send()
    .await?;
    status(response.status())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    /// 输入错误使用 WebDAV 专属错误码，不回退到通用备份错误。
    #[test]
    fn invalid_inputs_have_specific_webdav_errors() {
        for (url, code) in [
            ("", "backup_webdav_url_required"),
            ("  ", "backup_webdav_url_required"),
            ("not-a-url", "backup_webdav_url_invalid"),
            ("ftp://nas/backups", "backup_webdav_url_invalid"),
            ("http://user:pass@nas/", "backup_webdav_url_invalid"),
        ] {
            let error = target_directory(&Settings {
                url: url.into(),
                ..Default::default()
            })
            .unwrap_err();
            assert_eq!(error.code, code);
        }
    }

    const COLLECTION: &str = "<d:multistatus xmlns:d=\"DAV:\"><d:response><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>";

    /// 本地 HTTP 服务逐条检查方法、路径、Basic 认证及上传内容。
    fn server(
        responses: Vec<(&'static str, &'static str, u16, &'static str)>,
        authenticated: bool,
    ) -> (String, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}/dav/", listener.local_addr().unwrap());
        let thread = std::thread::spawn(move || {
            for (method, path, status, body) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut headers = Vec::new();
                let mut byte = [0_u8; 1];
                while !headers.ends_with(b"\r\n\r\n") {
                    stream.read_exact(&mut byte).unwrap();
                    headers.push(byte[0]);
                }
                let headers = String::from_utf8(headers).unwrap();
                assert!(headers.starts_with(&format!("{method} {path} HTTP/1.1")));
                assert_eq!(
                    headers
                        .to_ascii_lowercase()
                        .contains("authorization: basic dxnlcjpwyxnz"),
                    authenticated
                );
                let length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length: ")
                            .and_then(|s| s.parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                let mut bytes = vec![0; length];
                stream.read_exact(&mut bytes).unwrap();
                if method == "PUT" {
                    assert_eq!(bytes, b"archive-body");
                }
                write!(stream, "HTTP/1.1 {status} Result\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
        });
        (address, thread)
    }

    /// 目录缺失时逐层创建，实际 PUT 发送完整内容并使用 Basic 认证。
    #[test]
    fn upload_creates_directories_and_sends_archive() {
        let (address, server) = server(
            vec![
                ("PROPFIND", "/dav/backups/", 404, ""),
                ("PROPFIND", "/dav/", 207, COLLECTION),
                ("MKCOL", "/dav/backups/", 201, ""),
                ("PUT", "/dav/backups/test.zip", 201, ""),
            ],
            true,
        );
        let settings = Settings {
            url: format!("{address}backups/"),
            username: "user".into(),
            ..Default::default()
        };
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(b"archive-body").unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime
            .block_on(upload(
                &client().unwrap(),
                &settings,
                "pass",
                file.path(),
                "test.zip",
            ))
            .unwrap();
        server.join().unwrap();
    }

    /// 现存目录与多层缺失目录的连接测试都只发送 PROPFIND。
    #[test]
    fn connection_test_never_creates_directories() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        for exists in [true, false] {
            let responses = if exists {
                vec![("PROPFIND", "/dav/flux/a/b/", 207, COLLECTION)]
            } else {
                vec![
                    ("PROPFIND", "/dav/flux/a/b/", 404, ""),
                    ("PROPFIND", "/dav/flux/a/", 404, ""),
                    ("PROPFIND", "/dav/flux/", 207, COLLECTION),
                ]
            };
            let (address, server) = server(responses, true);
            let settings = Settings {
                url: format!("{address}flux/a/b"),
                username: "user".into(),
                ..Default::default()
            };
            runtime
                .block_on(test_connection(&client().unwrap(), &settings, "pass"))
                .unwrap();
            server.join().unwrap();
        }
    }

    /// 测试连接遇到父目录权限失败立即报错，不继续向上检查或创建目录。
    #[test]
    fn connection_test_rejects_inaccessible_parent() {
        let (address, server) = server(
            vec![
                ("PROPFIND", "/dav/blocked/child/", 404, ""),
                ("PROPFIND", "/dav/blocked/", 403, ""),
            ],
            false,
        );
        let settings = Settings {
            url: format!("{address}blocked/child"),
            ..Default::default()
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        assert_eq!(
            runtime
                .block_on(test_connection(&client().unwrap(), &settings, ""))
                .unwrap_err()
                .code,
            "backup_directory_unwritable"
        );
        server.join().unwrap();
    }

    /// 匿名请求不发送认证头，认证、跳转与目录错误不会报告成功。
    #[test]
    fn authentication_redirect_and_invalid_collection_fail() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        for (status, body, code) in [
            (401, "", "backup_auth_failed"),
            (302, "", "backup_redirect_refused"),
            (207, "<html/>", "backup_directory_unwritable"),
        ] {
            let (address, server) = server(vec![("PROPFIND", "/dav/", status, body)], false);
            let settings = Settings {
                url: address,
                ..Default::default()
            };
            let error = runtime
                .block_on(test_connection(&client().unwrap(), &settings, ""))
                .unwrap_err();
            assert_eq!(error.code, code);
            server.join().unwrap();
        }
    }

    /// 目录检查成功不等于上传成功，PUT 被拒绝必须返回错误。
    #[test]
    fn denied_put_is_not_success() {
        let (address, server) = server(
            vec![
                ("PROPFIND", "/dav/", 207, COLLECTION),
                ("PUT", "/dav/test.zip", 403, ""),
            ],
            false,
        );
        let settings = Settings {
            url: address,
            ..Default::default()
        };
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(b"archive-body").unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        assert_eq!(
            runtime
                .block_on(upload(
                    &client().unwrap(),
                    &settings,
                    "",
                    file.path(),
                    "test.zip"
                ))
                .unwrap_err()
                .code,
            "backup_directory_unwritable"
        );
        server.join().unwrap();
    }

    /// 完整地址中连续缺失的目录从最近的现存父目录开始逐层创建。
    #[test]
    fn full_url_creates_multiple_missing_directories() {
        let (address, server) = server(
            vec![
                ("PROPFIND", "/dav/flux/a/b/", 404, ""),
                ("PROPFIND", "/dav/flux/a/", 404, ""),
                ("PROPFIND", "/dav/flux/", 207, COLLECTION),
                ("MKCOL", "/dav/flux/a/", 201, ""),
                ("MKCOL", "/dav/flux/a/b/", 201, ""),
            ],
            false,
        );
        let settings = Settings {
            url: format!("{address}flux/a/b"),
            ..Default::default()
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let target = runtime
            .block_on(ensure_directory(&client().unwrap(), &settings, ""))
            .unwrap();
        assert!(target.path().ends_with("/flux/a/b/"));
        server.join().unwrap();
    }

    /// 父目录禁止访问时停止查找，不把权限问题误判成缺失目录。
    #[test]
    fn inaccessible_parent_does_not_trigger_directory_creation() {
        let (address, server) = server(
            vec![
                ("PROPFIND", "/dav/blocked/child/", 404, ""),
                ("PROPFIND", "/dav/blocked/", 403, ""),
            ],
            false,
        );
        let settings = Settings {
            url: format!("{address}blocked/child"),
            ..Default::default()
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        assert_eq!(
            runtime
                .block_on(ensure_directory(&client().unwrap(), &settings, ""))
                .unwrap_err()
                .code,
            "backup_directory_unwritable"
        );
        server.join().unwrap();
    }

    /// 并发创建导致 MKCOL 返回 405 时，确认目标是集合后继续。
    #[test]
    fn concurrently_created_directory_is_rechecked() {
        let (address, server) = server(
            vec![
                ("PROPFIND", "/dav/child/", 404, ""),
                ("PROPFIND", "/dav/", 207, COLLECTION),
                ("MKCOL", "/dav/child/", 405, ""),
                ("PROPFIND", "/dav/child/", 207, COLLECTION),
            ],
            false,
        );
        let settings = Settings {
            url: format!("{address}child"),
            ..Default::default()
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime
            .block_on(ensure_directory(&client().unwrap(), &settings, ""))
            .unwrap();
        server.join().unwrap();
    }

    /// 完整 URL 是唯一目录来源，已编码路径不会重复编码。
    #[test]
    fn http_and_encoded_segments_are_preserved() {
        let settings = Settings {
            url: "http://localhost:8080/dav/%E9%85%8D%E7%BD%AE/a%252Fb".into(),
            ..Default::default()
        };
        assert_eq!(
            target_directory(&settings).unwrap().as_str(),
            "http://localhost:8080/dav/%E9%85%8D%E7%BD%AE/a%252Fb/"
        );
    }
}
