use crate::source::{AccountSource, SourceError};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde_json::{json, Value};
use solana_account::Account;
use solana_address::Address;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Token bucket: `rate` tokens per second, at most `capacity` stored. `take` always reserves one
/// token (the balance may go negative) and returns how long the caller must wait before using it,
/// so concurrent callers queue up in order instead of racing.
#[derive(Debug)]
pub struct TokenBucket {
    rate: f64,
    capacity: f64,
    tokens: f64,
    last: Instant,
}

impl TokenBucket {
    pub fn new(rate: f64, capacity: f64, now: Instant) -> TokenBucket {
        let capacity = capacity.max(1.0);
        TokenBucket { rate, capacity, tokens: capacity, last: now }
    }

    pub fn take(&mut self, now: Instant) -> Duration {
        let elapsed = now.saturating_duration_since(self.last).as_secs_f64();
        self.tokens = (self.tokens + elapsed * self.rate).min(self.capacity);
        self.last = self.last.max(now);
        self.tokens -= 1.0;
        if self.tokens >= 0.0 { Duration::ZERO } else { Duration::from_secs_f64(-self.tokens / self.rate) }
    }
}

/// Requests per second from `AVAL_MAX_RPS` (unset, empty, unparsable or ≤ 0 = unlimited).
pub fn max_rps_from(v: Option<&str>) -> Option<f64> {
    v.and_then(|s| s.trim().parse::<f64>().ok()).filter(|r| r.is_finite() && *r > 0.0)
}

/// Process-wide limiter shared by every `Upstream` (clones included). Burst of 1: never more
/// than `rate` requests in any one-second window.
fn limiter() -> &'static Option<Mutex<TokenBucket>> {
    static L: OnceLock<Option<Mutex<TokenBucket>>> = OnceLock::new();
    L.get_or_init(|| {
        max_rps_from(std::env::var("AVAL_MAX_RPS").ok().as_deref()).map(|r| Mutex::new(TokenBucket::new(r, 1.0, Instant::now())))
    })
}

static CALLS: AtomicU64 = AtomicU64::new(0);

/// Upstream HTTP requests sent by this process so far (retries and failures included).
pub fn calls_made() -> u64 {
    CALLS.load(Ordering::Relaxed)
}

async fn pace() {
    if let Some(l) = limiter() {
        let wait = l.lock().expect("limiter").take(Instant::now());
        if !wait.is_zero() { tokio::time::sleep(wait).await; }
    }
}

/// `scheme://host[:port]` of a URL, for logs: path, query and credentials (API keys) are dropped.
pub fn redact_url(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else { return "<url>".into() };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or("");
    format!("{scheme}://{host}")
}

#[derive(Clone)]
pub struct Upstream {
    url: String,
    commitment: String,
    client: reqwest::Client,
}

fn parse_account(v: &Value) -> Result<Option<Account>, SourceError> {
    if v.is_null() {
        return Ok(None);
    }
    let bad = |what: &str| SourceError::Unavailable(format!("malformed account from upstream: {what}"));
    let data = v["data"][0].as_str().ok_or_else(|| bad("data"))?;
    Ok(Some(Account {
        lamports: v["lamports"].as_u64().ok_or_else(|| bad("lamports"))?,
        data: B64.decode(data).map_err(|_| bad("base64"))?,
        owner: Address::from_str(v["owner"].as_str().ok_or_else(|| bad("owner"))?).map_err(|_| bad("owner"))?,
        executable: v["executable"].as_bool().unwrap_or(false),
        rent_epoch: v["rentEpoch"].as_u64().unwrap_or(u64::MAX),
    }))
}

