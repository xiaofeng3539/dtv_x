use deno_core::{FastString, JsRuntime, RuntimeOptions};
use log::{debug, error};
use md5::{Digest, Md5};
use rand::RngExt;
use std::collections::HashMap;
#[cfg(target_os = "linux")]
use std::sync::Once;
use url::Url;

// Load sign.js content at compile time
const SIGN_JS_CONTENT: &str = include_str!("./sign.js");

#[cfg(target_os = "linux")]
static JS_RUNTIME_INIT: Once = Once::new();

fn ensure_js_runtime_platform_initialized() {
    #[cfg(target_os = "linux")]
    JS_RUNTIME_INIT.call_once(|| {
        JsRuntime::init_platform(None);
    });
}

pub async fn generate_signature(
    wss_url: &str,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let parsed_url = Url::parse(wss_url)?;
    let params_to_sign_keys = [
        "live_id",
        "aid",
        "version_code",
        "webcast_sdk_version",
        "room_id",
        "sub_room_id",
        "sub_channel_id",
        "did_rule",
        "user_unique_id",
        "device_platform",
        "device_type",
        "ac",
        "identity",
    ];
    let mut query_params_map = HashMap::new();
    for (key, value) in parsed_url.query_pairs() {
        query_params_map.insert(key.into_owned(), value.into_owned());
    }

    let mut tpl_params_vec: Vec<String> = Vec::new();
    for key_str in params_to_sign_keys {
        let value = query_params_map
            .get(key_str)
            .map(|s| s.as_str())
            .unwrap_or("");
        tpl_params_vec.push(format!("{}={}", key_str, value));
    }
    let to_sign_str = tpl_params_vec.join(",");
    debug!("[Douyin Danmaku] String to MD5 for signature: {}", to_sign_str);

    // Use md_5 crate for MD5 computation
    let mut hasher = Md5::new();
    hasher.update(to_sign_str.as_bytes());
    let digest_bytes = hasher.finalize();
    let md5_param = hex::encode(digest_bytes);
    debug!("[Douyin Danmaku] MD5 param for signature: {}", md5_param);

    ensure_js_runtime_platform_initialized();
    let mut runtime = JsRuntime::new(RuntimeOptions::default());

    let bootstrap_script = r#"
        globalThis.window = globalThis;
        globalThis.self = globalThis;
        globalThis.document = {}; 
        globalThis.navigator = {
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        };
    "#;
    runtime
        .execute_script("[bootstrap]", FastString::from_static(bootstrap_script))
        .map_err(|e| {
            error!("[Douyin Danmaku] Error during deno_core bootstrap script: {}", e);
            e
        })?;

    runtime.execute_script("[platform-user-agent]", FastString::from(format!(
        "globalThis.__dtv_douyin_user_agent = {};",
        serde_json::to_string(crate::platforms::douyin::web_api::DEFAULT_USER_AGENT)?,
    )))?;

    // Use the embedded sign.js content
    runtime
        .execute_script("./sign.js", FastString::from_static(SIGN_JS_CONTENT))
        .map_err(|e| {
            error!("[Douyin Danmaku] Error during deno_core eval of sign.js: {}", e);
            e
        })?;

    // Simple Live regenerates signatures containing '-' or '='. Keep this bounded.
    for _ in 0..128 {
        let result = runtime.execute_script("[call_get_sign]", FastString::from(format!("get_sign('{}')", md5_param)))?;
        let signature = {
            deno_core::scope!(scope, runtime);
            let value = deno_core::v8::Local::new(scope, result);
            if !value.is_string() { return Err("get_sign did not return a string".into()); }
            value.to_rust_string_lossy(scope)
        };
        if !signature.is_empty() && !signature.contains(['-', '=']) { return Ok(signature); }
    }
    Err("Douyin signature generation exhausted its retry limit".into())
}

pub fn generate_ms_token(length: usize) -> String {
    const CHARSET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"; // Removed _= as they are not typical for msToken
    let mut rng = rand::rng();
    (0..length)
        .map(|_| {
            let idx = rng.random_range(0..CHARSET.len());
            CHARSET[idx] as char
        })
        .collect()
}

#[tauri::command]
pub fn generate_douyin_ms_token() -> String {
    // For now, let's assume msToken length is always 107, as used elsewhere.
    // If variable length is needed, this command could take a length parameter.
    generate_ms_token(107)
}

#[cfg(test)]
mod upgrade_tests {
    use super::*;

    #[tokio::test]
    async fn embedded_douyin_signer_survives_v8_upgrade() {
        let signature = generate_signature(
            "wss://webcast5-ws-web-lq.douyin.com/webcast/im/push/v2/?live_id=1&aid=6383&room_id=123&user_unique_id=456&device_platform=web&identity=audience",
        ).await.unwrap();
        assert!(!signature.is_empty());
        assert!(signature.is_ascii());
        assert!(!signature.contains(char::is_whitespace));
        assert_ne!(signature, "undefined");
    }

    #[test]
    fn upgraded_rand_preserves_ms_token_format() {
        assert_eq!(generate_ms_token(0), "");
        for length in [1, 107] {
            let token = generate_ms_token(length);
            assert_eq!(token.len(), length);
            assert!(token.bytes().all(|byte| byte.is_ascii_alphanumeric()));
        }
    }
}

// Placeholder for the more complex signature generation if needed later.
// pub async fn generate_signature(wss_url: &str) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
//     // ... (implementation from demo if required)
//     unimplemented!();
// }
