//! Small text/SSE adapters. No SDK, tools, redirects, response-body logging or key persistence.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::sync::watch;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub name: String,
    pub protocol: String,
    pub base_url: String,
    pub model: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Message {
    pub role: String,
    pub content: String,
}
#[derive(Default, Serialize)]
pub struct Reply {
    pub text: String,
    pub usage: Option<Value>,
}

#[cfg(test)]
mod tests {
    use super::*;
    fn p(protocol: &str) -> Profile {
        Profile {
            name: "test".into(),
            protocol: protocol.into(),
            base_url: "https://example.org/v1".into(),
            model: "user-model".into(),
        }
    }
    #[test]
    fn protocol_contracts() {
        let msgs = vec![Message {
            role: "user".into(),
            content: "你好".into(),
        }];
        let (url, headers, b) = request(&p("openai"), "secret", "rules", &msgs, true).unwrap();
        assert_eq!(url.as_str(), "https://example.org/v1/chat/completions");
        assert_eq!(headers[0].0, "authorization");
        assert_eq!(b["messages"][0]["role"], "system");
        let (_, h, b) = request(&p("anthropic"), "secret", "rules", &msgs, false).unwrap();
        assert!(h.iter().any(|(k, _)| k == "anthropic-version"));
        assert_eq!(b["system"], "rules");
        let (url, h, b) = request(&p("gemini"), "secret", "rules", &msgs, true).unwrap();
        assert!(url.path().ends_with(":streamGenerateContent"));
        assert!(!url.as_str().contains("secret"));
        assert_eq!(h[0].0, "x-goog-api-key");
        assert_eq!(b["contents"][0]["parts"][0]["text"], "你好");
        for url in [
            "http://example.com",
            "https://user:pass@example.com",
            "https://example.com/?key=bad",
        ] {
            let mut config = p("openai");
            config.base_url = url.into();
            assert!(request(&config, "k", "r", &msgs, true).is_err());
        }
    }
    #[test]
    fn anonymous_local_compatible_endpoint_omits_authorization() {
        let mut profile = p("openai");
        profile.base_url = "http://localhost:8080/v1".into();
        let (_, headers, _) = request(&profile, "", "rules", &[], false).unwrap();
        assert!(
            headers.is_empty(),
            "anonymous endpoints must not receive an empty Bearer header"
        );
    }
    #[test]
    fn provider_responses_and_usage() {
        for (protocol, body) in [
            (
                "openai",
                json!({"choices":[{"message":{"content":"回答"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}),
            ),
            (
                "anthropic",
                json!({"content":[{"type":"text","text":"回答"}],"stop_reason":"end_turn","usage":{"input_tokens":2,"output_tokens":3}}),
            ),
            (
                "gemini",
                json!({"candidates":[{"content":{"parts":[{"text":"回答"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":3,"totalTokenCount":5}}),
            ),
        ] {
            let mut d = Decoder::default();
            d.accept(protocol, &body, false).unwrap();
            assert_eq!(d.text, "回答");
            assert_eq!(d.usage.unwrap()["input"], 2);
        }
        let mut d = Decoder::default();
        assert!(d
            .accept("openai", &json!({"error":{"message":"SECRET"}}), false)
            .is_err());
        assert!(d.accept("openai", &json!({"choices":[]}), false).is_err());
        let mut d = Decoder::default();
        d.accept(
            "openai",
            &json!({"choices":[{"message":{"content":"x"}}]}),
            false,
        )
        .unwrap();
        assert!(d.usage.is_none());
    }
    #[tokio::test]
    async fn real_http_mock_streaming_cancel_and_truncation() {
        use std::io::{Read, Write};
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = server.local_addr().unwrap();
        let worker = std::thread::spawn(move || {
            let (mut conn, _) = server.accept().unwrap();
            let mut b = [0; 8192];
            let n = conn.read(&mut b).unwrap();
            assert!(String::from_utf8_lossy(&b[..n]).contains("Bearer test-key"));
            let body="data: {\"choices\":[{\"delta\":{\"content\":\"你好\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
            let header=format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len());
            conn.write_all(header.as_bytes()).unwrap();
            for c in body.as_bytes().chunks(2) {
                conn.write_all(c).unwrap();
            }
        });
        let mut config = p("openai");
        config.base_url = format!("http://{address}/v1");
        let (_tx, rx) = watch::channel(false);
        let mut shown = String::new();
        let r = run(
            &config,
            "test-key",
            "rules",
            &[Message {
                role: "user".into(),
                content: "hi".into(),
            }],
            true,
            |v| {
                shown.push_str(v);
            },
            rx,
        )
        .await
        .unwrap();
        assert_eq!(r.text, "你好");
        assert_eq!(shown, "你好");
        worker.join().unwrap();
        let (tx, rx) = watch::channel(true);
        assert!(run(&config, "k", "r", &[], true, |_| {}, rx).await.is_err());
        drop(tx);
    }
}

pub fn request(
    p: &Profile,
    key: &str,
    system: &str,
    messages: &[Message],
    stream: bool,
) -> Result<(reqwest::Url, Vec<(String, String)>, Value), String> {
    if p.model.is_empty()
        || p.model.len() > 200
        || p.name.len() > 100
        || key.len() > 8192
        || messages.len() > 200
        || system.len() > 400000
        || messages
            .iter()
            .any(|m| !matches!(m.role.as_str(), "user" | "assistant") || m.content.len() > 400000)
    {
        return Err("模型配置或消息超出限制".into());
    }
    let mut url = reqwest::Url::parse(&p.base_url).map_err(|_| "Base URL 无效")?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "https"
            || (url.scheme() == "http"
                && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))))
    {
        return Err("仅允许HTTPS或本机HTTP，地址不得含凭据、查询串和片段".into());
    }
    let root = url.path().trim_end_matches('/').to_string();
    let (path, headers, body) = match p.protocol.as_str() {
        "openai" => {
            let mut ms = vec![json!({"role":"system","content":system})];
            ms.extend(
                messages
                    .iter()
                    .map(|m| json!({"role":m.role,"content":m.content})),
            );
            (
                format!("{root}/chat/completions"),
                if key.is_empty() {
                    vec![]
                } else {
                    vec![("authorization".into(), format!("Bearer {key}"))]
                },
                json!({"model":p.model,"messages":ms,"stream":stream}),
            )
        }
        "anthropic" => (
            format!("{root}/messages"),
            vec![
                ("x-api-key".into(), key.into()),
                ("anthropic-version".into(), "2023-06-01".into()),
            ],
            json!({"model":p.model,"system":system,"messages":messages,"max_tokens":4096,"stream":stream}),
        ),
        "gemini" => {
            if !p
                .model
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
            {
                return Err("Gemini模型名仅允许字母、数字、点、横线及下划线".into());
            }
            (
                format!(
                    "{root}/models/{}:{}",
                    p.model,
                    if stream {
                        "streamGenerateContent"
                    } else {
                        "generateContent"
                    }
                ),
                vec![("x-goog-api-key".into(), key.into())],
                json!({"systemInstruction":{"parts":[{"text":system}]},"contents":messages.iter().map(|m|json!({"role":if m.role=="assistant"{"model"}else{"user"},"parts":[{"text":m.content}]})).collect::<Vec<_>>()}),
            )
        }
        _ => return Err("不支持的API协议".into()),
    };
    url.set_path(&path);
    if p.protocol == "gemini" && stream {
        url.set_query(Some("alt=sse"));
    }
    Ok((url, headers, body))
}

#[derive(Default)]
struct Decoder {
    text: String,
    usage: Option<Value>,
    done: bool,
}
impl Decoder {
    fn accept(&mut self, protocol: &str, v: &Value, stream: bool) -> Result<String, String> {
        if v.get("error").is_some() || v["type"] == "error" {
            return Err("供应商返回错误；未回显响应内容".into());
        }
        let mut piece = String::new();
        let mut usage = serde_json::Map::new();
        let mut count = |to: &str, from: &Value| {
            if let Some(n) = from.as_u64() {
                usage.insert(to.into(), json!(n));
            }
        };
        match protocol {
            "openai" => {
                if let Some(c) = v["choices"].as_array().and_then(|a| a.first()) {
                    piece = c[if stream { "delta" } else { "message" }]["content"]
                        .as_str()
                        .unwrap_or("")
                        .into();
                    if let Some(reason) = c["finish_reason"].as_str() {
                        if !matches!(reason, "stop" | "tool_calls") {
                            return Err("模型输出被截断或过滤，请缩短输入后重试".into());
                        }
                        self.done = true;
                    }
                }
                count("input", &v["usage"]["prompt_tokens"]);
                count("output", &v["usage"]["completion_tokens"]);
                count("total", &v["usage"]["total_tokens"]);
            }
            "anthropic" => {
                if stream {
                    piece = v["delta"]["text"].as_str().unwrap_or("").into();
                    self.done |= v["type"] == "message_stop";
                } else {
                    piece = v["content"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .filter(|b| b["type"] == "text")
                                .filter_map(|b| b["text"].as_str())
                                .collect::<String>()
                        })
                        .unwrap_or_default();
                }
                let stop = if stream {
                    &v["delta"]["stop_reason"]
                } else {
                    &v["stop_reason"]
                };
                if stop == "max_tokens" {
                    return Err("模型输出超过长度限制".into());
                }
                count(
                    "input",
                    if v["type"] == "message_start" {
                        &v["message"]["usage"]["input_tokens"]
                    } else {
                        &v["usage"]["input_tokens"]
                    },
                );
                count("output", &v["usage"]["output_tokens"]);
            }
            "gemini" => {
                if let Some(c) = v["candidates"].as_array().and_then(|a| a.first()) {
                    piece = c["content"]["parts"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .filter(|b| b["thought"] != true)
                                .filter_map(|b| b["text"].as_str())
                                .collect::<String>()
                        })
                        .unwrap_or_default();
                    if let Some(reason) = c["finishReason"].as_str() {
                        if reason != "STOP" {
                            return Err("模型输出被截断或过滤".into());
                        }
                        self.done = true;
                    }
                }
                count("input", &v["usageMetadata"]["promptTokenCount"]);
                count("output", &v["usageMetadata"]["candidatesTokenCount"]);
                count("total", &v["usageMetadata"]["totalTokenCount"]);
            }
            _ => return Err("协议错误".into()),
        }
        if !usage.is_empty() {
            if let Some(Value::Object(old)) = &self.usage {
                for (k, v) in old {
                    usage.entry(k.clone()).or_insert(v.clone());
                }
            }
            self.usage = Some(Value::Object(usage));
        }
        if !stream && piece.is_empty() {
            return Err("模型未返回文本；拒绝保存空回答".into());
        }
        self.text.push_str(&piece);
        if self.text.len() > 1024 * 1024 {
            return Err("模型输出过大".into());
        }
        Ok(piece)
    }
}

pub async fn run(
    p: &Profile,
    key: &str,
    system: &str,
    messages: &[Message],
    stream: bool,
    mut delta: impl FnMut(&str),
    mut cancel: watch::Receiver<bool>,
) -> Result<Reply, String> {
    if *cancel.borrow() {
        return Err("请求已取消".into());
    }
    let (url, headers, body) = request(p, key, system, messages, stream)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .connect_timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "网络初始化失败")?;
    let mut req = client.post(url).json(&body);
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let future = async {
        let mut response = req.send().await.map_err(|e| {
            if e.is_timeout() {
                "请求超时"
            } else {
                "网络请求失败，请检查地址、证书及连接"
            }
        })?;
        if !response.status().is_success() {
            return Err(format!(
                "模型API返回HTTP {}；请检查协议、模型、凭据与额度",
                response.status().as_u16()
            ));
        }
        let sse = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .starts_with("text/event-stream");
        let mut decoder = Decoder::default();
        let mut buf = Vec::new();
        let mut total = 0;
        while let Some(chunk) = response.chunk().await.map_err(|_| "响应中断或超时")? {
            total += chunk.len();
            if total > 4 * 1024 * 1024 {
                return Err("响应过大".into());
            }
            buf.extend_from_slice(&chunk);
            if sse {
                while let Some(end) = buf.iter().position(|v| *v == b'\n') {
                    let line = String::from_utf8(buf.drain(..=end).collect())
                        .map_err(|_| "响应不是UTF-8")?;
                    if let Some(data) = line.trim().strip_prefix("data:") {
                        let data = data.trim();
                        if data == "[DONE]" {
                            decoder.done = true;
                        } else {
                            let v: Value =
                                serde_json::from_str(data).map_err(|_| "流式响应格式无效")?;
                            let piece = decoder.accept(&p.protocol, &v, true)?;
                            delta(&piece);
                        }
                    }
                }
            }
        }
        if sse {
            if !buf.iter().all(|b| b.is_ascii_whitespace()) || !decoder.done {
                return Err("流式响应未完整结束，未提交实验结果".into());
            }
        } else {
            let v: Value = serde_json::from_slice(&buf).map_err(|_| "响应不是有效JSON")?;
            let piece = decoder.accept(&p.protocol, &v, false)?;
            delta(&piece);
        }
        if decoder.text.trim().is_empty() {
            return Err("模型未返回文本".into());
        }
        Ok(Reply {
            text: decoder.text,
            usage: decoder.usage,
        })
    };
    tokio::select! {result=future=>result,_=cancel.changed()=>Err("请求已取消".into())}
}

#[cfg(test)]
mod transport_tests {
    use super::*;
    use std::io::{Read, Write};
    #[tokio::test]
    async fn three_providers_http_and_safe_error_paths() {
        for (protocol, body) in [
            (
                "openai",
                json!({"choices":[{"message":{"content":"模型回答"},"finish_reason":"stop"}]}),
            ),
            (
                "anthropic",
                json!({"content":[{"type":"text","text":"模型回答"}],"stop_reason":"end_turn"}),
            ),
            (
                "gemini",
                json!({"candidates":[{"content":{"parts":[{"text":"模型回答"}]},"finishReason":"STOP"}]}),
            ),
        ] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let serialized = body.to_string();
            let worker = std::thread::spawn(move || {
                let (mut conn, _) = listener.accept().unwrap();
                let mut b = [0; 8192];
                let n = conn.read(&mut b).unwrap();
                assert!(!String::from_utf8_lossy(&b[..n]).contains("key=secret"));
                let response=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",serialized.len(),serialized);
                conn.write_all(response.as_bytes()).unwrap();
            });
            let p = Profile {
                name: "mock".into(),
                protocol: protocol.into(),
                base_url: format!("http://{address}/v1"),
                model: "custom-model".into(),
            };
            let (_tx, rx) = watch::channel(false);
            let r = run(
                &p,
                "secret",
                "rules",
                &[Message {
                    role: "user".into(),
                    content: "输入".into(),
                }],
                false,
                |_| {},
                rx,
            )
            .await
            .unwrap();
            assert_eq!(r.text, "模型回答");
            assert!(r.usage.is_none());
            worker.join().unwrap();
        }
    }
    #[tokio::test]
    async fn in_flight_cancel_and_network_disconnect() {
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = server.local_addr().unwrap();
        let worker = std::thread::spawn(move || {
            let (conn, _) = server.accept().unwrap();
            std::thread::sleep(Duration::from_millis(100));
            drop(conn);
        });
        let p = Profile {
            name: "mock".into(),
            protocol: "openai".into(),
            base_url: format!("http://{address}/v1"),
            model: "model".into(),
        };
        let (tx, rx) = watch::channel(false);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            tx.send(true).unwrap();
        });
        let error = run(&p, "NEVER_PRINT_THIS_KEY", "rules", &[], true, |_| {}, rx)
            .await
            .err()
            .unwrap();
        assert!(error.contains("取消"));
        assert!(!error.contains("NEVER_PRINT_THIS_KEY"));
        worker.join().unwrap();
        let (_tx, rx) = watch::channel(false);
        let error = run(&p, "secret", "rules", &[], false, |_| {}, rx)
            .await
            .err()
            .unwrap();
        assert!(!error.contains("secret"));
    }
    #[test]
    fn streaming_anthropic_gemini_and_truncation() {
        let mut d = Decoder::default();
        d.accept(
            "anthropic",
            &json!({"type":"message_start","message":{"usage":{"input_tokens":7}}}),
            true,
        )
        .unwrap();
        assert_eq!(
            d.accept(
                "anthropic",
                &json!({"type":"content_block_delta","delta":{"text":"好"}}),
                true
            )
            .unwrap(),
            "好"
        );
        d.accept(
            "anthropic",
            &json!({"type":"message_delta","usage":{"output_tokens":2}}),
            true,
        )
        .unwrap();
        d.accept("anthropic", &json!({"type":"message_stop"}), true)
            .unwrap();
        assert!(d.done);
        assert_eq!(d.usage.unwrap(), json!({"input":7,"output":2}));
        let mut d = Decoder::default();
        d.accept("gemini",&json!({"candidates":[{"content":{"parts":[{"text":"隐藏","thought":true},{"text":"可见"}]},"finishReason":"STOP"}]}),true).unwrap();
        assert_eq!(d.text, "可见");
        assert!(d.done);
        assert!(d
            .accept(
                "openai",
                &json!({"choices":[{"delta":{"content":"残缺"},"finish_reason":"length"}]}),
                true
            )
            .is_err());
    }
}