impl Upstream {
    pub fn new(url: &str, commitment: &str, timeout_ms: u64) -> Upstream {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(timeout_ms))
            .build()
            .expect("reqwest client");
        Upstream { url: url.to_string(), commitment: commitment.to_string(), client }
    }

    /// Sends a raw JSON-RPC body and returns the raw reply body.
    pub async fn forward(&self, body: &Value) -> Result<Value, SourceError> {
        pace().await;
        CALLS.fetch_add(1, Ordering::Relaxed);
        let resp = self
            .client
            .post(&self.url)
            .json(body)
            .send()
            .await
            .map_err(|e| SourceError::Unavailable(e.without_url().to_string()))?;
        if !resp.status().is_success() {
            return Err(SourceError::Unavailable(format!("HTTP {}", resp.status())));
        }
        resp.json().await.map_err(|e| SourceError::Unavailable(e.without_url().to_string()))
    }

    /// One call; returns `result`, or `SourceError::Rpc(error)`.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value, SourceError> {
        let body = self.forward(&json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})).await?;
        if let Some(err) = body.get("error") {
            return Err(SourceError::Rpc(err.clone()));
        }
        Ok(body["result"].clone())
    }
}

impl Upstream {
    /// `getMultipleAccounts`; with `min_context_slot` the node must answer from at least that slot.
    pub async fn get_multiple_at(
        &self,
        keys: &[Address],
        min_context_slot: Option<u64>,
    ) -> Result<(u64, Vec<Option<Account>>), SourceError> {
        let keys: Vec<String> = keys.iter().map(|k| k.to_string()).collect();
        let mut config = json!({"encoding": "base64", "commitment": self.commitment});
        if let Some(slot) = min_context_slot {
            config["minContextSlot"] = json!(slot);
        }
        let result = self
            .call("getMultipleAccounts", json!([keys, config]))
            .await
            .map_err(|e| SourceError::Unavailable(e.to_string()))?;
        let slot = result["context"]["slot"]
            .as_u64()
            .ok_or_else(|| SourceError::Unavailable("missing context slot".into()))?;
        let values = result["value"].as_array().ok_or(SourceError::Unavailable("no value array".into()))?;
        if values.len() != keys.len() {
            return Err(SourceError::Unavailable(format!(
                "upstream returned {} accounts for {} keys",
                values.len(),
                keys.len()
            )));
        }
        let accounts = values.iter().map(parse_account).collect::<Result<Vec<_>, _>>()?;
        Ok((slot, accounts))
    }
}

impl AccountSource for Upstream {
    async fn get_multiple(&self, keys: &[Address]) -> Result<(u64, Vec<Option<Account>>), SourceError> {
        self.get_multiple_at(keys, None).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_partial_json, method};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[test]
    fn bucket_paces_to_the_rate_after_the_burst() {
        let t0 = Instant::now();
        let mut b = TokenBucket::new(9.0, 1.0, t0);
        assert_eq!(b.take(t0), Duration::ZERO);
        // Same instant: each next caller queues one interval (1/9 s) behind the previous.
        let w: Vec<f64> = (0..3).map(|_| b.take(t0).as_secs_f64()).collect();
        for (i, x) in w.iter().enumerate() { assert!((x - (i + 1) as f64 / 9.0).abs() < 1e-9, "{w:?}"); }
        // After a long idle the bucket holds only `capacity` tokens: one free call, then paced again.
        let later = t0 + Duration::from_secs(10);
        assert_eq!(b.take(later), Duration::ZERO);
        assert!((b.take(later).as_secs_f64() - 1.0 / 9.0).abs() < 1e-9);
    }

    #[test]
    fn bucket_never_exceeds_the_rate_in_any_second() {
        let t0 = Instant::now();
        let mut b = TokenBucket::new(9.0, 1.0, t0);
        // 100 callers arrive at once; their release times must be ≥ 1/9 s apart.
        let mut at: Vec<f64> = (0..100).map(|_| b.take(t0).as_secs_f64()).collect();
        at.sort_by(f64::total_cmp);
        for w in at.windows(10) { assert!(w[9] - w[0] >= 1.0 - 1e-9, "10 calls inside one second: {w:?}"); }
        let mut big = TokenBucket::new(2.0, 4.0, t0);
        let burst: Vec<Duration> = (0..5).map(|_| big.take(t0)).collect();
        assert_eq!(&burst[..4], &[Duration::ZERO; 4]);
        assert_eq!(burst[4], Duration::from_millis(500));
    }

