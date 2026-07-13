//! 通用工具函数。
use std::time::SystemTime;

/// 获取当前时间的 Unix 秒级时间戳。
pub fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 获取当前时间的 Unix 毫秒级时间戳。
pub fn now_epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// 增量解码终端 UTF-8 字节，并把跨读取块的不完整字符保留在输入缓冲中。
pub fn decode_terminal_output(buffer: &mut Vec<u8>, end_of_stream: bool) -> String {
    let mut output = String::new();
    let mut offset = 0usize;
    while offset < buffer.len() {
        match std::str::from_utf8(&buffer[offset..]) {
            Ok(valid) => {
                output.push_str(valid);
                offset = buffer.len();
            }
            Err(error) => {
                let valid_end = offset + error.valid_up_to();
                if valid_end > offset {
                    output.push_str(
                        std::str::from_utf8(&buffer[offset..valid_end])
                            .expect("valid_up_to must identify valid UTF-8"),
                    );
                }
                match error.error_len() {
                    Some(error_len) => {
                        output.push('\u{FFFD}');
                        offset = valid_end + error_len;
                    }
                    None if end_of_stream => {
                        output.push('\u{FFFD}');
                        offset = buffer.len();
                    }
                    None => {
                        offset = valid_end;
                        break;
                    }
                }
            }
        }
    }
    if offset > 0 {
        buffer.drain(..offset);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::decode_terminal_output;

    #[test]
    fn terminal_output_decoder_preserves_split_utf8_character() {
        let mut buffer = vec![b'A', 0xE4, 0xB8];
        assert_eq!(decode_terminal_output(&mut buffer, false), "A");
        assert_eq!(buffer, vec![0xE4, 0xB8]);

        buffer.push(0xAD);
        assert_eq!(decode_terminal_output(&mut buffer, false), "中");
        assert!(buffer.is_empty());
    }

    #[test]
    fn terminal_output_decoder_replaces_invalid_and_truncated_bytes() {
        let mut invalid = vec![b'A', 0xFF, b'B'];
        assert_eq!(decode_terminal_output(&mut invalid, false), "A\u{FFFD}B");
        assert!(invalid.is_empty());

        let mut truncated = vec![0xE4, 0xB8];
        assert_eq!(decode_terminal_output(&mut truncated, true), "\u{FFFD}");
        assert!(truncated.is_empty());
    }
}
