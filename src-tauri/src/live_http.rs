use reqwest::Client;
use std::time::Duration;

// 直播连接持续读取，不能沿用图片请求的总超时。
pub fn live_client() -> Client {
    Client::builder()
        .no_proxy()
        .http1_only()
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(15))
        .pool_idle_timeout(Duration::from_secs(30))
        .pool_max_idle_per_host(4)
        .tcp_keepalive(Duration::from_secs(60))
        .build()
        .expect("无法创建直播请求客户端")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[tokio::test]
    async fn 正常直播持续超过图片超时仍保持连接() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            socket.read(&mut request).unwrap();
            socket.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n").unwrap();
            for _ in 0..23 {
                socket.write_all(b"1\r\nx\r\n").unwrap();
                std::thread::sleep(Duration::from_secs(1));
            }
            socket.write_all(b"0\r\n\r\n").unwrap();
        });
        let response = live_client().get(format!("http://{address}")).send().await.unwrap();
        assert_eq!(response.bytes().await.unwrap().len(), 23);
        server.join().unwrap();
    }
}