    #[test]
    fn max_rps_env_parsing() {
        assert_eq!(max_rps_from(Some("9")), Some(9.0));
        assert_eq!(max_rps_from(Some(" 2.5 ")), Some(2.5));
        for bad in [None, Some(""), Some("0"), Some("-1"), Some("fast"), Some("inf")] { assert_eq!(max_rps_from(bad), None, "{bad:?}"); }
    }

    #[tokio::test]
    async fn every_request_is_counted() {
        let server = MockServer::start().await;
        Mock::given(method("POST")).respond_with(ResponseTemplate::new(429)).mount(&server).await;
        let up = Upstream::new(&server.uri(), "confirmed", 2000);
        let before = calls_made();
        let _ = up.call("getSlot", json!([])).await;
        let _ = up.call("getSlot", json!([])).await;
        assert!(calls_made() >= before + 2);
    }

    #[test]
    fn redact_url_keeps_only_scheme_and_host() {
        assert_eq!(redact_url("https://mainnet.helius-rpc.com/?api-key=SECRET123"), "https://mainnet.helius-rpc.com");
        assert_eq!(redact_url("http://user:SECRET123@127.0.0.1:8899/path?x=1#f"), "http://127.0.0.1:8899");
        assert_eq!(redact_url("not a url SECRET123"), "<url>");
    }

    #[tokio::test]
    async fn parses_get_multiple_accounts() {
        let server = MockServer::start().await;
        let owner = "11111111111111111111111111111111";
        Mock::given(method("POST"))
            .and(body_partial_json(json!({"method": "getMultipleAccounts"})))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "jsonrpc": "2.0", "id": 1,
                "result": {"context": {"slot": 77}, "value": [
                    {"lamports": 5, "owner": owner, "data": ["AQI=", "base64"], "executable": false, "rentEpoch": 18446744073709551615u64, "space": 2},
                    null
                ]}
            })))
            .mount(&server).await;
        let up = Upstream::new(&server.uri(), "confirmed", 2000);
        let (slot, accts) = up.get_multiple(&[Address::from([1; 32]), Address::from([2; 32])]).await.unwrap();
        assert_eq!(slot, 77);
        let a = accts[0].as_ref().unwrap();
        assert_eq!((a.lamports, a.data.clone(), a.rent_epoch), (5, vec![1, 2], u64::MAX));
        assert!(accts[1].is_none());
    }

    #[tokio::test]
    async fn http_failure_is_unavailable() {
        let server = MockServer::start().await;
        Mock::given(method("POST")).respond_with(ResponseTemplate::new(429)).mount(&server).await;
        let up = Upstream::new(&server.uri(), "confirmed", 2000);
        assert!(matches!(up.get_multiple(&[Address::from([1; 32])]).await, Err(SourceError::Unavailable(_))));
    }

    async fn reply_with(result: Value) -> Result<(u64, Vec<Option<Account>>), SourceError> {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"jsonrpc": "2.0", "id": 1, "result": result})))
            .mount(&server).await;
        let up = Upstream::new(&server.uri(), "confirmed", 2000);
        up.get_multiple(&[Address::from([1; 32]), Address::from([2; 32])]).await
    }

    #[tokio::test]
    async fn short_value_array_is_unavailable() {
        let r = reply_with(json!({"context": {"slot": 1}, "value": [null]})).await;
        assert!(matches!(r, Err(SourceError::Unavailable(_))));
    }

    #[tokio::test]
    async fn missing_slot_is_unavailable() {
        let r = reply_with(json!({"context": {}, "value": [null, null]})).await;
        assert!(matches!(r, Err(SourceError::Unavailable(_))));
    }
}
